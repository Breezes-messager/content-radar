'use strict';

/**
 * 小黑盒适配器
 *
 * 小黑盒 API 要求 hkey / _time / nonce 三个签名参数，算法在前端 JS 里且频繁变更，
 * 这里不去逆向它，而是：
 *   1. 用 Playwright 打开一次社区页，从网络请求里「抄」到已签名的 URL；
 *   2. 之后直接复用这个签名走纯 HTTP 抓取（实测同路径签名可长期复用）；
 *   3. 签名失效时自动回退到浏览器重新获取。
 *
 * 依赖 playwright-core（不含浏览器，使用系统已安装的 Edge / Chrome）。
 */

const { getJson, sleep } = require('../http');

const PC_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const HOME_URL = 'https://www.xiaoheihe.cn/app/bbs';
const SIGN_TTL = 6 * 60 * 60 * 1000; // 签名缓存 6 小时
const BROWSER_IDLE = 3 * 60 * 1000; // 浏览器闲置 3 分钟关闭

const state = {
  signedUrl: '',
  signedAt: 0,
  browser: null,
  browserIdleTimer: null,
  launching: null,
};

/* ------------------------- Playwright 懒加载 ------------------------- */

function loadPlaywright() {
  try {
    return require('playwright-core');
  } catch {
    throw new Error('小黑盒数据源需要 playwright-core，请先在项目目录执行：npm install playwright-core');
  }
}

async function launchBrowser() {
  const { chromium } = loadPlaywright();
  const attempts = [{ channel: 'msedge', headless: true }, { channel: 'chrome', headless: true }, { headless: true }];
  let lastErr = null;
  for (const opts of attempts) {
    try {
      const browser = await chromium.launch(opts);
      console.log(`[xiaoheihe] 已启动浏览器（${opts.channel || 'chromium'}）`);
      return browser;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`无法启动浏览器（需要系统安装 Edge 或 Chrome）：${lastErr ? lastErr.message : ''}`);
}

async function getBrowser() {
  if (state.browser && state.browser.isConnected()) return state.browser;
  if (!state.launching) {
    state.launching = launchBrowser()
      .then((b) => {
        state.browser = b;
        b.on('disconnected', () => {
          state.browser = null;
        });
        return b;
      })
      .finally(() => {
        state.launching = null;
      });
  }
  return state.launching;
}

function scheduleBrowserIdleClose() {
  if (state.browserIdleTimer) clearTimeout(state.browserIdleTimer);
  state.browserIdleTimer = setTimeout(() => {
    if (state.browser) {
      state.browser.close().catch(() => {});
      state.browser = null;
      console.log('[xiaoheihe] 浏览器已闲置关闭');
    }
  }, BROWSER_IDLE);
  if (state.browserIdleTimer.unref) state.browserIdleTimer.unref();
}

/** 把用户 Cookie 注入到浏览器上下文 */
async function injectCookie(ctx, cookie) {
  if (!cookie) return;
  const list = String(cookie)
    .split(';')
    .map((pair) => {
      const idx = pair.indexOf('=');
      if (idx === -1) return null;
      return { name: pair.slice(0, idx).trim(), value: pair.slice(idx + 1).trim(), domain: '.xiaoheihe.cn', path: '/' };
    })
    .filter(Boolean);
  if (list.length) await ctx.addCookies(list);
}

/** 用浏览器打开社区页，抄下已签名的 feeds 请求 URL */
async function captureSignedUrl({ timeoutMs = 45000, cookie = '' } = {}) {
  const browser = await getBrowser();
  const ctx = await browser.newContext({ userAgent: PC_UA, locale: 'zh-CN' });

  await injectCookie(ctx, cookie);

  const page = await ctx.newPage();
  let captured = '';

  page.on('response', (res) => {
    const u = res.url();
    if (!captured && u.includes('/bbs/app/feeds?') && !u.includes('banner')) captured = u;
  });

  try {
    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    const deadline = Date.now() + timeoutMs;
    while (!captured && Date.now() < deadline) await sleep(300);
  } finally {
    await ctx.close().catch(() => {});
    scheduleBrowserIdleClose();
  }

  if (!captured) throw new Error('未能从小黑盒页面捕获到接口签名（可能页面结构变化或被风控）');
  state.signedUrl = captured;
  state.signedAt = Date.now();
  console.log('[xiaoheihe] 已捕获接口签名');
  return captured;
}

/**
 * 检测登录态：注入 Cookie 后打开社区页，观察页面自己发出的 restore_login 响应。
 * （该接口需要签名，只能借浏览器环境来问。）
 */
async function checkLogin(cookie, { timeoutMs = 60000 } = {}) {
  const browser = await getBrowser();
  const ctx = await browser.newContext({ userAgent: PC_UA, locale: 'zh-CN' });
  await injectCookie(ctx, cookie);

  const page = await ctx.newPage();
  let payload = null;

  page.on('response', async (res) => {
    if (!payload && res.url().includes('/account/restore_login')) {
      try {
        payload = await res.json();
      } catch {}
    }
  });

  try {
    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    const deadline = Date.now() + 20000;
    while (!payload && Date.now() < deadline) await sleep(300);
  } finally {
    await ctx.close().catch(() => {});
    scheduleBrowserIdleClose();
  }

  if (!payload) {
    return { platform: 'xiaoheihe', loggedIn: false, message: '未能获取登录状态（页面未返回账号信息）' };
  }

  const msg = String(payload.msg || '');
  const isGuest = payload.status === 'login' || /请登录|未登录|登录后/.test(msg);
  const result = payload.result || {};
  const user = result.account_detail || result.user || result.profile || {};
  const nickname = user.username || user.nickname || user.heybox_nick_name || '';

  return {
    platform: 'xiaoheihe',
    loggedIn: !isGuest,
    nickname,
    extra: { heyboxId: user.heybox_id || '' },
    message: isGuest ? '未登录（Cookie 无效或已过期）' : `已登录${nickname ? '：' + nickname : ''}`,
  };
}

/* ----------------------------- 抓取 ----------------------------- */

const JSON_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  Referer: 'https://www.xiaoheihe.cn/',
  Origin: 'https://www.xiaoheihe.cn',
};

