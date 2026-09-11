'use strict';

const fs = require('fs');
const path = require('path');

// 数据目录：默认在项目下，可用环境变量覆盖（测试 / 多实例场景）
const DATA_DIR = process.env.CONTENT_RADAR_DATA_DIR
  ? path.resolve(process.env.CONTENT_RADAR_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

/** 默认配置 —— 与前端设置面板一一对应 */
const DEFAULTS = {
  _migrations: [], // 已执行的配置迁移标记（避免重复追加默认源）
  port: 7788,
  theme: 'dark', // dark | light
  accent: '#8b7cff',
  layout: 'single', // single（列表）| double | triple | quad
  cardSize: 'md', // sm | md | lg
  previewScale: 1.15, // 悬停封面放大倍率（1 = 关闭）
  showReason: true, // 卡片上显示 AI 判定理由

  // 抓取
  fetch: {
    intervalMinutes: 0, // 0 = 不自动轮询
    perSourceLimit: 24,
    timeoutMs: 15000,
  },

  // 桌面 App 行为（仅 Electron 模式生效）
  minimizeToTray: true, // 关闭窗口时缩到托盘而不是退出
  notify: true, // 抓到新内容时弹系统通知

  // 关键词过滤（借鉴 TrendRadar 的三级语法）
  keywords: {
    any: [], // 普通词：命中任一即通过
    must: [], // 必须词（+）：必须全部命中
    exclude: [], // 排除词（!）：命中任一即剔除
    strict: true, // 严格匹配：标题必须命中（否则标题+简介）
  },

  // AI 过滤
  ai: {
    enabled: false,
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    minScore: 6, // 兴趣分低于该值被剔除
    strictness: 'standard', // 引战容忍度：loose(8) / standard(6) / serious(5) / strict(4)
    scoreTtlHours: 24, // 打分缓存时长，命中不重复花钱
    interests: '', // 自然语言兴趣描述
    batchSize: 10, // 每次送给模型多少条
    priceIn: 1, // 元 / 百万 token（用于成本估算，默认 deepseek-chat 缓存未命中价）
    priceOut: 2,
  },

  // 账号：填自己的 Cookie 后，抓取会带上登录态；留空则走匿名
  accounts: {
    bilibili: { cookie: '' }, // 需要 SESSDATA
    tieba: { cookie: '' }, // 需要 BDUSS
    xiaoheihe: { cookie: '' }, // 需要 pkey / x_xhh_tokenid
  },

  // 数据源
  sources: [
    {
      id: 'bili-search-ai',
      type: 'bilibili',
      name: 'B站 · 搜索「人工智能」',
      enabled: true,
      options: { mode: 'search', keyword: '人工智能', pageSize: 24 },
    },
    {
      id: 'bili-ranking',
      type: 'bilibili',
      name: 'B站 · 全站排行榜',
      enabled: true,
      options: { mode: 'ranking', rid: 0, pageSize: 24 },
    },
    {
      id: 'xhh-feed',
      type: 'xiaoheihe',
      name: '小黑盒 · 社区推荐流',
      enabled: true,
      options: { mode: 'feed', cookie: '', pageSize: 20 },
    },
    {
      id: 'tieba-forum',
      type: 'tieba',
      name: '贴吧 · 填吧名后启用',
      enabled: false,
      options: { mode: 'forum', kw: '', cookie: '', pageSize: 30 },
    },
  ],
};

function deepMerge(base, patch) {
  if (Array.isArray(patch)) return patch;
  if (patch === null || typeof patch !== 'object') return patch === undefined ? base : patch;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = deepMerge(base && typeof base === 'object' ? base[k] : undefined, v);
  }
  return out;
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * 升级迁移：老配置文件补齐后来新增的默认数据源（只执行一次，
 * 用 _migrations 标记，用户主动删掉的源不会被反复加回来）
 */
function migrate(cfg) {
  const done = new Set(cfg._migrations || []);
  if (done.has('sources-v2')) return cfg;

  const existing = new Set((cfg.sources || []).map((s) => s.type));
  const additions = DEFAULTS.sources.filter((s) => !existing.has(s.type));
  if (additions.length) {
    cfg.sources = [...(cfg.sources || []), ...structuredClone(additions)];
    console.log(`[config] 已补充默认数据源：${additions.map((s) => s.name).join('、')}`);
  }
  cfg._migrations = [...done, 'sources-v2'];
  saveConfig(cfg);
  return cfg;
}

function loadConfig() {
  ensureDataDir();
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2), 'utf8');
    return structuredClone(DEFAULTS);
  }
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return migrate(deepMerge(structuredClone(DEFAULTS), raw));
  } catch (err) {
    console.error('[config] 读取失败，回退默认配置:', err.message);
    return structuredClone(DEFAULTS);
  }
}

function saveConfig(cfg) {
  ensureDataDir();
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  fs.renameSync(tmp, CONFIG_PATH);
  return cfg;
}

function updateConfig(patch) {
  const next = deepMerge(loadConfig(), patch);
  return saveConfig(next);
}

module.exports = { DEFAULTS, DATA_DIR, CONFIG_PATH, loadConfig, saveConfig, updateConfig, deepMerge };
