'use strict';

/**
 * 内嵌登录窗口
 *
 * 用 Playwright 打开一个有头浏览器窗口，让用户在里面正常登录（扫码 / 输密码），
 * 后台每隔 2 秒检查一次登录态，成功后自动把 Cookie 抓回来。
 * 贴吧、小黑盒这类没有公开扫码接口的平台走这条路。
 */

const crypto = require('crypto');
const { sleep } = require('./http');
const accounts = require('./accounts');

const LOGIN_URLS = {
  bilibili: 'https://passport.bilibili.com/login',
  tieba: 'https://tieba.baidu.com/',
  xiaoheihe: 'https://www.xiaoheihe.cn/app/bbs',
};

const LABELS = { bilibili: 'B站', tieba: '贴吧', xiaoheihe: '小黑盒' };

const MAX_SESSIONS = 3;
const DEFAULT_TIMEOUT = 5 * 60 * 1000; // 5 分钟

/** id -> session */
const sessions = new Map();

function publicView(s) {
  return {
    id: s.id,
    platform: s.platform,
    label: LABELS[s.platform] || s.platform,
    status: s.status,
    message: s.message,
    nickname: s.nickname,
    // Cookie 不下发给前端，只告诉它「已保存」
    hasCookie: Boolean(s.cookie),
  };
}

function reapStale(timeoutMs) {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (s.status !== 'waiting' && now - s.startedAt > 60000) {
      sessions.delete(id);
    } else if (now - s.startedAt > timeoutMs + 120000) {
      if (s.browser) s.browser.close().catch(() => {});
      sessions.delete(id);
    }
  }
}

/**
 * 打开登录窗口
 * @param {'bilibili'|'tieba'|'xiaoheihe'} platform
 */
async function open(platform, { timeoutMs = DEFAULT_TIMEOUT } = {}) {
  const url = LOGIN_URLS[platform];
  if (!url) throw new Error(`不支持的平台：${platform}`);

  reapStale(timeoutMs);
  if (sessions.size >= MAX_SESSIONS) {
    throw new Error('已有登录窗口在等待，请先完成或关闭它');
  }

  const { chromium } = require('playwright-core');
  let browser;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: false });
  } catch {
    try {
      browser = await chromium.launch({ channel: 'chrome', headless: false });
    } catch (err) {
      throw new Error(`无法打开浏览器窗口（需要系统安装 Edge 或 Chrome）：${err.message}`);
    }
  }

  const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1120, height: 780 } });
  const page = await ctx.newPage();

  const session = {
    id: crypto.randomUUID(),
    platform,
    status: 'waiting',
    message: `请在弹出的窗口里登录${LABELS[platform] || ''}`,
    nickname: '',
    cookie: '',
    startedAt: Date.now(),
    browser,
  };
  sessions.set(session.id, session);

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});

  // 小黑盒首页需要点一下「登录」才会弹登录框
  if (platform === 'xiaoheihe') {
    await sleep(2500);
    await page
      .getByText('登录', { exact: true })
      .first()
      .click({ timeout: 5000 })
      .catch(() => {});
  }

  // 后台盯着登录态
  (async () => {
    const deadline = Date.now() + timeoutMs;
    try {
      while (Date.now() < deadline && session.status === 'waiting' && !session.aborted) {
        await sleep(2000);
        if (session.aborted) break;

        const cookies = await ctx.cookies().catch(() => []);
        if (!cookies.length) continue;

        const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
        const check = await accounts.check(platform, { cookie: cookieStr, timeoutMs: 15000 }).catch(() => null);

        if (check && check.loggedIn) {
          session.status = 'success';
          session.cookie = cookieStr;
          session.nickname = check.nickname || '';
          session.message = check.message || '登录成功';
          break;
        }
      }

      if (session.status === 'waiting') {
        session.status = 'timeout';
        session.message = '等待超时，请重新打开登录窗口';
      }
    } finally {
      await browser.close().catch(() => {});
      session.browser = null;
    }
  })();

  return publicView(session);
}

function get(id) {
  const s = sessions.get(String(id || ''));
  return s ? publicView(s) : null;
}

function takeCookie(id) {
  const s = sessions.get(String(id || ''));
  if (!s || s.status !== 'success' || !s.cookie) return null;
  return { platform: s.platform, cookie: s.cookie, nickname: s.nickname };
}

function close(id) {
  const s = sessions.get(String(id || ''));
  if (!s) return false;
  s.aborted = true;
  if (s.browser) s.browser.close().catch(() => {});
  sessions.delete(id);
  return true;
}

async function closeAll() {
  for (const s of sessions.values()) {
    s.aborted = true;
    if (s.browser) await s.browser.close().catch(() => {});
  }
  sessions.clear();
}

module.exports = { open, get, takeCookie, close, closeAll, LOGIN_URLS, LABELS };
