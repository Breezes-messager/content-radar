'use strict';

/**
 * 打包版启动验证：真实启动 release 里的 App，确认
 *   1) 内嵌服务可用（安全守卫不误伤同源请求）
 *   2) 跨站 / 伪造 Host 请求仍然被拒
 * 运行：node --test test/app.test.js（需先执行 npm run pack）
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const test = require('node:test');
const assert = require('node:assert');
const { spawn, execSync } = require('node:child_process');

const EXE = path.join(__dirname, '..', 'release', 'ContentRadar', 'ContentRadar.exe');

const rawRequest = (port, { method = 'GET', path: p = '/', headers = {} } = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end();
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('打包版 App 能启动，且安全守卫不误伤同源请求', { timeout: 180000 }, async (t) => {
  if (!fs.existsSync(EXE)) {
    assert.fail('找不到打包产物，请先执行 npm run pack');
  }

  try {
    execSync('taskkill /IM ContentRadar.exe /F', { stdio: 'ignore' });
  } catch {}

  const child = spawn(EXE, [], { detached: true, stdio: 'ignore' });
  child.unref();

  t.after(() => {
    try {
      execSync('taskkill /IM ContentRadar.exe /F', { stdio: 'ignore' });
    } catch {}
  });

  // 等待内嵌服务起来
  let port = 0;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    for (const candidate of [7788, 7789, 7790]) {
      try {
        const r = await rawRequest(candidate, { path: '/api/bootstrap' });
        if (r.status === 200) {
          port = candidate;
          break;
        }
      } catch {}
    }
    if (port) break;
  }
  assert.ok(port, '打包版内嵌服务应在 30 秒内启动');
  console.log(`    App 已启动，内嵌服务端口 ${port}`);

  // 1) 同源请求（带正常 Origin）必须放行
  const sameOrigin = await rawRequest(port, {
    path: '/api/bootstrap',
    headers: { Origin: `http://127.0.0.1:${port}` },
  });
  assert.equal(sameOrigin.status, 200, '同源请求应放行');
  const boot = JSON.parse(sameOrigin.body);
  assert.ok(boot.config.sources.length >= 3, '应返回配置与数据源');
  console.log(`    数据源 ${boot.config.sources.length} 个，适配器 ${boot.adapters.length} 个`);

  // 2) 跨站请求必须被拒
  const crossSite = await rawRequest(port, {
    method: 'POST',
    path: '/api/items/clear',
    headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json', 'Content-Length': 2 },
  });
  assert.equal(crossSite.status, 403, '跨站请求应被拒绝');

  // 3) 伪造 Host 必须被拒
  const badHost = await rawRequest(port, { path: '/api/config', headers: { Host: 'evil.example' } });
  console.log(`    伪造 Host 响应：${badHost.status} / ${badHost.body.slice(0, 120)}`);
  assert.ok([400, 403].includes(badHost.status), `伪造 Host 应被拒绝，实际 ${badHost.status}`);
  assert.ok(!badHost.body.includes('apiKey'), '伪造 Host 不应泄露配置');

  // 4) SSRF 目标必须被拒
  const ssrf = await rawRequest(port, {
    path: '/api/proxy?url=' + encodeURIComponent('http://127.0.0.1:' + port + '/api/config'),
  });
  assert.equal(ssrf.status, 400, '内网代理应被拒绝');

  console.log('    ✓ 同源放行 / 跨站拒绝 / 伪造 Host 拒绝 / SSRF 拒绝');
});
