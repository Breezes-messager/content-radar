'use strict';

/**
 * 抓取流水线：拉取 → 归一化 → 关键词过滤 → 入库 → 后台渐进 AI 打分
 *
 * 抓取路径不再等待 AI（借鉴 Mirror-Sorter）：新条目先进池子立即可见，
 * 打分交给后台逐批补，避免「点抓取卡半天才出内容」。
 */

const { EventEmitter } = require('events');
const { loadConfig } = require('./config');
const store = require('./store');
const { fetchFromSource } = require('./sources');
const { compileRules, applyKeywordRules, hasRules } = require('./filter/keyword');
const { AiClient, judge } = require('./ai');

/** 抓取事件（Electron 主进程监听它来弹新内容通知） */
const events = new EventEmitter();

let running = null;
let scoring = false;

/** 简单并发池 */
async function mapLimit(list, limit, worker) {
  const results = new Array(list.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (cursor < list.length) {
      const i = cursor++;
      results[i] = await worker(list[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

const batchSizeOf = (cfg) => Math.max(1, Math.min(30, cfg.ai.batchSize || 10));

/**
 * 把 AI 裁决写进条目（抓取路径与后台评分共用）
 * 多维门禁：营销低质 / 引战 / 情绪过负 / 兴趣不足
 */
function applyVerdicts(batch, results, usage, cfg) {
  let filteredNow = 0;
  batch.forEach((item, idx) => {
    const v = results.get(idx);
    if (!v) return;
    const gate = judge(v, { strictness: cfg.ai.strictness, minScore: cfg.ai.minScore });
    item.ai = {
      score: v.interest,
      interest: v.interest,
      flame: v.flame,
      spam: v.spam,
      emo: v.emo,
      density: v.density,
      tags: v.tags,
      reason: v.reason,
      model: usage.model,
      scoredAt: Date.now(),
    };
    if (!gate.keep) {
      item.status = 'filtered';
      item.filterStage = 'ai';
      item.filterReason = `AI：${gate.why}${v.reason ? `｜${v.reason}` : ''}`;
      filteredNow++;
      store.bumpFunnel(gate.stage);
    }
  });
  return filteredNow;
}

async function runFetch({ sourceId = '', useAi = null } = {}) {
  if (running) return running;
  running = (async () => {
    const cfg = loadConfig();
    const rules = compileRules(cfg.keywords);
    const keywordsActive = hasRules(cfg.keywords);
    const wantAi = useAi === null ? cfg.ai.enabled : Boolean(useAi);
    const ai = new AiClient(cfg.ai);
    const aiEnabled = wantAi && ai.ready;

    const all = cfg.sources.filter((s) => s.enabled && (!sourceId || s.id === sourceId));
    if (!all.length) {
      const summary = { at: Date.now(), sources: [], note: sourceId ? `未找到启用的源 ${sourceId}` : '没有启用的数据源' };
      store.setFetchMeta(summary);
      return summary;
    }

    // 源产出率自适应：通过率太低的源本轮跳过（指定了具体源时不跳过，尊重手动意图）
    const sources = [];
    const throttled = [];
    for (const s of all) {
      if (!sourceId && !store.sourceYieldOk(s.id)) {
        store.markSourceSkipped(s.id);
        throttled.push({ sourceId: s.id, sourceName: s.name });
      } else {
        sources.push(s);
      }
    }

    const perSource = [];

    await mapLimit(sources, 2, async (source) => {
      const row = {
        sourceId: source.id,
        sourceName: source.name,
        fetched: 0,
        new: 0,
        keywordFiltered: 0,
        dedup: 0,
        queued: 0,
        kept: 0,
        error: null,
      };
      try {
        const raw = await fetchFromSource(source, {
          timeoutMs: cfg.fetch.timeoutMs,
          limit: cfg.fetch.perSourceLimit,
        });
        row.fetched = raw.length;
        store.bumpFunnel('fetched', raw.length);

        // 1) 关键词过滤
        const afterKeyword = [];
        for (const item of raw) {
          if (keywordsActive) {
            const verdict = applyKeywordRules(item, rules);
            if (!verdict.pass) {
              item.status = 'filtered';
              item.filterStage = 'keyword';
              item.filterReason = verdict.reason;
              row.keywordFiltered++;
              afterKeyword.push(item); // 仍然入库，方便在“已过滤”里回看
              continue;
            }
            item.filterReason = verdict.reason;
          }
          item.status = 'kept';
          afterKeyword.push(item);
        }
        store.bumpFunnel('keyword', row.keywordFiltered);

        // 2) 去重：同一批里已经存在的算重复
        const { fresh, existing } = store.partitionNew(afterKeyword);
        row.dedup = existing.length;
        store.bumpFunnel('dedup', row.dedup);

        // 3) 先入库 —— 不让 AI 拖住首屏
        const { added } = store.upsertItems(afterKeyword);
        row.new = added;
        row.kept = afterKeyword.filter((it) => it.status !== 'filtered').length;
        store.bumpFunnel('kept', row.kept);

        // 4) 新条目排进后台评分队列
        if (aiEnabled) {
          const ids = fresh.filter((it) => it.status !== 'filtered').map((it) => it.id);
          row.queued = store.enqueueScoring(ids);
        }

        // 5) 记录这个源的产出率，供下一轮决定要不要跳过
        store.recordSourceYield(source.id, { fetched: raw.length, kept: row.kept });
      } catch (err) {
        row.error = err.message;
        console.warn(`[pipeline] 源 ${source.name} 抓取失败: ${err.message}`);
      }
      perSource.push(row);
    });

    const order = new Map(cfg.sources.map((s, i) => [s.id, i]));
    const summary = {
      at: Date.now(),
      aiEnabled,
      keywordRules: keywordsActive,
      queued: perSource.reduce((acc, r) => acc + r.queued, 0),
      throttled,
      sources: perSource.sort((a, b) => (order.get(a.sourceId) ?? 99) - (order.get(b.sourceId) ?? 99)),
    };
    store.setFetchMeta(summary);
    store.flush();
    // 供 Electron 主进程监听（用于新内容通知）
    events.emit('fetched', summary);

    // 6) 后台补分，不阻塞返回
    if (aiEnabled && summary.queued) {
      scoreLoop().catch((err) => console.warn('[pipeline] 后台评分异常:', err.message));
    }

    return summary;
  })();

  try {
    return await running;
  } finally {
    running = null;
  }
}

/**
 * 后台渐进评分：从队列里逐批取，打完写库
 * - 命中缓存（scoreTtlHours 内已打过分）直接出队跳过
 * - 出错就停，避免刷爆 API
 */
async function scoreLoop({ maxRounds = 20 } = {}) {
  if (scoring) return { scored: 0, skipped: '已有评分任务在跑' };
  scoring = true;

  let scored = 0;
  let filtered = 0;
  let cost = 0;
  try {
    const cfg = loadConfig();
    const ai = new AiClient(cfg.ai);
    if (!ai.ready) return { scored: 0, skipped: 'AI 未配置' };

    const ttl = Math.max(0, Number(cfg.ai.scoreTtlHours ?? 24)) * 3600 * 1000;
    const feedback = store.feedbackSamples({ limit: 10 });
    const size = batchSizeOf(cfg);

    for (let round = 0; round < maxRounds; round++) {
      const peeked = store.peekScoring(size);
      if (!peeked.length) break;

      // 缓存命中：这段时间内打过分的不重复花钱
      const now = Date.now();
      const stale = [];
      const fresh = [];
      for (const it of peeked) {
        const at = it.ai && it.ai.scoredAt;
        if (at && ttl > 0 && now - at < ttl) stale.push(it.id);
        else fresh.push(it);
      }
      if (stale.length) store.ackScoring(stale);
      if (!fresh.length) continue;

      try {
        const { results, usage } = await ai.scoreBatch(fresh, feedback);
        const filteredNow = applyVerdicts(fresh, results, usage, cfg);
        store.recordAiUsage({
          tokensIn: usage.tokensIn,
          tokensOut: usage.tokensOut,
          cost: usage.cost,
          filtered: filteredNow,
        });
        store.ackScoring(fresh.map((it) => it.id));
        store.flush();

        scored += fresh.length;
        filtered += filteredNow;
        cost += usage.cost;
        events.emit('scored', { count: fresh.length, filtered: filteredNow, pending: store.scoringPending() });
      } catch (err) {
        console.warn(`[pipeline] 后台评分失败，剩余 ${store.scoringPending()} 条下次再试: ${err.message}`);
        break;
      }
    }
  } finally {
    scoring = false;
  }

  const result = { scored, filtered, cost, pending: store.scoringPending() };
  if (scored) events.emit('scoring-done', result);
  return result;
}

/** 对已入库的历史条目重新跑一遍过滤（改了关键词/AI 配置后使用） */
async function reapplyFilters() {
  const cfg = loadConfig();
  const rules = compileRules(cfg.keywords);
  const keywordsActive = hasRules(cfg.keywords);
  const ai = new AiClient(cfg.ai);
  const db = store.getRaw();
  const all = Object.values(db.items);
  let changed = 0;

  const aiReady = Boolean(cfg.ai.enabled && ai.ready);
  for (const item of all) {
    if (keywordsActive) {
      const verdict = applyKeywordRules(item, rules);
      const nextStatus = verdict.pass ? 'kept' : 'filtered';
      const nextStage = verdict.pass ? null : 'keyword';
      if (item.status !== nextStatus || item.filterReason !== verdict.reason) {
        item.status = nextStatus;
        item.filterStage = nextStage;
        item.filterReason = verdict.reason;
        changed++;
      }
    } else if (item.filterStage === 'keyword') {
      // 关键词规则被清空：把之前因关键词剔除的条目放回信息池
      item.status = 'kept';
      item.filterStage = null;
      item.filterReason = '';
      changed++;
    }

    // AI 关闭时，之前被 AI 剔除的条目同样放回
    if (!aiReady && item.filterStage === 'ai') {
      item.status = 'kept';
      item.filterStage = null;
      item.filterReason = '';
      changed++;
    }
  }

  // AI 打开时，把还没打过分（或分数过期）的条目重新排进队列，由后台慢慢补
  if (aiReady) {
    const ttl = Math.max(0, Number(cfg.ai.scoreTtlHours ?? 24)) * 3600 * 1000;
    const now = Date.now();
    const needScore = all
      .filter((it) => it.status !== 'filtered')
      .filter((it) => !it.ai || typeof it.ai.interest !== 'number' || ttl === 0 || now - (it.ai.scoredAt || 0) >= ttl);
    store.enqueueScoring(needScore.map((it) => it.id));
  }

  store.flush();
  const queued = store.scoringPending();
  if (aiReady && queued) scoreLoop().catch((err) => console.warn('[pipeline] 后台评分异常:', err.message));
  return { changed, scanned: all.length, queued };
}

module.exports = { runFetch, scoreLoop, reapplyFilters, events };
