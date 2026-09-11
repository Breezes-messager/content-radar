'use strict';

/**
 * 账号（登录态）测试
 * - 配置读取与优先级（纯逻辑）
 * - 三平台登录检测（真实请求，使用无效 Cookie 验证「未登录」路径）
 * - /api/accounts/check 接口
 */

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.CONTENT_RADAR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'content-radar-acct-'));

const test = require('node:test');
const assert = require('node:assert');

const { updateConfig } = require('../src/config');
const accounts = require('../src/accounts');
const store = require('../src/store');
const { listen } = require('../src/server');

/* ---------------------------- 配置读取 ---------------------------- */

test('未配置时返回空 Cookie', () => {
  assert.equal(accounts.getCookie('bilibili'), '');
  assert.equal(accounts.hasAccount('bilibili'), false);
});

test('配置后生效，且源级 Cookie 优先于全局账号', () => {
  updateConfig({ accounts: { bilibili: { cookie: 'SESSDATA=global' } } });
  assert.equal(accounts.getCookie('bilibili'), 'SESSDATA=global');
  assert.equal(accounts.getCookie('bilibili', 'SESSDATA=source'), 'SESSDATA=source');
  assert.equal(accounts.hasAccount('bilibili'), true);
  assert.equal(accounts.hasAccount('tieba'), false);
});

/* ---------------------------- 登录检测 ---------------------------- */

test('空 Cookie 直接判未配置，不发请求', async () => {
  // 先清掉全局账号，避免被上一个用例的配置影响
  updateConfig({ accounts: { bilibili: { cookie: '' }, tieba: { cookie: '' }, xiaoheihe: { cookie: '' } } });
  for (const platform of ['bilibili', 'tieba', 'xiaoheihe']) {
    const r = await accounts.check(platform, { cookie: '' });
    assert.equal(r.loggedIn, false);
    assert.match(r.message, /未填写/);
  }
});

test('B站：无效 Cookie 判定为未登录', { timeout: 40000 }, async () => {
  const r = await accounts.checkBilibili('SESSDATA=this_is_not_valid');
  assert.equal(r.loggedIn, false, '无效 SESSDATA 不应被判为已登录');
  assert.ok(r.message.length > 0);
  console.log(`    B站检测结果：${r.message}`);
});

test('贴吧：无效 Cookie 判定为未登录', { timeout: 40000 }, async () => {
  const r = await accounts.checkTieba('BDUSS=this_is_not_valid');
  assert.equal(r.loggedIn, false, '无效 BDUSS 不应被判为已登录');
  assert.ok(r.message.length > 0);
  console.log(`    贴吧检测结果：${r.message}`);
});

test('小黑盒：无效 Cookie 判定为未登录', { timeout: 180000 }, async (t) => {
  t.after(async () => {
    await require('../src/sources/xiaoheihe').closeBrowser();
  });
  const r = await accounts.checkXiaoheihe('pkey=this_is_not_valid');
  assert.equal(r.loggedIn, false, '无效 Cookie 不应被判为已登录');
  assert.ok(r.message.length > 0);
  console.log(`    小黑盒检测结果：${r.message}`);
});

/* ---------------------------- HTTP 接口 ---------------------------- */

test('/api/accounts/check 可检测且不因未登录报错', { timeout: 60000 }, async (t) => {
  store.load();
  const { server, port } = await listen(7970);
  t.after(() => {
    server.close();
    store.flush();
  });

  const call = async (body) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/accounts/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json() };
  };

  const bad = await call({ platform: 'tieba', cookie: 'BDUSS=invalid' });
  assert.equal(bad.status, 200);
  assert.equal(bad.json.ok, true);
  assert.equal(bad.json.loggedIn, false);

  const unknown = await call({ platform: 'weibo', cookie: 'x' });
  assert.equal(unknown.json.loggedIn, false);
  assert.match(unknown.json.message, /不支持/);

  // 账号列表接口
  const list = await (await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();
  assert.equal(list.ok, true);
  assert.equal(list.accounts.length, 3);
  assert.ok(list.accounts.every((a) => a.hint && a.label), '每个平台都应带标签与提示');
});
