'use strict';

/**
 * 智能机制测试：漏斗统计 / 源产出率自适应 / 后台渐进评分 / 智能排序
 * 运行：node --test test/intel.test.js
 */

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

process.env.CONTENT_RADAR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'content-radar-intel-'));

const test = require('node:test');
const assert = require('node:assert');

const store = require('../src/store');
const { updateConfig, loadConfig } = require('../src/config');
const { scoreLoop } = require('../src/pipeline');

const seed = (id, over = {}) => ({
  id,
  sourceId: 'intel-src',
  sourceType: 'rss',
  sourceName: '示例源',
  sourceMode: 'rss',
  title: `标题 ${id}`,
  author: '某作者',
  authorId: '',
  cover: '',
  url: `https://example.com/${id}`,
  desc: '简介',
  stats: {},
  publishedAt: Date.now(),
  fetchedAt: Date.now(),
  status: 'kept',
  starred: false,
  seen: false,
  ...over,
});

function startMock(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      // 第三个参数给 req，方便按路径分流（前两个参数保持老签名不变）
      handler(raw, res, req);
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const okReply = (payload) => (_, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      model: 'mock-model',
      choices: [{ message: { content: JSON.stringify(payload) } }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    }),
  );
};

/* ------------------------------ 漏斗统计 ------------------------------ */

test('漏斗：跨天自动重置，计数按阶段累加', () => {
  store.load();
  store.bumpFunnel('fetched', 100);
  store.bumpFunnel('fetched', 20);
  store.bumpFunnel('dedup', 5);

  const f = store.getFunnel();
  assert.equal(f.counts.fetched, 120);
  assert.equal(f.counts.dedup, 5);
  assert.ok(f.labels.fetched, '应带中文标签给前端用');

  // 手动把日期改成昨天，模拟跨天
  const raw = store.getRaw();
  raw.funnel.day = '2000-01-01';
  const next = store.getFunnel();
  assert.equal(next.counts.fetched, undefined, '跨天后计数应清空');
  assert.notEqual(next.day, '2000-01-01');
});

/* --------------------------- 源产出率自适应 --------------------------- */

test('源产出率：按通过率 EMA 更新，低产源被跳过，跳多了会回升', () => {
  const raw = store.getRaw();
  raw.sourceYield = {};
  store.flush();

  // 第一次：直接等于本轮通过率
  const first = store.recordSourceYield('src:good', { fetched: 100, kept: 40 });
  assert.equal(first.yield, 0.4, '首次应直接取通过率');

  // 第二次：EMA 0.7 * 0.4 + 0.3 * 0.1 = 0.31
  const second = store.recordSourceYield('src:good', { fetched: 100, kept: 10 });
  assert.ok(Math.abs(second.yield - 0.31) < 1e-9, `EMA 应约 0.31，实际 ${second.yield}`);

  // 没统计过的源一律放行（冷启动）
  assert.equal(store.sourceYieldOk('src:unknown'), true, '未知源应放行');

  // 造一个烂源
  raw.sourceYield['src:bad'] = { fetched: 100, kept: 5, yield: 0.05, skips: 0, updatedAt: Date.now() };
  assert.equal(store.sourceYieldOk('src:bad'), false, '通过率低于 0.12 应被跳过');

  // 每跳过一次回升一档
  const before = raw.sourceYield['src:bad'].yield;
  store.markSourceSkipped('src:bad');
  assert.ok(raw.sourceYield['src:bad'].yield > before, '跳过时应回升，避免永久饿死');
  assert.equal(raw.sourceYield['src:bad'].skips, 1);

  // 连续跳过到上限后强制给机会
  raw.sourceYield['src:bad'].skips = store.SRC_YIELD_SKIP_LIMIT;
  raw.sourceYield['src:bad'].yield = 0.01;
  assert.equal(store.sourceYieldOk('src:bad'), true, '连续跳过达上限后应强制放行一次');

  // 统计快照
  const rows = store.sourceYieldStats();
  assert.ok(rows.find((r) => r.sourceId === 'src:good'), '快照应包含统计过的源');
  assert.equal(typeof rows[0].yield, 'number');
});

/* -------------------------- 后台渐进评分队列 -------------------------- */

