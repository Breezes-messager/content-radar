'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { compileRules, applyKeywordRules, hasRules } = require('../src/filter/keyword');
const { parseFeed } = require('../src/sources/rss');
const { extractJson, estimateTokens } = require('../src/ai');
const { _internal } = require('../src/sources/bilibili');

/* ------------------------- 关键词过滤 ------------------------- */

const item = (over = {}) => ({
  title: '大模型推理优化实战',
  desc: '讲一讲 vLLM 的调度策略',
  author: '某某',
  sourceName: 'B站 · 搜索',
  ...over,
});

test('无规则时全部通过', () => {
  const rules = compileRules({});
  assert.equal(hasRules({}), false);
  assert.equal(applyKeywordRules(item(), rules).pass, true);
});

test('关注词命中任一即通过', () => {
  const rules = compileRules({ any: ['大模型', '具身智能'] });
  assert.equal(hasRules({ any: ['大模型'] }), true);
  assert.equal(applyKeywordRules(item(), rules).pass, true);
  assert.equal(applyKeywordRules(item({ title: '家常菜做法', desc: '红烧肉' }), rules).pass, false);
});

test('必须词缺一不可', () => {
  const rules = compileRules({ must: ['大模型', '推理'] });
  assert.equal(applyKeywordRules(item(), rules).pass, true);
  assert.equal(applyKeywordRules(item({ title: '大模型综述', desc: '概览' }), rules).pass, false);
});

test('排除词优先级最高', () => {
  // 宽松模式：简介里的排除词也会命中
  const loose = compileRules({ any: ['大模型'], exclude: ['广告'], strict: false });
  assert.equal(applyKeywordRules(item({ desc: '含广告内容' }), loose).pass, false);

  // 严格模式：只看标题
  const strict = compileRules({ any: ['大模型'], exclude: ['广告'], strict: true });
  assert.equal(applyKeywordRules(item({ title: '广告：大模型速成' }), strict).pass, false);
  assert.equal(applyKeywordRules(item({ desc: '含广告内容' }), strict).pass, true);
});

test('严格模式只看标题', () => {
  const strictRules = compileRules({ any: ['vLLM'], strict: true });
  assert.equal(applyKeywordRules(item(), strictRules).pass, false, '简介命中但标题没命中，应被拒');

  const looseRules = compileRules({ any: ['vLLM'], strict: false });
  assert.equal(applyKeywordRules(item(), looseRules).pass, true, '宽松模式下简介命中即可');
});

test('+ / ! 前缀写在 any 里也能识别', () => {
  const rules = compileRules({ any: ['+大模型', '!广告'] });
  assert.equal(rules.must.includes('大模型'), true);
  assert.equal(rules.exclude.includes('广告'), true);
});

/* --------------------------- RSS 解析 --------------------------- */

const RSS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>测试源</title>
  <item>
    <title><![CDATA[第一条 <b>标题</b>]]></title>
    <link>https://example.com/a</link>
    <description><![CDATA[<p>摘要 &amp; 内容</p>]]></description>
    <pubDate>Wed, 09 Sep 2026 10:00:00 GMT</pubDate>
    <author>作者A</author>
  </item>
  <item>
    <title>第二条</title>
    <link>https://example.com/b</link>
    <description>纯文本</description>
    <pubDate>Tue, 08 Sep 2026 10:00:00 GMT</pubDate>
  </item>
</channel></rss>`;

const ATOM_XML = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom 测试</title>
  <entry>
    <title>原子条目</title>
    <link rel="alternate" href="https://example.com/atom/1" />
    <summary>这是摘要</summary>
    <updated>2026-09-09T12:00:00Z</updated>
    <author><name>某人</name></author>
  </entry>
</feed>`;

test('解析 RSS 2.0', () => {
  const feed = parseFeed(RSS_XML);
  assert.equal(feed.kind, 'rss');
  assert.equal(feed.title, '测试源');
  assert.equal(feed.entries.length, 2);
  assert.equal(feed.entries[0].title, '第一条 标题');
  assert.equal(feed.entries[0].link, 'https://example.com/a');
  assert.equal(feed.entries[0].desc, '摘要 & 内容');
  assert.equal(feed.entries[0].author, '作者A');
  assert.ok(feed.entries[0].publishedAt > 0);
});

test('解析 Atom', () => {
  const feed = parseFeed(ATOM_XML);
  assert.equal(feed.kind, 'atom');
  assert.equal(feed.entries.length, 1);
  assert.equal(feed.entries[0].title, '原子条目');
  assert.equal(feed.entries[0].link, 'https://example.com/atom/1');
  assert.equal(feed.entries[0].author, '某人');
});

/* ----------------------------- AI 工具 ----------------------------- */

test('从模型输出里提取 JSON（含代码块）', () => {
  assert.deepEqual(extractJson('```json\n{"results":[]}\n```'), { results: [] });
  assert.deepEqual(extractJson('前言 {"a":1} 后话'), { a: 1 });
  assert.equal(extractJson('完全不是 JSON'), null);
});

test('token 估算对中文更敏感', () => {
  assert.ok(estimateTokens('你好世界') >= 4);
  assert.ok(estimateTokens('hello world') < estimateTokens('你好世界你好世界'));
});

/* --------------------------- WBI 签名 --------------------------- */

test('WBI 签名参数有序且带 w_rid', () => {
  const q = _internal.signQuery({ b: 2, a: 1 }, 'imgkey', 'subkey');
  assert.match(q, /a=1&b=2&wts=\d+&w_rid=[0-9a-f]{32}$/);
});

test('mixin key 固定长度 32', () => {
  assert.equal(_internal.mixinKey('a'.repeat(64), 'b'.repeat(64)).length, 32);
});
