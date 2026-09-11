'use strict';

/**
 * B站扫码登录
 *
 * 主路径（可靠）：用 Playwright 打开 B站登录页，把页面上的二维码截图给前端显示；
 * 用户扫码后直接读浏览器上下文里的 SESSDATA —— 不依赖响应头解析，
 * 绕开「登录成功却拿不到 Cookie」这类问题。
 *
 * 备用路径：官方扫码 API（generate + poll），保留给测试与快速校验。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');
const { request, getJson, sleep } = require('./http');

const DEBUG_LOG = path.join(DATA_DIR, 'qr-debug.log');

/** 把扫码链路的真实返回写进日志，方便排查「扫了没反应」这类问题 */
function logDebug(entry) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(DEBUG_LOG, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', 'utf8');
  } catch {}
}

/* ============================ 浏览器扫码（主路径） ============================ */

const LOGIN_URL = 'https://passport.bilibili.com/login';
const QR_SELECTOR = '.login-scan__qrcode';
const SESSION_TTL = 5 * 60 * 1000;

/** id -> session */
const sessions = new Map();

async function launchBrowser() {
  const { chromium } = require('playwright-core');
  let lastErr = null;
  for (const opts of [{ channel: 'msedge', headless: true }, { channel: 'chrome', headless: true }, { headless: true }]) {
    try {
      return await chromium.launch(opts);
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`无法启动浏览器（需要系统安装 Edge 或 Chrome）：${lastErr ? lastErr.message : ''}`);
}

/** 抓取二维码截图（base64 PNG） */
async function shotQr(page) {
  const el = await page.waitForSelector(QR_SELECTOR, { timeout: 30000 });
  return (await el.screenshot({ type: 'png' })).toString('base64');
}

function buildCookie(cookies) {
  const wanted = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid', 'buvid3', 'buvid4'];
  const map = new Map(cookies.map((c) => [c.name, c.value]));
  return wanted.filter((n) => map.get(n)).map((n) => `${n}=${map.get(n)}`).join('; ');
}

function publicView(s) {
  return { id: s.id, status: s.status, message: s.message, hasCookie: Boolean(s.cookie) };
}

/** 清掉过期会话 */
function reap() {
  for (const [id, s] of sessions) {
    if (Date.now() - s.startedAt > SESSION_TTL + 120000) {
      if (s.browser) s.browser.close().catch(() => {});
      sessions.delete(id);
    }
  }
}

/**
 * 开启一次扫码会话：打开登录页、截图二维码、后台盯着 Cookie
 * @returns {{id:string, image:string, message:string}}
 */
async function startSession({ timeoutMs = 45000 } = {}) {
  reap();

  const browser = await launchBrowser();
  const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1100, height: 760 } });
  const page = await ctx.newPage();

  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

  const id = crypto.randomUUID();
  const session = {
    id,
    status: 'waiting',
    message: '请用 B站 App 扫码',
    image: '',
    cookie: '',
    startedAt: Date.now(),
    browser,
    ctx,
    page,
  };

  try {
    session.image = await shotQr(page);
  } catch (err) {
    await browser.close().catch(() => {});
    logDebug({ phase: 'startSession', error: err.message });
    throw new Error('没能取到登录二维码，请改用「登录窗口」方式');
  }

  sessions.set(id, session);
  logDebug({ phase: 'startSession', id });

  // 后台轮询浏览器里的 Cookie
  (async () => {
    const deadline = Date.now() + SESSION_TTL;
    try {
      while (Date.now() < deadline && session.status === 'waiting' && !session.aborted) {
        await sleep(1500);
        if (session.aborted) break;
        const cookies = await ctx.cookies().catch(() => []);
        if (cookies.some((c) => c.name === 'SESSDATA' && c.value)) {
          session.cookie = buildCookie(cookies);
          session.status = 'success';
          session.message = '登录成功';
          logDebug({ phase: 'browserPoll', status: 'success', fields: session.cookie.split('; ').map((p) => p.split('=')[0]) });
          break;
        }
      }
      if (session.status === 'waiting') {
        session.status = 'timeout';
        session.message = '二维码已过期，请点「刷新二维码」';
      }
    } finally {
      await browser.close().catch(() => {});
      session.browser = null;
    }
  })();

  return { id, image: session.image, message: session.message };
}

function get(id) {
  const s = sessions.get(String(id || ''));
  return s ? publicView(s) : null;
}

