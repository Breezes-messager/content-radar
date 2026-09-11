'use strict';

/**
 * 新功能的 UI 测试：AI 摘要按钮 / B站内嵌播放 / 悬停放大 / 简报面板
 * 运行：node --test test/ui-features.test.js
 */

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.CONTENT_RADAR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'content-radar-ui2-'));

const test = require('node:test');
const assert = require('node:assert');

const store = require('../src/store');
const { listen } = require('../src/server');

test('卡片交互：摘要按钮 / 内嵌播放 / 悬停放大 / 简报面板', { timeout: 150000 }, async (t) => {
  store.load();
  store.upsertItems([
    {
      id: 'bilibili:BVTEST123',
      sourceId: 's1',
      sourceType: 'bilibili',
      sourceName: 'B站 · 测试',
      title: 'B站测试视频',
      author: '某UP',
      authorId: '1',
      cover: '',
      url: 'https://www.bilibili.com/video/BVTEST123',
      desc: '视频简介',
      stats: { play: 100 },
      publishedAt: Date.now(),
      fetchedAt: Date.now(),
      extra: { bvid: 'BVTEST123' },
      status: 'kept',
      starred: false,
      seen: false,
    },
    {
      id: 'rss:test-1',
      sourceId: 's2',
      sourceType: 'rss',
      sourceName: 'RSS · 测试',
      title: 'RSS 测试条目',
      author: '某作者',
      authorId: '',
      cover: '',
      url: 'https://example.com/x',
      desc: '文章简介',
      stats: {},
      publishedAt: Date.now(),
      fetchedAt: Date.now(),
      extra: {},
      status: 'kept',
      starred: false,
      seen: false,
    },
  ]);

  const { server, port } = await listen(7902);
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });

  t.after(async () => {
    await browser.close();
    server.close();
    store.flush();
  });

  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.card');

  // 0) 这两条都没有封面 → 应该是紧凑文字卡（没有封面区，标签在正文首行）
  const noCover = await page.$$eval('.card.no-cover', (els) => els.length);
  assert.equal(noCover, 2, '无封面的条目应带 no-cover 类');
  const covers = await page.$$eval('.card .card-cover', (els) => els.length);
  assert.equal(covers, 0, '无封面时不应渲染封面区');
  const headTags = await page.$$eval('.card .card-head .source-tag', (els) => els.length);
  assert.equal(headTags, 2, '来源标签应移到正文首行');

  // 1) 每条卡片都有 ✨ 摘要按钮
  const summaryBtns = await page.$$eval('.card [data-act="summarize"]', (els) => els.length);
  assert.equal(summaryBtns, 2, '两条卡片都应有效摘要按钮');

  // 1.5) 赞 / 踩：点击高亮、写库、统计更新、再点取消
  assert.equal(await page.$$eval('.card [data-act="up"]', (els) => els.length), 2, '每张卡片都应有点赞按钮');
  assert.equal(await page.$$eval('.card [data-act="down"]', (els) => els.length), 2, '每张卡片都应有踩按钮');

  await page.click('.card [data-act="up"]');
  await page.waitForTimeout(800);
  assert.equal(await page.$$eval('.card [data-act="up"].on', (els) => els.length), 1, '点赞后按钮应高亮');
  assert.equal(await page.$eval('#stat-feedback', (el) => el.textContent), '1 / 0', '统计应显示 1 个赞');

  const secondCard = (await page.$$('.card'))[1];
  await secondCard.$eval('[data-act="down"]', (el) => el.click());
  await page.waitForTimeout(800);
  assert.equal(await page.$$eval('.card [data-act="down"].on', (els) => els.length), 1, '点踩后按钮应高亮');
  assert.equal(await page.$eval('#stat-feedback', (el) => el.textContent), '1 / 1', '统计应显示 1 赞 1 踩');

  // 再点一次取消
  await page.click('.card [data-act="up"]');
  await page.waitForTimeout(800);
  assert.equal(await page.$$eval('.card [data-act="up"].on', (els) => els.length), 0, '再点应取消点赞');
  assert.equal(await page.$eval('#stat-feedback', (el) => el.textContent), '0 / 1', '取消后赞数应回落');

  // 刷新页面：反馈应已落库并回显
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.card');
  assert.equal(await page.$$eval('.card [data-act="down"].on', (els) => els.length), 1, '刷新后踩的状态应还在');

  // 2) 只有 B站条目有播放按钮
  const playBtns = await page.$$eval('.card [data-act="play"]', (els) => els.length);
  assert.equal(playBtns, 1, '只有 B站条目应有内嵌播放按钮');

  // 3) 点播放 → 卡片内出现 B站播放器
  await page.click('.card [data-act="play"]');
  await page.waitForTimeout(700);
  const iframeSrc = await page.$eval('.card-player iframe', (el) => el.src);
  assert.ok(iframeSrc.includes('player.bilibili.com'), '应加载 B站播放器');
  assert.ok(iframeSrc.includes('BVTEST123'), '播放器应带上 bvid');

  // 4) 再点一次 → 收起
  await page.click('.card [data-act="play"]');
  await page.waitForTimeout(400);
  assert.equal(await page.$$eval('.card-player.open', (els) => els.length), 0, '再次点击应收起播放器');

  // 5) 悬停放大设置生效
  await page.click('#seg-preview button[data-value="2"]');
  await page.waitForTimeout(300);
  const scale = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--preview-scale').trim(),
  );
  assert.equal(scale, '2', '悬停放大倍率应生效');

  // 6) 简报面板可切换并生成（未配 AI 时为纯列表版）
  await page.click('.ins-tab[data-pane="digest"]');
  await page.waitForSelector('#pane-digest:not(.hidden)');
  await page.click('#btn-digest');
  await page.waitForTimeout(3000);
  const digestText = await page.$eval('#digest-body', (el) => el.textContent);
  assert.ok(digestText.includes('最近 24 小时'), '简报应显示时间范围');
  assert.ok(/B站测试视频|RSS 测试条目/.test(digestText), '简报应包含条目标题');

  console.log('    ✓ 摘要按钮 / 内嵌播放 / 悬停放大 / 简报面板均正常');
});
