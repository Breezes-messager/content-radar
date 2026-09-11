'use strict';

/**
 * XSS 防护测试：往信息池塞入恶意内容，用真实浏览器验证不会被执行。
 * 覆盖标题 / 作者 / 来源名 / 简介 / 链接协议。
 * 运行：node --test test/xss.test.js
 */

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.CONTENT_RADAR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'content-radar-xss-'));

const test = require('node:test');
const assert = require('node:assert');

const store = require('../src/store');
const { listen } = require('../src/server');

const PAYLOAD = '<script>window.__xss=(window.__xss||0)+1</script>';

test('卡片渲染对第三方内容做转义，不执行注入脚本', { timeout: 120000 }, async (t) => {
  store.load();

  // 直接往信息池塞一条「恶意」内容
  store.upsertItems([
    {
      id: 'xss:1',
      sourceId: 'xss-src',
      sourceType: 'rss',
      sourceName: `<img src=x onerror="window.__xss=(window.__xss||0)+10">`,
      sourceMode: 'rss',
      title: PAYLOAD + '正常标题',
      author: `"><img src=x onerror="window.__xss=(window.__xss||0)+100">`,
      authorId: '',
      cover: '',
      url: 'javascript:window.__xss=(window.__xss||0)+1000',
      desc: '<iframe src="javascript:window.__xss=(window.__xss||0)+10000"></iframe>简介',
      stats: { play: 1 },
      publishedAt: Date.now(),
      fetchedAt: Date.now(),
      status: 'kept',
      starred: false,
      seen: false,
    },
  ]);

  const { server, port } = await listen(7960);
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });

  t.after(async () => {
    await browser.close();
    server.close();
    store.flush();
  });

  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  page.on('dialog', (d) => d.dismiss());

  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.card', { timeout: 20000 });

  // 1) 没有任何脚本被执行
  const xssCount = await page.evaluate(() => window.__xss || 0);
  assert.equal(xssCount, 0, '不应执行任何注入脚本');
  assert.equal(pageErrors.length, 0, `不应有页面错误：${pageErrors.join('; ')}`);

  // 2) DOM 里没有注入的元素
  const injected = await page.evaluate(() => ({
    scripts: [...document.querySelectorAll('.card script')].length,
    imgs: document.querySelectorAll('.card img[src="x"]').length,
    iframes: document.querySelectorAll('.card iframe').length,
  }));
  assert.equal(injected.scripts, 0, '不应出现注入的 script');
  assert.equal(injected.imgs, 0, '不应出现注入的 img');
  assert.equal(injected.iframes, 0, '不应出现注入的 iframe');

  // 3) 恶意内容以纯文本形式展示
  const title = await page.$eval('.card-title', (el) => el.textContent);
  assert.ok(title.includes('<script>'), '标题中的标签应以文本形式出现');
  const sourceTag = await page.$eval('.source-tag', (el) => el.textContent);
  assert.ok(sourceTag.includes('<img'), '来源名中的标签应以文本形式出现');

  // 4) javascript: 链接被拦截（safeUrl 返回空 → 不打开，只提示）
  const linkTitle = await page.$eval('.card-actions button:last-child', (el) => el.getAttribute('title'));
  assert.equal(linkTitle, '', 'javascript: 链接应被过滤为空');

  console.log('    ✓ 标题/作者/来源名/简介均以文本渲染，javascript: 链接已被拦截');
});
