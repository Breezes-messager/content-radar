'use strict';

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');

const DB_PATH = path.join(DATA_DIR, 'db.json');
const MAX_ITEMS = 5000; // 超出后按时间淘汰最旧的非收藏项

// 源产出率自适应（借鉴 Mirror-Sorter）：按「抓回 → 存活」通过率动态降权差源
const SRC_YIELD_MIN = 0.12; // 通过率低于此值的源会被跳过
const SRC_YIELD_DECAY = 0.7; // 指数移动平均：旧值权重
const SRC_YIELD_RECOVER = 0.15; // 每被跳过一轮的回升幅度（防永久饿死）
const SRC_YIELD_SKIP_LIMIT = 3; // 连续跳过这么多轮后强制给一次机会

const FUNNEL_LABELS = {
  fetched: '抓回候选',
  keyword: '关键词拦下',
  dedup: '重复标题',
  aiSpam: '营销/低质',
  aiFlame: '引战',
  aiEmo: '情绪过负',
  aiInterest: '兴趣不符',
  kept: '最终入池',
};

const todayKey = () => new Date().toISOString().slice(0, 10);

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
    scoredTotal: 0,
  },
  meta: { lastFetchAt: null, lastFetchSummary: null },
  funnel: { day: '', counts: {} }, // 漏斗统计，按天重置
  sourceYield: {}, // sourceId -> { fetched, kept, yield, skips, updatedAt }
  scoreQueue: [], // 待打分的条目 id（后台渐进评分用）
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
      // 老版本 db.json 没有这些字段，补齐结构
      if (!db.funnel || !db.funnel.counts) db.funnel = { day: '', counts: {} };
      if (!db.sourceYield || typeof db.sourceYield !== 'object') db.sourceYield = {};
      if (!Array.isArray(db.scoreQueue)) db.scoreQueue = [];
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

  if (sort === 'smart') {
    // 智能排序（借鉴 Mirror-Sorter 的显式加权元组）：
    // 自己赞过 → 喜欢的作者 → 未读 → 已读；踩过的作者/内容沉底；同级按兴趣分，再按时间
    const fb = feedbackSamples({ limit: 0 });
    const likedAuthors = new Set(fb.upAuthors.map((a) => a.name));
    const dislikedAuthors = new Set(fb.downAuthors.map((a) => a.name));

    const rankOf = (it) => {
      if (it.feedback === 'down' || (it.author && dislikedAuthors.has(it.author))) return 9;
      if (it.feedback === 'up') return 0;
      if (it.author && likedAuthors.has(it.author)) return 1;
      return it.seen ? 3 : 2;
    };

    list.sort((a, b) => {
      const ra = rankOf(a);
      const rb = rankOf(b);
      if (ra !== rb) return ra - rb;
      const sa = (a.ai && a.ai.interest) || 0;
      const sb = (b.ai && b.ai.interest) || 0;
      if (sa !== sb) return sb - sa;
      return (b.publishedAt || b.fetchedAt || 0) - (a.publishedAt || a.fetchedAt || 0);
    });
  } else {
    list.sort(sorters[sort] || sorters.time);
  }

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

/* ---------------------------- 漏斗统计 ---------------------------- */

/** 记一笔漏斗事件（跨天自动重置） */
function bumpFunnel(key, n = 1) {
  if (!n) return;
  const day = todayKey();
  if (db.funnel.day !== day) db.funnel = { day, counts: {} };
  db.funnel.counts[key] = (db.funnel.counts[key] || 0) + n;
  markDirty();
}

/** 漏斗快照：按顺序返回每个阶段的计数，前端一行展示 */
function getFunnel() {
  const day = todayKey();
  const counts = db.funnel.day === day ? { ...db.funnel.counts } : {};
  return { day, labels: FUNNEL_LABELS, counts };
}

/* -------------------------- 源产出率自适应 -------------------------- */

/**
 * 抓取结束后记录某个源的「抓回 → 存活」通过率
 * 用指数移动平均，近期表现权重更高（0.3）
 */
function recordSourceYield(sourceId, { fetched = 0, kept = 0 } = {}) {
  if (!sourceId || !fetched) return null;
  const row = db.sourceYield[sourceId] || { fetched: 0, kept: 0, yield: 0, skips: 0, updatedAt: 0 };
  const rate = kept / fetched;
  row.yield = row.updatedAt ? SRC_YIELD_DECAY * row.yield + (1 - SRC_YIELD_DECAY) * rate : rate;
  row.fetched += fetched;
  row.kept += kept;
  row.skips = 0;
  row.updatedAt = Date.now();
  db.sourceYield[sourceId] = row;
  markDirty();
  return row;
}

/** 这个源这轮值不值得抓？没统计过的源一律放行（给冷启动机会） */
function sourceYieldOk(sourceId) {
  const row = db.sourceYield[sourceId];
  if (!row || !row.updatedAt) return true;
  if (row.skips >= SRC_YIELD_SKIP_LIMIT) return true; // 连续跳过太多次，强制给一次机会
  return row.yield >= SRC_YIELD_MIN;
}

