'use strict';

/**
 * 每日简报：把一段时间窗口内筛选出的内容汇总成一份报告。
 * 有 AI 时生成一段综述，没有也能出（纯列表版）。
 * 产物写到 data/digests/ 下的 .json 与 .md。
 */

const fs = require('fs');
const path = require('path');

const { DATA_DIR, loadConfig } = require('./config');
const store = require('./store');
const { AiClient } = require('./ai');

const DIGEST_DIR = path.join(DATA_DIR, 'digests');

function ensureDir() {
  if (!fs.existsSync(DIGEST_DIR)) fs.mkdirSync(DIGEST_DIR, { recursive: true });
}

const fmtTime = (ts) => new Date(ts).toLocaleString('zh-CN', { hour12: false });

function toMarkdown(d) {
  const lines = [
    `# 内容雷达简报 · ${d.date}`,
    '',
    `生成时间：${fmtTime(d.generatedAt)}　覆盖：最近 ${d.hours} 小时，共 ${d.total} 条`,
    '',
  ];

  if (d.bySource && d.bySource.length) {
    lines.push('来源分布：' + d.bySource.map((s) => `${s.name} ${s.count}`).join(' · '), '');
  }

  if (d.overview) {
    lines.push('## 综述', '', d.overview, '');
  } else {
    lines.push('## 综述', '', '（未启用 AI 或没有可用内容，以下为原始条目）', '');
  }

  lines.push('## 条目', '');
  for (const it of d.items) {
    const meta = [it.sourceName, it.author].filter(Boolean).join(' · ');
    const score = typeof it.score === 'number' ? ` · AI ${it.score}/10` : '';
    lines.push(`- [${it.title}](${it.url})　—　${meta}${score}`);
    if (it.summary) lines.push(`  - ${it.summary}`);
  }
  lines.push('');

  return lines.join('\n');
}

function save(digest) {
  ensureDir();
  const base = `${digest.date}_${digest.generatedAt}`;
  const jsonPath = path.join(DIGEST_DIR, `${base}.json`);
  const mdPath = path.join(DIGEST_DIR, `${base}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(digest, null, 2), 'utf8');
  fs.writeFileSync(mdPath, toMarkdown(digest), 'utf8');
  digest.files = { json: jsonPath, markdown: mdPath };
  return digest;
}

/**
 * 生成一份简报
 * @param {{hours?:number, useAi?:boolean, limit?:number}} opts
 */
async function generate({ hours = 24, useAi = true, limit = 60 } = {}) {
  const items = store.recentItems({ hours, limit });

  const counts = new Map();
  for (const it of items) counts.set(it.sourceName || it.sourceId, (counts.get(it.sourceName || it.sourceId) || 0) + 1);

  const digest = {
    date: new Date().toISOString().slice(0, 10),
    generatedAt: Date.now(),
    hours,
    total: items.length,
    bySource: [...counts.entries()].map(([name, count]) => ({ name, count })),
    overview: '',
    items: items.map((it) => ({
      id: it.id,
      title: it.title,
      url: it.url,
      sourceName: it.sourceName,
      author: it.author,
      publishedAt: it.publishedAt,
      score: it.ai && typeof it.ai.score === 'number' ? it.ai.score : null,
      tags: (it.ai && it.ai.tags) || [],
      summary: (it.ai && it.ai.summary) || '',
    })),
    model: '',
    cost: 0,
  };

  const cfg = loadConfig();
  const client = new AiClient(cfg.ai);
  if (useAi && client.ready && items.length) {
    try {
      const r = await client.digest(items, { hours });
      digest.overview = r.overview;
      digest.model = r.usage.model;
      digest.cost = r.usage.cost;
      store.recordAiUsage({ tokensIn: r.usage.tokensIn, tokensOut: r.usage.tokensOut, cost: r.usage.cost });
    } catch (err) {
      digest.overview = '';
      digest.aiError = err.message;
      console.warn('[digest] AI 综述失败，回退为纯列表:', err.message);
    }
  }

  return save(digest);
}

/** 历史简报列表（不含正文，减少体积） */
function list() {
  ensureDir();
  return fs
    .readdirSync(DIGEST_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(DIGEST_DIR, f), 'utf8'));
        return { file: f, date: d.date, generatedAt: d.generatedAt, total: d.total, hasOverview: Boolean(d.overview) };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.generatedAt - a.generatedAt);
}

function read(file) {
  const safe = path.basename(String(file || ''));
  const full = path.join(DIGEST_DIR, safe);
  if (!full.startsWith(DIGEST_DIR) || !fs.existsSync(full)) return null;
  try {
    return JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch {
    return null;
  }
}

function latest() {
  const first = list()[0];
  return first ? read(first.file) : null;
}

module.exports = { generate, list, read, latest, toMarkdown, DIGEST_DIR };