/** 二维码过期时重新截图 */
async function refresh(id) {
  const s = sessions.get(String(id || ''));
  if (!s) throw new Error('扫码会话不存在或已结束');
  if (s.status !== 'waiting') return publicView(s);
  if (!s.page) throw new Error('浏览器已关闭，请重新扫码');
  s.image = await shotQr(s.page);
  return { ...publicView(s), image: s.image };
}

function takeCookie(id) {
  const s = sessions.get(String(id || ''));
  if (!s || s.status !== 'success' || !s.cookie) return null;
  return { platform: 'bilibili', cookie: s.cookie, nickname: '' };
}

function close(id) {
  const s = sessions.get(String(id || ''));
  if (!s) return false;
  s.aborted = true;
  if (s.browser) s.browser.close().catch(() => {});
  sessions.delete(id);
  return true;
}

async function closeAll() {
  for (const s of sessions.values()) {
    s.aborted = true;
    if (s.browser) await s.browser.close().catch(() => {});
  }
  sessions.clear();
}

/* ============================ 备用：官方扫码 API ============================ */

const HEADERS = {
  Referer: 'https://www.bilibili.com/',
  Origin: 'https://www.bilibili.com',
  Accept: 'application/json, text/plain, */*',
};

const WANTED_COOKIES = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid', 'buvid3', 'buvid4'];

/** 申请二维码（官方 API） */
async function generate({ timeoutMs = 15000 } = {}) {
  const json = await getJson('https://passport.bilibili.com/x/passport-login/web/qrcode/generate', {
    headers: HEADERS,
    timeoutMs,
  });
  if (!json || json.code !== 0 || !json.data || !json.data.qrcode_key) {
    throw new Error(`申请二维码失败：${(json && json.message) || '未知错误'}`);
  }
  return { key: json.data.qrcode_key, url: json.data.url };
}

/** 把二维码内容渲染成 SVG */
function toSvg(text, { size = 220, margin = 2 } = {}) {
  const qrcode = require('qrcode-generator');
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const cellSize = Math.max(2, Math.floor(size / (count + margin * 2)));
  return qr.createSvgTag({ cellSize, margin, scalable: true });
}

/** 从响应头里提取登录 Cookie */
function extractCookie(res) {
  const list = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const map = new Map();
  for (const raw of list) {
    const pair = String(raw).split(';')[0];
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (WANTED_COOKIES.includes(name) && value) map.set(name, value);
  }
  return WANTED_COOKIES.filter((n) => map.has(n))
    .map((n) => `${n}=${map.get(n)}`)
    .join('; ');
}

/** 轮询扫码状态（官方 API，备用路径） */
async function poll(key, { timeoutMs = 15000 } = {}) {
  if (!key) throw new Error('缺少 qrcode_key');

  const res = await request(
    `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(key)}`,
    { headers: HEADERS, timeoutMs, retries: 0, redirect: 'manual' },
  );
  const text = await res.text();
  const headerCookie = extractCookie(res);

  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    if (headerCookie && /SESSDATA=/.test(headerCookie)) {
      return { status: 'success', code: 0, message: '登录成功', cookie: headerCookie };
    }
    logDebug({ phase: 'poll', httpStatus: res.status, parseError: true, body: text.slice(0, 200) });
    throw new Error(`扫码状态返回异常（HTTP ${res.status}）`);
  }

  const data = json.data || {};
  const code = Number(data.code);
  const result = { code, message: data.message || '', status: 'waiting', cookie: '' };

  if (code === 86101) {
    result.message = '等待扫码';
  } else if (code === 86090) {
    result.status = 'scanned';
    result.message = '已扫码，请在手机上确认';
  } else if (code === 86038) {
    result.status = 'expired';
    result.message = '二维码已过期，请重新获取';
  } else if (code === 0) {
    result.status = 'success';
    result.message = '登录成功';
    result.cookie = headerCookie;
    if (!/SESSDATA=/.test(result.cookie)) {
      result.status = 'failed';
      result.message = '登录成功但没拿到 SESSDATA，请改用「登录窗口」方式';
    }
  } else {
    result.status = 'failed';
    result.message = data.message || `未知状态 ${code}`;
  }

  logDebug({
    phase: 'poll',
    httpStatus: res.status,
    code,
    status: result.status,
    setCookieCount: res.headers.getSetCookie ? res.headers.getSetCookie().length : -1,
    body: text.slice(0, 200),
  });

  return result;
}

module.exports = {
  // 主路径
  startSession,
  get,
  refresh,
  takeCookie,
  close,
  closeAll,
  // 备用 API 路径
  generate,
  poll,
  toSvg,
  extractCookie,
  WANTED_COOKIES,
  logDebug,
};
