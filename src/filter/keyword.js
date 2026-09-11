'use strict';

/**
 * 关键词过滤引擎
 * 语法（借鉴 TrendRadar，但独立实现）：
 *   - 普通词：命中任意一个即通过（any 列表）
 *   - 必须词：以 + 开头，必须全部命中（must 列表）
 *   - 排除词：以 ! 开头，命中任意一个即剔除（exclude 列表）
 * 若 any / must 都为空，则视为“不设关键词门槛”，全部通过。
 */

const PREFIX_MUST = '+';
const PREFIX_EXCLUDE = '!';

function normalizeWords(list) {
  const out = { any: [], must: [], exclude: [] };
  for (const raw of list || []) {
    const word = String(raw || '').trim();
    if (!word) continue;
    if (word.startsWith(PREFIX_MUST)) out.must.push(word.slice(1).trim());
    else if (word.startsWith(PREFIX_EXCLUDE)) out.exclude.push(word.slice(1).trim());
    else out.any.push(word);
  }
  return out;
}

function buildHaystack(item, strict) {
  const parts = [item.title];
  if (!strict) parts.push(item.desc, item.author, item.sourceName);
  return parts.filter(Boolean).join('\n').toLowerCase();
}

function compileRules(keywords = {}) {
  const strip = (w) => String(w).replace(/^[+!]/, '');
  const raw = [
    ...(keywords.any || []),
    ...(keywords.must || []).map((w) => PREFIX_MUST + strip(w)),
    ...(keywords.exclude || []).map((w) => PREFIX_EXCLUDE + strip(w)),
  ];
  const { any, must, exclude } = normalizeWords(raw);
  const lower = (w) => String(w).toLowerCase();
  return {
    any: any.map(lower).filter(Boolean),
    must: must.map(lower).filter(Boolean),
    exclude: exclude.map(lower).filter(Boolean),
    strict: keywords.strict !== false,
  };
}

/**
 * @returns {{pass:boolean, reason:string, matched:string[]}}
 */
function applyKeywordRules(item, rules) {
  const hay = buildHaystack(item, rules.strict);
  const matched = [];

  for (const word of rules.exclude) {
    if (hay.includes(word)) {
      return { pass: false, reason: `命中排除词「${word}」`, matched: [word] };
    }
  }

  for (const word of rules.must) {
    if (!hay.includes(word)) {
      return { pass: false, reason: `缺少必须词「${word}」`, matched: [] };
    }
    matched.push(word);
  }

  if (rules.any.length) {
    const hit = rules.any.filter((w) => hay.includes(w));
    if (!hit.length) {
      return { pass: false, reason: '未命中任何关注词', matched: [] };
    }
    matched.push(...hit);
  }

  return { pass: true, reason: matched.length ? `命中：${matched.join('、')}` : '未设置关键词门槛', matched };
}

const hasRules = (keywords) =>
  Boolean(keywords) &&
  ((keywords.any || []).length || (keywords.must || []).length || (keywords.exclude || []).length);

module.exports = { applyKeywordRules, compileRules, normalizeWords, hasRules };
