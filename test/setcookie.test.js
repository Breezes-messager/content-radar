'use strict';

/**
 * 验证运行环境能读到 Set-Cookie —— 扫码登录依赖这个能力。
 * 运行：node --test test/setcookie.test.js
 */

const http = require('node:http');
const test = require('node:test');
const assert = require('node:assert');

const { extractCookie } = require('../src/qrlogin');

test('运行环境能读到 Set-Cookie（扫码登录的前提）', { timeout: 30000 }, async (t) => {
  const srv = http.createServer((req, res) => {
    res.setHeader('Set-Cookie', ['SESSDATA=abc%2Cdef; Path=/; HttpOnly', 'bili_jct=tok; Path=/']);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());

  const port = srv.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/`);
  await res.text();

  assert.equal(typeof res.headers.getSetCookie, 'function', 'getSetCookie 必须可用');
  const list = res.headers.getSetCookie();
  assert.equal(list.length, 2, `应读到 2 条 Set-Cookie，实际 ${list.length}`);

  const cookie = extractCookie(res);
  assert.ok(cookie.includes('SESSDATA=abc%2Cdef'), `应提取到 SESSDATA，实际：${cookie}`);
  assert.ok(cookie.includes('bili_jct=tok'), '应提取到 bili_jct');

  console.log(`    node ${process.version} · Set-Cookie 读取正常 → ${cookie}`);
});
