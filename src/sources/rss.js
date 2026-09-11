'use strict';

/**
 * 通用 RSS / Atom 适配器
 * 用来接入 RSSHub 等任意订阅源（贴吧、微博、知乎、公众号、小黑盒镜像等都可以走这里）。
 * 零依赖，手写轻量解析器。
 */

const crypto = require('crypto');
const { getText, stripHtml } = require('../http');

function unescapeXml(s = '') {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

function pick(block, tag) {
  const m =
    block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i')) ||
    block.match(new RegExp(`<${tag}[^>]*/>`, 'i'));
  return m ? unescapeXml(m[1] || '').trim() : '';
}

function pickLink(block) {
  const direct = pick(block, 'link');
  if (direct) return direct;
  const alt = block.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i);
  if (alt) return unescapeXml(alt[1]);
  const any = block.match(/<link[^>]*href=["']([^"']+)["']/i);
  return any ? unescapeXml(any[1]) : '';
}

function pickImage(block) {
  const patterns = [
    /<media:content[^>]*url=["']([^"']+)["']/i,
    /<media:thumbnail[^>]*url=["']([^"']+)["']/i,
    /<enclosure[^>]*url=["']([^"']+)["'][^>]*>/i,
    /<img[^>]*src=["']([^"']+)["']/i,
  ];
  for (const p of patterns) {
    const m = block.match(p);
    if (m) return unescapeXml(m[1]);
  }
  return '';
}

function splitEntries(xml) {
  const itemBlocks = [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)].map((m) => m[0]);
  if (itemBlocks.length) return { blocks: itemBlocks, kind: 'rss' };
  const entryBlocks = [...xml.matchAll(/<entry[\s>][\s\S]*?<\/entry>/gi)].map((m) => m[0]);
  return { blocks: entryBlocks, kind: 'atom' };
}

function parseFeed(xml) {
  const channelTitle = pick(xml.split(/<item[\s>]|<entry[\s>]/i)[0] || '', 'title');
  const { blocks, kind } = splitEntries(xml);
  const entries = blocks.map((block) => {
    const rawDate = pick(block, 'pubDate') || pick(block, 'published') || pick(block, 'updated') || pick(block, 'dc:date');
    const ts = rawDate ? Date.parse(rawDate) : NaN;
    const description = pick(block, 'description') || pick(block, 'summary') || pick(block, 'content') || pick(block, 'content:encoded');
    return {
      title: stripHtml(pick(block, 'title')),
      link: pickLink(block),
      author: stripHtml(pick(block, 'author') || pick(block, 'dc:creator') || pick(block, 'name')),
      desc: stripHtml(description).slice(0, 300),
      image: pickImage(block) || pickImage(description),
      publishedAt: Number.isFinite(ts) ? ts : 0,
      guid: pick(block, 'guid') || pick(block, 'id') || '',
    };
  });
  return { title: stripHtml(channelTitle), kind, entries };
}

const hashId = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

async function fetchItems(source, ctx = {}) {
  const url = String(source.options.url || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('RSS 源缺少合法 url');
  const timeoutMs = ctx.timeoutMs || 15000;
  const limit = ctx.limit || source.options.pageSize || 24;

  const { status, text } = await getText(url, { timeoutMs, headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' } });
  if (status >= 400) throw new Error(`RSS 源返回 HTTP ${status}`);
  const feed = parseFeed(text);

  return feed.entries
    .filter((e) => e.title || e.link)
    .slice(0, limit)
    .map((e) => ({
      id: `${source.id}:${hashId(e.guid || e.link || e.title)}`,
      sourceId: source.id,
      sourceType: 'rss',
      sourceName: source.name,
      sourceMode: 'rss',
      title: e.title || '(无标题)',
      author: e.author || feed.title || '',
      authorId: '',
      cover: e.image || '',
      url: e.link || '',
      desc: e.desc || '',
      stats: {},
      publishedAt: e.publishedAt || Date.now(),
      fetchedAt: Date.now(),
      extra: { feedTitle: feed.title },
      status: 'kept',
      starred: false,
      seen: false,
    }));
}

module.exports = { type: 'rss', label: 'RSS', fetchItems, parseFeed, MODES: [{ value: 'rss', label: '订阅源', fields: ['url'] }] };
