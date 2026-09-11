'use strict';

/**
 * 新功能测试：AI 摘要 / 每日简报 / B站关注动态
 * 运行：node --test test/features.test.js
 */

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

process.env.CONTENT_RADAR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'content-radar-feat-'));

const test = require('node:test');
const assert = require('node:assert');

const store = require('../src/store');
const { listen } = require('../src/server');
const { updateConfig } = require('../src/config');
const digest = require('../src/digest');
const bilibili = require('../src/sources/bilibili');

/** 起一个 mock 的 OpenAI 兼容接口 */
function startMock(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      handler(raw, res);
    });
    // 端口被占用等问题要立刻抛错，否则会一直挂着等不到 resolve
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const okReply = (content, usage = { prompt_tokens: 120, completion_tokens: 40 }) => (_, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ model: 'mock-model', choices: [{ message: { content } }], usage }));
};

const seed = (id, over = {}) => ({
  id,
  sourceId: 'seed-src',
  sourceType: 'rss',
  sourceName: '示例源',
  sourceMode: 'rss',
  title: '关于具身智能的一点思考',
  author: '某作者',
  authorId: '',
  cover: '',
  url: 'https://example.com/a',
  desc: '讨论了机器人本体与模型的关系。',
  stats: {},
  publishedAt: Date.now() - 3600 * 1000,
  fetchedAt: Date.now(),
  status: 'kept',
  starred: false,
  seen: false,
  ...over,
});

/* ------------------------------ AI 摘要 ------------------------------ */

test('AI 摘要接口：正常生成 / 条目不存在 404 / 未配置 400', { timeout: 60000 }, async (t) => {
  const { server: mock, port: mockPort } = await startMock(okReply('这是自动生成的摘要。'));
  const { server, port } = await listen(7980);
  t.after(() => {
    server.close();
    mock.close();
    store.flush();
  });

  store.load();
  store.upsertItems([seed('feat:summary')]);

  const call = async (body) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/items/summarize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json() };
  };

  // 1) 正常生成并缓存
  updateConfig({ ai: { enabled: true, baseUrl: `http://127.0.0.1:${mockPort}/v1`, apiKey: 'sk-test', model: 'mock-model' } });
  const before = store.getStats().stats.aiCalls;

  const ok = await call({ id: 'feat:summary' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.summary, '这是自动生成的摘要。');
  assert.equal(store.getItem('feat:summary').ai.summary, '这是自动生成的摘要。', '摘要应缓存到条目上');
  assert.equal(store.getStats().stats.aiCalls, before + 1, '应计入 AI 调用次数');

  // 2) 条目不存在
  const missing = await call({ id: '不存在的条目' });
  assert.equal(missing.status, 404);

  // 3) 未配置 AI
  updateConfig({ ai: { enabled: false, apiKey: '' } });
  const notReady = await call({ id: 'feat:summary' });
  assert.equal(notReady.status, 400);
});

/* ------------------------------ 每日简报 ------------------------------ */

test('每日简报：不启用 AI 也能生成，并落盘 markdown', { timeout: 60000 }, async (t) => {
  updateConfig({ ai: { enabled: false, apiKey: '' } });
  store.upsertItems([seed('feat:digest-1'), seed('feat:digest-2', { title: '另一条内容', sourceName: '另一个源' })]);

  const d = await digest.generate({ hours: 24, useAi: false });

  assert.ok(d.total >= 2, `应至少收录 2 条，实际 ${d.total}`);
  assert.equal(d.overview, '', '未启用 AI 时综述为空');
  assert.equal(d.aiSkipped, 'no-ai', '有内容但没启用 AI 时，应标记原因是 no-ai');
  assert.ok(d.bySource.length >= 1, '应有来源分布');
  assert.ok(d.files && fs.existsSync(d.files.markdown), '应写出 markdown 文件');

  const md = fs.readFileSync(d.files.markdown, 'utf8');
  assert.ok(md.includes('# 内容雷达简报'), 'markdown 应有标题');
  assert.ok(md.includes('关于具身智能的一点思考'), 'markdown 应包含条目');
  assert.ok(md.includes('（未启用 AI，以下为原始条目）'), '未启用 AI 时 markdown 应说清原因');

  const list = digest.list();
  assert.ok(list.length >= 1, '历史列表应包含刚生成的简报');
  assert.ok(digest.latest(), '应能取到最新简报');
});

