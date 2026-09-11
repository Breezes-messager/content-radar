'use strict';

/**
 * HTTP 服务：静态前端 + JSON API + 图片代理
 * 零依赖，只监听本机回环地址。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const { loadConfig, saveConfig } = require('./config');
const store = require('./store');
const { runFetch, reapplyFilters, scoreLoop } = require('./pipeline');
const { listAdapters } = require('./sources');
const { AiClient } = require('./ai');
const { getBuffer } = require('./http');
const { guard, isPublicHttpUrl } = require('./security');
const accounts = require('./accounts');
const digest = require('./digest');
const qrlogin = require('./qrlogin');
const loginWindow = require('./loginWindow');
const exporter = require('./export');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_PROXY_BYTES = 8 * 1024 * 1024; // 图片代理单次最多 8MB

/** 各平台 Cookie 获取提示 */
const ACCOUNT_HINTS = {
  bilibili: '登录 bilibili.com → F12 → Application → Cookies，复制 SESSDATA（或整条 Cookie）',
  tieba: '登录 tieba.baidu.com → F12 → Application → Cookies，复制 BDUSS（或整条 Cookie）',
  xiaoheihe: '登录 xiaoheihe.cn → F12 → Application → Cookies，复制 pkey / x_xhh_tokenid（或整条 Cookie）',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'];

let fetchState = { running: false, startedAt: 0 };

/* ------------------------------- helpers ------------------------------- */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, limit = 1024 * 512) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        const err = new Error('请求体过大');
        err.statusCode = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** 图片代理：SSRF 防护 + 禁止跳转 + 限制大小 */
async function proxyImage(req, res, url) {
  // SSRF 防护：只允许公网 http(s)，且域名解析结果必须全部是公网地址
  if (!(await isPublicHttpUrl(url))) {
    res.writeHead(400).end('非法的代理地址');
    return;
  }
  try {
    const { status, headers, buffer } = await getBuffer(url, {
      timeoutMs: 12000,
      retries: 0,
      redirect: 'manual', // 禁止跟随跳转，避免 302 到内网
      maxBytes: MAX_PROXY_BYTES,
      headers: { Referer: 'https://www.bilibili.com/', Accept: 'image/avif,image/webp,image/*,*/*;q=0.8' },
    });
    if (status >= 300 && status < 400) {
      res.writeHead(400).end('拒绝重定向');
      return;
    }
    const type = (headers.get('content-type') || '').split(';')[0].trim();
    if (status >= 400) {
      res.writeHead(502).end('图片拉取失败');
      return;
    }
    if (!IMAGE_TYPES.includes(type)) {
      res.writeHead(415).end('非图片类型');
      return;
    }
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'public, max-age=86400',
      'Content-Length': buffer.length,
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(buffer);
  } catch (err) {
    res.writeHead(502).end('图片代理失败');
  }
}

function serveStatic(req, res, pathname) {
  // 不解码路径：URL 里的 %2e%2e 会保持字面量，配合下面的 relative 检查即可杜绝穿越
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.resolve(PUBLIC_DIR, rel);
  const relative = path.relative(PUBLIC_DIR, filePath);
  // 必须仍在 public 目录内（用 relative 判断，避免 public-evil 这类前缀绕过）
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  });
}

/* --------------------------------- API --------------------------------- */

