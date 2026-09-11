'use strict';

/**
 * 赞 / 踩 反馈测试（让 AI 学用户口味）
 * 运行：node --test test/feedback.test.js
 */

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.CONTENT_RADAR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'content-radar-feedback-'));

const test = require('node:test');
const assert = require('node:assert');

const store = require('../src/store');
const { listen } = require('../src/server');
const { buildMessages } = require('../src/ai');

const seed = (id, over = {}) => ({
  id,
  sourceId: 'fb-src',
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

test('反馈：写入赞、切换到踩、再点取消', () => {
  store.load();
  store.upsertItems([seed('fb:1'), seed('fb:2')]);

  let it = store.setFeedback('fb:1', 'up');
  assert.equal(it.feedback, 'up', '应记录为赞');
  assert.ok(it.feedbackAt > 0, '应记录反馈时间');

  it = store.setFeedback('fb:1', 'down');
  assert.equal(it.feedback, 'down', '再点是改成踩，而不是叠加');

  it = store.setFeedback('fb:1', null);
  assert.equal(it.feedback, null, '取消后应为空');
  assert.equal(it.feedbackAt, null, '取消后时间应清空');

  it = store.setFeedback('fb:1', '乱七八糟');
  assert.equal(it.feedback, null, '非法值按取消处理');

  assert.equal(store.setFeedback('不存在', 'up'), null, '条目不存在时返回 null');
});

test('反馈样本：按类型分开统计，且只取最近的 N 条', () => {
  store.load();
  const items = [];
  for (let i = 0; i < 12; i++) items.push(seed(`s:up:${i}`));
  for (let i = 0; i < 3; i++) items.push(seed(`s:down:${i}`));
  store.upsertItems(items);

  for (let i = 0; i < 12; i++) store.setFeedback(`s:up:${i}`, 'up');
  for (let i = 0; i < 3; i++) store.setFeedback(`s:down:${i}`, 'down');

  const s = store.feedbackSamples({ limit: 5 });
  assert.equal(s.upTotal, 12, '赞的总数应是全部，不受 limit 影响');
  assert.equal(s.downTotal, 3);
  assert.equal(s.up.length, 5, '样本按 limit 截断');
  assert.equal(s.down.length, 3);
  assert.ok(s.up[0].title.startsWith('标题 s:up:'), '样本应带标题供 AI 参考');
});

test('反馈注入 AI 提示词：赞与踩的标题都会出现', () => {
  const feedback = {
    up: [{ title: '深度解析 Rust 所有权', source: 'B站' }],
    down: [{ title: '明星八卦合集', source: '贴吧' }],
  };

  const without = buildMessages([{ title: '测试内容' }], '我喜欢编程');
  const withFb = buildMessages([{ title: '测试内容' }], '我喜欢编程', feedback);

  const plainUser = without[1].content;
  const fbUser = withFb[1].content;

  assert.ok(!plainUser.includes('点过赞'), '没有反馈时不应有反馈段落');
  assert.match(fbUser, /点过赞/, '应说明哪些点过赞');
  assert.match(fbUser, /深度解析 Rust 所有权/);
  assert.match(fbUser, /点过踩/);
  assert.match(fbUser, /明星八卦合集/);
  assert.match(fbUser, /我喜欢编程/, '原有兴趣描述应保留');

  // 空反馈不应产生多余段落
  const empty = buildMessages([{ title: 'x' }], 'i', { up: [], down: [] });
  assert.ok(!empty[1].content.includes('点过赞'), '空反馈不应注入段落');
});

test('统计里能看到赞 / 踩数量', () => {
  store.load();
  const s = store.getStats();
  assert.equal(typeof s.feedbackUp, 'number');
  assert.equal(typeof s.feedbackDown, 'number');
  assert.equal(s.feedbackUp, 12, '前面标了 12 个赞');
  assert.equal(s.feedbackDown, 3);
});

test('/api/items/feedback 接口：点赞返回计数，未知条目 404', { timeout: 60000 }, async (t) => {
  store.load();
  store.flush();
  const { server, port } = await listen(7997);
  t.after(() => {
    server.close();
    store.flush();
  });

  const post = (body) =>
    fetch(`http://127.0.0.1:${port}/api/items/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const ok = await post({ id: 's:up:0', value: 'down' });
  assert.equal(ok.status, 200);
  const data = await ok.json();
  assert.equal(data.ok, true);
  assert.equal(data.feedback, 'down', '应返回切换后的状态');
  assert.ok(data.upTotal >= 11, `应回传赞总数，实际 ${data.upTotal}`);
  assert.ok(data.downTotal >= 4, `应回传踩总数，实际 ${data.downTotal}`);

  const missing = await post({ id: '不存在', value: 'up' });
  assert.equal(missing.status, 404, '条目不存在应 404');

  // 落盘校验：重新加载后反馈还在
  store.flush();
  const raw = JSON.parse(fs.readFileSync(store.DB_PATH, 'utf8'));
  assert.equal(raw.items['s:up:0'].feedback, 'down', '反馈应已写入 db.json');
});
