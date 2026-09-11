'use strict';

/**
 * 配置读写与升级迁移测试
 * 用独立临时数据目录，不碰真实配置。
 */

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert');

process.env.CONTENT_RADAR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'content-radar-cfg-'));

const { loadConfig, saveConfig, updateConfig, DEFAULTS } = require('../src/config');

const CONFIG_FILE = path.join(process.env.CONTENT_RADAR_DATA_DIR, 'config.json');
const writeLegacy = (obj) => fs.writeFileSync(CONFIG_FILE, JSON.stringify(obj, null, 2), 'utf8');

test('首次加载写出默认配置，且包含四个内置数据源', () => {
  if (fs.existsSync(CONFIG_FILE)) fs.rmSync(CONFIG_FILE);
  const cfg = loadConfig();
  assert.ok(fs.existsSync(CONFIG_FILE), '应写出 config.json');
  const types = cfg.sources.map((s) => s.type).sort();
  assert.deepEqual(types, ['bilibili', 'bilibili', 'tieba', 'xiaoheihe']);
  assert.equal(DEFAULTS.port, 7788);
});

test('迁移：老配置自动补齐后来新增的默认源', () => {
  writeLegacy({
    port: 7788,
    sources: [
      {
        id: 'bili-ranking',
        type: 'bilibili',
        name: 'B站 · 全站排行榜',
        enabled: true,
        options: { mode: 'ranking', rid: 0, pageSize: 24 },
      },
    ],
  });

  const cfg = loadConfig();
  const types = cfg.sources.map((s) => s.type);
  assert.equal(types.filter((t) => t === 'bilibili').length, 1, '原有源应保留');
  assert.ok(types.includes('xiaoheihe'), '应补上小黑盒源');
  assert.ok(types.includes('tieba'), '应补上贴吧源');
  assert.ok(cfg._migrations.includes('sources-v2'), '应记录迁移标记');
});

test('迁移是幂等的，不会重复追加', () => {
  const first = loadConfig();
  const second = loadConfig();
  assert.equal(second.sources.filter((s) => s.type === 'xiaoheihe').length, 1, '不应重复');
  assert.equal(second.sources.length, first.sources.length);
});

test('用户主动删掉的源不会被反复加回来', () => {
  const cfg = loadConfig();
  cfg.sources = cfg.sources.filter((s) => s.type !== 'xiaoheihe');
  saveConfig(cfg);

  const reloaded = loadConfig();
  assert.ok(!reloaded.sources.some((s) => s.type === 'xiaoheihe'), '迁移过就不该再加回来');
});

test('updateConfig 支持深合并且保留未涉及的字段', () => {
  updateConfig({ keywords: { any: ['大模型'] } });
  const cfg = loadConfig();
  assert.deepEqual(cfg.keywords.any, ['大模型']);
  assert.equal(cfg.keywords.strict, true, '未覆盖的字段应保持默认值');
  assert.equal(cfg.port, 7788, '顶层字段不应丢失');
});
