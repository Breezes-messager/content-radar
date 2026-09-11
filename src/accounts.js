'use strict';

/**
 * 账号（登录态）管理
 *
 * 三个平台各自支持填自己的 Cookie：
 *   - B站：需要 SESSDATA（登录后能看到更完整的内容）
 *   - 贴吧：需要 BDUSS（登录后可读关注吧与登录可见内容）
 *   - 小黑盒：需要 pkey / x_xhh_tokenid
 *
 * 这里只负责「读取配置 + 检测登录态」，实际抓取时由各适配器取用 Cookie。
 */

const { loadConfig } = require('./config');
const { getJson, sleep } = require('./http');

const PLATFORMS = ['bilibili', 'tieba', 'xiaoheihe'];

const LABELS = { bilibili: 'B站', tieba: '贴吧', xiaoheihe: '小黑盒' };

/** 取某个平台的账号 Cookie（源级配置优先，其次全局账号） */
function getCookie(platform, override = '') {
  const own = String(override || '').trim();
  if (own) return own;
  const cfg = loadConfig();
  const account = (cfg.accounts && cfg.accounts[platform]) || {};
  return String(account.cookie || '').trim();
}

/** 是否配置了账号 */
function hasAccount(platform) {
  return Boolean(getCookie(platform));
}

/* ------------------------------ B站 ------------------------------ */

async function checkBilibili(cookie, { timeoutMs = 15000 } = {}) {
  if (!cookie) return { platform: 'bilibili', loggedIn: false, message: '未填写 Cookie（需要 SESSDATA）' };

  const json = await getJson('https://api.bilibili.com/x/web-interface/nav', {
    headers: { Cookie: cookie, Referer: 'https://www.bilibili.com/' },
    timeoutMs,
  });

  if (json && json.code === 0 && json.data && json.data.isLogin) {
    const d = json.data;
    return {
      platform: 'bilibili',
      loggedIn: true,
      nickname: d.uname || '',
      uid: String(d.mid || ''),
      extra: {
        vip: d.vipStatus === 1,
        level: d.level_info && d.level_info.current_level,
        coins: d.money,
      },
      message: `已登录：${d.uname || d.mid}`,
    };
  }

  return {
    platform: 'bilibili',
    loggedIn: false,
    message: (json && json.message) || '未登录（Cookie 无效或已过期）',
  };
}

/* ------------------------------ 贴吧 ------------------------------ */

async function checkTieba(cookie, { timeoutMs = 15000 } = {}) {
  if (!cookie) return { platform: 'tieba', loggedIn: false, message: '未填写 Cookie（需要 BDUSS）' };

  const json = await getJson('https://tieba.baidu.com/dc/common/tbs', {
    headers: { Cookie: cookie, Referer: 'https://tieba.baidu.com/' },
    timeoutMs,
  });

  if (json && Number(json.is_login) === 1) {
    return {
      platform: 'tieba',
      loggedIn: true,
      nickname: '',
      extra: { tbs: json.tbs ? '已获取' : '' },
      message: '已登录',
    };
  }
  return { platform: 'tieba', loggedIn: false, message: '未登录（Cookie 无效或已过期）' };
}

/* ----------------------------- 小黑盒 ----------------------------- */

async function checkXiaoheihe(cookie, { timeoutMs = 60000 } = {}) {
  if (!cookie) return { platform: 'xiaoheihe', loggedIn: false, message: '未填写 Cookie（需要 pkey / x_xhh_tokenid）' };

  // 复用小黑盒适配器的浏览器实例（页面会自己算签名）
  const adapter = require('./sources/xiaoheihe');
  return adapter.checkLogin(cookie, { timeoutMs });
}

/* ------------------------------ 统一入口 ------------------------------ */

async function check(platform, { cookie = '', timeoutMs } = {}) {
  if (!PLATFORMS.includes(platform)) {
    return { platform, loggedIn: false, message: `不支持的平台：${platform}` };
  }
  const value = getCookie(platform, cookie);
  try {
    if (platform === 'bilibili') return await checkBilibili(value, { timeoutMs });
    if (platform === 'tieba') return await checkTieba(value, { timeoutMs });
    return await checkXiaoheihe(value, { timeoutMs });
  } catch (err) {
    return { platform, loggedIn: false, message: `检测失败：${err.message}` };
  }
}

/** 依次检测所有已配置账号的平台 */
async function checkAll() {
  const results = [];
  for (const platform of PLATFORMS) {
    if (!hasAccount(platform)) {
      results.push({ platform, loggedIn: false, configured: false, message: '未配置' });
      continue;
    }
    const r = await check(platform);
    results.push({ ...r, configured: true });
  }
  return results;
}

module.exports = { PLATFORMS, LABELS, getCookie, hasAccount, check, checkAll, checkBilibili, checkTieba, checkXiaoheihe };
