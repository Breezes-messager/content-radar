'use strict';

/**
 * 导出功能 + 抓取事件测试
 * 运行：node --test test/export.test.js
 */

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.CONTENT_RADAR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'content-radar-export-'));

const test = require('node:test');
const assert = require('node:assert');

const store = require('../src/store');
const { listen } = require('../src/server');
const { updateConfig } = require('../src/config');
const exporter = require('../src/export');
const { events } = require('../src/pipeline');

const seed = (id, over = {}) => ({
  id,
  sourceId: 'exp-src',
  sourceType: 'rss',
  sourceName: '示例源',
  sourceMode: 'rss',
  title: '测试收藏标题',
  author: '某作者',
  authorId: '',
  cover: '',
  url: 'https://example.com/a',
  desc: '简介',
  stats: {},
  publishedAt: Date.now(),
  fetchedAt: Date.now(),
  status: 'kept',
  starred: false,
  seen: false,
  ...over,
});

test('导出类型列表包含三种', () => {
  const types = exporter.listTypes().map((t) => t.type);
  assert.deepEqual(types, ['favorites', 'items', 'sources']);
});

test('导出：收藏 Markdown 内容与落盘', () => {
  store.load();
  store.upsertItems([
    seed('exp:1', { starred: true, ai: { score: 8, tags: ['AI'], summary: '这是摘要' } }),
    seed('exp:2', { starred: false }),
  ]);

  const r = exporter.build('favorites');
  assert.equal(r.count, 1, '只导出收藏的条目');
  assert.match(r.content, /# 我的收藏/);
  assert.match(r.content, /测试收藏标题/);
  assert.match(r.content, /这是摘要/);
  assert.ok(fs.existsSync(r.file), '应落盘一份');
  assert.match(path.basename(r.file), /^content-radar-favorites-\d{4}-\d{2}-\d{2}\.md$/);
});

test('导出：信息池 JSON', () => {
  const r = exporter.build('items');
  const parsed = JSON.parse(r.content);
  assert.ok(Array.isArray(parsed.items));
  assert.ok(parsed.count >= 2, `应包含至少 2 条，实际 ${parsed.count}`);
  assert.equal(parsed.items[0].id.startsWith('exp:'), true);
});

test('导出：数据源 OPML 只含 RSS 源', () => {
  updateConfig({
    sources: [
      { id: 'rss-a', type: 'rss', name: '某订阅', enabled: true, options: { url: 'https://example.com/feed.xml' } },
      { id: 'bili-a', type: 'bilibili', name: 'B站源', enabled: true, options: { mode: 'ranking' } },
    ],
  });
  const r = exporter.build('sources');
  assert.equal(r.count, 1, '只导出 RSS 类型的源');
  assert.match(r.content, /<opml version="2.0">/);
  assert.match(r.content, /xmlUrl="https:\/\/example.com\/feed.xml"/);
  assert.ok(!r.content.includes('B站源'), '非 RSS 源不应出现在 OPML 里');
});

test('导出：未知类型报错', () => {
  assert.throws(() => exporter.build('nope'), /不支持的导出类型/);
});

test('/api/export 返回可下载文件', { timeout: 60000 }, async (t) => {
  store.load();
  const { server, port } = await listen(7988);
  t.after(() => {
    server.close();
    store.flush();
  });

  const res = await fetch(`http://127.0.0.1:${port}/api/export?type=favorites`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition') || '', /attachment; filename="content-radar-favorites-/);
  const text = await res.text();
  assert.match(text, /# 我的收藏/);

  const bad = await fetch(`http://127.0.0.1:${port}/api/export?type=nope`);
  assert.equal(bad.status, 400);
});

test('抓取事件：runFetch 结束后会 emit（供通知使用）', { timeout: 60000 }, async (t) => {
  updateConfig({
    sources: [{ id: 'rss-event', type: 'rss', name: '本地测试源', enabled: true, options: { url: '' } }],
    fetch: { perSourceLimit: 5 },
  });

  const seen = [];
  const onFetched = (summary) => seen.push(summary);
  events.on('fetched', onFetched);
  t.after(() => events.off('fetched', onFetched));

  const { runFetch } = require('../src/pipeline');
  await runFetch();

  assert.equal(seen.length, 1, '应收到一次 fetched 事件');
  assert.ok(Array.isArray(seen[0].sources), '事件里应带抓取摘要');
});
