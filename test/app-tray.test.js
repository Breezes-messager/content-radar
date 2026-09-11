'use strict';

/**
 * 打包版 App 的托盘与通知验证：启动 App，捕获主进程输出。
 * 注意：不要和 pack.test.js 并发运行（后者会 taskkill 掉这里的实例）。
 * 运行：node --test test/app-tray.test.js（需先 npm run pack）
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const test = require('node:test');
const assert = require('node:assert');
const { spawn, execSync } = require('node:child_process');

const EXE = path.join(__dirname, '..', 'release', 'ContentRadar', 'ContentRadar.exe');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

test('打包版：托盘创建成功 + 导出接口可用', { timeout: 180000 }, async (t) => {
  if (!fs.existsSync(EXE)) assert.fail('找不到打包产物，请先执行 npm run pack');

  try {
    execSync('taskkill /IM ContentRadar.exe /F', { stdio: 'ignore' });
  } catch {}

  const child = spawn(EXE, [], { detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (c) => (output += c.toString()));
  child.stderr.on('data', (c) => (output += c.toString()));
  child.unref();

  t.after(() => {
    try {
      execSync('taskkill /IM ContentRadar.exe /F', { stdio: 'ignore' });
    } catch {}
  });

  // 等内嵌服务起来
  let port = 0;
  for (let i = 0; i < 40; i++) {
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
  assert.ok(port, `内嵌服务应在 40 秒内启动，当前输出：\n${output.slice(0, 600)}`);
  console.log(`    App 已启动（端口 ${port}）`);

  // 托盘日志
  await sleep(1500);
  console.log(`    主进程输出：${output.trim().split('\n').filter(Boolean).join(' | ').slice(0, 300)}`);
  assert.match(output, /托盘已创建/, '主进程应报告托盘创建成功');

  // 导出接口
  const res = await rawRequest(port, { path: '/api/export?type=favorites' });
  assert.equal(res.status, 200, '导出接口应返回 200');
  assert.ok(res.body.includes('# 我的收藏'), '导出内容应是收藏 Markdown');
  console.log(`    导出接口返回 ${res.body.length} 字节`);
});
