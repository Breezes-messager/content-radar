'use strict';

/**
 * 真实数据源测试（需要联网；小黑盒还需要系统已安装 Edge/Chrome）
 * 运行：node --test test/sources.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { listAdapters } = require('../src/sources');
const tieba = require('../src/sources/tieba');
const xiaoheihe = require('../src/sources/xiaoheihe');

/* --------------------------- 注册表 --------------------------- */

test('适配器注册表包含 B站 / RSS / 贴吧 / 小黑盒', () => {
  const types = listAdapters().map((a) => a.type).sort();
  assert.deepEqual(types, ['bilibili', 'rss', 'tieba', 'xiaoheihe']);
});

/* --------------------------- 贴吧 --------------------------- */

const TIEBA_HTML = `<ul class="threads_list" id="frslistcontent">
  <li class="tl_top" data-tid="10314658010"><a href="/p/10314658010" class="j_common ti_item top"><div class="ti_title"><span class="ti_title_icon ti_icon_zhiding">置顶</span><span>置顶公告</span></div></a></li>
  <li class="tl_shadow" data-tid="8195539630"><div class="ti_infos"><div class="ti_author_time"><span class="ti_author">某吧友</span><span class="ti_time">19:59</span></div></div><a href="/p/8195539630" class="j_common ti_item"><div class="ti_title"><span>量子纠缠的直观解释</span></div><div class="ti_zan_reply"><span>12</span><span>3</span></div></a></li>
  <li class="tl_shadow" data-tid="11009340224"><div class="ti_infos"><div class="ti_author_time"><span class="ti_author">张三</span><span class="ti_time">9-8</span></div></div><a href="/p/11009340224" class="j_common ti_item"><div class="ti_title"><span class="ti_title_icon ti_icon_jing">精</span><span>黑洞热力学笔记</span></div></a></li>
</ul>`;

test('贴吧：解析 wap HTML（标题/作者/时间/回复数）', () => {
  const parsed = tieba._internal.parseForumHtml(TIEBA_HTML);
  assert.equal(parsed.length, 3, '应解析出 3 条');
  assert.equal(parsed[0].isTop, true, '第一条应识别为置顶');
  assert.equal(parsed[1].title, '量子纠缠的直观解释');
  assert.equal(parsed[1].author, '某吧友');
  assert.equal(parsed[1].reply, 12);
  assert.equal(parsed[1].like, 3);
  assert.equal(parsed[2].isGood, true, '第三条应识别为精品帖');
  assert.ok(parsed[1].publishedAt > 0, '时间应能解析');
});

test('贴吧：时间格式解析', () => {
  const t1 = tieba._internal.parseTiebaTime('19:59');
  const t2 = tieba._internal.parseTiebaTime('9-8');
  assert.ok(t1 > 0 && t2 > 0);
  assert.ok(t1 > t2, '今天的时刻应晚于 9-8');
  assert.equal(tieba._internal.parseTiebaTime(''), 0);
});

test('贴吧：真实抓取「理论物理吧」', { timeout: 60000 }, async () => {
  const items = await tieba.fetchItems(
    { id: 'tieba-live', name: '贴吧 · 理论物理吧', options: { mode: 'forum', kw: '理论物理' } },
    { timeoutMs: 25000, limit: 5 },
  );
  assert.ok(items.length > 0, '应抓到真实帖子');
  const first = items[0];
  assert.equal(first.sourceType, 'tieba');
  assert.ok(first.id.startsWith('tieba:'), 'id 应带源前缀');
  assert.ok(first.title.length > 0);
  assert.match(first.url, /^https:\/\/tieba\.baidu\.com\/p\/\d+$/);
  assert.ok(first.publishedAt > 0);
  console.log(`    贴吧样本：${first.title.slice(0, 30)} | ${first.author} | 回复=${first.stats.reply}`);
});

/* -------------------------- 小黑盒 -------------------------- */

test('小黑盒：真实抓取社区推荐流', { timeout: 180000 }, async (t) => {
  t.after(async () => {
    await xiaoheihe.closeBrowser();
  });

  const items = await xiaoheihe.fetchItems(
    { id: 'xhh-live', name: '小黑盒 · 社区推荐流', options: { mode: 'feed' } },
    { timeoutMs: 60000, limit: 5 },
  );
  assert.ok(items.length > 0, '应抓到真实帖子');
  const first = items[0];
  assert.equal(first.sourceType, 'xiaoheihe');
  assert.ok(first.id.startsWith('xiaoheihe:'), 'id 应带源前缀');
  assert.ok(first.title.length > 0);
  assert.match(first.url, /^https:\/\/www\.xiaoheihe\.cn\/app\/bbs\/link\/\d+$/);
  assert.ok(typeof first.stats.comment === 'number', '应有评论数');
  assert.ok(first.publishedAt > 0);
  console.log(
    `    小黑盒样本：${first.title.slice(0, 30)} | ${first.author} | 评论=${first.stats.comment} 赞=${first.stats.like}`,
  );

  // 第二次抓取应命中签名缓存，明显更快
  const t0 = Date.now();
  const again = await xiaoheihe.fetchItems(
    { id: 'xhh-live', name: '小黑盒 · 社区推荐流', options: { mode: 'feed' } },
    { timeoutMs: 30000, limit: 5 },
  );
  const cost = Date.now() - t0;
  assert.ok(again.length > 0, '缓存签名后仍应抓到内容');
  assert.ok(cost < 5000, `签名缓存后应快速返回，实际 ${cost}ms`);
  console.log(`    二次抓取耗时 ${cost}ms（命中签名缓存）`);
});
