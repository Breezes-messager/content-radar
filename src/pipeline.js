'use strict';

/**
 * 抓取流水线：拉取 → 归一化 → 关键词过滤 → AI 过滤 → 入库
 * 这是整个应用的“引擎”，server 只负责触发和读取结果。
 */

const { EventEmitter } = require('events');
const { loadConfig } = require('./config');
const store = require('./store');
const { fetchFromSource } = require('./sources');
const { compileRules, applyKeywordRules, hasRules } = require('./filter/keyword');
const { AiClient } = require('./ai');

/** 抓取事件（Electron 主进程监听它来弹新内容通知） */
const events = new EventEmitter();

let running = null;

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

async function runFetch({ sourceId = '', useAi = null } = {}) {
  if (running) return running;
  running = (async () => {
    const cfg = loadConfig();
    const rules = compileRules(cfg.keywords);
    const keywordsActive = hasRules(cfg.keywords);
    const aiEnabled = useAi === null ? cfg.ai.enabled : Boolean(useAi);
    const ai = new AiClient(cfg.ai);

    const sources = cfg.sources.filter((s) => s.enabled && (!sourceId || s.id === sourceId));
    if (!sources.length) {
      const summary = { at: Date.now(), sources: [], note: sourceId ? `未找到启用的源 ${sourceId}` : '没有启用的数据源' };
      store.setFetchMeta(summary);
      return summary;
    }

    const perSource = [];

    await mapLimit(sources, 2, async (source) => {
      const row = {
        sourceId: source.id,
        sourceName: source.name,
        fetched: 0,
        new: 0,
        keywordFiltered: 0,
        aiFiltered: 0,
        kept: 0,
        aiCost: 0,
        error: null,
      };
      try {
        const raw = await fetchFromSource(source, {
          timeoutMs: cfg.fetch.timeoutMs,
          limit: cfg.fetch.perSourceLimit,
        });
        row.fetched = raw.length;

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

        // 2) 只对“新条目且已通过关键词”的内容做 AI 打分
        const { fresh } = store.partitionNew(afterKeyword);
        const aiCandidates = fresh.filter((it) => it.status !== 'filtered');

        if (aiEnabled && ai.ready && aiCandidates.length) {
          const batchSize = Math.max(1, Math.min(30, cfg.ai.batchSize || 10));
          for (let i = 0; i < aiCandidates.length; i += batchSize) {
            const batch = aiCandidates.slice(i, i + batchSize);
            try {
              const { results, usage } = await ai.scoreBatch(batch);
              let filteredNow = 0;
              batch.forEach((item, idx) => {
                const verdict = results.get(idx);
                if (!verdict) return;
                const keep = verdict.score >= Number(cfg.ai.minScore || 6);
                item.ai = {
                  score: verdict.score,
                  tags: verdict.tags,
                  reason: verdict.reason,
                  model: usage.model,
                  scoredAt: Date.now(),
                };
                if (!keep) {
                  item.status = 'filtered';
                  item.filterStage = 'ai';
                  item.filterReason = `AI 判定 ${verdict.score}/10：${verdict.reason || '与兴趣不符'}`;
                  filteredNow++;
                }
              });
              row.aiFiltered += filteredNow;
              row.aiCost += usage.cost;
              store.recordAiUsage({
                tokensIn: usage.tokensIn,
                tokensOut: usage.tokensOut,
                cost: usage.cost,
                filtered: filteredNow,
              });
            } catch (err) {
              row.aiError = err.message;
              console.warn(`[pipeline] AI 打分失败（该批内容保留）: ${err.message}`);
            }
          }
        }

        const { added } = store.upsertItems(afterKeyword);
        row.new = added;
        row.kept = afterKeyword.filter((it) => it.status !== 'filtered').length;
      } catch (err) {
        row.error = err.message;
        console.warn(`[pipeline] 源 ${source.name} 抓取失败: ${err.message}`);
      }
      perSource.push(row);
    });

    const summary = {
      at: Date.now(),
      aiEnabled: aiEnabled && ai.ready,
      keywordRules: keywordsActive,
      sources: perSource.sort((a, b) => sources.findIndex((s) => s.id === a.sourceId) - sources.findIndex((s) => s.id === b.sourceId)),
    };
    store.setFetchMeta(summary);
    store.flush();
    // 供 Electron 主进程监听（用于新内容通知）
    events.emit('fetched', summary);
    return summary;
  })();

  try {
    return await running;
  } finally {
    running = null;
  }
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

  if (aiReady) {
    const needScore = all.filter((it) => it.status !== 'filtered' && (!it.ai || !it.ai.score));
    const batchSize = Math.max(1, Math.min(30, cfg.ai.batchSize || 10));
    for (let i = 0; i < needScore.length; i += batchSize) {
      const batch = needScore.slice(i, i + batchSize);
      try {
        const { results, usage } = await ai.scoreBatch(batch);
        let filteredNow = 0;
        batch.forEach((item, idx) => {
          const v = results.get(idx);
          if (!v) return;
          item.ai = { score: v.score, tags: v.tags, reason: v.reason, model: usage.model, scoredAt: Date.now() };
          if (v.score < Number(cfg.ai.minScore || 6)) {
            item.status = 'filtered';
            item.filterStage = 'ai';
            item.filterReason = `AI 判定 ${v.score}/10：${v.reason || '与兴趣不符'}`;
            filteredNow++;
          }
          changed++;
        });
        store.recordAiUsage({ tokensIn: usage.tokensIn, tokensOut: usage.tokensOut, cost: usage.cost, filtered: filteredNow });
      } catch (err) {
        console.warn('[pipeline] 重新打分失败:', err.message);
        break;
      }
    }
  }

  store.flush();
  return { changed, scanned: all.length };
}

module.exports = { runFetch, reapplyFilters, events };
