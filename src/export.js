'use strict';

/**
 * 导出：收藏 / 信息池 / 数据源
 * 既通过 HTTP 下载，也落一份到 data/exports/ 方便找回。
 */

const fs = require('fs');
const path = require('path');

const { DATA_DIR, loadConfig } = require('./config');
const store = require('./store');

const EXPORT_DIR = path.join(DATA_DIR, 'exports');

const xmlEsc = (s = '') =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

/* ---------------------------- 各类型导出 ---------------------------- */

function buildFavorites() {
  const items = store.queryItems({ starred: true, pageSize: 10000 }).items;
  const lines = [
    `# 我的收藏 · ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    '',
    `共 ${items.length} 条`,
    '',
  ];

  for (const it of items) {
    lines.push(`## ${it.title}`, '');
    lines.push(`- 来源：${it.sourceName || '-'}`);
    if (it.author) lines.push(`- 作者：${it.author}`);
    if (it.url) lines.push(`- 链接：${it.url}`);
    if (it.publishedAt) lines.push(`- 时间：${new Date(it.publishedAt).toLocaleString('zh-CN', { hour12: false })}`);
    if (it.ai && typeof it.ai.score === 'number') lines.push(`- AI 评分：${it.ai.score}/10`);
    if (it.ai && it.ai.tags && it.ai.tags.length) lines.push(`- 标签：${it.ai.tags.join('、')}`);
    if (it.ai && it.ai.summary) lines.push('', `> ${it.ai.summary}`);
    lines.push('');
  }

  return { content: lines.join('\n'), count: items.length };
}

function buildItems() {
  const items = store.queryItems({ pageSize: 10000 }).items;
  return {
    content: JSON.stringify({ exportedAt: Date.now(), count: items.length, items }, null, 2),
    count: items.length,
  };
}

function buildSources() {
  const cfg = loadConfig();
  const rows = (cfg.sources || []).filter((s) => s.type === 'rss' && s.options && s.options.url);

  const body = rows
    .map(
      (s) =>
        `    <outline type="rss" text="${xmlEsc(s.name)}" title="${xmlEsc(s.name)}" xmlUrl="${xmlEsc(s.options.url)}" />`,
    )
    .join('\n');

  const content = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    '  <head>',
    '    <title>Content Radar 数据源</title>',
    `    <dateCreated>${new Date().toISOString()}</dateCreated>`,
    '  </head>',
    '  <body>',
    body,
    '  </body>',
    '</opml>',
    '',
  ].join('\n');

  return { content, count: rows.length };
}

const EXPORTERS = {
  favorites: { ext: 'md', mime: 'text/markdown; charset=utf-8', label: '收藏（Markdown）', build: buildFavorites },
  items: { ext: 'json', mime: 'application/json; charset=utf-8', label: '信息池（JSON）', build: buildItems },
  sources: { ext: 'opml', mime: 'text/xml; charset=utf-8', label: '数据源（OPML）', build: buildSources },
};

function listTypes() {
  return Object.entries(EXPORTERS).map(([type, e]) => ({ type, label: e.label, ext: e.ext }));
}

/**
 * 生成导出内容并落盘
 * @returns {{type:string, fileName:string, content:string, count:number, mime:string, file:string}}
 */
function build(type) {
  const exporter = EXPORTERS[type];
  if (!exporter) throw new Error(`不支持的导出类型：${type}`);

  const { content, count } = exporter.build();
  const stamp = new Date().toISOString().slice(0, 10);
  const fileName = `content-radar-${type}-${stamp}.${exporter.ext}`;

  let file = '';
  try {
    if (!fs.existsSync(EXPORT_DIR)) fs.mkdirSync(EXPORT_DIR, { recursive: true });
    file = path.join(EXPORT_DIR, fileName);
    fs.writeFileSync(file, content, 'utf8');
  } catch (err) {
    console.warn('[export] 落盘失败（仍可通过下载获取）:', err.message);
  }

  return { type, fileName, content, count, mime: exporter.mime, file };
}

module.exports = { build, listTypes, EXPORT_DIR, EXPORTERS };
