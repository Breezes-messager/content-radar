'use strict';

/**
 * 扫码登录的 UI 测试：按钮、弹窗、二维码渲染、关闭
 * 运行：node --test test/ui-qr.test.js
 */

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.CONTENT_RADAR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'content-radar-uiqr-'));

const test = require('node:test');
const assert = require('node:assert');

const store = require('../src/store');
const { listen } = require('../src/server');

test('账号面板：扫码按钮 + 二维码弹窗', { timeout: 150000 }, async (t) => {
  store.load();
  const { server, port } = await listen(7903);
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });

  t.after(async () => {
    await browser.close();
    server.close();
    store.flush();
  });

  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#account-list .account-item');

  // 1) B站有「扫码登录」+「登录窗口」兜底，贴吧 / 小黑盒有「打开登录窗口」
  assert.ok(await page.$('#account-list .account-item:nth-child(1) [data-act="qr"]'), 'B站应有扫码登录按钮');
  const windowBtns = await page.$$eval('#account-list [data-act="window"]', (els) => els.length);
  assert.equal(windowBtns, 3, '三个平台都应有登录窗口按钮（B站作为扫码的兜底）');

  // 2) 点扫码 → 弹窗打开，显示登录页截图出来的二维码
  await page.click('#account-list .account-item:nth-child(1) [data-act="qr"]');
  await page.waitForSelector('#qr-modal:not(.hidden)', { timeout: 15000 });
  await page.waitForSelector('#qr-box img', { timeout: 90000 });

  const src = await page.$eval('#qr-box img', (el) => el.getAttribute('src'));
  assert.ok(src.startsWith('data:image/png;base64,'), '二维码应是截图后的 PNG data URL');
  assert.ok(src.length > 2000, `截图应有实际内容，实际 ${src.length} 字节`);

  const statusText = await page.$eval('#qr-status', (el) => el.textContent.trim());
  assert.ok(statusText.length > 0, '应显示扫码状态文案');
  console.log(`    弹窗状态：${statusText}（二维码 ${Math.round(src.length / 1024)} KB）`);

  // 3) 关闭弹窗
  await page.click('#qr-close');
  await page.waitForTimeout(500);
  const hidden = await page.$eval('#qr-modal', (el) => el.classList.contains('hidden'));
  assert.ok(hidden, '关闭后弹窗应隐藏');
});
