'use strict';

/**
 * 扫码登录 / 登录窗口测试
 * 运行：node --test test/qrlogin.test.js
 */

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.CONTENT_RADAR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'content-radar-qr-'));

const test = require('node:test');
const assert = require('node:assert');

const qrlogin = require('../src/qrlogin');
const loginWindow = require('../src/loginWindow');
const store = require('../src/store');
const { listen } = require('../src/server');

/* ---------------------------- 二维码 ---------------------------- */

test('二维码渲染成 SVG', () => {
  const svg = qrlogin.toSvg('https://example.com/scan?k=abc');
  assert.match(svg, /^<svg/, '应是 SVG 标签');
  assert.ok(svg.includes('</svg>'));
  assert.ok(svg.length > 500, '应包含足够的路径数据');
});

test('Cookie 提取只保留关键字段', () => {
  const fakeRes = {
    headers: {
      getSetCookie: () => [
        'SESSDATA=abc%2Cdef; Path=/; Domain=.bilibili.com',
        'bili_jct=token123; Path=/',
        'DedeUserID=12345; Path=/',
        'irrelevant=xxx; Path=/',
      ],
    },
  };
  const cookie = qrlogin.extractCookie(fakeRes);
  assert.ok(cookie.includes('SESSDATA=abc%2Cdef'), '应保留 SESSDATA');
  assert.ok(cookie.includes('bili_jct=token123'));
  assert.ok(cookie.includes('DedeUserID=12345'));
  assert.ok(!cookie.includes('irrelevant'), '无关字段应被丢弃');
});

/* -------------------------- 真实扫码流程 -------------------------- */

test('B站扫码：能申请到二维码，未扫码时状态为 waiting', { timeout: 60000 }, async () => {
  const { key, url } = await qrlogin.generate();
  assert.ok(key && key.length > 10, '应返回 qrcode_key');
  assert.ok(url.startsWith('https://'), '应返回二维码内容 URL');

  const r = await qrlogin.poll(key);
  assert.equal(r.status, 'waiting');
  assert.equal(r.code, 86101);
  assert.match(r.message, /等待扫码|未扫码/);
  console.log(`    扫码状态：${r.message}（code=${r.code}）`);
});

test('B站扫码：非法 key 不会崩，返回可识别状态', { timeout: 30000 }, async () => {
  const r = await qrlogin.poll('invalid_key_for_test');
  assert.ok(['failed', 'expired', 'waiting'].includes(r.status), `异常 key 应返回可识别状态，实际 ${r.status}`);
});

/* --------------------------- HTTP 接口 --------------------------- */

test('/api/accounts/qr：start 返回二维码截图 + GET 查状态 + 未知 action', { timeout: 120000 }, async (t) => {
  store.load();
  const { server, port } = await listen(7985);
  t.after(async () => {
    server.close();
    store.flush();
    await qrlogin.closeAll();
  });

  const call = async (body) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/accounts/qr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json() };
  };

  // 开启扫码会话：应返回会话 id 与二维码截图
  const start = await call({ action: 'start' });
  assert.equal(start.status, 200, `start 应成功，实际 ${start.status}: ${JSON.stringify(start.json).slice(0, 200)}`);
  assert.ok(start.json.id, '应返回会话 id');
  assert.ok(start.json.image && start.json.image.length > 1000, '应返回二维码截图 base64');
  console.log(`    二维码截图 ${Math.round(start.json.image.length / 1024)} KB`);

  // 查询状态
  const view = await (
    await fetch(`http://127.0.0.1:${port}/api/accounts/qr?id=${encodeURIComponent(start.json.id)}`)
  ).json();
  assert.equal(view.ok, true);
  assert.equal(view.status, 'waiting');
  assert.ok(!view.cookie, '不应把 Cookie 回传前端');

  const bad = await call({ action: 'unknown' });
  assert.equal(bad.status, 400);
});

/* -------------------------- 登录窗口 -------------------------- */

test('登录窗口：会话查询 / 关闭 / 登录地址', () => {
  assert.equal(loginWindow.get('不存在的 id'), null);
  assert.equal(loginWindow.takeCookie('不存在的 id'), null);
  assert.equal(loginWindow.close('不存在的 id'), false);

  assert.ok(loginWindow.LOGIN_URLS.tieba.includes('tieba.baidu.com'));
  assert.ok(loginWindow.LOGIN_URLS.xiaoheihe.includes('xiaoheihe.cn'));
  assert.ok(loginWindow.LOGIN_URLS.bilibili.includes('bilibili.com'));
});

test('登录窗口：打开不支持的平台会被拒绝', { timeout: 30000 }, async () => {
  await assert.rejects(() => loginWindow.open('weibo'), /不支持的平台/);
});