async function handleApi(req, res, pathname, query) {
  const method = req.method.toUpperCase();

  // --- 引导数据 ---
  if (pathname === '/api/bootstrap' && method === 'GET') {
    return sendJson(res, 200, {
      config: loadConfig(),
      stats: store.getStats(),
      adapters: listAdapters(),
      fetchState,
      version: require('../package.json').version,
    });
  }

  // --- 内容列表 ---
  if (pathname === '/api/items' && method === 'GET') {
    const result = store.queryItems({
      sourceId: query.get('sourceId') || '',
      status: query.get('status') || '',
      starred: query.get('starred') === '1',
      q: query.get('q') || '',
      sort: query.get('sort') || 'time',
      page: Number(query.get('page') || 1),
      pageSize: Number(query.get('pageSize') || 24),
    });
    return sendJson(res, 200, result);
  }

  if (pathname === '/api/items/star' && method === 'POST') {
    const body = await readBody(req);
    const item = store.setStar(body.id, body.value);
    return sendJson(res, item ? 200 : 404, { ok: Boolean(item), item });
  }

  // 赞 / 踩：喂给 AI 学口味
  if (pathname === '/api/items/feedback' && method === 'POST') {
    const body = await readBody(req);
    const item = store.setFeedback(body.id, body.value);
    if (item) store.flush();
    const samples = store.feedbackSamples({ limit: 0 });
    return sendJson(res, item ? 200 : 404, {
      ok: Boolean(item),
      feedback: item ? item.feedback || null : null,
      upTotal: samples.upTotal,
      downTotal: samples.downTotal,
    });
  }

  if (pathname === '/api/items/seen' && method === 'POST') {
    const body = await readBody(req);
    const item = store.markSeen(body.id);
    return sendJson(res, item ? 200 : 404, { ok: Boolean(item) });
  }

  if (pathname === '/api/items/clear' && method === 'POST') {
    const body = await readBody(req);
    const removed = store.clearItems({ sourceId: body.sourceId || '', onlyFiltered: Boolean(body.onlyFiltered) });
    store.flush();
    return sendJson(res, 200, { ok: true, removed });
  }

  // --- 抓取 ---
  if (pathname === '/api/fetch' && method === 'POST') {
    if (fetchState.running) return sendJson(res, 409, { ok: false, error: '已有抓取任务在运行' });
    const body = await readBody(req);
    fetchState = { running: true, startedAt: Date.now() };
    try {
      const summary = await runFetch({ sourceId: body.sourceId || '' });
      return sendJson(res, 200, { ok: true, summary });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    } finally {
      fetchState = { running: false, startedAt: 0 };
    }
  }

  if (pathname === '/api/filters/reapply' && method === 'POST') {
    try {
      const result = await reapplyFilters();
      return sendJson(res, 200, { ok: true, ...result });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  // --- 账号 ---
  if (pathname === '/api/accounts/check' && method === 'POST') {
    const body = await readBody(req);
    const platform = String(body.platform || '');
    // 允许用「还没保存」的 Cookie 直接测试
    const result = await accounts.check(platform, { cookie: body.cookie });
    return sendJson(res, 200, { ok: true, ...result });
  }

  if (pathname === '/api/accounts' && method === 'GET') {
    const cfg = loadConfig();
    const list = accounts.PLATFORMS.map((p) => ({
      platform: p,
      label: accounts.LABELS[p],
      configured: accounts.hasAccount(p),
      hint: ACCOUNT_HINTS[p],
      cookie: (cfg.accounts && cfg.accounts[p] && cfg.accounts[p].cookie) || '',
    }));
    return sendJson(res, 200, { ok: true, accounts: list });
  }

  // --- B站扫码登录（浏览器截图二维码 + 读浏览器 Cookie） ---
  if (pathname === '/api/accounts/qr' && method === 'POST') {
    const body = await readBody(req);
    const action = String(body.action || 'start');

    if (action === 'start') {
      try {
        const s = await qrlogin.startSession();
        return sendJson(res, 200, { ok: true, ...s });
      } catch (err) {
        return sendJson(res, 502, { ok: false, error: err.message });
      }
    }

    if (action === 'refresh') {
      try {
        const s = await qrlogin.refresh(String(body.id || ''));
        return sendJson(res, 200, { ok: true, ...s });
      } catch (err) {
        return sendJson(res, 502, { ok: false, error: err.message });
      }
    }

    if (action === 'close') {
      qrlogin.close(String(body.id || ''));
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 400, { ok: false, error: '未知的 action' });
  }

  if (pathname === '/api/accounts/qr' && method === 'GET') {
    const id = query.get('id') || '';
    const view = qrlogin.get(id);
    if (!view) return sendJson(res, 404, { ok: false, error: '扫码会话不存在或已结束' });

    if (view.status === 'success') {
      const taken = qrlogin.takeCookie(id);
      if (taken) {
        const cfg = loadConfig();
        cfg.accounts = cfg.accounts || {};
        cfg.accounts.bilibili = { ...(cfg.accounts.bilibili || {}), cookie: taken.cookie };
        saveConfig(cfg);
        const check = await accounts.checkBilibili(taken.cookie).catch(() => null);
        if (check) {
          view.nickname = check.nickname || '';
          view.message = check.message || view.message;
        }
        view.saved = true;
      }
      qrlogin.close(id);
    }
    return sendJson(res, 200, { ok: true, ...view });
  }

  // --- 内嵌登录窗口（贴吧 / 小黑盒） ---
  if (pathname === '/api/accounts/login-window' && method === 'POST') {
    const body = await readBody(req);
    try {
      const s = await loginWindow.open(String(body.platform || ''));
      return sendJson(res, 200, { ok: true, ...s });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  if (pathname === '/api/accounts/login-window' && method === 'GET') {
    const id = query.get('id') || '';
    const view = loginWindow.get(id);
    if (!view) return sendJson(res, 404, { ok: false, error: '登录会话不存在或已结束' });

    if (view.status === 'success') {
      const taken = loginWindow.takeCookie(id);
      if (taken) {
        const cfg = loadConfig();
        cfg.accounts = cfg.accounts || {};
        cfg.accounts[taken.platform] = { ...(cfg.accounts[taken.platform] || {}), cookie: taken.cookie };
        saveConfig(cfg);
        view.saved = true;
        if (taken.nickname) view.nickname = taken.nickname;
      }
      loginWindow.close(id);
    }
    return sendJson(res, 200, { ok: true, ...view });
  }

  // --- 导出 ---
  if (pathname === '/api/export' && method === 'GET') {
    const type = query.get('type') || 'favorites';
    let result;
    try {
      result = exporter.build(type);
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }
    const body = Buffer.from(result.content, 'utf8');
    res.writeHead(200, {
      'Content-Type': result.mime,
      'Content-Disposition': `attachment; filename="${result.fileName}"`,
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
    });
    res.end(body);
    return;
  }

  if (pathname === '/api/export' && method === 'POST') {
    const body = await readBody(req);
    try {
      const result = exporter.build(String(body.type || 'favorites'));
      return sendJson(res, 200, {
        ok: true,
        type: result.type,
        fileName: result.fileName,
        count: result.count,
        file: result.file,
      });
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }
  }

  // --- 配置 ---
  if (pathname === '/api/config' && method === 'GET') {
    return sendJson(res, 200, loadConfig());
  }

  if (pathname === '/api/config' && method === 'POST') {
    const body = await readBody(req);
    const next = saveConfig(require('./config').deepMerge(loadConfig(), body));
    return sendJson(res, 200, { ok: true, config: next });
  }

  // --- AI ---
  if (pathname === '/api/ai/test' && method === 'POST') {
    const cfg = loadConfig();
    const client = new AiClient(cfg.ai);
    if (!client.ready) return sendJson(res, 400, { ok: false, error: '请先填写 API 地址、Key 和模型' });
    try {
      const result = await client.testConnection();
      store.recordAiUsage({ tokensIn: result.tokensIn, tokensOut: result.tokensOut, cost: result.cost });
      return sendJson(res, 200, { ok: true, ...result });
    } catch (err) {
      return sendJson(res, 502, { ok: false, error: err.message });
    }
  }

  if (pathname === '/api/items/summarize' && method === 'POST') {
    const body = await readBody(req);
    const cfg = loadConfig();
    const client = new AiClient(cfg.ai);
    if (!client.ready) return sendJson(res, 400, { ok: false, error: '请先在设置里配置 AI' });
    const item = store.getItem(body.id);
    if (!item) return sendJson(res, 404, { ok: false, error: '条目不存在' });
    try {
      const r = await client.summarize(item);
      store.setSummary(item.id, r.summary);
      store.recordAiUsage({ tokensIn: r.usage.tokensIn, tokensOut: r.usage.tokensOut, cost: r.usage.cost });
      store.flush();
      return sendJson(res, 200, { ok: true, summary: r.summary, usage: r.usage });
    } catch (err) {
      return sendJson(res, 502, { ok: false, error: err.message });
    }
  }

  // --- 后台渐进评分：手动触发 ---
  if (pathname === '/api/score' && method === 'POST') {
    try {
      const result = await scoreLoop({ maxRounds: 40 });
      store.flush();
      return sendJson(res, 200, { ok: true, ...result });
    } catch (err) {
      return sendJson(res, 502, { ok: false, error: err.message });
    }
  }

  // --- 每日简报 ---
  if (pathname === '/api/digest' && method === 'POST') {
    const body = await readBody(req);
    try {
      const d = await digest.generate({
        hours: Math.max(1, Math.min(168, Number(body.hours) || 24)),
        useAi: body.useAi !== false,
      });
      store.flush();
      return sendJson(res, 200, { ok: true, digest: d });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  if (pathname === '/api/digest' && method === 'GET') {
    const file = query.get('file');
    if (file) {
      const d = digest.read(file);
      return d ? sendJson(res, 200, { ok: true, digest: d }) : sendJson(res, 404, { ok: false, error: '简报不存在' });
    }
    return sendJson(res, 200, { ok: true, digests: digest.list() });
  }

  if (pathname === '/api/ai/ask' && method === 'POST') {
    const body = await readBody(req);
    const cfg = loadConfig();
    const client = new AiClient(cfg.ai);
    if (!client.ready) return sendJson(res, 400, { ok: false, error: 'AI 未配置' });
    const question = String(body.question || '').slice(0, 2000);
    if (!question.trim()) return sendJson(res, 400, { ok: false, error: '问题不能为空' });
    try {
      const pool = store.queryItems({ pageSize: 12, sort: 'time' }).items;
      const result = await client.ask(question, pool, store.feedbackSamples({ limit: 10 }));
      store.recordAiUsage({ tokensIn: result.usage.tokensIn, tokensOut: result.usage.tokensOut, cost: result.usage.cost });
      return sendJson(res, 200, { ok: true, ...result });
    } catch (err) {
      return sendJson(res, 502, { ok: false, error: err.message });
    }
  }

  if (pathname === '/api/stats' && method === 'GET') {
    return sendJson(res, 200, store.getStats());
  }

  return sendJson(res, 404, { ok: false, error: '接口不存在: ' + pathname });
}

/* ------------------------------- server ------------------------------- */

function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const { pathname, searchParams } = url;

    try {
      // 安全守卫：拒绝非本机 Host（DNS rebinding）与跨站来源（CSRF）
      const blocked = guard(req);
      if (blocked) {
        res.writeHead(blocked.status, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(blocked.message);
        return;
      }

      if (pathname === '/api/proxy') {
        return await proxyImage(req, res, searchParams.get('url') || '');
      }
      if (pathname.startsWith('/api/')) {
        return await handleApi(req, res, pathname, searchParams);
      }
      return serveStatic(req, res, pathname);
    } catch (err) {
      console.error('[server] 未捕获错误:', err.message);
      if (!res.headersSent) {
        const status = err.statusCode || 500;
        sendJson(res, status, { ok: false, error: status === 500 ? '服务内部错误' : err.message });
      } else {
        res.end();
      }
    }
  });
}

function listen(port, { maxAttempts = 10 } = {}) {
  const server = createServer();
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryPort = (p) => {
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && attempt < maxAttempts) {
          attempt++;
          tryPort(p + 1);
        } else {
          reject(err);
        }
      });
      server.listen(p, '127.0.0.1', () => resolve({ server, port: p }));
    };
    tryPort(port);
  });
}

