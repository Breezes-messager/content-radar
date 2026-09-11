'use strict';

/**
 * 安全回归测试：用真实请求验证防护是否生效。
 * 覆盖：路径穿越、SSRF、CSRF、DNS rebinding（Host 头）、请求体大小、凭据暴露。
 * 运行：node --test test/security.test.js
 */

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

process.env.CONTENT_RADAR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'content-radar-sec-'));

const test = require('node:test');
const assert = require('node:assert');

const store = require('../src/store');
const { listen } = require('../src/server');

/** 用原生 http 发请求，方便伪造 Host 头（fetch 会忽略 Host） */
function rawRequest(port, { method = 'GET', path: reqPath = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: reqPath, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('安全防护回归', { timeout: 120000 }, async (t) => {
  store.load();
  const { server, port } = await listen(7950);
  const base = `http://127.0.0.1:${port}`;

  t.after(() => {
    server.close();
    store.flush();
  });

  /* ---------------------- 1. 路径穿越 ---------------------- */
  const traversals = [
    '/../package.json',
    '/../../package.json',
    '/..%2fpackage.json',
    '/%2e%2e/package.json',
    '/%2e%2e%2fpackage.json',
    '/..%5cpackage.json',
    '/../src/server.js',
    '/....//package.json',
  ];
  for (const p of traversals) {
    const r = await rawRequest(port, { path: p });
    assert.ok([400, 403, 404].includes(r.status), `路径穿越 ${p} 应被拒绝，实际 ${r.status}`);
    assert.ok(!r.body.includes('"name": "content-radar"'), `路径穿越 ${p} 泄露了 package.json`);
    assert.ok(!r.body.includes('require('), `路径穿越 ${p} 泄露了源码`);
  }

  /* ---------------------- 2. SSRF ---------------------- */
  const ssrfTargets = [
    'http://127.0.0.1:7950/api/config',
    'http://127.0.0.1.nip.io/x',
    'http://localhost:7950/api/config',
    'http://169.254.169.254/latest/meta-data/',
    'http://192.168.1.1/',
    'http://10.0.0.1/',
    'http://172.16.0.1/',
    'http://0.0.0.0:7950/',
    'http://[::1]:7950/',
    'http://[::ffff:127.0.0.1]/',
    'http://100.64.0.1/',
    'file:///C:/Windows/win.ini',
    'gopher://127.0.0.1:80/',
    'ftp://example.com/x',
  ];
  for (const target of ssrfTargets) {
    const r = await rawRequest(port, { path: '/api/proxy?url=' + encodeURIComponent(target) });
    assert.equal(r.status, 400, `SSRF ${target} 应被拒绝，实际 ${r.status}`);
    assert.ok(!r.body.includes('apiKey'), `SSRF ${target} 泄露了配置`);
  }

  /* ---------------------- 3. CSRF ---------------------- */
  const csrfAttempts = [
    { name: '跨站 Origin + text/plain', headers: { Origin: 'https://evil.example', 'Content-Type': 'text/plain' } },
    { name: '跨站 Origin + form', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/x-www-form-urlencoded' } },
    { name: '跨站 Referer', headers: { Referer: 'https://evil.example/x', 'Content-Type': 'application/json' } },
  ];
  for (const attempt of csrfAttempts) {
    const r = await rawRequest(port, {
      method: 'POST',
      path: '/api/items/clear',
      headers: attempt.headers,
      body: '{}',
    });
    assert.equal(r.status, 403, `CSRF（${attempt.name}）应被拒绝，实际 ${r.status}`);
  }

  /* ---------------------- 4. DNS rebinding / Host 头 ---------------------- */
  const badHosts = ['evil.example', 'attacker.com:7950', '127.0.0.1.evil.example'];
  for (const host of badHosts) {
    const r = await rawRequest(port, { path: '/api/config', headers: { Host: host } });
    assert.equal(r.status, 403, `伪造 Host=${host} 应被拒绝，实际 ${r.status}`);
  }

  /* ---------------------- 5. 请求体大小 ---------------------- */
  const huge = JSON.stringify({ pad: 'x'.repeat(2 * 1024 * 1024) });
  let bodyResult;
  try {
    bodyResult = await rawRequest(port, {
      method: 'POST',
      path: '/api/config',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(huge) },
      body: huge,
    });
  } catch (err) {
    bodyResult = { status: 0, body: '连接被中断' }; // 服务端 destroy 也算防护生效
  }
  assert.ok(bodyResult.status === 0 || bodyResult.status >= 400, `超大请求体应被拒绝，实际 ${bodyResult.status}`);

  /* ---------------------- 6. 正常请求仍然可用 ---------------------- */
  const ok = await rawRequest(port, { path: '/api/bootstrap' });
  assert.equal(ok.status, 200, '正常请求不应被误伤');
  const home = await rawRequest(port, { path: '/' });
  assert.equal(home.status, 200, '首页应可访问');
});