test('每日简报：窗口内没有内容时，原因标为 no-items 而不是「未启用 AI」', { timeout: 60000 }, async (t) => {
  // AI 是配好的，只是这段时间没内容 —— 以前的版本会误报成「未启用 AI」
  const { server: mock, port: mockPort } = await startMock(okReply('不该被调用'));
  t.after(() => mock.close());
  updateConfig({ ai: { enabled: true, baseUrl: `http://127.0.0.1:${mockPort}/v1`, apiKey: 'sk-test', model: 'mock-model' } });

  // 时间窗口设为 0 小时（起点即此刻）→ 等价于「这段时间没有内容」
  const d = await digest.generate({ hours: 0, useAi: true });
  assert.equal(d.total, 0, '窗口内应没有条目');
  assert.equal(d.overview, '');
  assert.equal(d.aiSkipped, 'no-items', '没内容时应标记 no-items');

  const md = fs.readFileSync(d.files.markdown, 'utf8');
  assert.ok(md.includes('小时内没有筛选出的内容'), 'markdown 应说明是时间窗口内没内容');
  assert.ok(!md.includes('未启用 AI'), '不应再误报成未启用 AI');
});

test('每日简报：启用 AI 时写入综述', { timeout: 60000 }, async (t) => {
  const { server: mock, port: mockPort } = await startMock(okReply('## 综述\n今天最值得关注的是具身智能。'));
  t.after(() => mock.close());

  updateConfig({ ai: { enabled: true, baseUrl: `http://127.0.0.1:${mockPort}/v1`, apiKey: 'sk-test', model: 'mock-model' } });

  // 并发跑多个测试文件时偶发过「读到别的 mock 地址」导致误判，这里先确认配置真的写进去了
  const { loadConfig } = require('../src/config');
  assert.equal(
    loadConfig().ai.baseUrl,
    `http://127.0.0.1:${mockPort}/v1`,
    '刚写入的 AI 地址应立刻生效',
  );

  const d = await digest.generate({ hours: 24, useAi: true });
  assert.ok(d.overview.includes('具身智能'), `综述应来自 AI 返回，实际：${JSON.stringify(d.overview)} / aiError=${d.aiError || '无'}`);
  assert.equal(d.model, 'mock-model');
  assert.ok(d.cost > 0, '应记录成本');
});

/* --------------------------- B站关注动态 --------------------------- */

test('B站关注动态：未登录时给出明确提示', { timeout: 60000 }, async () => {
  updateConfig({ accounts: { bilibili: { cookie: '' } } });
  await assert.rejects(
    () => bilibili.fetchItems({ id: 'b', name: 'B站关注', options: { mode: 'following' } }, { timeoutMs: 20000, limit: 5 }),
    /需要登录/,
    '未登录应提示需要登录而不是抛出原始错误',
  );
});

test('B站关注动态：normalizeDynamic 解析视频动态', () => {
  const dyn = {
    id_str: '123456',
    modules: {
      module_author: { mid: 111, name: '某UP主', pub_ts: 1788955000 },
      module_dynamic: {
        major: {
          archive: {
            bvid: 'BV1xx411c7mD',
            title: '一条测试视频',
            cover: '//i0.hdslb.com/bfs/x.jpg',
            desc: '视频简介',
            stat: { play: 1234, danmaku: 56, like: 78, favorite: 9, coin: 10 },
          },
        },
      },
      module_stat: { comment: { count: 12 }, like: { count: 78 } },
    },
  };

  const it = bilibili._internal.normalizeDynamic(dyn, { id: 'b', name: 'B站关注' });
  assert.equal(it.id, 'bilibili:BV1xx411c7mD');
  assert.equal(it.title, '一条测试视频');
  assert.equal(it.author, '某UP主');
  assert.equal(it.stats.play, 1234);
  assert.equal(it.stats.danmaku, 56);
  assert.equal(it.stats.reply, 12);
  assert.equal(it.cover, 'https://i0.hdslb.com/bfs/x.jpg', '封面应补全协议');
  assert.equal(it.extra.bvid, 'BV1xx411c7mD');
  assert.equal(it.publishedAt, 1788955000 * 1000);
  assert.equal(it.url, 'https://www.bilibili.com/video/BV1xx411c7mD');
});

test('B站关注动态：normalizeDynamic 解析图文动态', () => {
  const dyn = {
    id_str: '654321',
    modules: {
      module_author: { mid: 222, name: 'UP乙', pub_ts: 1788956000 },
      module_dynamic: {
        desc: { text: '今天去了展会，随手拍了几张。' },
        major: { draw: { items: [{ src: '//i0.hdslb.com/bfs/pic.jpg' }] } },
      },
      module_stat: { comment: { count: 5 }, like: { count: 20 }, forward: { count: 2 } },
    },
  };

  const it = bilibili._internal.normalizeDynamic(dyn, { id: 'b', name: 'B站关注' });
  assert.equal(it.id, 'bilibili:dynamic:654321');
  assert.match(it.title, /展会/);
  assert.equal(it.cover, 'https://i0.hdslb.com/bfs/pic.jpg');
  assert.equal(it.stats.like, 20);
  assert.match(it.url, /t\.bilibili\.com\/654321/);
});

test('B站关注动态：空动态返回 null', () => {
  assert.equal(bilibili._internal.normalizeDynamic(null, { id: 'b', name: 'x' }), null);
  assert.equal(bilibili._internal.normalizeDynamic({ modules: {} }, { id: 'b', name: 'x' }), null);
});
