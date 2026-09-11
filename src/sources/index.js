'use strict';

/** 适配器注册表：新增数据源只需在这里挂一个实现 fetchItems 的模块 */

const bilibili = require('./bilibili');
const rss = require('./rss');
const tieba = require('./tieba');
const xiaoheihe = require('./xiaoheihe');

const REGISTRY = new Map([
  [bilibili.type, bilibili],
  [rss.type, rss],
  [tieba.type, tieba],
  [xiaoheihe.type, xiaoheihe],
]);

function getAdapter(type) {
  const adapter = REGISTRY.get(type);
  if (!adapter) throw new Error(`未知数据源类型: ${type}`);
  return adapter;
}

function listAdapters() {
  return [...REGISTRY.values()].map((a) => ({ type: a.type, label: a.label, modes: a.MODES || [] }));
}

async function fetchFromSource(source, ctx) {
  const adapter = getAdapter(source.type);
  const items = await adapter.fetchItems(source, ctx);
  return items.filter((it) => it && it.id && it.title);
}

module.exports = { getAdapter, listAdapters, fetchFromSource, types: [...REGISTRY.keys()] };