/** 记一次「因产出率低被跳过」，同时让通过率回升一档（防永久饿死） */
function markSourceSkipped(sourceId) {
  const row = db.sourceYield[sourceId];
  if (!row) return null;
  row.skips = (row.skips || 0) + 1;
  row.yield += (1 - row.yield) * SRC_YIELD_RECOVER;
  markDirty();
  return row;
}

/** 各源产出率快照（数据源面板展示用） */
function sourceYieldStats() {
  return Object.entries(db.sourceYield).map(([sourceId, r]) => ({
    sourceId,
    fetched: r.fetched,
    kept: r.kept,
    yield: Number((r.yield || 0).toFixed(3)),
    throttled: r.updatedAt > 0 && r.yield < SRC_YIELD_MIN && r.skips < SRC_YIELD_SKIP_LIMIT,
  }));
}

/* ------------------------ 后台渐进评分队列 ------------------------ */

/** 把待打分的条目塞进队列（去重） */
function enqueueScoring(ids = []) {
  const set = new Set(db.scoreQueue);
  let added = 0;
  for (const id of ids) {
    if (!db.items[id] || set.has(id)) continue;
    set.add(id);
    added++;
  }
  db.scoreQueue = [...set];
  if (added) markDirty();
  return added;
}

/** 取一批待打分的条目（不删除，打分成功后再 ack） */
function peekScoring(limit = 15) {
  return db.scoreQueue.slice(0, limit).map((id) => db.items[id]).filter((it) => it && it.status !== 'filtered');
}

/** 确认这批已处理完（无论成功失败都出队，避免卡住） */
function ackScoring(ids = []) {
  const set = new Set(ids);
  const before = db.scoreQueue.length;
  db.scoreQueue = db.scoreQueue.filter((id) => !set.has(id));
  if (db.scoreQueue.length !== before) markDirty();
  return before - db.scoreQueue.length;
}

function scoringPending() {
  return db.scoreQueue.length;
}

/** 写入 AI 摘要（保留已有的分数/标签） */
function setSummary(id, summary) {
  const it = db.items[id];
  if (!it) return null;
  it.ai = { ...(it.ai || {}), summary: String(summary || ''), summaryAt: Date.now() };
  markDirty();
  return it;
}

/**
 * 用户反馈：赞成 / 反对
 * 这是让 AI 了解你口味的主要信号——会作为样本注入打分提示词。
 */
function setFeedback(id, value) {
  const it = db.items[id];
  if (!it) return null;
  const next = value === 'up' || value === 'down' ? value : null;
  it.feedback = next;
  it.feedbackAt = next ? Date.now() : null;
  markDirty();
  return it;
}

/** 取最近的赞/踩样本（供 AI 校准打分）——除了标题，还按作者聚合（借鉴 Mirror-Sorter） */
function feedbackSamples({ limit = 10, authorLimit = 5 } = {}) {
  const picked = itemsArray().filter((it) => it.feedback === 'up' || it.feedback === 'down');
  const byTime = (a, b) => (b.feedbackAt || 0) - (a.feedbackAt || 0);
  const brief = (it) => ({ title: it.title, source: it.sourceName || '' });

  // 作者维度的偏好信号：比单个标题更稳，也更能泛化
  const tally = (kind) => {
    const m = new Map();
    for (const it of picked) {
      if (it.feedback !== kind) continue;
      const name = (it.author || '').trim();
      if (!name || name === '-') continue;
      m.set(name, (m.get(name) || 0) + 1);
    }
    return [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, authorLimit)
      .map(([name, n]) => ({ name, count: n }));
  };

  return {
    up: picked.filter((it) => it.feedback === 'up').sort(byTime).slice(0, limit).map(brief),
    down: picked.filter((it) => it.feedback === 'down').sort(byTime).slice(0, limit).map(brief),
    upAuthors: tally('up'),
    downAuthors: tally('down'),
    upTotal: picked.filter((it) => it.feedback === 'up').length,
    downTotal: picked.filter((it) => it.feedback === 'down').length,
  };
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
    feedbackUp: all.filter((it) => it.feedback === 'up').length,
    feedbackDown: all.filter((it) => it.feedback === 'down').length,
    scoringPending: db.scoreQueue.length,
    funnel: getFunnel(),
    sourceYield: sourceYieldStats(),
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
  setFeedback,
  feedbackSamples,
  recentItems,
  clearItems,
  recordAiUsage,
  getStats,
  setFetchMeta,
  bumpFunnel,
  getFunnel,
  recordSourceYield,
  sourceYieldOk,
  markSourceSkipped,
  sourceYieldStats,
  enqueueScoring,
  peekScoring,
  ackScoring,
  scoringPending,
  SRC_YIELD_MIN,
  SRC_YIELD_SKIP_LIMIT,
  FUNNEL_LABELS,
  DB_PATH,
  getRaw: () => db,
};
