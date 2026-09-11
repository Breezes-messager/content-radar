'use strict';

/**
 * 视觉快照工具：生成列表形态的截图，方便人工检查排版。
 * 手动运行：node --test test/snapshot.test.js
 * 截图输出到系统临时目录。
 */

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.CONTENT_RADAR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'content-radar-shot-'));

const test = require('node:test');
const assert = require('node:assert');

const store = require('../src/store');
const { listen } = require('../src/server');
const { updateConfig } = require('../src/config');

const now = Date.now();

const withCover = (i) => ({
  id: `shot:bili:${i}`,
  sourceId: 'shot-bili',
  sourceType: 'bilibili',
  sourceName: 'B站 · 搜索「人工智能」',
  sourceMode: 'search',
  title: `【深度解析】大模型推理优化实战 ${i}：从 KV Cache 到连续批处理`,
  author: '某技术UP主',
  authorId: '1',
  cover: 'https://i0.hdslb.com/bfs/archive/b31e4b5f678f04d736a811460e591fc9719c98e3.jpg',
  url: `https://www.bilibili.com/video/BV1xx411c7mD${i}`,
  desc: '本期视频详细讲解了推理框架中的调度策略，并对比了 vLLM、TensorRT-LLM 的实测数据。',
  stats: { play: 123456, danmaku: 892, like: 4521 },
  publishedAt: now - i * 3600 * 1000,
  fetchedAt: now,
  extra: { bvid: `BV1xx411c7mD${i}` },
  status: 'kept',
  starred: false,
  seen: false,
  ai: { score: 8, tags: ['AI', '推理优化'], reason: '技术深度高，与兴趣匹配' },
});

const noCover = (i) => ({
  id: `shot:tieba:${i}`,
  sourceId: 'shot-tieba',
  sourceType: 'tieba',
  sourceName: '贴吧 · deepseek吧',
  sourceMode: 'forum',
  title: `新4.1甲巨厚，这次更新到底值不值得升 ${i}`,
  author: '曾爱菜nice',
  authorId: '',
  cover: '',
  url: `https://tieba.baidu.com/p/12345678${i}`,
  desc: '',
  stats: { reply: 176, like: 12 },
  publishedAt: now - i * 1800 * 1000,
  fetchedAt: now,
  extra: {},
  status: 'kept',
  starred: false,
  seen: false,
  ai: { score: 6, tags: ['AI', '讨论'], reason: '有一定信息量但偏主观' },
});

test('生成列表形态的视觉快照', { timeout: 120000 }, async (t) => {
  store.load();
  updateConfig({ layout: 'single' });

  const items = [];
  for (let i = 0; i < 6; i++) {
    items.push(withCover(i), noCover(i));
  }
  store.upsertItems(items);

  const { server, port } = await listen(7910);
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });

  t.after(async () => {
    await browser.close();
    server.close();
    store.flush();
  });

  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#feed .card');
  await page.waitForTimeout(4000); // 等封面图加载

  // 基本结构断言
  const stats = await page.evaluate(() => ({
    cards: document.querySelectorAll('#feed .card').length,
    withCover: document.querySelectorAll('#feed .card .card-cover').length,
    noCover: document.querySelectorAll('#feed .card.no-cover').length,
    cols: document.querySelectorAll('#feed .feed-col').length,
  }));
  assert.equal(stats.cards, 12, '应有 12 条卡片');
  assert.equal(stats.withCover, 6, '6 条带封面');
  assert.equal(stats.noCover, 6, '6 条无封面');
  assert.equal(stats.cols, 0, '列表形态不使用列容器');

  const listShot = path.join(os.tmpdir(), 'content-radar-list.png');
  await page.screenshot({ path: listShot });
  console.log(`    列表形态截图：${listShot}`);

  await page.click('#seg-layout button[data-value="double"]');
  await page.waitForTimeout(2500);
  const doubleShot = path.join(os.tmpdir(), 'content-radar-double.png');
  await page.screenshot({ path: doubleShot });
  console.log(`    双栏截图：${doubleShot}`);

  // 多栏时卡片应为纵向（封面在上）
  const columnCard = await page.evaluate(() => {
    const card = document.querySelector('#feed .card');
    return card ? getComputedStyle(card).flexDirection : '';
  });
  assert.equal(columnCard, 'column', '多栏时卡片应改为纵向布局');

  // 简报弹窗排版
  await page.evaluate(() => {
    window.openDigestModal({
      date: '2026-09-09',
      generatedAt: Date.now(),
      hours: 24,
      total: 12,
      model: 'deepseek-chat',
      bySource: [
        { name: '贴吧 · deepseek吧', count: 8 },
        { name: 'B站 · 全站排行榜', count: 4 },
      ],
      overview: [
        '**整体综述**',
        '近期 AI 领域讨论热度极高，核心焦点集中在 DeepSeek 与 OpenAI 的竞争态势、模型版本迭代以及 AI 技术突破性进展上。',
        '',
        '**重点条目**',
        '- AI 已攻克纳米-斯托克斯千年难题 —— 若属实，将是 AI 在基础科学领域的里程碑式突破',
        '- 官网通告：V4.1 Flash 将于 9月10日 正式发布，旧旗舰型号将逐步淘汰',
        '',
        '**值得留意**',
        '- 梁圣降价阴谋论篇 —— 反映用户对价格战背后商业逻辑的敏感与疑惑',
      ].join('\n'),
      items: [
        {
          title: '新4.1甲巨厚，这次更新到底值不值得升',
          url: 'https://tieba.baidu.com/p/1',
          sourceName: '贴吧 · deepseek吧',
          author: '曾爱菜nice',
          score: 6,
          tags: ['AI', '讨论'],
          summary: '有一定信息量但偏主观',
        },
        {
          title: '【深度解析】大模型推理优化实战：从 KV Cache 到连续批处理',
          url: 'https://www.bilibili.com/video/BV1xx411c7mD',
          sourceName: 'B站 · 全站排行榜',
          author: '某技术UP主',
          score: 8,
          tags: ['AI', '推理优化'],
        },
      ],
    });
  });
  await page.waitForTimeout(800);

  const digestShot = path.join(os.tmpdir(), 'content-radar-digest.png');
  await page.screenshot({ path: digestShot });
  console.log(`    简报弹窗截图：${digestShot}`);

  // markdown 应被渲染成真正的标签，而不是露出星号
  const md = await page.evaluate(() => ({
    strong: document.querySelectorAll('#digest-modal-body strong').length,
    lis: document.querySelectorAll('#digest-modal-body li').length,
    rawStars: document.querySelector('#digest-modal-body').textContent.includes('**'),
  }));
  assert.ok(md.strong >= 3, `应渲染出粗体标签，实际 ${md.strong}`);
  assert.ok(md.lis >= 3, `应渲染出列表项，实际 ${md.lis}`);
  assert.equal(md.rawStars, false, '不应把 ** 星号直接显示出来');
});
