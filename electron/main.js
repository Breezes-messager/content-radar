'use strict';

/**
 * Electron 主进程
 * 把本地 HTTP 服务内嵌进 App，用原生窗口承载前端页面；
 * 支持托盘常驻与新内容系统通知。
 */

const path = require('path');
const { app, BrowserWindow, shell, dialog, Tray, Menu, Notification, nativeImage } = require('electron');

// 关键：数据目录必须指向用户数据目录（打包后 asar 内部是只读的）
// 必须在 require 业务模块之前设置，config.js 会读取这个环境变量
process.env.CONTENT_RADAR_DATA_DIR = path.join(app.getPath('userData'), 'data');

const store = require('../src/store');
const { listen } = require('../src/server');
const { loadConfig } = require('../src/config');
const { events } = require('../src/pipeline');

const ICON_PATH = path.join(__dirname, '..', 'assets', 'icon.png');
const TRAY_PATH = path.join(__dirname, '..', 'assets', 'tray.png');

let win = null;
let tray = null;
let serverRef = null;
let baseUrl = '';
let quitting = false;

/* ---------------------------- 单实例 ---------------------------- */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showWindow();
  });
}

/* --------------------------- 内嵌服务 --------------------------- */

async function startLocalServer() {
  store.load();
  const cfg = loadConfig();
  const { server, port } = await listen(Number(cfg.port) || 7788);
  serverRef = server;
  baseUrl = `http://127.0.0.1:${port}`;
  console.log('[app] 本地服务已启动:', baseUrl);
  console.log('[app] 数据目录:', process.env.CONTENT_RADAR_DATA_DIR);
  return baseUrl;
}

/* ---------------------------- 主窗口 ---------------------------- */

function showWindow() {
  if (!win) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#16161a',
    title: 'Content Radar · 内容雷达',
    icon: ICON_PATH,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => win.show());
  win.loadURL(baseUrl);

  // 站内链接留在 App 内，外部链接交给系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(baseUrl)) return { action: 'allow' };
    shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(baseUrl)) {
      event.preventDefault();
      shell.openExternal(url).catch(() => {});
    }
  });

  // 关闭窗口时缩到托盘（除非用户选了「退出」）
  win.on('close', (event) => {
    if (quitting) return;
    let minimizeToTray = true;
    try {
      minimizeToTray = loadConfig().minimizeToTray !== false;
    } catch {}
    if (minimizeToTray && tray) {
      event.preventDefault();
      win.hide();
    }
  });

  win.on('closed', () => {
    win = null;
  });
}

/* ----------------------------- 托盘 ----------------------------- */

function createTray() {
  console.log('[app] 正在创建托盘，图标路径:', TRAY_PATH);
  let image = nativeImage.createFromPath(TRAY_PATH);
  console.log('[app] tray.png 加载结果：isEmpty =', image.isEmpty());
  if (image.isEmpty()) {
    image = nativeImage.createFromPath(ICON_PATH);
    console.log('[app] 回退到 icon.png：isEmpty =', image.isEmpty());
  }
  if (image.isEmpty()) {
    console.warn('[app] 托盘图标缺失，跳过托盘');
    return;
  }

  try {
    tray = new Tray(image.resize({ width: 16, height: 16 }));
  } catch (err) {
    console.warn('[app] 创建托盘失败:', err.message);
    return;
  }

  const menu = Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => showWindow() },
    { label: '立即抓取', click: () => triggerFetch() },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);

  tray.setToolTip('Content Radar · 内容雷达');
  tray.setContextMenu(menu);
  tray.on('click', () => showWindow());
  tray.on('double-click', () => showWindow());
  console.log('[app] 托盘已创建（关闭窗口将缩到托盘）');
}

/* -------------------------- 抓取与通知 -------------------------- */

async function triggerFetch() {
  try {
    const res = await fetch(`${baseUrl}/api/fetch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const json = await res.json();
    if (json && json.ok) {
      const added = (json.summary.sources || []).reduce((a, s) => a + (s.new || 0), 0);
      tray?.displayBalloon?.({ title: 'Content Radar', content: `抓取完成，新增 ${added} 条` });
    }
  } catch (err) {
    console.warn('[app] 托盘抓取失败:', err.message);
  }
}

function notifyNewItems(summary) {
  const rows = (summary && summary.sources) || [];
  const added = rows.reduce((a, s) => a + (s.new || 0), 0);
  if (!added) return;

  // 窗口正开着就别打扰
  if (win && win.isVisible() && win.isFocused()) return;

  let enabled = true;
  try {
    enabled = loadConfig().notify !== false;
  } catch {}
  if (!enabled) return;
  if (!Notification.isSupported()) return;

  const detail = rows
    .filter((s) => s.new > 0)
    .slice(0, 2)
    .map((s) => `${s.sourceName} +${s.new}`)
    .join('，');

  const notification = new Notification({
    title: 'Content Radar · 有新内容',
    body: `${added} 条新内容${detail ? `（${detail}）` : ''}`,
    icon: ICON_PATH,
  });
  notification.on('click', () => showWindow());
  notification.show();
}

events.on('fetched', (summary) => {
  try {
    notifyNewItems(summary);
  } catch (err) {
    console.warn('[app] 通知失败:', err.message);
  }
});

/* ----------------------------- 生命周期 ----------------------------- */

app.whenReady().then(async () => {
  try {
    await startLocalServer();
  } catch (err) {
    dialog.showErrorBox('Content Radar 启动失败', '无法启动本地服务：\n\n' + err.message);
    app.quit();
    return;
  }

  createWindow();
  createTray();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // 托盘常驻时不因为关窗口就退出
  if (process.platform !== 'darwin' && !tray) app.quit();
});

app.on('before-quit', () => {
  quitting = true;
  try {
    store.flush();
  } catch {}
  try {
    require('../src/sources/xiaoheihe').closeBrowser();
  } catch {}
  try {
    require('../src/loginWindow').closeAll();
  } catch {}
  try {
    if (serverRef) serverRef.close();
  } catch {}
  try {
    if (tray) tray.destroy();
  } catch {}
});
