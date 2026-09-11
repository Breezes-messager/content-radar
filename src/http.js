'use strict';

/**
 * 统一出网封装：超时、重试、UA、JSON/文本解析。
 * 零依赖，仅用 Node 内置 fetch。
 */

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(url, { headers = {}, timeoutMs = 15000, retries = 2, method = 'GET', body, redirect = 'follow' } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        body,
        signal: ac.signal,
        redirect,
        headers: { 'User-Agent': DEFAULT_UA, 'Accept-Language': 'zh-CN,zh;q=0.9', ...headers },
      });
      clearTimeout(timer);
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < retries) await sleep(400 * (attempt + 1));
    }
  }
  throw new Error(`请求失败 ${url}: ${lastErr && lastErr.message}`);
}

async function getJson(url, opts = {}) {
  const res = await request(url, { ...opts, headers: { Accept: 'application/json, text/plain, */*', ...opts.headers } });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`响应不是合法 JSON (HTTP ${res.status}): ${text.slice(0, 160)}`);
  }
}

async function getText(url, opts = {}) {
  const res = await request(url, {
    ...opts,
    headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', ...opts.headers },
  });
  return { status: res.status, text: await res.text(), headers: res.headers };
}

/** 抓取二进制（用于图片代理），可限制最大字节数避免被大文件拖垮 */
async function getBuffer(url, opts = {}) {
  const { maxBytes = 0, ...rest } = opts;
  const res = await request(url, rest);

  const declared = Number(res.headers.get('content-length') || 0);
  if (maxBytes && declared > maxBytes) {
    try {
      await res.body?.cancel();
    } catch {}
    throw new Error(`响应声明长度 ${declared} 字节，超过上限 ${maxBytes}`);
  }

  if (!res.body) return { status: res.status, headers: res.headers, buffer: Buffer.alloc(0) };

  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (maxBytes && total > maxBytes) {
      try {
        await res.body.cancel();
      } catch {}
      throw new Error(`响应超过 ${maxBytes} 字节上限`);
    }
    chunks.push(chunk);
  }
  return { status: res.status, headers: res.headers, buffer: Buffer.concat(chunks) };
}

/** 极简 HTML 实体解码 + 去标签，用于 RSS description 清洗 */
function stripHtml(input = '') {
  return String(input)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = { request, getJson, getText, getBuffer, stripHtml, sleep, DEFAULT_UA };