test('评分队列：入队去重、peek 不删除、ack 出队', () => {
  store.load();
  store.upsertItems([seed('q:1'), seed('q:2'), seed('q:3')]);
  const raw = store.getRaw();
  raw.scoreQueue = [];

  assert.equal(store.enqueueScoring(['q:1', 'q:2', 'q:1']), 2, '重复 id 只入队一次');
  assert.equal(store.enqueueScoring(['q:3']), 1);
  assert.equal(store.scoringPending(), 3);

  const peeked = store.peekScoring(2);
  assert.equal(peeked.length, 2);
  assert.equal(store.scoringPending(), 3, 'peek 不应出队');

  store.ackScoring(['q:1']);
  assert.equal(store.scoringPending(), 2);

  // 不存在的 id 不应入队
  assert.equal(store.enqueueScoring(['不存在']), 0);
});

/* --------------------------- 后台评分 + 门禁 --------------------------- */

test('scoreLoop：多维打分写库、按门禁剔除、命中缓存不重复花钱', { timeout: 60000 }, async (t) => {
  const { server, port } = await startMock(
    okReply({
      results: [
        { i: 0, interest: 9, flame: 0, spam: 1, emo: 4, density: 8, tags: ['AI'], reason: '很相关' },
        { i: 1, interest: 8, flame: 1, spam: 9, emo: 2, density: 3, tags: [], reason: '带货文' },
        { i: 2, interest: 7, flame: 8, spam: 1, emo: -2, density: 5, tags: [], reason: '吵起来了' },
      ],
    }),
  );
  t.after(() => server.close());

  updateConfig({
    ai: { enabled: true, baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-test', model: 'mock-model', strictness: 'standard', scoreTtlHours: 24 },
  });

  store.load();
  store.upsertItems([seed('s:keep'), seed('s:spam'), seed('s:flame')]);
  const raw = store.getRaw();
  raw.scoreQueue = [];
  store.enqueueScoring(['s:keep', 's:spam', 's:flame']);

  const r = await scoreLoop();
  assert.equal(r.scored, 3, '三条都应被打分');
  assert.equal(r.pending, 0, '队列应清空');

  assert.equal(raw.items['s:keep'].status, 'kept', '正常内容保留');
  assert.equal(raw.items['s:keep'].ai.interest, 9);
  assert.equal(raw.items['s:keep'].ai.spam, 1);

  assert.equal(raw.items['s:spam'].status, 'filtered', '营销分 9 应被剔除');
  assert.match(raw.items['s:spam'].filterReason, /营销\/低质/);

  assert.equal(raw.items['s:flame'].status, 'filtered', '引战分 8 超过 standard 阈值 6');
  assert.match(raw.items['s:flame'].filterReason, /引战/);

  // 统计里能看到各阶段的剔除量
  const f = store.getFunnel();
  assert.equal(f.counts.aiSpam, 1);
  assert.equal(f.counts.aiFlame, 1);

  // 缓存：再入队一次，全部命中缓存，不应调用 AI
  const callsBefore = raw.stats.aiCalls;
  store.enqueueScoring(['s:keep']);
  const again = await scoreLoop();
  assert.equal(again.scored, 0, '缓存命中时不应重新打分');
  assert.equal(raw.stats.aiCalls, callsBefore, '不应产生新的 AI 调用');
  assert.equal(store.scoringPending(), 0);
});

/* ------------------------------ 智能排序 ------------------------------ */

test('智能排序：赞过的和喜欢的作者优先，踩过的沉底', () => {
  store.load();
  const raw = store.getRaw();
  raw.items = {};
  raw.scoreQueue = [];

  store.upsertItems([
    seed('o:a', { author: '大牛', title: '未读好文' }),
    seed('o:b', { author: '路人甲', title: '已读内容', seen: true }),
    seed('o:c', { author: '讨厌鬼', title: '踩过的作者发的' }),
    seed('o:d', { author: '路人乙', title: '我点过赞的', feedback: 'up', feedbackAt: Date.now() }),
    seed('o:e', { author: '大牛', title: '喜欢作者的旧文', seen: true }),
  ]);

  // 把「大牛」标成喜欢的作者（通过给它的条目点赞）
  const rawItems = store.getRaw().items;
  rawItems['o:a'].feedback = 'up';
  rawItems['o:a'].feedbackAt = Date.now();
  rawItems['o:c'].feedback = 'down';
  rawItems['o:c'].feedbackAt = Date.now();

  const order = store.queryItems({ sort: 'smart', pageSize: 10 }).items.map((it) => it.id);

  // o:a 和 o:d 都点过赞（同一优先级），谁在前取决于时间戳，只断言都在最前面
  assert.deepEqual([...order.slice(0, 2)].sort(), ['o:a', 'o:d'], '赞过的两条应排最前');
  assert.ok(order.indexOf('o:e') < order.indexOf('o:b'), '喜欢作者的旧文应排在普通已读之前');
  assert.equal(order[order.length - 1], 'o:c', '踩过的作者内容沉底');
  assert.ok(order.includes('o:b'), '所有条目都应在结果里');
});

test('智能排序：同级按兴趣分再按时间', () => {
  store.load();
  const raw = store.getRaw();
  raw.items = {};
  store.upsertItems([
    seed('n:low', { author: 'X', ai: { interest: 3, scoredAt: Date.now() } }),
    seed('n:high', { author: 'Y', ai: { interest: 9, scoredAt: Date.now() } }),
    seed('n:none', { author: 'Z' }),
  ]);

  const order = store.queryItems({ sort: 'smart', pageSize: 10 }).items.map((it) => it.id);
  assert.equal(order[0], 'n:high', '兴趣分高的在前');
  assert.equal(order[order.length - 1], 'n:none', '没打分的排最后');
});

test('runFetch：抓取路径不等 AI，新条目立即可见并进评分队列', { timeout: 60000 }, async (t) => {
  const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>t</title>
  <item><title>新条目甲</title><link>https://example.com/1</link><description>简介甲</description></item>
  <item><title>新条目乙</title><link>https://example.com/2</link><description>简介乙</description></item>
</channel></rss>`;

  // AI 故意慢 3 秒：如果抓取路径还在等它打分，runFetch 就会超时
  const { server: mock, port: mockPort } = await startMock((_, res, req) => {
    if (req && req.url && req.url.includes('/feed.xml')) {
      res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
      res.end(RSS);
      return;
    }
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          model: 'slow-model',
          choices: [
            {
              message: {
                content: JSON.stringify({
                  results: [{ i: 0, interest: 9, spam: 0, flame: 0, emo: 3, density: 7, tags: ['测试'], reason: '相关' }],
                }),
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10 },
        }),
      );
    }, 3000);
  });
  t.after(() => mock.close());

  const { runFetch } = require('../src/pipeline');
  updateConfig({
    ai: { enabled: true, baseUrl: `http://127.0.0.1:${mockPort}/v1`, apiKey: 'sk-test', model: 'mock-model', batchSize: 10 },
    sources: [
      { id: 'local-rss', type: 'rss', name: '本地 RSS', enabled: true, options: { url: `http://127.0.0.1:${mockPort}/feed.xml` } },
    ],
    keywords: { any: [], must: [], exclude: [], strict: true },
  });

  store.load();
  const raw = store.getRaw();
  raw.items = {};
  raw.scoreQueue = [];
  raw.sourceYield = {};

  const t0 = Date.now();
  const summary = await runFetch({ sourceId: 'local-rss' });
  const elapsed = Date.now() - t0;

  assert.ok(elapsed < 2500, `抓取不应等 AI 打分（AI 故意延迟 3 秒），实际耗时 ${elapsed}ms`);
  assert.equal(summary.queued, 2, '两条新内容应进评分队列');

  const row = summary.sources.find((s) => s.sourceId === 'local-rss');
  assert.equal(row.fetched, 2);
  assert.equal(row.new, 2);
  assert.equal(row.kept, 2);

  // 抓取返回时条目已经在池子里（还没打分）
  const inPool = store.queryItems({ pageSize: 10 }).items.filter((it) => it.sourceId === 'local-rss');
  assert.equal(inPool.length, 2, '新条目应立即可见');
  assert.ok(!inPool[0].ai, '此时还没轮到打分');

  // 源产出率也记上了
  const y = store.sourceYieldStats().find((x) => x.sourceId === 'local-rss');
  assert.ok(y && y.yield === 1, '2 条全存活，通过率应是 100%');

  // 漏斗也记了
  const f = store.getFunnel();
  assert.equal(f.counts.fetched, 2);
  assert.equal(f.counts.kept, 2);
});
