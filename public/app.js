'use strict';

/* ============================== 基础工具 ============================== */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  config: null,
  items: [],
  total: 0,
  page: 1,
  pageSize: 24,
  view: 'all', // all | starred | filtered
  sourceId: '',
  sort: 'smart', // smart（默认）| time | hot | score
  q: '',
  loading: false,
  fetching: false,
  scoreTimer: null, // 有待评分条目时的轮询计时器
};

const ACCENTS = [
  '#ff5f8f',
  '#4ea8ff',
  '#8b7cff',
  '#4ade80',
  '#fbbf24',
  '#fb7185',
  '#22d3ee',
  '#a3a3b3',
];

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) {
    throw new Error(json.error || `请求失败 HTTP ${res.status}`);
  }
  return json;
}

let toastTimer = null;
function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('err', isError);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

const fmtNum = (n) => {
  const v = Number(n) || 0;
  if (v >= 1e8) return (v / 1e8).toFixed(1) + '亿';
  if (v >= 1e4) return (v / 1e4).toFixed(1) + '万';
  return String(v);
};

const timeAgo = (ts) => {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min}分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}天前`;
  return new Date(ts).toLocaleDateString('zh-CN');
};

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const debounce = (fn, ms) => {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
};

/* ============================== 外观 ============================== */

/** 信息流栏数映射 */
const LAYOUT_COLS = { single: 1, double: 2, triple: 3, quad: 4 };

function applyAppearance() {
  const cfg = state.config;
  if (!cfg) return;
  document.documentElement.dataset.theme = cfg.theme || 'dark';
  document.documentElement.style.setProperty('--accent', cfg.accent || '#8b7cff');
  document.documentElement.style.setProperty('--accent-soft', hexToSoft(cfg.accent || '#8b7cff'));

  const cols = LAYOUT_COLS[cfg.layout] || 1;
  document.documentElement.style.setProperty('--feed-cols', cols);

  const sizes = { sm: ['120px', '13px'], md: ['150px', '14px'], lg: ['210px', '15px'], xl: ['280px', '16px'] };
  const [rawH, rawT] = sizes[cfg.cardSize] || sizes.md;
  // 栏数越多卡片越窄，封面按比例收窄、标题降一档，避免卡片被拉得又高又窄
  const shrink = cols >= 4 ? 0.68 : cols === 3 ? 0.82 : 1;
  const h = shrink === 1 ? rawH : `${Math.round(parseInt(rawH, 10) * shrink)}px`;
  const t = shrink === 1 ? rawT : `${Math.max(11, parseInt(rawT, 10) - 1)}px`;
  document.documentElement.style.setProperty('--cover-h', h);
  document.documentElement.style.setProperty('--title-size', t);
  document.documentElement.style.setProperty('--preview-scale', String(Number(cfg.previewScale) || 1));

  // 列表形态下的缩略图尺寸：单栏最大，栏数越多越小
  const rowCover = cols === 1 ? ['168px', '100px'] : cols === 2 ? ['132px', '80px'] : ['88px', '54px'];
  document.documentElement.style.setProperty('--row-cover-w', rowCover[0]);
  document.documentElement.style.setProperty('--row-cover-h', rowCover[1]);
}

function hexToSoft(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 'rgba(139,124,255,0.16)';
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, 0.16)`;
}

function syncAppearanceControls() {
  const cfg = state.config;
  $$('#seg-theme button').forEach((b) => b.classList.toggle('active', b.dataset.value === cfg.theme));
  $$('#seg-layout button').forEach((b) => b.classList.toggle('active', b.dataset.value === cfg.layout));
  $$('#seg-cardsize button').forEach((b) => b.classList.toggle('active', b.dataset.value === cfg.cardSize));
  $$('#seg-preview button').forEach((b) =>
    b.classList.toggle('active', Number(b.dataset.value) === Number(cfg.previewScale ?? 1.15)),
  );
  $$('#swatches button').forEach((b) => b.classList.toggle('active', b.dataset.color === cfg.accent));
}

/* ============================== 设置面板 ============================== */

function renderSwatches() {
  const box = $('#swatches');
  box.innerHTML = '';
  for (const color of ACCENTS) {
    const b = document.createElement('button');
    b.style.background = color;
    b.dataset.color = color;
    b.title = color;
    b.onclick = () => {
      state.config.accent = color;
      applyAppearance();
      syncAppearanceControls();
      persistConfig();
    };
    box.appendChild(b);
  }
}

function fillConfigForm() {
  const cfg = state.config;
  $('#kw-any').value = (cfg.keywords.any || []).join(', ');
  $('#kw-must').value = (cfg.keywords.must || []).join(', ');
  $('#kw-exclude').value = (cfg.keywords.exclude || []).join(', ');
  $('#kw-strict').checked = cfg.keywords.strict !== false;

  $('#ai-enabled').checked = Boolean(cfg.ai.enabled);
  $('#ai-baseurl').value = cfg.ai.baseUrl || '';
  $('#ai-apikey').value = cfg.ai.apiKey || '';
  $('#ai-model').value = cfg.ai.model || '';
  $('#ai-interests').value = cfg.ai.interests || '';
  $('#ai-minscore').value = cfg.ai.minScore ?? 6;
  $('#ai-minscore-label').textContent = cfg.ai.minScore ?? 6;
  $('#ai-strictness').value = cfg.ai.strictness || 'standard';
  $('#ai-scorettl').value = cfg.ai.scoreTtlHours ?? 24;

  $('#fetch-limit').value = cfg.fetch.perSourceLimit ?? 24;
  $('#fetch-interval').value = cfg.fetch.intervalMinutes ?? 0;
  $('#chk-reason').checked = cfg.showReason !== false;
  $('#chk-tray').checked = cfg.minimizeToTray !== false;
  $('#chk-notify').checked = cfg.notify !== false;

  renderAccounts();
  renderSourceList();
  renderSourceFilter();
}

