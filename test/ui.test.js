'use strict';

/**
 * 前端 UI 测试：用真实浏览器验证布局与账号面板。
 * 依赖 playwright-core + 系统 Edge/Chrome。
 * 运行：node --test test/ui.test.js
 */

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.CONTENT_RADAR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'content-radar-ui-'));

const test = require('node:test');
const assert = require('node:assert');

const store = require('../src/store');
const { listen } = require('../src/server');

test('信息流布局：单/双/三/四栏都能生效', { timeout: 120000 }, async (t) => {
  store.load();
  // 塞几条数据，才能看到真实的列结构
  store.upsertItems(
    Array.from({ length: 8 }, (_, i) => ({
      id: `layout:${i}`,
      sourceId: 'layout-src',
      sourceType: 'rss',
      sourceName: '布局测试源',
      sourceMode: 'rss',
      title: `第 ${i + 1} 条测试内容`,
      author: '作者',
      authorId: '',
      cover: '',
      url: `https://example.com/${i}`,
      desc: '',
      stats: {},
      publishedAt: Date.now() - i * 1000,
      fetchedAt: Date.now(),
      status: 'kept',
      starred: false,
      seen: false,
    })),
  );

  const { server, port } = await listen(7900);
  const base = `http://127.0.0.1:${port}`;

  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });

  t.after(async () => {
    await browser.close();
    server.close();
    store.flush();
  });

  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#seg-layout button');
  await page.waitForSelector('#feed .card');

  const readVar = (name) =>
    page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

  // 1) 四个按钮都在，且文案正确
  const labels = await page.$$eval('#seg-layout button', (els) => els.map((e) => e.textContent.trim()));
  assert.deepEqual(labels, ['列表', '双栏', '三栏', '四栏'], '设置面板应有四档布局按钮');

  // 2) 逐档切换：CSS 变量、列容器数量、卡片总数都要对
  const cases = [
    ['single', '1', 1],
    ['double', '2', 2],
    ['triple', '3', 3],
    ['quad', '4', 4],
  ];
  for (const [value, expectedVar, expectedCols] of cases) {
    await page.click(`#seg-layout button[data-value="${value}"]`);
    await page.waitForTimeout(300);

    assert.equal(await readVar('--feed-cols'), expectedVar, `--feed-cols 应为 ${expectedVar}`);

    const stats = await page.evaluate(() => ({
      cols: document.querySelectorAll('#feed .feed-col').length,
      directCards: document.querySelectorAll('#feed > .card').length,
      allCards: document.querySelectorAll('#feed .card').length,
    }));
    assert.equal(stats.allCards, 8, '卡片总数应保持 8 条');

    if (expectedCols === 1) {
      assert.equal(stats.cols, 0, '单栏时不用列容器');
      assert.equal(stats.directCards, 8, '单栏时卡片直接是 feed 的子元素');
    } else {
      assert.equal(stats.cols, expectedCols, `${value} 应有 ${expectedCols} 个列容器`);
    }

    const active = await page.$eval('#seg-layout button.active', (el) => el.dataset.value);
    assert.equal(active, value, '按钮高亮状态应同步');
  }

  // 3) 栏数越多，列表缩略图越小（避免卡片被挤扁）
  const coverOf = async (value) => {
    await page.click(`#seg-layout button[data-value="${value}"]`);
    await page.waitForTimeout(200);
    return parseInt(await readVar('--row-cover-h'), 10);
  };
  const c1 = await coverOf('single');
  const c2 = await coverOf('double');
  const c3 = await coverOf('triple');

  assert.ok(c2 < c1, `双栏缩略图(${c2}px)应小于列表(${c1}px)`);
  assert.ok(c3 < c2, `三栏缩略图(${c3}px)应小于双栏(${c2}px)`);
  console.log(`    缩略图高度：列表 ${c1}px → 双栏 ${c2}px → 三栏 ${c3}px`);

  // 4) 设置要能持久化（写进 config.json）
  const saved = await page.evaluate(() => fetch('/api/config').then((r) => r.json()));
  assert.equal(saved.layout, 'triple', '最后选择的三栏应已保存到配置');

  console.log('    ✓ 四档布局切换、列容器渲染、缩略图自适应、配置持久化均正常');
});

test('账号面板：三平台可配置，输入后状态变为「已配置」', { timeout: 120000 }, async (t) => {
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const { server, port } = await listen(7901);

  t.after(async () => {
    await browser.close();
    server.close();
    store.flush();
  });

  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#account-list .account-item');

  // 三个平台都在，且各有「检测登录」按钮
  const names = await page.$$eval('#account-list .a-name', (els) => els.map((e) => e.textContent.trim()));
  assert.deepEqual(names, ['B站', '贴吧', '小黑盒'], '应列出三个平台的账号');

  const checkButtons = await page.$$eval('#account-list [data-act="check"]', (els) => els.length);
  assert.equal(checkButtons, 3, '每个平台都应有检测按钮');

  // 输入 Cookie 后，状态与指示灯应立刻变化，并自动保存
  await page.fill('#account-list .account-item:nth-child(1) input', 'SESSDATA=fake_for_test');
  await page.waitForTimeout(1000);

  const status = await page.$eval('#account-list .account-item:nth-child(1) [data-status]', (el) => el.textContent);
  assert.equal(status, '已配置', '输入 Cookie 后状态应变为已配置');

  const dotClass = await page.$eval('#account-list .account-item:nth-child(1) .dot', (el) => el.className);
  assert.ok(!dotClass.includes('idle'), '指示灯应变为高亮');

  const saved = await page.evaluate(() => fetch('/api/config').then((r) => r.json()));
  assert.equal(saved.accounts.bilibili.cookie, 'SESSDATA=fake_for_test', 'Cookie 应已保存到配置');

  // 点检测按钮不应让页面崩（假 Cookie 只会提示未登录）
  await page.click('#account-list .account-item:nth-child(1) [data-act="check"]');
  await page.waitForTimeout(3000);
  const afterCheck = await page.$eval('#account-list .account-item:nth-child(1) [data-status]', (el) => el.textContent);
  assert.ok(afterCheck.length > 0, '检测后应显示结果文字');

  console.log(`    ✓ 三平台账号面板正常，检测结果：${afterCheck}`);
});
