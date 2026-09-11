'use strict';

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');

const DB_PATH = path.join(DATA_DIR, 'db.json');
const MAX_ITEMS = 5000; // 超出后按时间淘汰最旧的非收藏项

const emptyDb = () => ({
  version: 1,
  items: {}, // id -> item
  stats: {
    aiCalls: 0,
    aiTokensIn: 0,
    aiTokensOut: 0,
    aiCost: 0,
    aiFiltered: 0,
    fetchedTotal: 0,
  },
  meta: { lastFetchAt: null, lastFetchSummary: null },
});

let db = emptyDb();
let dirty = false;
let flushTimer = null;

function load() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_PATH)) {
    try {
      const raw = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
      db = { ...emptyDb(), ...raw, stats: { ...emptyDb().stats, ...(raw.stats || {}) } };
    } catch (err) {
      console.error('[store] db.json 损坏，已备份并重建:', err.message);
      try {
        fs.renameSync(DB_PATH, DB_PATH + '.corrupt-' + Date.now());
      } catch {}
      db = emptyDb();
    }
  }
  return db;
}

function flush() {
  if (!dirty) return;
  dirty = false;
  const tmp = DB_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db), 'utf8');
  fs.renameSync(tmp, DB_PATH);
}

function markDirty() {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    try {
      flush();
    } catch (err) {
      console.error('[store] 落盘失败:', err.message);
    }
  }, 500);
  if (flushTimer.unref) flushTimer.unref();
}

function itemsArray() {
  return Object.values(db.items);
}

function prune() {
  const all = itemsArray();
  if (all.length <= MAX_ITEMS) return;
  const removable = all
    .filter((it) => !it.starred)
    .sort((a, b) => (a.publishedAt || a.fetchedAt || 0) - (b.publishedAt || b.fetchedAt || 0));
  const overflow = all.length - MAX_ITEMS;
  for (let i = 0; i < overflow && i < removable.length; i++) delete db.items[removable[i].id];
}

/**
 * 写入抓取结果，按 id 去重。
 * 已存在的条目只补充“可变字段”（统计数据、更新时间），保留用户的 starred/seen 状态。
 */
function upsertItems(list) {
  let added = 0;
  let updated = 0;
  for (const incoming of list) {
    if (!incoming || !incoming.id) continue;
    const prev = db.items[incoming.id];
    if (!prev) {
      db.items[incoming.id] = incoming;
      added++;
    } else {
      db.items[incoming.id] = {
        ...prev,
        ...incoming,
        starred: prev.starred || incoming.starred || false,
        seen: prev.seen || incoming.seen || false,
        firstSeenAt: prev.firstSeenAt || incoming.firstSeenAt,
        ai: incoming.ai || prev.ai,
        status: incoming.status || prev.status,
      };
      updated++;
    }
  }
  db.stats.fetchedTotal += added;
  prune();
  markDirty();
  return { added, updated };
}

/** 区分新条目与已存在条目（AI 只对真正的新内容付费打分） */
function partitionNew(list) {
  const fresh = [];
  const existing = [];
  for (const it of list) (db.items[it.id] ? existing : fresh).push(it);
  return { fresh, existing };
}

function queryItems(opts = {}) {
  const {
    sourceId = '',
    status = '', // kept | filtered
    starred = false,
    q = '',
    sort = 'time', // time | hot | score
    page = 1,
    pageSize = 24,
  } = opts;

  const keyword = String(q).trim().toLowerCase();
  let list = itemsArray();

  if (sourceId) list = list.filter((it) => it.sourceId === sourceId);
  if (starred) list = list.filter((it) => it.starred);
  if (status === 'filtered') list = list.filter((it) => it.status === 'filtered');
  else if (status === 'kept') list = list.filter((it) => it.status !== 'filtered');
  else list = list.filter((it) => it.status !== 'filtered'); // 默认不显示被过滤的

  if (keyword) {
    list = list.filter((it) =>
      [it.title, it.author, it.desc, (it.ai && it.ai.tags ? it.ai.tags.join(' ') : '')]
        .join(' ')
        .toLowerCase()
        .includes(keyword),
    );
  }

  const sorters = {
    time: (a, b) => (b.publishedAt || b.fetchedAt || 0) - (a.publishedAt || a.fetchedAt || 0),
    hot: (a, b) => (b.stats && b.stats.play ? b.stats.play : 0) - (a.stats && a.stats.play ? a.stats.play : 0),
    score: (a, b) => ((b.ai && b.ai.score) || 0) - ((a.ai && a.ai.score) || 0),
  };
  list.sort(sorters[sort] || sorters.time);

  const total = list.length;
  const size = Math.max(1, Math.min(100, Number(pageSize) || 24));
  const p = Math.max(1, Number(page) || 1);
  return { total, page: p, pageSize: size, items: list.slice((p - 1) * size, p * size) };
}