async function main() {
  store.load();
  const cfg = loadConfig();
  const { port } = await listen(Number(cfg.port) || 7788);

  const url = `http://127.0.0.1:${port}`;
  console.log('');
  console.log('  ┌────────────────────────────────────────────┐');
  console.log('  │  Content Radar · 内容雷达                  │');
  console.log(`  │  ${url.padEnd(42)}│`);
  console.log('  └────────────────────────────────────────────┘');
  console.log('  按 Ctrl+C 停止服务\n');

  // 可选：定时轮询
  const minutes = Number(cfg.fetch.intervalMinutes) || 0;
  if (minutes > 0) {
    const timer = setInterval(() => {
      runFetch().catch((err) => console.warn('[scheduler] 自动抓取失败:', err.message));
    }, minutes * 60 * 1000);
    timer.unref();
    console.log(`  已开启自动抓取：每 ${minutes} 分钟一次\n`);
  }

  const shutdown = () => {
    console.log('\n正在保存数据…');
    try {
      store.flush();
    } catch {}
    try {
      require('./sources/xiaoheihe').closeBrowser();
    } catch {}
    try {
      loginWindow.closeAll();
    } catch {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('启动失败:', err.message);
    process.exit(1);
  });
}

module.exports = { createServer, listen, handleApi };
