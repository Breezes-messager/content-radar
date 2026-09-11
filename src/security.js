'use strict';

/**
 * 安全防护工具
 * 集中处理三类针对「本地 HTTP 服务」的常见攻击：
 *   1. SSRF —— 图片代理可能被用来探测内网（含域名解析到内网的绕过）
 *   2. DNS rebinding —— 恶意域名解析到 127.0.0.1 后同源读取本地接口
 *   3. CSRF —— 恶意网页向本地接口发起写操作
 */

const net = require('net');
const dns = require('dns').promises;

/** IP 是否属于内网 / 保留 / 不可路由地址 */
function isPrivateIp(ip) {
  const version = net.isIP(ip);
  if (version === 4) {
    const p = ip.split('.').map(Number);
    if (p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    if (p[0] === 0 || p[0] === 10 || p[0] === 127) return true; // 本机 / 私有
    if (p[0] === 169 && p[1] === 254) return true; // link-local（云元数据）
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true; // 私有
    if (p[0] === 192 && p[1] === 168) return true; // 私有
    if (p[0] === 192 && p[1] === 0 && p[2] === 0) return true; // IETF 保留
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT
    if (p[0] >= 224) return true; // 组播 / 保留
    return false;
  }
  if (version === 6) {
    const low = ip.toLowerCase();
    if (low === '::1' || low === '::') return true;
    if (low.startsWith('fc') || low.startsWith('fd')) return true; // ULA
    if (low.startsWith('fe80')) return true; // link-local
    if (low.startsWith('::ffff:')) return isPrivateIp(low.slice(7)); // IPv4-mapped
    if (low.startsWith('64:ff9b:')) return true; // NAT64
    return false;
  }
  return true; // 不是合法 IP，按不安全处理
}

/**
 * 是否允许代理的地址：必须是 http(s)，且解析结果全部为公网地址。
 * 域名会真实解析一次，避免 127.0.0.1.nip.io 这类绕过。
 */
async function isPublicHttpUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.username || u.password) return false; // 禁止带凭据的 URL

  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  if (host.endsWith('.internal') || host.endsWith('.local') || host.endsWith('.home.arpa')) return false;

  if (net.isIP(host)) return !isPrivateIp(host);

  try {
    const records = await dns.lookup(host, { all: true });
    if (!records.length) return false;
    return records.every((r) => !isPrivateIp(r.address));
  } catch {
    return false; // 解析失败一律拒绝
  }
}

const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0:0:0:0:0:0:0:1']);

function normalizeHostname(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, ''); // 去掉根域点
}

/** Host 头是否指向本机（防 DNS rebinding） */
function isLocalHost(hostHeader) {
  const host = normalizeHostname(hostHeader).replace(/:\d+$/, '');
  return LOCAL_HOSTNAMES.has(host);
}

/** Origin / Referer 是否来自本机（防 CSRF） */
function isLocalOrigin(value) {
  if (!value) return false;
  try {
    const u = new URL(String(value));
    return LOCAL_HOSTNAMES.has(normalizeHostname(u.hostname));
  } catch {
    return false;
  }
}

/**
 * 请求守卫：返回 null 表示放行，否则返回 { status, message }
 * @param {import('http').IncomingMessage} req
 */
function guard(req) {
  // 1) Host 必须是本机，否则可能是 DNS rebinding
  const hostHeader = req.headers.host;
  if (hostHeader && !isLocalHost(hostHeader)) {
    return { status: 403, message: '拒绝非本机 Host 的请求' };
  }

  // 2) 跨站来源一律拒绝（浏览器跨站请求一定带 Origin 或 Referer）
  const origin = req.headers.origin;
  if (origin && !isLocalOrigin(origin)) {
    return { status: 403, message: '拒绝跨站请求' };
  }
  const referer = req.headers.referer;
  if (referer && !isLocalOrigin(referer)) {
    return { status: 403, message: '拒绝跨站请求' };
  }

  return null;
}

module.exports = { isPrivateIp, isPublicHttpUrl, isLocalHost, isLocalOrigin, guard, LOCAL_HOSTNAMES };
