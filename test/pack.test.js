'use strict';

/**
 * 打包冒烟测试：执行 tools/pack.js 并校验产物完整性。
 * 注意：会重建 release/ 目录，比较慢，所以不放进 npm test 默认集。
 * 运行：node --test test/pack.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

test('打包脚本能产出可运行的 App（含运行时依赖）', { timeout: 600000 }, () => {
  // 打包前先结束正在运行的实例，否则 release 目录删不掉
  try {
    execSync('taskkill /IM ContentRadar.exe /F', { stdio: 'ignore' });
  } catch {}

  require('../tools/pack.js');

  const out = path.join(__dirname, '..', 'release', 'ContentRadar');
  const appDir = path.join(out, 'resources', 'app');

  assert.ok(fs.existsSync(path.join(out, 'ContentRadar.exe')), '应产出 ContentRadar.exe');
  assert.ok(fs.existsSync(path.join(appDir, 'electron', 'main.js')), '应包含 Electron 主进程');
  assert.ok(fs.existsSync(path.join(appDir, 'src', 'sources', 'tieba.js')), '应包含贴吧适配器');
  assert.ok(fs.existsSync(path.join(appDir, 'src', 'sources', 'xiaoheihe.js')), '应包含小黑盒适配器');
  assert.ok(fs.existsSync(path.join(appDir, 'assets', 'icon.png')), '应包含应用图标');
  assert.ok(fs.existsSync(path.join(appDir, 'assets', 'tray.png')), '应包含托盘图标');
  assert.ok(
    fs.existsSync(path.join(appDir, 'node_modules', 'playwright-core')),
    '应包含 playwright-core 运行时依赖（小黑盒需要）',
  );

  const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
  assert.equal(pkg.main, 'electron/main.js', '打包后的入口应指向主进程');
  assert.ok(!pkg.devDependencies, '打包后应剔除 devDependencies');
});
