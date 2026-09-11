'use strict';

/**
 * 贴吧适配器
 *
 * 走 wap 版页面（tieba.baidu.com/mo/q/m），无需登录即可读取吧内帖子列表。
 * 注意：百度对无 Cookie 的请求会返回 403，所以这里会自动获取 BAIDUID；
 * 若在配置里填了自己的 Cookie（含 BDUSS），则使用登录态，稳定性更好。
 */

const { getText } = require('../http');

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const PC_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 匿名 Cookie 缓存（BAIDUID 等），有效期 30 分钟 */
const session = { cookie: '', fetchedAt: 0 };

async function ensureCookie(timeoutMs) {
  if (session.cookie && Date.now() - session.fetchedAt < 30 * 60 * 1000) return session.cookie;
  try {
    const res = await fetch('https://www.baidu.com/', {
      headers: { 'User-Agent': PC_UA },
      signal: AbortSignal.timeout(timeoutMs || 12000),
    });
    const list = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    const cookie = list.map((c) => c.split(';')[0]).join('; ');
    if (cookie) {
      session.cookie = cookie;
      session.fetchedAt = Date.now();
    }
  } catch (err) {
    console.warn('[tieba] 获取匿名 Cookie 失败:', err.message);
  }
  return session.cookie;
}

const stripTags = (s = '') =>
  String(s)
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();

/** 贴吧的 ti_time 只有 "19:59" / "9-8" 这种短格式，需要补全日期 */
function parseTiebaTime(raw) {
  const text = String(raw || '').trim();
  if (!text) return 0;
  const now = new Date();

  let m = text.match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    const d = new Date(now);
    d.setHours(Number(m[1]), Number(m[2]), 0, 0);
    if (d.getTime() > now.getTime() + 60_000) d.setDate(d.getDate() - 1); // 未来时间说明是昨天
    return d.getTime();
  }

  m = text.match(/^(\d{1,2})-(\d{1,2})$/);
  if (m) {
    const d = new Date(now.getFullYear(), Number(m[1]) - 1, Number(m[2]));
    if (d.getTime() > now.getTime() + 86_400_000) d.setFullYear(d.getFullYear() - 1);
    return d.getTime();
  }

  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 解析 wap 版帖子列表 */
function parseForumHtml(html) {
  const blocks = html.split(/<li class="tl_/).slice(1);
  const items = [];

  for (const block of blocks) {
    const seg = block.slice(0, block.indexOf('</li>') > -1 ? block.indexOf('</li>') : block.length);
    const tid = (seg.match(/data-tid="(\d+)"/) || [])[1];
    if (!tid) continue;

    const titleMatch = seg.match(/<div class="ti_title">([\s\S]*?)<\/div>/);
    const rawTitle = titleMatch ? titleMatch[1] : '';
    const title = stripTags(rawTitle.replace(/<span class="ti_title_icon[\s\S]*?<\/span>/g, ''));
    if (!title) continue;

    const author = stripTags((seg.match(/class="ti_author"[^>]*>([\s\S]*?)<\/span>/) || [])[1] || '');
    const timeText = stripTags((seg.match(/class="ti_time"[^>]*>([\s\S]*?)<\/span>/) || [])[1] || '');
    const replyBlock = (seg.match(/class="ti_zan_reply[^"]*"[^>]*>([\s\S]*?)<\/div>/) || [])[1] || '';
    const nums = [...replyBlock.matchAll(/>(\d+)</g)].map((m) => Number(m[1]));

    const isTop = /tl_top/.test(seg) || /ti_icon_zhiding/.test(rawTitle);
    const isGood = /ti_icon_jing/.test(rawTitle);

    items.push({
      tid,
      title,
      author,
      timeText,
      publishedAt: parseTiebaTime(timeText),
      reply: nums[0] || 0,
      like: nums[1] || 0,
      isTop,
      isGood,
    });
  }
  return items;
}

async function fetchForum(source, { timeoutMs, limit }) {
  const kw = String(source.options.kw || '').trim();
  if (!kw) throw new Error('贴吧源缺少吧名（kw）');

  // 源级 cookie 优先，其次全局账号，最后自动获取匿名 Cookie
  const cookie =
    require('../accounts').getCookie('tieba', source.options.cookie) || (await ensureCookie(timeoutMs));
  const url = `https://tieba.baidu.com/mo/q/m?kw=${encodeURIComponent(kw)}&lp=5028&mo_device=1`;
  const { status, text } = await getText(url, {
    timeoutMs,
    headers: {
      'User-Agent': MOBILE_UA,
      Referer: 'https://tieba.baidu.com/',
      Cookie: cookie,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });

  if (status === 403 || status === 302) {
    throw new Error(`贴吧返回 HTTP ${status}：百度风控拦截，请在数据源里填入自己的浏览器 Cookie（至少包含 BAIDUID）`);
  }
  if (status >= 400) throw new Error(`贴吧返回 HTTP ${status}`);

  const parsed = parseForumHtml(text);
  if (!parsed.length) {
    throw new Error('贴吧页面解析为空：可能被风控或页面结构变化，建议填入登录 Cookie 后重试');
  }

  return parsed
    .filter((p) => !p.isTop) // 置顶帖通常不是新内容
    .slice(0, limit || 30)
    .map((p) => ({
      id: `tieba:${p.tid}`,
      sourceId: source.id,
      sourceType: 'tieba',
      sourceName: source.name,
      sourceMode: 'forum',
      title: p.title,
      author: p.author,
      authorId: '',
      cover: '',
      url: `https://tieba.baidu.com/p/${p.tid}`,
      desc: p.isGood ? '精品帖' : '',
      stats: { reply: p.reply, like: p.like },
      publishedAt: p.publishedAt || Date.now(),
      fetchedAt: Date.now(),
      extra: { tid: p.tid, forum: kw, timeText: p.timeText },
      status: 'kept',
      starred: false,
      seen: false,
    }));
}

module.exports = {
  type: 'tieba',
  label: '贴吧',
  fetchItems: async (source, ctx = {}) => {
    const mode = source.options.mode || 'forum';
    if (mode !== 'forum') throw new Error(`贴吧暂不支持模式：${mode}`);
    return fetchForum(source, { timeoutMs: ctx.timeoutMs || 15000, limit: ctx.limit || 30 });
  },
  MODES: [{ value: 'forum', label: '吧内帖子', fields: ['kw', 'cookie'] }],
  _internal: { parseForumHtml, parseTiebaTime },
};
