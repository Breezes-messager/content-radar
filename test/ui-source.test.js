'use strict';

/**
 * 数据源编辑的 UI 测试：紧凑列表 + 弹窗表单（带标签与说明）+ 新增源类型选择
 * 运行：node --test test/ui-source.test.js
 */

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.CONTENT_RADAR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'content-radar-uisrc-'));

const test = require('node:test');
const assert = require('node:assert');

const store = require('../src/store');
const { listen } = require('../src/server');
const { updateConfig } = require('../src/config');

test('数据源：紧凑列表 + 弹窗编辑 + 类型下拉新增', { timeout: 150000 }, async (t) => {
  store.load();
  updateConfig({
    sources: [
      {
        id: 'bili-1',
        type: 'bilibili',
        name: 'B站测试源',
        enabled: true,
        options: { mode: 'search', keyword: '人工智能', pageSize: 24 },
      },
      { id: 'rss-1', type: 'rss', name: 'RSS 测试源', enabled: false, options: { url: 'https://example.com/feed' } },
    ],
  });

  const { server, port } = await listen(7904);
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });

  t.after(async () => {
    await browser.close();
    server.close();
    store.flush();
  });

  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#source-list .source-item');

  /* ---------- 1. 列表是紧凑的一行 ---------- */
  const names = await page.$$eval('#source-list .s-name', (els) => els.map((e) => e.textContent.trim()));
  console.log('    列表项:', names.join(' | '));
  assert.ok(names.includes('B站测试源') && names.includes('RSS 测试源'), '自定义源应在列表里');

  const subs = await page.$$eval('#source-list .s-sub', (els) => els.map((e) => e.textContent.trim()));
  const biliIndex = names.indexOf('B站测试源');
  assert.ok(
    subs[biliIndex].includes('关键词搜索') && subs[biliIndex].includes('人工智能'),
    `摘要应含模式与关键词，实际：${subs[biliIndex]}`,
  );
  const rssIndex = names.indexOf('RSS 测试源');
  assert.ok(subs[rssIndex].includes('example.com'), `RSS 摘要应含地址，实际：${subs[rssIndex]}`);

  const toggles = await page.$$eval('#source-list .s-toggle input', (els) => els.length);
  assert.equal(toggles, names.length, '每个源应有启用开关');

  /* ---------- 2. 点开编辑弹窗：字段带标签 + 说明 ---------- */
  await page.click('#source-list .source-item:nth-child(1) [data-act="edit"]');
  await page.waitForSelector('#source-modal:not(.hidden)');

  const labels = await page.$$eval('#source-form .field > span', (els) => els.map((e) => e.textContent.trim()));
  assert.ok(labels.includes('名称'), '应有「名称」标签');
  assert.ok(labels.includes('模式'), '应有「模式」标签');
  assert.ok(labels.includes('搜索关键词'), '应有「搜索关键词」标签');

  const hints = await page.$$eval('#source-form .field-hint', (els) => els.length);
  assert.ok(hints >= 2, `应有字段说明文字，实际 ${hints} 条`);

  /* ---------- 3. 改关键词并保存 ---------- */
  await page.fill('#source-form [data-key="keyword"]', '大模型');
  await page.click('#source-save');
  await page.waitForTimeout(900);

  const cfg = await page.evaluate(() => fetch('/api/config').then((r) => r.json()));
  const saved = cfg.sources.find((s) => s.id === 'bili-1');
  assert.equal(saved.options.keyword, '大模型', '编辑应已保存');

  /* ---------- 4. 新增源：类型用下拉选，字段跟着变 ---------- */
  await page.click('#btn-add-source');
  await page.waitForSelector('#src-type');

  const typeOptions = await page.$$eval('#src-type option', (els) => els.map((e) => e.value));
  assert.deepEqual(typeOptions, ['bilibili', 'tieba', 'xiaoheihe', 'rss'], '类型应以下拉方式提供');

  await page.selectOption('#src-type', 'tieba');
  await page.waitForTimeout(400);
  const labels2 = await page.$$eval('#source-form .field > span', (els) => els.map((e) => e.textContent.trim()));
  assert.ok(labels2.includes('吧名'), `切到贴吧后应出现「吧名」，实际：${labels2.join('/')}`);

  await page.fill('#src-name', '贴吧·测试吧');
  await page.fill('#source-form [data-key="kw"]', '理论物理');
  await page.click('#source-save');
  await page.waitForTimeout(900);

  const cfg2 = await page.evaluate(() => fetch('/api/config').then((r) => r.json()));
  // 注意：内置默认源里也有贴吧，这里只认新建的那个
  const tieba = cfg2.sources.find((s) => s.type === 'tieba' && s.name === '贴吧·测试吧');
  assert.ok(tieba, `应新增一个贴吧源，实际：${cfg2.sources.map((s) => s.name).join(' | ')}`);
  assert.equal(tieba.options.kw, '理论物理');
  assert.equal(tieba.enabled, true, '新增的源默认启用');

  console.log(`    ✓ 列表摘要：${subs[biliIndex]}`);
  console.log('    ✓ 弹窗标签、说明、保存、新增（含类型切换）均正常');
});
