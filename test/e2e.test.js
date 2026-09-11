'use strict';

/**
 * 端到端测试：真实启动服务 + 真实抓取 B 站，验证完整链路。
 * 需要联网。单独运行：node --test test/e2e.test.js
 * （不放进 npm test 默认集，避免每次跑单元测试都触网）
 */

const os = require('os');
const fs = require('fs');
const path = require('path');

// 用独立临时数据目录：不污染真实数据，也保证测试可重复
process.env.CONTENT_RADAR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'content-radar-e2e-'));

const test = require('node:test');
const assert = require('node:assert');

const store = require('../src/store');
const { listen } = require('../src/server');
const { loadConfig, updateConfig } = require('../src/config');

const post = (base, path, body) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });

test('端到端：服务启动 → 真实抓取 → 列表 → 图片代理 → 收藏 → 关键词过滤 → 统计', async (t) => {
  store.load();
  const { server, port } = await listen(7788);
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await require('../src/sources/xiaoheihe').closeBrowser();
    server.close();
    store.flush();
  });

  // 1) 静态首页
  const home = await fetch(base + '/');
  const html = await home.text();
  assert.equal(home.status, 200, '首页应可访问');
  assert.ok(html.includes('id="feed"'), '首页应包含信息流容器');

  // 2) bootstrap
  const boot = await (await fetch(base + '/api/bootstrap')).json();
  assert.ok(boot.config.sources.length > 0, '默认配置应带数据源');
  assert.deepEqual(
    boot.adapters.map((a) => a.type).sort(),
    ['bilibili', 'rss', 'tieba', 'xiaoheihe'],
    '应注册 B站 / RSS / 贴吧 / 小黑盒 四个适配器',
  );

  // 3) 真实抓取
  const fetchRes = await (await post(base, '/api/fetch')).json();
  assert.equal(fetchRes.ok, true, '抓取接口应返回 ok');
  const rows = fetchRes.summary.sources;
  assert.ok(rows.length > 0, '应有抓取结果');
  const totalFetched = rows.reduce((a, r) => a + r.fetched, 0);
  assert.ok(totalFetched > 0, `真实抓取应至少拿到 1 条，实际 ${totalFetched}；明细：${JSON.stringify(rows)}`);
  const noError = rows.filter((r) => !r.error);
  assert.ok(noError.length > 0, '至少一个源应抓取成功');

  // 4) 列表与字段完整性
  const list = await (await fetch(base + '/api/items?pageSize=5&sort=hot')).json();
  assert.ok(list.total > 0, '信息池应有内容');
  const first = list.items[0];
  assert.ok(first.title, '条目应有标题');
  assert.ok(first.id.startsWith('bilibili:'), '条目 id 应带源前缀');
  assert.ok(typeof first.stats.play === 'number', '应有播放量数值');

  // 5) 图片代理
  const withCover = list.items.find((i) => i.cover);
  if (withCover) {
    const img = await fetch(base + '/api/proxy?url=' + encodeURIComponent(withCover.cover));
    assert.equal(img.status, 200, '图片代理应返回 200');
    assert.match(img.headers.get('content-type') || '', /^image\//, '代理应返回图片类型');
    assert.ok((await img.arrayBuffer()).byteLength > 1000, '图片应非空');
  }

  // 6) 收藏
  const star = await (await post(base, '/api/items/star', { id: first.id, value: true })).json();
  assert.equal(star.ok, true, '收藏应成功');
  const starred = await (await fetch(base + '/api/items?starred=1')).json();
  assert.equal(starred.total, 1, '收藏夹应有 1 条');

  // 7) 关键词过滤（临时改成不可能命中的词，再还原）
  const backup = loadConfig().keywords;
  const beforeStats = await (await fetch(base + '/api/stats')).json();
  updateConfig({ keywords: { any: ['绝对不存在的关键词xyz'], must: [], exclude: [], strict: true } });
  const reapply = await (await post(base, '/api/filters/reapply')).json();
  assert.ok(reapply.scanned > 0, '重新过滤应扫描到条目');
  const filtered = await (await fetch(base + '/api/items?status=filtered')).json();
  assert.equal(filtered.total, beforeStats.total, '全部条目都应被关键词剔除');

  updateConfig({ keywords: backup });
  await post(base, '/api/filters/reapply');
  const restored = await (await fetch(base + '/api/items')).json();
  assert.equal(restored.total, beforeStats.total, '清空关键词后内容应全部恢复可见');

  // 8) 统计
  const stats = await (await fetch(base + '/api/stats')).json();
  assert.equal(stats.total, list.total, '统计总数应与列表一致');
  assert.equal(stats.starred, 1, '统计收藏数应为 1');
  assert.ok(stats.bySource.length >= 1, '应有来源维度统计');

  console.log(
    `\n端到端结果：抓取 ${totalFetched} 条 / 入库 ${stats.total} 条 / 收藏 ${stats.starred} 条 / 来源 ${stats.bySource
      .map((s) => `${s.sourceName}=${s.total}`)
      .join(', ')}`,
  );
});
