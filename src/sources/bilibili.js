'use strict';

/**
 * B 站适配器
 * 支持四种模式：search（关键词搜索）/ ranking（排行榜）/ popular（热门）/ user（UP 主投稿）
 * 全部接口都需要 WBI 签名，部分还需要 buvid3 cookie —— 这里自行获取并缓存。
 */

const crypto = require('crypto');
const { getJson, sleep } = require('../http');

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

// WBI 签名用的乱序表（B 站前端固定常量）
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28,
  14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21,
  56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

const HEADERS = {
  Referer: 'https://www.bilibili.com/',
  Origin: 'https://www.bilibili.com',
  Accept: 'application/json, text/plain, */*',
};

const session = {
  cookie: '',
  imgKey: '',
  subKey: '',
  fetchedAt: 0,
};

function mixinKey(imgKey, subKey) {
  const raw = imgKey + subKey;
  return MIXIN_KEY_ENC_TAB.map((n) => raw[n]).join('').slice(0, 32);
}

function signQuery(params, imgKey, subKey) {
  const key = mixinKey(imgKey, subKey);
  const signed = { ...params, wts: Math.round(Date.now() / 1000) };
  const query = Object.keys(signed)
    .sort()
    .map((k) => {
      const v = String(signed[k]).replace(/[!'()*]/g, '');
      return `${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
    })
    .join('&');
  return `${query}&w_rid=${md5(query + key)}`;
}

/** 获取 buvid3 + WBI 密钥，30 分钟内复用 */
async function ensureSession(timeoutMs) {
  if (session.imgKey && Date.now() - session.fetchedAt < 30 * 60 * 1000) return session;

  try {
    const spi = await getJson('https://api.bilibili.com/x/frontend/finger/spi', { headers: HEADERS, timeoutMs });
    if (spi && spi.code === 0 && spi.data) {
      session.cookie = `buvid3=${spi.data.b_4}; buvid4=${spi.data.b_3}`;
    }
  } catch (err) {
    console.warn('[bilibili] 获取 buvid 失败，继续匿名请求:', err.message);
  }

  const nav = await getJson('https://api.bilibili.com/x/web-interface/nav', {
    headers: { ...HEADERS, Cookie: session.cookie },
    timeoutMs,
  });
  const img = nav && nav.data && nav.data.wbi_img ? nav.data.wbi_img : null;
  if (!img) throw new Error('无法获取 WBI 密钥（B 站 nav 接口异常）');
  session.imgKey = img.img_url.split('/').pop().split('.')[0];
  session.subKey = img.sub_url.split('/').pop().split('.')[0];
  session.fetchedAt = Date.now();
  return session;
}

/** 全局账号 Cookie（填了就以登录态请求，能拿到更完整的内容） */
function accountCookie() {
  try {
    return require('../accounts').getCookie('bilibili');
  } catch {
    return '';
  }
}

async function callApi(pathname, params, { timeoutMs, signed = true } = {}) {
  const s = await ensureSession(timeoutMs);
  const query = signed ? signQuery(params, s.imgKey, s.subKey) : new URLSearchParams(params).toString();
  const url = `https://api.bilibili.com${pathname}${query ? '?' + query : ''}`;
  const cookie = [s.cookie, accountCookie()].filter(Boolean).join('; ');
  const json = await getJson(url, { headers: { ...HEADERS, Cookie: cookie }, timeoutMs });
  if (json.code !== 0) {
    const err = new Error(`B站接口 ${pathname} 返回 code=${json.code} msg=${json.message || ''}`);
    err.code = json.code;
    throw err;
  }
  return json.data;
}

const cleanTitle = (t = '') => String(t).replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').trim();
const fixPic = (p = '') => (p.startsWith('//') ? 'https:' + p : p);
const toMs = (sec) => (sec ? Number(sec) * 1000 : 0);
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function normalizeVideo(v, source, mode) {
  const bvid = v.bvid || (v.aid ? 'av' + v.aid : '');
  if (!bvid) return null;
  const stat = v.stat || {};
  const owner = v.owner || {};
  return {
    id: `bilibili:${bvid}`,
    sourceId: source.id,
    sourceType: 'bilibili',
    sourceName: source.name,
    sourceMode: mode,
    title: cleanTitle(v.title),
    author: v.author || owner.name || '',
    authorId: String(v.mid || owner.mid || ''),
    cover: fixPic(v.pic || v.pic_url || ''),
    url: `https://www.bilibili.com/video/${bvid}`,
    desc: String(v.description || v.desc || '').slice(0, 300),
    stats: {
      play: num(v.play ?? stat.view),
      danmaku: num(v.video_review ?? stat.danmaku),
      like: num(v.like ?? stat.like),
      reply: num(v.review ?? stat.reply),
      favorite: num(v.favorites ?? stat.favorite),
      coin: num(stat.coin),
    },
    publishedAt: toMs(v.pubdate || v.pub_date || v.created),
    fetchedAt: Date.now(),
    extra: { bvid, duration: v.duration || '', tag: v.typename || v.tname || '' },
    status: 'kept',
    starred: false,
    seen: false,
  };
}

async function fetchSearch(source, { timeoutMs, limit }) {
  const keyword = String(source.options.keyword || '').trim();
  if (!keyword) throw new Error('搜索源缺少 keyword');
  const pageSize = Math.min(50, limit || source.options.pageSize || 24);
  const data = await callApi('/x/web-interface/wbi/search/type', {
    search_type: 'video',
    keyword,
    page: 1,
    page_size: pageSize,
  }, { timeoutMs });
  const list = (data && data.result) || [];
  return list.map((v) => normalizeVideo(v, source, 'search')).filter(Boolean);
}

async function fetchRanking(source, { timeoutMs, limit }) {
  const rid = Number(source.options.rid ?? 0);
  const data = await callApi('/x/web-interface/ranking/v2', { rid, type: 'all' }, { timeoutMs });
  const list = ((data && data.list) || []).slice(0, limit || 24);
  return list.map((v) => normalizeVideo(v, source, 'ranking')).filter(Boolean);
}

async function fetchPopular(source, { timeoutMs, limit }) {
  const ps = Math.min(50, limit || 24);
  const data = await callApi('/x/web-interface/popular', { ps, pn: 1 }, { timeoutMs });
  const list = (data && data.list) || [];
  return list.map((v) => normalizeVideo(v, source, 'popular')).filter(Boolean);
}

async function fetchUser(source, { timeoutMs, limit }) {
  const mid = String(source.options.mid || '').trim();
  if (!/^\d+$/.test(mid)) throw new Error('UP 主源缺少合法的 mid');
  const ps = Math.min(50, limit || 24);
  const data = await callApi('/x/space/wbi/arc/search', {
    mid,
    ps,
    pn: 1,
    order: source.options.order || 'pubdate',
  }, { timeoutMs });
  const list = (data && data.list && data.list.vlist) || [];
  return list.map((v) => normalizeVideo(v, source, 'user')).filter(Boolean);
}

/** 把「关注动态」里的一条动态归一化（视频动态 + 图文动态都支持） */
function normalizeDynamic(dyn, source) {
  if (!dyn) return null;
  const author = (dyn.modules && dyn.modules.module_author) || {};
  const dynamic = (dyn.modules && dyn.modules.module_dynamic) || {};
  const major = dynamic.major || {};
  const archive = major.archive || null;
  const stat = (dyn.modules && dyn.modules.module_stat) || {};
  const descText = (dynamic.desc && dynamic.desc.text) || '';
  const publishedAt = author.pub_ts ? Number(author.pub_ts) * 1000 : 0;

  if (archive && archive.bvid) {
    const aStat = archive.stat || {};
    return {
      id: `bilibili:${archive.bvid}`,
      sourceId: source.id,
      sourceType: 'bilibili',
      sourceName: source.name,
      sourceMode: 'following',
      title: cleanTitle(archive.title || ''),
      author: author.name || '',
      authorId: String(author.mid || ''),
      cover: fixPic(archive.cover || ''),
      url: `https://www.bilibili.com/video/${archive.bvid}`,
      desc: String(archive.desc || descText || '').slice(0, 300),
      stats: {
        play: num(aStat.play),
        danmaku: num(aStat.danmaku),
        like: num(aStat.like ?? (stat.like && stat.like.count)),
        reply: num(stat.comment && stat.comment.count),
        favorite: num(aStat.favorite),
        coin: num(aStat.coin),
      },
      publishedAt: publishedAt || toMs(archive.pubdate),
      fetchedAt: Date.now(),
      extra: { bvid: archive.bvid, dynamicId: dyn.id_str || '', from: 'following', duration: archive.duration_text || '' },
      status: 'kept',
      starred: false,
      seen: false,
    };
  }

  // 图文 / 转发类动态
  const title = cleanTitle(descText).slice(0, 80);
  if (!title) return null;
  const pics = (dynamic.major && dynamic.major.draw && dynamic.major.draw.items) || [];
  const cover = pics[0] && pics[0].src ? fixPic(pics[0].src) : '';
  return {
    id: `bilibili:dynamic:${dyn.id_str || author.mid + '-' + publishedAt}`,
    sourceId: source.id,
    sourceType: 'bilibili',
    sourceName: source.name,
    sourceMode: 'following',
    title,
    author: author.name || '',
    authorId: String(author.mid || ''),
    cover,
    url: `https://t.bilibili.com/${dyn.id_str || ''}`,
    desc: cleanTitle(descText).slice(0, 300),
    stats: {
      like: num(stat.like && stat.like.count),
      reply: num(stat.comment && stat.comment.count),
      forward: num(stat.forward && stat.forward.count),
    },
    publishedAt,
    fetchedAt: Date.now(),
    extra: { dynamicId: dyn.id_str || '', from: 'following' },
    status: 'kept',
    starred: false,
    seen: false,
  };
}

/** 关注 UP 主动态（需要登录：在「账号」里填 SESSDATA） */
async function fetchFollowing(source, { timeoutMs, limit }) {
  const want = Math.min(50, limit || 24);
  const items = [];
  let offset = '';
  let page = 1;

  while (items.length < want && page <= 4) {
    const params = { page };
    if (offset) params.offset = offset;
    let data;
    try {
      data = await callApi('/x/polymer/web-dynamic/v1/feed/all', params, { timeoutMs });
    } catch (err) {
      if (err.code === -101) {
        throw new Error('B站「关注动态」需要登录：请在左侧「账号」里填入自己的 SESSDATA');
      }
      throw err;
    }
    const list = (data && data.items) || [];
    if (!list.length) break;
    for (const dyn of list) {
      const it = normalizeDynamic(dyn, source);
      if (it) items.push(it);
    }
    if (!data.has_more) break;
    offset = data.offset || '';
    page += 1;
    await sleep(300);
  }

  return items.slice(0, want);
}

/**
 * 统一入口
 * @param {object} source 配置里的源对象
 * @param {{timeoutMs:number, limit:number}} ctx
 */
async function fetchItems(source, ctx = {}) {
  const timeoutMs = ctx.timeoutMs || 15000;
  const limit = ctx.limit || source.options.pageSize || 24;
  const mode = source.options.mode || 'search';
  const runners = {
    search: fetchSearch,
    ranking: fetchRanking,
    popular: fetchPopular,
    user: fetchUser,
    following: fetchFollowing,
  };
  const runner = runners[mode];
  if (!runner) throw new Error(`不支持的 B 站模式: ${mode}`);
  const items = await runner(source, { timeoutMs, limit });
  await sleep(200); // 轻微节流，避免触发风控
  return items;
}

/** 给前端设置面板用的模式说明 */
const MODES = [
  { value: 'search', label: '关键词搜索', fields: ['keyword'] },
  { value: 'ranking', label: '全站排行榜', fields: ['rid'] },
  { value: 'popular', label: '热门推荐', fields: [] },
  { value: 'user', label: 'UP 主投稿', fields: ['mid'] },
  { value: 'following', label: '关注动态（需登录）', fields: [] },
];

module.exports = {
  type: 'bilibili',
  label: 'B站',
  fetchItems,
  MODES,
  _internal: { signQuery, mixinKey, normalizeDynamic },
};
