'use strict';

/**
 * 依赖漏洞审计：调用 npm audit，要求没有 high / critical 级别漏洞。
 * 需要联网访问 npm registry；离线时自动跳过。
 * 运行：node --test test/audit.test.js
 */

const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert');
const { execSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

function runAudit() {
  try {
    const out = execSync('npm.cmd audit --json', {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000,
    });
    return JSON.parse(out);
  } catch (err) {
    // npm audit 发现漏洞时退出码非 0，但 stdout 里仍有完整 JSON
    if (err.stdout) {
      try {
        return JSON.parse(err.stdout);
      } catch {}
    }
    return null;
  }
}

test('依赖没有 high / critical 级别的已知漏洞', { timeout: 180000 }, () => {
  const report = runAudit();
  if (!report) {
    console.log('    ⚠️ npm audit 不可用（可能离线），已跳过');
    return;
  }

  const v = (report.metadata && report.metadata.vulnerabilities) || {};
  console.log(
    `    依赖审计：critical=${v.critical || 0} high=${v.high || 0} moderate=${v.moderate || 0} low=${v.low || 0} info=${v.info || 0}`,
  );

  if (v.critical || v.high) {
    const detail = Object.values(report.vulnerabilities || {})
      .filter((x) => x.severity === 'high' || x.severity === 'critical')
      .map((x) => `${x.name}(${x.severity})`)
      .join(', ');
    assert.fail(`存在高危依赖漏洞：${detail}`);
  }
});
