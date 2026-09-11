'use strict';

/**
 * 免安装打包脚本（不依赖 electron-builder）
 *
 * Electron 运行时只需要「dist 目录 + resources/app 里的应用代码」，
 * 而本项目是零运行时依赖的，所以直接把源码复制进去即可。
 *
 * 用法：node tools/pack.js
 * 产物：release/ContentRadar/ContentRadar.exe
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'node_modules', 'electron', 'dist');
const OUT = path.join(ROOT, 'release', 'ContentRadar');
const APP_DIR = path.join(OUT, 'resources', 'app');

const COPY = ['package.json', 'src', 'public', 'electron', 'assets', 'README.md'];

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** 结束正在运行的旧实例，否则 release 目录删不掉 */
function killRunningApp() {
  for (const name of ['ContentRadar.exe', 'electron.exe']) {
    try {
      execSync(`taskkill /IM ${name} /F`, { stdio: 'ignore' });
      console.log(`  已结束正在运行的 ${name}`);
    } catch {}
  }
}

function rmrf(target, attempts = 3) {
  if (!fs.existsSync(target)) return;
  for (let i = 0; i < attempts; i++) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      return;
    } catch (err) {
      if (i < attempts - 1) {
        sleepSync(1000);
        killRunningApp();
      } else {
        console.warn(`  ⚠️ 无法完全清理旧目录（${err.code}），改为覆盖式打包`);
      }
    }
  }
}

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) copyRecursive(path.join(src, entry), path.join(dest, entry));
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

function human(bytes) {
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(p) : fs.statSync(p).size;
  }
  return total;
}

(function main() {
  if (!fs.existsSync(DIST)) {
    console.error('找不到 Electron 运行时，请先执行：npm install');
    process.exit(1);
  }

  console.log('清理旧产物…');
  killRunningApp();
  rmrf(path.join(ROOT, 'release'));
  fs.mkdirSync(APP_DIR, { recursive: true });

  console.log('复制 Electron 运行时…');
  for (const entry of fs.readdirSync(DIST)) {
    // 去掉自带的默认应用，换成我们的
    if (entry === 'resources') continue;
    copyRecursive(path.join(DIST, entry), path.join(OUT, entry));
  }
  fs.mkdirSync(path.join(OUT, 'resources'), { recursive: true });
  copyRecursive(path.join(DIST, 'resources', 'default_app.asar'), path.join(OUT, 'resources', 'default_app.asar'));

  console.log('复制应用代码…');
  for (const item of COPY) {
    const src = path.join(ROOT, item);
    if (fs.existsSync(src)) copyRecursive(src, path.join(APP_DIR, item));
  }

  // 复制运行时依赖（例如小黑盒源需要的 playwright-core）
  const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const runtimeDeps = Object.keys(rootPkg.dependencies || {});
  for (const dep of runtimeDeps) {
    const src = path.join(ROOT, 'node_modules', dep);
    if (!fs.existsSync(src)) {
      console.warn(`  ⚠️ 运行时依赖 ${dep} 未安装，打包后该功能不可用`);
      continue;
    }
    console.log(`  复制依赖 ${dep}…`);
    copyRecursive(src, path.join(APP_DIR, 'node_modules', dep));
  }

  // 打包后不需要 devDependencies，剔除以减小体积
  const pkgPath = path.join(APP_DIR, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  delete pkg.devDependencies;
  delete pkg.scripts;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), 'utf8');

  console.log('重命名可执行文件…');
  const exeFrom = path.join(OUT, 'electron.exe');
  const exeTo = path.join(OUT, 'ContentRadar.exe');
  if (fs.existsSync(exeFrom)) fs.renameSync(exeFrom, exeTo);

  const size = dirSize(OUT);
  console.log('');
  console.log('✅ 打包完成');
  console.log('   产物：' + exeTo);
  console.log('   体积：' + human(size));
  console.log('   双击 ContentRadar.exe 即可运行（无需 Node、无需 npm install）');
  console.log('   整个 release/ContentRadar 文件夹可以直接拷给别人用。');
})();