function collectConfigForm() {
  const split = (v) =>
    String(v || '')
      .split(/[,，\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
  const cfg = state.config;
  cfg.keywords.any = split($('#kw-any').value);
  cfg.keywords.must = split($('#kw-must').value);
  cfg.keywords.exclude = split($('#kw-exclude').value);
  cfg.keywords.strict = $('#kw-strict').checked;

  cfg.ai.enabled = $('#ai-enabled').checked;
  cfg.ai.baseUrl = $('#ai-baseurl').value.trim();
  cfg.ai.apiKey = $('#ai-apikey').value.trim();
  cfg.ai.model = $('#ai-model').value.trim();
  cfg.ai.interests = $('#ai-interests').value.trim();
  cfg.ai.minScore = Number($('#ai-minscore').value);
  cfg.ai.strictness = $('#ai-strictness').value || 'standard';
  cfg.ai.scoreTtlHours = Math.max(0, Math.min(168, Number($('#ai-scorettl').value) || 0));

  cfg.fetch.perSourceLimit = Math.max(5, Math.min(50, Number($('#fetch-limit').value) || 24));
  cfg.fetch.intervalMinutes = Math.max(0, Number($('#fetch-interval').value) || 0);
  cfg.showReason = $('#chk-reason').checked;
  cfg.minimizeToTray = $('#chk-tray').checked;
  cfg.notify = $('#chk-notify').checked;
  return cfg;
}

async function persistConfig(showHint = false) {
  const cfg = collectConfigForm();
  try {
    const r = await api('/api/config', { method: 'POST', body: cfg });
    state.config = r.config;
    applyAppearance();
    if (showHint) {
      const hint = $('#save-hint');
      hint.textContent = '已保存 ✓';
      hint.className = 'hint center ok';
      setTimeout(() => (hint.textContent = ''), 2000);
    }
  } catch (err) {
    toast('保存失败：' + err.message, true);
  }
}

/* ---------------------------- 账号 ---------------------------- */

const ACCOUNT_META = {
  bilibili: { label: 'B站', placeholder: 'SESSDATA=...; bili_jct=...' },
  tieba: { label: '贴吧', placeholder: 'BDUSS=...' },
  xiaoheihe: { label: '小黑盒', placeholder: 'pkey=...; x_xhh_tokenid=...' },
};

function renderAccounts() {
  const box = $('#account-list');
  if (!box) return;
  box.innerHTML = '';
  const accounts = state.config.accounts || (state.config.accounts = {});

  for (const [platform, meta] of Object.entries(ACCOUNT_META)) {
    accounts[platform] = accounts[platform] || { cookie: '' };
    const value = accounts[platform].cookie || '';

    const el = document.createElement('div');
    el.className = 'account-item';
    el.innerHTML = `
      <div class="a-head">
        <span class="dot ${value ? '' : 'idle'}"></span>
        <span class="a-name">${esc(meta.label)}</span>
        <span class="a-status" data-status>${value ? '已配置' : '未配置'}</span>
      </div>
      <input type="password" data-cookie placeholder="${esc(meta.placeholder)}" />
      <div class="a-actions">
        <button class="btn btn-ghost" data-act="check">检测登录</button>
        ${
          platform === 'bilibili'
            ? '<button class="btn btn-ghost" data-act="qr">扫码登录</button><button class="btn btn-ghost" data-act="window">登录窗口</button>'
            : '<button class="btn btn-ghost" data-act="window">打开登录窗口</button>'
        }
      </div>`;

    const input = el.querySelector('[data-cookie]');
    input.value = value;
    input.addEventListener('input', () => {
      accounts[platform].cookie = input.value.trim();
      el.querySelector('.dot').classList.toggle('idle', !input.value.trim());
      el.querySelector('[data-status]').textContent = input.value.trim() ? '已配置' : '未配置';
      el.querySelector('[data-status]').className = 'a-status';
      debouncedPersist();
    });

    el.querySelector('[data-act="check"]').onclick = async () => {
      const statusEl = el.querySelector('[data-status]');
      statusEl.textContent = '检测中…';
      statusEl.className = 'a-status';
      accounts[platform].cookie = input.value.trim();
      await persistConfig();
      try {
        const r = await api('/api/accounts/check', {
          method: 'POST',
          body: { platform, cookie: input.value.trim() },
        });
        statusEl.textContent = r.message || (r.loggedIn ? '已登录' : '未登录');
        statusEl.className = 'a-status ' + (r.loggedIn ? 'ok' : 'err');
        el.querySelector('.dot').className = 'dot' + (r.loggedIn ? '' : ' idle');
        toast(`${meta.label}：${r.message}`, !r.loggedIn);
      } catch (err) {
        statusEl.textContent = '检测失败';
        statusEl.className = 'a-status err';
        toast(err.message, true);
      }
    };

    // B站：官方扫码登录
    const qrBtn = el.querySelector('[data-act="qr"]');
    if (qrBtn) qrBtn.onclick = () => openQrLogin(el, input);

    // 贴吧 / 小黑盒：弹出登录窗口，登录后自动抓 Cookie
    const winBtn = el.querySelector('[data-act="window"]');
    if (winBtn) winBtn.onclick = () => openLoginWindow(platform, meta, el, input);

    box.appendChild(el);
  }
}

/* ---------------------------- 扫码 / 登录窗口 ---------------------------- */

let qrTimer = null;
let qrSessionId = '';

function stopQrPolling() {
  if (qrTimer) {
    clearInterval(qrTimer);
    qrTimer = null;
  }
  qrSessionId = '';
}

async function startQrSession() {
  const box = $('#qr-box');
  const status = $('#qr-status');
  box.innerHTML = '<div class="qr-loading">正在打开登录页…</div>';
  status.textContent = '正在获取二维码…';
  status.className = 'qr-status';

  try {
    const r = await api('/api/accounts/qr', { method: 'POST', body: { action: 'start' } });
    qrSessionId = r.id;
    box.innerHTML = `<img src="data:image/png;base64,${r.image}" alt="B站登录二维码" />`;
    status.textContent = r.message || '请用 B站 App 扫码';
    return r.id;
  } catch (err) {
    box.innerHTML = '';
    status.textContent = `获取二维码失败：${err.message}（可改用「登录窗口」）`;
    status.className = 'qr-status err';
    return '';
  }
}

async function openQrLogin() {
  const modal = $('#qr-modal');
  modal.classList.remove('hidden');
  stopQrPolling();

  const id = await startQrSession();
  if (!id) return;

  const statusEl = $('#qr-status');

  qrTimer = setInterval(async () => {
    if (!qrSessionId) return;
    try {
      const r = await api('/api/accounts/qr?id=' + encodeURIComponent(qrSessionId));
      statusEl.textContent = r.message || '';
      statusEl.className = 'qr-status' + (r.status === 'success' ? ' ok' : r.status === 'failed' ? ' err' : '');

      if (r.status === 'success') {
        stopQrPolling();
        toast(`B站：${r.message}`, false);
        // 重新拉一次配置，否则面板还拿着旧配置，会显示「未配置」
        try {
          state.config = await api('/api/config');
        } catch {}
        setTimeout(() => {
          modal.classList.add('hidden');
          fillConfigForm();
        }, 900);
      } else if (r.status === 'timeout') {
        stopQrPolling();
        statusEl.className = 'qr-status err';
      }
    } catch (err) {
      statusEl.textContent = '轮询失败：' + err.message;
      statusEl.className = 'qr-status err';
    }
  }, 2000);
}

/** 二维码过期后重新截图 */
async function refreshQrCode() {
  if (!qrSessionId) return openQrLogin();
  try {
    const r = await api('/api/accounts/qr', { method: 'POST', body: { action: 'refresh', id: qrSessionId } });
    if (r.image) $('#qr-box').innerHTML = `<img src="data:image/png;base64,${r.image}" alt="B站登录二维码" />`;
    const statusEl = $('#qr-status');
    statusEl.textContent = r.message || '请用 B站 App 扫码';
    statusEl.className = 'qr-status';
  } catch (err) {
    toast(err.message, true);
  }
}

async function openLoginWindow(platform, meta, accountEl, input) {
  const statusEl = accountEl.querySelector('[data-status]');
  statusEl.textContent = '等待窗口登录…';
  statusEl.className = 'a-status';

  let session;
  try {
    session = await api('/api/accounts/login-window', { method: 'POST', body: { platform } });
    toast(`${meta.label}：${session.message}`);
  } catch (err) {
    statusEl.textContent = '打开失败';
    statusEl.className = 'a-status err';
    toast(err.message, true);
    return;
  }

  const deadline = Date.now() + 5 * 60 * 1000;
  const tick = async () => {
    if (Date.now() > deadline) {
      statusEl.textContent = '等待超时';
      statusEl.className = 'a-status err';
      return;
    }
    try {
      const r = await api('/api/accounts/login-window?id=' + encodeURIComponent(session.id));
      if (r.status === 'success') {
        statusEl.textContent = r.message || '已登录';
        statusEl.className = 'a-status ok';
        accountEl.querySelector('.dot').className = 'dot';
        toast(`${meta.label}：${r.message || '登录成功'}`, false);
        fillConfigForm();
        return;
      }
      if (r.status === 'timeout') {
        statusEl.textContent = '等待超时';
        statusEl.className = 'a-status err';
        return;
      }
      setTimeout(tick, 2500);
    } catch (err) {
      // 会话已结束时后端返回 404
      statusEl.textContent = '会话已结束';
      statusEl.className = 'a-status err';
    }
  };
  setTimeout(tick, 2500);
}

/* ---------------------------- 数据源编辑 ---------------------------- */

const SOURCE_TYPES = [
  { value: 'bilibili', label: 'B站' },
  { value: 'tieba', label: '贴吧' },
  { value: 'xiaoheihe', label: '小黑盒' },
  { value: 'rss', label: 'RSS 订阅' },
];

const typeLabel = (t) => (SOURCE_TYPES.find((x) => x.value === t) || {}).label || t;

const DEFAULT_MODES = { bilibili: 'search', tieba: 'forum', xiaoheihe: 'feed', rss: 'rss' };

const DEFAULT_OPTIONS = {
  bilibili: { mode: 'search', keyword: '', pageSize: 24 },
  tieba: { mode: 'forum', kw: '', cookie: '', pageSize: 30 },
  xiaoheihe: { mode: 'feed', cookie: '', pageSize: 20 },
  rss: { url: '', pageSize: 24 },
};

/** 每个类型的可填字段（label + 示例 + 说明） */
const SOURCE_FIELDS = {
  bilibili: [
    {
      key: 'mode',
      label: '模式',
      type: 'select',
      options: [
        ['search', '关键词搜索'],
        ['ranking', '排行榜'],
        ['popular', '热门推荐'],
        ['user', 'UP 主投稿'],
        ['following', '关注动态（需登录）'],
      ],
      hint: '选好后下面的参数会跟着变',
    },
    { key: 'keyword', label: '搜索关键词', type: 'text', placeholder: '人工智能', onlyModes: ['search'], hint: '按关键词搜全站视频' },
    {
      key: 'mid',
      label: 'UP 主 mid',
      type: 'text',
      placeholder: '2267573',
      onlyModes: ['user'],
      hint: 'UP 主主页地址 space.bilibili.com/ 后面的数字',
    },
    { key: 'rid', label: '分区 rid', type: 'text', placeholder: '0', onlyModes: ['ranking'], hint: '0 = 全站；知识区 36、科技区 188' },
    { key: 'pageSize', label: '抓取条数', type: 'text', placeholder: '24', hint: '留空用全局设置' },
  ],
  tieba: [
    { key: 'mode', label: '模式', type: 'select', options: [['forum', '吧内帖子列表']] },
    { key: 'kw', label: '吧名', type: 'text', placeholder: '理论物理', hint: '直接填吧名，不用带「吧」字' },
    {
      key: 'cookie',
      label: '贴吧 Cookie（可选）',
      type: 'text',
      placeholder: 'BDUSS=...',
      hint: '留空用匿名访问；建议改用上方「账号」面板统一登录',
    },
    { key: 'pageSize', label: '抓取条数', type: 'text', placeholder: '30', hint: '留空用全局设置' },
  ],
  xiaoheihe: [
    { key: 'mode', label: '模式', type: 'select', options: [['feed', '社区推荐流']] },
    {
      key: 'cookie',
      label: '小黑盒 Cookie（可选）',
      type: 'text',
      placeholder: 'pkey=...',
      hint: '留空用匿名；建议改用上方「账号」面板统一登录',
    },
    { key: 'pageSize', label: '抓取条数', type: 'text', placeholder: '20', hint: '留空用全局设置' },
  ],
  rss: [
    {
      key: 'url',
      label: 'RSS 地址',
      type: 'text',
      placeholder: 'https://rsshub.app/weibo/keyword/人工智能',
      hint: '任何 RSS / Atom 地址都可以',
    },
    { key: 'pageSize', label: '抓取条数', type: 'text', placeholder: '24', hint: '留空用全局设置' },
  ],
};

/** 用一行摘要说明这个源当前在抓什么 */
function sourceSummary(source) {
  const o = source.options || {};
  const bits = [typeLabel(source.type)];
  const mode = o.mode || DEFAULT_MODES[source.type];
  const modeText = {
    search: '关键词搜索',
    ranking: '排行榜',
    popular: '热门推荐',
    user: 'UP 主投稿',
    following: '关注动态',
    forum: '吧内帖子',
    feed: '社区推荐流',
    rss: '订阅源',
  }[mode];
  if (modeText) bits.push(modeText);
  if (o.keyword) bits.push(`「${o.keyword}」`);
  if (o.kw) bits.push(`${o.kw}吧`);
  if (o.mid) bits.push(`mid ${o.mid}`);
  if (o.rid) bits.push(o.rid === '0' ? '全站' : `分区 ${o.rid}`);
  if (o.url) bits.push(o.url.replace(/^https?:\/\//, '').slice(0, 32));
  return bits.join(' · ');
}

let editingSourceId = null;

function renderSourceList() {
  const box = $('#source-list');
  box.innerHTML = '';
  const sources = state.config.sources || [];
  if (!sources.length) {
    box.innerHTML = '<div class="hint">还没有数据源，点下面的按钮添加。</div>';
    return;
  }

  for (const source of sources) {
    const el = document.createElement('div');
    el.className = 'source-item';
    el.innerHTML = `
      <label class="s-toggle" title="启用 / 停用">
        <input type="checkbox" ${source.enabled ? 'checked' : ''} />
      </label>
      <div class="s-main" data-act="edit" title="点击编辑">
        <div class="s-name">${esc(source.name)}</div>
        <div class="s-sub">${esc(sourceSummary(source))}</div>
      </div>
      <button class="s-icon" data-act="edit" title="编辑">✎</button>
      <button class="s-icon danger" data-act="del" title="删除">✕</button>`;

    el.querySelector('input[type="checkbox"]').addEventListener('change', (e) => {
      source.enabled = e.target.checked;
      persistConfig();
    });

    el.querySelectorAll('[data-act="edit"]').forEach((n) => {
      n.onclick = () => openSourceModal(source.id);
    });

    el.querySelector('[data-act="del"]').onclick = () => {
      if (!confirm(`删除数据源「${source.name}」？`)) return;
      state.config.sources = state.config.sources.filter((s) => s.id !== source.id);
      renderSourceList();
      renderSourceFilter();
      persistConfig();
      toast('已删除数据源');
    };

    box.appendChild(el);
  }
}

/* ---------------------------- 数据源编辑弹窗 ---------------------------- */

function collectSourceForm() {
  const values = {};
  $('#source-form')
    .querySelectorAll('[data-key]')
    .forEach((el) => {
      values[el.dataset.key] = el.value.trim();
    });
  return values;
}

function renderSourceForm({ type, name = '', options = {}, isNew = false }) {
  const mode = options.mode || DEFAULT_MODES[type] || '';
  const fields = (SOURCE_FIELDS[type] || []).filter((f) => !f.onlyModes || f.onlyModes.includes(mode));

  const typeBlock = isNew
    ? `<label class="field">
         <span>数据源类型</span>
         <select id="src-type">
           ${SOURCE_TYPES.map((t) => `<option value="${t.value}" ${t.value === type ? 'selected' : ''}>${t.label}</option>`).join('')}
         </select>
       </label>`
    : `<div class="field">
         <span>类型</span>
         <div class="field-static">${esc(typeLabel(type))}</div>
       </div>`;

  const nameBlock = `<label class="field">
      <span>名称</span>
      <input type="text" id="src-name" value="${esc(name)}" placeholder="起个好认的名字" />
    </label>`;

  const paramBlock = fields
    .map((f) => {
      const val = options[f.key] ?? '';
      const hint = f.hint ? `<em class="field-hint">${esc(f.hint)}</em>` : '';
      if (f.type === 'select') {
        return `<label class="field">
            <span>${esc(f.label)}</span>
            <select data-key="${f.key}">
              ${f.options.map(([v, l]) => `<option value="${v}" ${String(val) === v ? 'selected' : ''}>${l}</option>`).join('')}
            </select>${hint}
          </label>`;
      }
      return `<label class="field">
          <span>${esc(f.label)}</span>
          <input type="text" data-key="${f.key}" value="${esc(val)}" placeholder="${esc(f.placeholder || '')}" />${hint}
        </label>`;
    })
    .join('');

  $('#source-form').innerHTML = typeBlock + nameBlock + paramBlock;

  // 类型变化 → 换一套字段，保留已填的值
  const typeSel = $('#src-type');
  if (typeSel) {
    typeSel.addEventListener('change', () => {
      const kept = collectSourceForm();
      renderSourceForm({
        type: typeSel.value,
        name: $('#src-name').value,
        options: { ...DEFAULT_OPTIONS[typeSel.value], ...kept },
        isNew: true,
      });
    });
  }

  // 模式变化 → 换下面的参数
  const modeSel = $('#source-form').querySelector('[data-key="mode"]');
  if (modeSel) {
    modeSel.addEventListener('change', () => {
      const kept = collectSourceForm();
      renderSourceForm({ type, name: $('#src-name').value, options: kept, isNew });
    });
  }
}

function openSourceModal(sourceId = null) {
  editingSourceId = sourceId;
  const source = sourceId ? (state.config.sources || []).find((s) => s.id === sourceId) : null;
  const isNew = !source;
  const type = source ? source.type : 'bilibili';

  $('#source-modal-title').textContent = isNew ? '新增数据源' : '编辑数据源';
  renderSourceForm({
    type,
    name: source ? source.name : '',
    options: source ? { ...source.options } : { ...DEFAULT_OPTIONS[type] },
    isNew,
  });
  $('#source-modal').classList.remove('hidden');
}

function closeSourceModal() {
  $('#source-modal').classList.add('hidden');
  editingSourceId = null;
}

async function saveSourceModal() {
  const values = collectSourceForm();
  const typeSel = $('#src-type');
  const existing = editingSourceId ? (state.config.sources || []).find((s) => s.id === editingSourceId) : null;
  const type = existing ? existing.type : typeSel ? typeSel.value : 'bilibili';
  const name = ($('#src-name').value || '').trim() || typeLabel(type);

  const options = { ...(existing ? existing.options : DEFAULT_OPTIONS[type]), ...values };
  // 清掉空字符串，让默认值生效
  for (const [k, v] of Object.entries(options)) if (v === '') delete options[k];

  if (existing) {
    existing.name = name;
    existing.options = options;
  } else {
    state.config.sources.push({
      id: `${type}-${Date.now().toString(36)}`,
      type,
      name,
      enabled: true,
      options,
    });
  }

  await persistConfig();
  renderSourceList();
  renderSourceFilter();
  closeSourceModal();
  toast(existing ? '已更新数据源' : '已新增数据源');
}

function renderSourceFilter() {
  const sel = $('#source-filter');
  const current = sel.value;
  sel.innerHTML = '<option value="">全部来源</option>';
  for (const s of state.config.sources || []) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.name + (s.enabled ? '' : '（停用）');
    sel.appendChild(opt);
  }
  sel.value = current;
}

const debouncedPersist = debounce(() => persistConfig(), 700);

/* ============================== 卡片流 ============================== */

/** 只允许 http/https 链接，避免 javascript: / data: 等伪协议被执行 */
function safeUrl(raw) {
  try {
    const u = new URL(String(raw || ''), window.location.origin);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : '';
  } catch {
    return '';
  }
}

function cardHtml(item) {
  const cover = item.cover ? `/api/proxy?url=${encodeURIComponent(item.cover)}` : '';
  const score = item.ai && typeof item.ai.score === 'number' ? item.ai.score : null;
  const scoreClass = score == null ? '' : score >= 8 ? 'high' : score >= 5 ? 'mid' : 'low';
  const filtered = item.status === 'filtered';
  const showReason = state.config.showReason !== false;

  const metaBits = [];
  if (item.author) metaBits.push(`<span class="author">${esc(item.author)}</span>`);
  if (item.stats && item.stats.play) metaBits.push(`<span>▶ ${fmtNum(item.stats.play)}</span>`);
  if (item.stats && item.stats.danmaku) metaBits.push(`<span>💬 ${fmtNum(item.stats.danmaku)}</span>`);
  if (item.stats && item.stats.reply) metaBits.push(`<span>💬 ${fmtNum(item.stats.reply)} 回复</span>`);
  if (item.stats && item.stats.comment) metaBits.push(`<span>💬 ${fmtNum(item.stats.comment)} 评论</span>`);
  if (item.stats && item.stats.like) metaBits.push(`<span>👍 ${fmtNum(item.stats.like)}</span>`);
  if (item.publishedAt) metaBits.push(`<span>${timeAgo(item.publishedAt)}</span>`);

  const tags = (item.ai && item.ai.tags) || [];
  const reasonText = filtered ? item.filterReason : item.ai && item.ai.reason;
  const summary = (item.ai && item.ai.summary) || '';
  // 只有 B站条目支持内嵌播放
  const playable = item.sourceType === 'bilibili' && item.extra && item.extra.bvid;
  // 没有封面（贴吧这类纯文字源）时走紧凑布局
  const hasCover = Boolean(item.cover);

  const scoreBadge = score != null ? `<span class="ai-score ${scoreClass}">${score}</span>` : '';
  const sourceTag = `<span class="source-tag ${esc(item.sourceType)}">${esc(item.sourceName)}</span>`;

  // 多维标记：>=5 才显示，避免噪音（低质/营销、引战、戾气）
  const flags = [];
  if (item.ai) {
    if (item.ai.spam >= 5) flags.push(`<span class="flag spam" title="营销/低质 ${item.ai.spam}/10">低质 ${item.ai.spam}</span>`);
    if (item.ai.flame >= 5) flags.push(`<span class="flag flame" title="引战 ${item.ai.flame}/10">引战 ${item.ai.flame}</span>`);
    if (typeof item.ai.emo === 'number' && item.ai.emo <= -5) flags.push(`<span class="flag emo" title="情绪净值 ${item.ai.emo}">戾气 ${item.ai.emo}</span>`);
  }
  const flagHtml = flags.length ? `<span class="card-flags">${flags.join('')}</span>` : '';
  // 还没轮到打分时给个占位，免得看起来像打分失败
  const pendingBadge =
    score == null && !filtered && state.config.ai && state.config.ai.enabled
      ? '<span class="ai-score pending" title="已排进后台评分队列">待评</span>'
      : '';

  return `
    <article class="card ${filtered ? 'filtered' : ''} ${hasCover ? '' : 'no-cover'}" data-id="${esc(item.id)}">
      ${
        hasCover
          ? `<div class="card-cover" style="background-image:url('${cover}')" data-act="open">
               <span class="play-badge"><span>▶</span></span>
             </div>`
          : ''
      }
      <div class="card-body">
        <div class="card-head">${sourceTag}${scoreBadge}${pendingBadge}${flagHtml}</div>
        <div class="card-title" data-act="open">${esc(item.title)}</div>
        <div class="card-meta">${metaBits.join('')}</div>
        ${summary ? `<div class="card-summary">✨ ${esc(summary)}</div>` : item.desc ? `<div class="card-desc">${esc(item.desc)}</div>` : ''}
        ${showReason && reasonText ? `<div class="card-reason">${esc(reasonText)}</div>` : ''}
        ${tags.length ? `<div class="card-tags">${tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
        ${playable ? `<div class="card-player" data-player></div>` : ''}
        <div class="card-actions">
          ${playable ? `<button class="icon-btn" data-act="play" title="在卡片里播放">▶</button>` : ''}
          <button class="icon-btn up ${item.feedback === 'up' ? 'on' : ''}" data-act="up" title="赞：告诉 AI 你喜欢这类内容">👍</button>
          <button class="icon-btn down ${item.feedback === 'down' ? 'on' : ''}" data-act="down" title="踩：告诉 AI 你不喜欢这类内容">👎</button>
          <button class="icon-btn" data-act="summarize" title="生成 AI 摘要">✨</button>
          <button class="icon-btn star ${item.starred ? 'on' : ''}" data-act="star" title="收藏">★</button>
          <button class="icon-btn" data-act="copy" title="复制链接">⧉</button>
          <span class="spacer"></span>
          <button class="icon-btn" data-act="open" title="${esc(safeUrl(item.url))}">🔗</button>
        </div>
      </div>
    </article>`;
}

function bindFeed() {
  $('#feed').addEventListener('click', async (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    const id = card.dataset.id;
    const item = state.items.find((it) => it.id === id);
    if (!item) return;
    const act = e.target.dataset.act;

    if (act === 'open') {
      const link = safeUrl(item.url);
      if (link) window.open(link, '_blank', 'noopener');
      else toast('该条目的链接地址无效，已阻止打开', true);
      api('/api/items/seen', { method: 'POST', body: { id } }).catch(() => {});
    } else if (act === 'star') {
      const next = !item.starred;
      item.starred = next;
      card.querySelector('[data-act="star"]').classList.toggle('on', next);
      try {
        await api('/api/items/star', { method: 'POST', body: { id, value: next } });
        toast(next ? '已加入收藏' : '已取消收藏');
      } catch (err) {
        item.starred = !next;
        toast(err.message, true);
      }
    } else if (act === 'copy') {
      try {
        await navigator.clipboard.writeText(item.url || item.title);
        toast('已复制链接');
      } catch {
        toast('复制失败，请手动复制', true);
      }
    } else if (act === 'up' || act === 'down') {
      const next = item.feedback === act ? null : act;
      const prev = item.feedback;
      item.feedback = next;
      card.querySelector('[data-act="up"]').classList.toggle('on', next === 'up');
      card.querySelector('[data-act="down"]').classList.toggle('on', next === 'down');
      try {
        const r = await api('/api/items/feedback', { method: 'POST', body: { id, value: next } });
        const label = next === 'up' ? '已记下：喜欢这类' : next === 'down' ? '已记下：不喜欢这类' : '已取消反馈';
        toast(`${label}（赞 ${r.upTotal} / 踩 ${r.downTotal}，AI 下次打分会参考）`);
        refreshStats();
      } catch (err) {
        item.feedback = prev;
        card.querySelector('[data-act="up"]').classList.toggle('on', prev === 'up');
        card.querySelector('[data-act="down"]').classList.toggle('on', prev === 'down');
        toast(err.message, true);
      }
    } else if (act === 'summarize') {
      const btn = e.target;
      if (btn.dataset.busy === '1') return;
      btn.dataset.busy = '1';
      btn.textContent = '…';
      try {
        const r = await api('/api/items/summarize', { method: 'POST', body: { id } });
        item.ai = { ...(item.ai || {}), summary: r.summary };
        renderFeed();
        toast('摘要已生成');
        refreshStats();
      } catch (err) {
        btn.dataset.busy = '0';
        btn.textContent = '✨';
        toast(err.message, true);
      }
    } else if (act === 'play') {
      togglePlayer(card, item);
    }
  });
}

/** 卡片内展开/收起 B站播放器 */
function togglePlayer(card, item) {
  const box = card.querySelector('[data-player]');
  if (!box) return;

  if (box.dataset.open === '1') {
    box.innerHTML = '';
    box.dataset.open = '0';
    box.classList.remove('open');
    return;
  }

  const bvid = item.extra && item.extra.bvid;
  const url = safeUrl(item.url);
  if (!bvid || !url.startsWith('https://www.bilibili.com/')) {
    toast('该条目没有可内嵌播放的视频', true);
    return;
  }

  box.innerHTML = `<iframe
      src="https://player.bilibili.com/player.html?bvid=${encodeURIComponent(bvid)}&autoplay=1&high_quality=1&danmaku=0"
      scrolling="no" frameborder="no" framespacing="0" allowfullscreen="true"
      referrerpolicy="no-referrer"></iframe>`;
  box.dataset.open = '1';
  box.classList.add('open');
}

async function loadItems(reset = true) {
  if (state.loading) return;
  state.loading = true;
  if (reset) state.page = 1;
  const params = new URLSearchParams({
    page: state.page,
    pageSize: state.pageSize,
    sort: state.sort,
    q: state.q,
    sourceId: state.sourceId,
  });
  if (state.view === 'starred') params.set('starred', '1');
  if (state.view === 'filtered') params.set('status', 'filtered');

  try {
    const r = await api('/api/items?' + params);
    state.total = r.total;
    state.items = reset ? r.items : [...state.items, ...r.items];
    renderFeed(reset);
  } catch (err) {
    toast('加载失败：' + err.message, true);
  } finally {
    state.loading = false;
  }
}

function renderFeed() {
  const feed = $('#feed');
  if (!state.items.length) {
    feed.innerHTML = `<div class="empty">${
      state.fetching ? '正在抓取内容…' : '信息池还是空的，点右上角「立即抓取」试试。'
    }</div>`;
    $('#feed-more').innerHTML = '';
    return;
  }

  const cols = Math.max(1, LAYOUT_COLS[state.config.layout] || 1);
  if (cols === 1) {
    feed.className = 'feed list';
    feed.innerHTML = state.items.map(cardHtml).join('');
  } else {
    // 轮流分配到各列：视觉顺序仍是「从左到右、从上到下」，但卡片高度各自适应
    const buckets = Array.from({ length: cols }, () => []);
    state.items.forEach((item, i) => buckets[i % cols].push(item));
    feed.className = `feed cols-${cols}`;
    feed.innerHTML = buckets.map((cards) => `<div class="feed-col">${cards.map(cardHtml).join('')}</div>`).join('');
  }

  const more = state.items.length < state.total;
  $('#feed-more').innerHTML = more
    ? `<button class="btn" id="btn-more">加载更多（${state.items.length}/${state.total}）</button>`
    : `<span class="hint">已显示全部 ${state.total} 条</span>`;
  const btn = $('#btn-more');
  if (btn) btn.onclick = () => {
    state.page += 1;
    loadItems(false);
  };
}

/* ============================== 统计面板 ============================== */

/** 今日漏斗：抓回 → 各阶段剔除 → 最终入池 */
function renderFunnel(s) {
  const f = s.funnel;
  if (!f) return;
  $('#funnel-day').textContent = f.day || '';
  const order = ['fetched', 'keyword', 'dedup', 'aiSpam', 'aiFlame', 'aiEmo', 'aiInterest', 'kept'];
  const parts = order
    .filter((k) => (f.counts[k] || 0) > 0)
    .map((k) => {
      const label = (f.labels && f.labels[k]) || k;
      const cls = k === 'kept' ? 'funnel-kept' : k === 'fetched' ? 'funnel-in' : 'funnel-out';
      return `<span class="funnel-step ${cls}"><i>${esc(label)}</i><b>${f.counts[k]}</b></span>`;
    });
  $('#funnel-body').innerHTML = parts.length
    ? parts.join('<span class="funnel-arrow">›</span>')
    : '<div class="hint">今天还没有抓取记录</div>';
}

/** 各数据源产出率 */
function renderYield(s) {
  const box = $('#yield-body');
  const rows = [...(s.sourceYield || [])].sort((a, b) => b.yield - a.yield);
  if (!rows.length) {
    box.innerHTML = '<div class="hint">还没有统计数据，抓几轮后出现</div>';
    return;
  }
  const names = new Map((state.config.sources || []).map((x) => [x.id, x.name]));
  box.innerHTML = rows
    .map((r) => {
      const name = names.get(r.sourceId) || r.sourceId;
      const pct = Math.round((r.yield || 0) * 100);
      const tip = `抓回 ${r.fetched} 条，存活 ${r.kept} 条${r.throttled ? '（本轮被跳过）' : ''}`;
      return `<div class="yield-row ${r.throttled ? 'throttled' : ''}" title="${esc(tip)}">
        <span class="yield-name">${esc(name)}</span>
        <span class="yield-bar"><i style="width:${Math.min(100, pct)}%"></i></span>
        <span class="yield-pct">${pct}%</span>
      </div>`;
    })
    .join('');
}

/** 待评分条数：还没评完就定期回来看一眼，评完自动停 */
function renderPending(s) {
  const n = Number(s.scoringPending) || 0;
  $('#stat-pending').textContent = n ? `${n} 条` : '已全部评完';
  if (n && !state.scoreTimer) {
    state.scoreTimer = setInterval(async () => {
      await refreshStats();
      loadItems();
    }, 6000);
  } else if (!n && state.scoreTimer) {
    clearInterval(state.scoreTimer);
    state.scoreTimer = null;
  }
}

async function refreshStats() {
  try {
    const s = await api('/api/stats');
    const todayCount = s.bySource.reduce((acc, r) => acc + r.today, 0);
    $('#stat-today').textContent = `${todayCount} 条`;
    $('#stat-filtered').textContent = `${s.stats.aiFiltered} 条`;
    $('#stat-feedback').textContent = `${s.feedbackUp || 0} / ${s.feedbackDown || 0}`;
    $('#stat-calls').textContent = `${s.stats.aiCalls} 次`;
    $('#stat-cost').textContent = `约 ¥${Number(s.stats.aiCost || 0).toFixed(4)}`;
    $('#stat-ai').textContent = state.config.ai.enabled ? (state.config.ai.apiKey ? '已启用' : '缺少 Key') : '未启用';
    renderFunnel(s);
    renderYield(s);
    renderPending(s);

    const box = $('#source-stats');
    box.innerHTML = '';
    if (!s.bySource.length) {
      box.innerHTML = '<div class="hint">暂无数据源统计</div>';
    }
    for (const row of s.bySource) {
      const el = document.createElement('div');
      el.className = 'stat-source';
      el.innerHTML = `
        <span class="dot ${row.today ? '' : 'idle'}"></span>
        <div class="info">
          <div class="name">${esc(row.sourceName || row.sourceId)}</div>
          <div class="sub">今日 ${row.today} · 剔除 ${row.filtered} · 共 ${row.total}</div>
        </div>
        <div class="num">${row.total}</div>`;
      box.appendChild(el);
    }
  } catch (err) {
    toast('统计刷新失败：' + err.message, true);
  }
}

/* ============================== 抓取 ============================== */

async function triggerFetch() {
  if (state.fetching) return;
  state.fetching = true;
  const btn = $('#btn-fetch');
  btn.disabled = true;
  btn.textContent = '抓取中…';
  renderFeed();

  try {
    const r = await api('/api/fetch', { method: 'POST', body: {} });
    const rows = r.summary.sources || [];
    const added = rows.reduce((a, x) => a + x.new, 0);
    const kw = rows.reduce((a, x) => a + x.keywordFiltered, 0);
    const ai = rows.reduce((a, x) => a + x.aiFiltered, 0);
    const errors = rows.filter((x) => x.error);
    toast(`抓取完成：新增 ${added} 条，关键词剔除 ${kw} 条，AI 剔除 ${ai} 条`);
    if (errors.length) toast(`${errors.length} 个源失败：${errors[0].error}`, true);
    await loadItems(true);
    await refreshStats();
  } catch (err) {
    toast('抓取失败：' + err.message, true);
  } finally {
    state.fetching = false;
    btn.disabled = false;
    btn.textContent = '立即抓取';
  }
}

/* ============================== AI 对话 ============================== */

function appendMsg(role, text, meta = '') {
  const log = $('#chat-log');
  const el = document.createElement('div');
  el.className = 'msg ' + role;
  el.innerHTML = `${esc(text)}${meta ? `<div class="meta">${esc(meta)}</div>` : ''}`;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

async function sendChat() {
  const input = $('#chat-text');
  const question = input.value.trim();
  if (!question) return;
  if (!state.config.ai.apiKey) {
    toast('请先在左侧填写 AI API Key', true);
    return;
  }
  input.value = '';
  appendMsg('user', question);
  const pending = appendMsg('ai', '思考中…');
  try {
    const r = await api('/api/ai/ask', { method: 'POST', body: { question } });
    pending.innerHTML = esc(r.answer) + `<div class="meta">${esc(r.usage.model)} · ¥${Number(r.usage.cost).toFixed(5)}</div>`;
    refreshStats();
  } catch (err) {
    pending.innerHTML = `<span style="color:var(--danger)">出错了：${esc(err.message)}</span>`;
  }
}

/* ============================== 每日简报 ============================== */

/** 极简 markdown 渲染（粗体 / 行内代码 / 无序列表 / 标题 / 段落），先转义再替换 */
function renderMarkdown(text) {
  const inline = (s) =>
    esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');

  const out = [];
  let inList = false;
  const closeList = () => {
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
  };

  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) {
      closeList();
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }

    closeList();

    const heading = line.match(/^#{1,4}\s+(.*)$/);
    if (heading) {
      out.push(`<h4>${inline(heading[1])}</h4>`);
      continue;
    }

    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join('');
}

let lastDigest = null;

/**
 * 没有综述时给出真实原因，避免把「这段时间没内容」误报成「没启用 AI」
 * （除了 aiError 需要转义，其余都是固定文案或数字）
 */
function digestHint(d) {
  if (!d.total) {
    return `最近 ${d.hours} 小时没有筛选出的新内容 · 把时间范围调大一些，或先点「立即抓取」`;
  }
  if (d.aiError) return `AI 综述失败：${esc(d.aiError)}`;
  if (d.aiSkipped === 'no-ai') return '（未启用 AI，以下是原始条目）';
  return '（AI 未生成综述，以下是原始条目）';
}

function renderDigest(d) {
  const box = $('#digest-body');
  if (!d) {
    box.innerHTML = '<div class="hint">还没有简报。选好时间范围后点「生成简报」。</div>';
    return;
  }
  lastDigest = d;

  const time = new Date(d.generatedAt).toLocaleString('zh-CN', { hour12: false });
  const sources = (d.bySource || []).map((s) => `${esc(s.name)} ${s.count}`).join(' · ');
  // 面板里只放综述的前几段，完整内容在弹窗里看
  const preview = (d.overview || '').split('\n').filter(Boolean).slice(0, 3).join('\n');

  box.innerHTML = `
    <div class="digest-meta">${esc(time)} · 最近 ${d.hours} 小时 · ${d.total} 条${d.model ? ` · ${esc(d.model)}` : ''}</div>
    ${sources ? `<div class="digest-sources">${sources}</div>` : ''}
    ${preview ? `<div class="digest-preview">${renderMarkdown(preview)}</div>` : `<div class="hint">${digestHint(d)}</div>`}
    <button class="btn btn-primary btn-block" id="btn-digest-open">查看完整简报（${d.total} 条）</button>
    <div class="digest-list">
      ${(d.items || [])
        .slice(0, 6)
        .map((it) => {
          const link = safeUrl(it.url);
          const meta = [it.sourceName, it.author].filter(Boolean).join(' · ');
          return `
        <div class="digest-item">
          <div class="digest-item-title" ${link ? `data-open-url="${esc(link)}"` : ''}>${esc(it.title)}</div>
          <div class="digest-item-meta">${esc(meta)}</div>
        </div>`;
        })
        .join('')}
      ${d.items && d.items.length > 6 ? `<div class="hint">…还有 ${d.items.length - 6} 条，点上面的按钮看全部</div>` : ''}
    </div>`;

  const openBtn = $('#btn-digest-open');
  if (openBtn) openBtn.onclick = () => openDigestModal(d);
}

/** 完整简报弹窗：宽排版，行距宽松 */
function openDigestModal(d) {
  const data = d || lastDigest;
  if (!data) return;

  const time = new Date(data.generatedAt).toLocaleString('zh-CN', { hour12: false });
  const sources = (data.bySource || []).map((s) => `${esc(s.name)} ${s.count}`).join(' · ');

  $('#digest-modal-title').textContent = `每日简报 · ${data.date}`;
  $('#digest-modal-body').innerHTML = `
    <div class="digest-doc">
      <div class="digest-doc-meta">${esc(time)} · 最近 ${data.hours} 小时 · 共 ${data.total} 条${data.model ? ` · ${esc(data.model)}` : ''}</div>
      ${sources ? `<div class="digest-doc-sources">来源分布：${sources}</div>` : ''}
      ${
        data.overview
          ? `<div class="digest-doc-body">${renderMarkdown(data.overview)}</div>`
          : `<div class="hint">${digestHint(data)}</div>`
      }
      <h4 class="digest-doc-h">全部条目（${(data.items || []).length}）</h4>
      <ol class="digest-doc-list">
        ${(data.items || [])
          .map((it) => {
            const link = safeUrl(it.url);
            const meta = [it.sourceName, it.author].filter(Boolean).join(' · ');
            const score = typeof it.score === 'number' ? ` · AI ${it.score}/10` : '';
            const tags = (it.tags || []).length ? ` · ${it.tags.map((t) => esc(t)).join('/')}` : '';
            return `<li>
              <div class="digest-doc-title" ${link ? `data-open-url="${esc(link)}"` : ''}>${esc(it.title)}</div>
              <div class="digest-doc-item-meta">${esc(meta)}${score}${tags}</div>
              ${it.summary ? `<div class="digest-doc-summary">${esc(it.summary)}</div>` : ''}
            </li>`;
          })
          .join('')}
      </ol>
    </div>`;

  $('#digest-modal').classList.remove('hidden');
}

async function generateDigest() {
  const btn = $('#btn-digest');
  btn.disabled = true;
  btn.textContent = '生成中…';
  try {
    const hours = Number($('#digest-hours').value) || 24;
    const r = await api('/api/digest', { method: 'POST', body: { hours } });
    renderDigest(r.digest);
    toast(`简报已生成：${r.digest.total} 条`);
    refreshStats();
  } catch (err) {
    toast('生成失败：' + err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '生成简报';
  }
}

async function loadLatestDigest() {
  try {
    const list = await api('/api/digest');
    const first = (list.digests || [])[0];
    if (!first) return;
    const r = await api('/api/digest?file=' + encodeURIComponent(first.file));
    renderDigest(r.digest);
  } catch {}
}

/* ============================== 事件绑定 ============================== */

function bindEvents() {
  // 主题 / 布局 / 尺寸
  $('#seg-theme').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.config.theme = b.dataset.value;
    applyAppearance();
    syncAppearanceControls();
    persistConfig();
  });
  $('#seg-layout').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.config.layout = b.dataset.value;
    applyAppearance();
    syncAppearanceControls();
    persistConfig();
    renderFeed(); // 栏数变了要重新分列
  });
  $('#seg-cardsize').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.config.cardSize = b.dataset.value;
    applyAppearance();
    syncAppearanceControls();
    persistConfig();
  });
  $('#seg-preview').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.config.previewScale = Number(b.dataset.value);
    applyAppearance();
    syncAppearanceControls();
    persistConfig();
  });

  // 严格匹配开关
  $('#chip-strict').onclick = () => {
    state.config.keywords.strict = !state.config.keywords.strict;
    $('#kw-strict').checked = state.config.keywords.strict;
    syncStrictChip();
    persistConfig();
    loadItems(true);
  };

  // 搜索
  $('#search').addEventListener(
    'input',
    debounce((e) => {
      state.q = e.target.value.trim();
      loadItems(true);
    }, 320),
  );

  // 视图切换
  $$('.tab[data-view]').forEach((btn) => {
    btn.onclick = () => {
      const view = btn.dataset.view;
      state.view = state.view === view ? 'all' : view;
      $$('.tab[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === state.view));
      loadItems(true);
    };
  });

  $('#source-filter').onchange = (e) => {
    state.sourceId = e.target.value;
    loadItems(true);
  };

  $('#sort-select').onchange = (e) => {
    state.sort = e.target.value;
    loadItems(true);
  };

  $('#btn-fetch').onclick = triggerFetch;

  $('#btn-clear').onclick = async () => {
    if (!confirm('清空信息池中所有未收藏的内容？此操作不可撤销。')) return;
    try {
      const r = await api('/api/items/clear', { method: 'POST', body: {} });
      toast(`已清空 ${r.removed} 条`);
      loadItems(true);
      refreshStats();
    } catch (err) {
      toast(err.message, true);
    }
  };

  $('#btn-refresh-stats').onclick = () => {
    refreshStats();
    toast('已刷新');
  };

  // 右侧面板切换
  $$('.ins-tab').forEach((tab) => {
    tab.onclick = () => {
      $$('.ins-tab').forEach((t) => t.classList.toggle('active', t === tab));
      $('#pane-stats').classList.toggle('hidden', tab.dataset.pane !== 'stats');
      $('#pane-digest').classList.toggle('hidden', tab.dataset.pane !== 'digest');
      $('#pane-chat').classList.toggle('hidden', tab.dataset.pane !== 'chat');
    };
  });

  // 扫码弹窗
  const closeQrModal = () => {
    const id = qrSessionId;
    stopQrPolling();
    $('#qr-modal').classList.add('hidden');
    // 让后端把扫码会话的浏览器也关掉，避免残留进程
    if (id) api('/api/accounts/qr', { method: 'POST', body: { action: 'close', id } }).catch(() => {});
  };
  $('#qr-close').onclick = closeQrModal;
  $('#qr-refresh').onclick = () => refreshQrCode();
  $('#qr-modal').addEventListener('click', (e) => {
    if (e.target.id === 'qr-modal') closeQrModal();
  });

  // 简报
  $('#btn-digest').onclick = generateDigest;
  $('#digest-body').addEventListener('click', (e) => {
    const el = e.target.closest('[data-open-url]');
    if (!el) return;
    const url = safeUrl(el.dataset.openUrl);
    if (url) window.open(url, '_blank', 'noopener');
  });

  // 简报弹窗
  const closeDigestModal = () => $('#digest-modal').classList.add('hidden');
  $('#digest-close').onclick = closeDigestModal;
  $('#digest-modal').addEventListener('click', (e) => {
    if (e.target.id === 'digest-modal') closeDigestModal();
  });
  $('#digest-modal-body').addEventListener('click', (e) => {
    const el = e.target.closest('[data-open-url]');
    if (!el) return;
    const url = safeUrl(el.dataset.openUrl);
    if (url) window.open(url, '_blank', 'noopener');
  });

  $('#btn-chat-send').onclick = sendChat;
  $('#chat-text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) sendChat();
  });

  // 设置保存
  $('#btn-save').onclick = () => persistConfig(true);
  $('#ai-minscore').addEventListener('input', (e) => {
    $('#ai-minscore-label').textContent = e.target.value;
  });

  $('#btn-ai-test').onclick = async () => {
    const hint = $('#ai-hint');
    hint.textContent = '测试中…';
    hint.className = 'hint';
    await persistConfig();
    try {
      const r = await api('/api/ai/test', { method: 'POST' });
      hint.textContent = `连接成功：${r.model}（约 ¥${Number(r.cost).toFixed(6)}）`;
      hint.className = 'hint ok';
      refreshStats();
    } catch (err) {
      hint.textContent = '连接失败：' + err.message;
      hint.className = 'hint err';
    }
  };

  $('#btn-reapply').onclick = async () => {
    const hint = $('#ai-hint');
    hint.textContent = '正在重新过滤…';
    hint.className = 'hint';
    await persistConfig();
    try {
      const r = await api('/api/filters/reapply', { method: 'POST' });
      hint.textContent = `已扫描 ${r.scanned} 条，更新 ${r.changed} 条`;
      hint.className = 'hint ok';
      loadItems(true);
      refreshStats();
    } catch (err) {
      hint.textContent = '失败：' + err.message;
      hint.className = 'hint err';
    }
  };

  $('#btn-add-source').onclick = () => openSourceModal();

  // 数据源编辑弹窗
  $('#source-close').onclick = closeSourceModal;
  $('#source-cancel').onclick = closeSourceModal;
  $('#source-save').onclick = () => saveSourceModal();
  $('#source-modal').addEventListener('click', (e) => {
    if (e.target.id === 'source-modal') closeSourceModal();
  });

  // 导出
  $$('[data-export]').forEach((btn) => {
    btn.onclick = () => {
      const type = btn.dataset.export;
      const a = document.createElement('a');
      a.href = `/api/export?type=${encodeURIComponent(type)}`;
      a.download = '';
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast('已开始下载，数据目录的 exports/ 里也留了一份');
    };
  });

  // 自动保存文本类设置
  ['#kw-any', '#kw-must', '#kw-exclude', '#ai-baseurl', '#ai-apikey', '#ai-model', '#ai-interests', '#fetch-limit', '#fetch-interval', '#ai-scorettl'].forEach(
    (sel) => {
      const el = $(sel);
      if (el) el.addEventListener('input', debouncedPersist);
    },
  );
  ['#kw-strict', '#ai-enabled', '#chk-reason', '#chk-tray', '#chk-notify', '#ai-strictness'].forEach((sel) => {
    const el = $(sel);
    if (el) el.addEventListener('change', () => persistConfig());
  });
}

function syncStrictChip() {
  const on = state.config.keywords.strict !== false;
  $('#chip-strict').classList.toggle('active', on);
  $('#chip-strict').title = on ? '严格匹配：标题必须命中关注词' : '宽松匹配：标题、简介、作者任一命中即可';
}

/* ============================== 启动 ============================== */

async function boot() {
  try {
    const b = await api('/api/bootstrap');
    state.config = b.config;
    $('#version').textContent = 'v' + b.version;

    renderSwatches();
    applyAppearance();
    syncAppearanceControls();
    fillConfigForm();
    syncStrictChip();
    bindEvents();
    bindFeed();

    await loadItems(true);
    await refreshStats();
    await loadLatestDigest();
  } catch (err) {
    document.body.innerHTML = `<div style="padding:40px;color:#ff6b6b;font-family:sans-serif">
      启动失败：${esc(err.message)}<br /><br />请确认服务已启动（npm start）。</div>`;
  }
}

boot();