function setStar(id, value) {
  const it = db.items[id];
  if (!it) return null;
  it.starred = Boolean(value);
  markDirty();
  return it;
}

function markSeen(id) {
  const it = db.items[id];
  if (!it) return null;
  it.seen = true;
  it.seenAt = Date.now();
  markDirty();
  return it;
}

function getItem(id) {
  return db.items[id] || null;
}

/** 写入 AI 摘要（保留已有的分数/标签） */
function setSummary(id, summary) {
  const it = db.items[id];
  if (!it) return null;
  it.ai = { ...(it.ai || {}), summary: String(summary || ''), summaryAt: Date.now() };
  markDirty();
  return it;
}

/** 取某个时间窗口内的条目（简报用），按发布时间倒序 */
function recentItems({ hours = 24, onlyKept = true, limit = 200 } = {}) {
  const since = Date.now() - hours * 3600 * 1000;
  return itemsArray()
    .filter((it) => (onlyKept ? it.status !== 'filtered' : true))
    .filter((it) => (it.publishedAt || it.fetchedAt || 0) >= since)
    .sort((a, b) => (b.publishedAt || b.fetchedAt || 0) - (a.publishedAt || a.fetchedAt || 0))
    .slice(0, limit);
}

function clearItems({ sourceId = '', onlyFiltered = false } = {}) {
  let removed = 0;
  for (const [id, it] of Object.entries(db.items)) {
    if (it.starred) continue;
    if (sourceId && it.sourceId !== sourceId) continue;
    if (onlyFiltered && it.status !== 'filtered') continue;
    delete db.items[id];
    removed++;
  }
  markDirty();
  return removed;
}

function recordAiUsage({ tokensIn = 0, tokensOut = 0, cost = 0, filtered = 0 }) {
  db.stats.aiCalls += 1;
  db.stats.aiTokensIn += tokensIn;
  db.stats.aiTokensOut += tokensOut;
  db.stats.aiCost += cost;
  db.stats.aiFiltered += filtered;
  markDirty();
}

function getStats() {
  const all = itemsArray();
  const bySource = {};
  for (const it of all) {
    const key = it.sourceId || 'unknown';
    bySource[key] = bySource[key] || { sourceId: key, sourceName: it.sourceName, total: 0, filtered: 0, today: 0 };
    bySource[key].total++;
    if (it.status === 'filtered') bySource[key].filtered++;
    if (it.fetchedAt && Date.now() - it.fetchedAt < 86400000) bySource[key].today++;
  }
  return {
    total: all.length,
    kept: all.filter((it) => it.status !== 'filtered').length,
    filtered: all.filter((it) => it.status === 'filtered').length,
    starred: all.filter((it) => it.starred).length,
    bySource: Object.values(bySource),
    stats: db.stats,
    meta: db.meta,
  };
}

function setFetchMeta(summary) {
  db.meta.lastFetchAt = Date.now();
  db.meta.lastFetchSummary = summary;
  markDirty();
}

module.exports = {
  load,
  flush,
  upsertItems,
  partitionNew,
  queryItems,
  setStar,
  markSeen,
  getItem,
  setSummary,
  recentItems,
  clearItems,
  recordAiUsage,
  getStats,
  setFetchMeta,
  DB_PATH,
  getRaw: () => db,
};