async function requestFeed(url, timeoutMs) {
  const json = await getJson(url, { headers: JSON_HEADERS, timeoutMs, retries: 1 });
  const links = json && json.result && json.result.links;
  if (!Array.isArray(links)) {
    const msg = (json && json.msg) || '未知错误';
    const err = new Error(`小黑盒接口返回异常：${msg}`);
    err.signatureExpired = /非法请求|缺少必要参数|验证参数错误/.test(msg);
    throw err;
  }
  return links;
}

async function fetchFeed(source, ctx = {}) {
  const timeoutMs = ctx.timeoutMs || 20000;
  const limit = ctx.limit || 20;
  // 源级 cookie 优先，否则用全局账号
  const cookie = require('../accounts').getCookie('xiaoheihe', source.options.cookie);

  let links;
  try {
    if (!state.signedUrl || Date.now() - state.signedAt > SIGN_TTL) {
      await captureSignedUrl({ timeoutMs: 45000, cookie });
    }
    links = await requestFeed(state.signedUrl, timeoutMs);
  } catch (err) {
    if (err.signatureExpired || !state.signedUrl) {
      console.warn('[xiaoheihe] 签名失效，重新获取…');
      state.signedUrl = '';
      await captureSignedUrl({ timeoutMs: 45000, cookie });
      links = await requestFeed(state.signedUrl, timeoutMs);
    } else {
      throw err;
    }
  }

  const seen = new Set();
  const items = [];
  for (const link of links) {
    if (!link || !link.linkid || seen.has(link.linkid)) continue;
    seen.add(link.linkid);
    const topic = Array.isArray(link.topics) && link.topics[0] ? link.topics[0].name : '';
    items.push({
      id: `xiaoheihe:${link.linkid}`,
      sourceId: source.id,
      sourceType: 'xiaoheihe',
      sourceName: source.name,
      sourceMode: 'feed',
      title: String(link.title || '').trim() || '(无标题)',
      author: (link.user && link.user.username) || `用户${link.userid}`,
      authorId: String(link.userid || ''),
      cover: (Array.isArray(link.thumbs) && link.thumbs[0]) || (Array.isArray(link.imgs) && link.imgs[0]) || '',
      url: `https://www.xiaoheihe.cn/app/bbs/link/${link.linkid}`,
      desc: String(link.description || '').slice(0, 300),
      stats: {
        comment: Number(link.comment_num) || 0,
        like: Number(link.link_award_num) || 0,
        forward: Number(link.forward_num) || 0,
      },
      publishedAt: link.create_at ? Number(link.create_at) * 1000 : Date.now(),
      fetchedAt: Date.now(),
      extra: { linkid: link.linkid, topic, hasVideo: Boolean(link.has_video) },
      status: 'kept',
      starred: false,
      seen: false,
    });
    if (items.length >= limit) break;
  }
  return items;
}

/** 供进程退出时调用 */
async function closeBrowser() {
  if (state.browserIdleTimer) clearTimeout(state.browserIdleTimer);
  if (state.browser) {
    await state.browser.close().catch(() => {});
    state.browser = null;
  }
}

module.exports = {
  type: 'xiaoheihe',
  label: '小黑盒',
  fetchItems: async (source, ctx = {}) => {
    const mode = source.options.mode || 'feed';
    if (mode !== 'feed') throw new Error(`小黑盒暂不支持模式：${mode}`);
    return fetchFeed(source, ctx);
  },
  MODES: [{ value: 'feed', label: '社区推荐流', fields: ['cookie'] }],
  closeBrowser,
  checkLogin,
  _internal: { state, injectCookie },
};
