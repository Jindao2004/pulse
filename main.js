'use strict';

const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  ipcMain,
  screen,
  nativeImage,
  nativeTheme,
  systemPreferences,
  dialog,
  shell,
  Notification,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { MetricsMonitor } = require('./lib/metrics');
const { GameMode } = require('./lib/game-mode');
const { autoUpdater } = require('electron-updater');

const execFileAsync = promisify(execFile);

// This is a tiny, mostly static desktop widget. Software compositing avoids
// waking the discrete GPU every frame just to shade a 320px panel.
app.disableHardwareAcceleration();

const APP_NAME = 'Pulse';
const APP_ID = 'com.pulse.monitor';
const WINDOW_WIDTH = 320;
const BASE_WINDOW_HEIGHT = 594;
const PERIPHERAL_ROW_HEIGHT = 28;
let currentWindowHeight = BASE_WINDOW_HEIGHT;
const SETTINGS_WIDTH = 700;
const SETTINGS_HEIGHT = 760;
const DEFAULT_REFRESH_MS = 1000;
const POSITIONS = [
  ['top-left', '左上'],
  ['top-center', '上中'],
  ['top-right', '右上'],
  ['middle-left', '左中'],
  ['center', '居中'],
  ['middle-right', '右中'],
  ['bottom-left', '左下'],
  ['bottom-center', '下中'],
  ['bottom-right', '右下'],
];
const EMPTY_SENSORS = {
  cpu: { fan: '', temperature: '', frequency: '', power: '' },
  gpu: { fan: '', temperature: '', frequency: '', power: '' },
};

const POWERSHELL = process.env.SystemRoot
  ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe';

const screenshotArg = process.argv.find((arg) => arg.startsWith('--screenshot'));
const screenshotTarget = screenshotArg
  ? path.resolve(
      process.cwd(),
      screenshotArg.includes('=') ? screenshotArg.split('=').slice(1).join('=') : 'preview.png',
    )
  : null;
const openSettingsOnLaunch = process.argv.includes('--settings');

app.setName(APP_NAME);
app.setAppUserModelId(APP_ID);
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

if (!app.requestSingleInstanceLock() && !screenshotTarget) {
  app.quit();
}

let mainWindow = null;
let settingsWindow = null;
let tray = null;
let monitor = null;
let gameMode = null;
let hiddenForGame = false;
let gameVisibilityTimer = null;
let gameConfigSyncTimer = null;
let lastGameSnapshot = '';
const gameIconCache = new Map();
let quitting = false;
let saveTimer = null;
let firstHideHintShown = false;
let config = null;
let configPath = null;
let configBackupPath = null;

const updateState = {
  status: 'idle',
  currentVersion: app.getVersion(),
  version: null,
  percent: 0,
  message: '点击检查更新',
  releaseNotes: '',
};
let updaterInitialized = false;
let notifiedUpdateVersion = '';
let startupUpdateTimer = null;

function showUpdateNotification(version) {
  if (!version || notifiedUpdateVersion === version) return;
  if (!Notification.isSupported()) return;
  notifiedUpdateVersion = version;
  const notification = new Notification({
    title: `Pulse 有新版本 v${version}`,
    body: '点击打开设置，检查并安装更新。',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
  });
  notification.on('click', () => showSettingsWindow());
  notification.show();
}

function getUpdateState() {
  return { ...updateState };
}

function publishUpdateState(patch) {
  Object.assign(updateState, patch);
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('pulse:update', getUpdateState());
  }
  if (tray) updateTrayMenu();
}

function initAutoUpdater() {
  if (updaterInitialized || !app.isPackaged) return;
  updaterInitialized = true;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;
  autoUpdater.allowPrerelease = false;

  autoUpdater.on('checking-for-update', () => {
    publishUpdateState({ status: 'checking', percent: 0, message: '正在检查更新…' });
  });
  autoUpdater.on('update-available', (info) => {
    const notes = Array.isArray(info.releaseNotes)
      ? info.releaseNotes.map((item) => item.note || '').join('\n')
      : String(info.releaseNotes || '');
    publishUpdateState({
      status: 'available',
      version: info.version,
      percent: 0,
      message: `发现新版本 ${info.version}`,
      releaseNotes: notes,
    });
    if (!settingsWindow || settingsWindow.isDestroyed() || !settingsWindow.isVisible()) {
      showUpdateNotification(info.version);
    }
  });
  autoUpdater.on('update-not-available', (info) => {
    publishUpdateState({
      status: 'latest',
      version: info?.version || null,
      percent: 0,
      message: `已是最新版本 ${app.getVersion()}`,
      releaseNotes: '',
    });
  });
  autoUpdater.on('download-progress', (progress) => {
    publishUpdateState({
      status: 'downloading',
      percent: Math.max(0, Math.min(100, Math.round(Number(progress.percent) || 0))),
      message: `正在下载 ${Math.round(Number(progress.percent) || 0)}%`,
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    publishUpdateState({
      status: 'downloaded',
      version: info.version,
      percent: 100,
      message: `更新 ${info.version} 已下载，重启后安装`,
    });
  });
  autoUpdater.on('error', (error) => {
    publishUpdateState({
      status: 'error',
      message: `更新失败：${error?.message || '未知错误'}`,
    });
  });
}

async function checkForUpdates() {
  if (!app.isPackaged) {
    publishUpdateState({ status: 'error', message: '开发模式下不检查更新' });
    return getUpdateState();
  }
  initAutoUpdater();
  publishUpdateState({ status: 'checking', percent: 0, message: '正在检查更新…' });
  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    publishUpdateState({
      status: 'error',
      message: `检查更新失败：${error?.message || '网络错误'}`,
    });
  }
  return getUpdateState();
}

async function downloadUpdate() {
  if (!app.isPackaged) return getUpdateState();
  initAutoUpdater();
  publishUpdateState({ status: 'downloading', percent: 0, message: '正在下载 0%' });
  try {
    await autoUpdater.downloadUpdate();
  } catch (error) {
    publishUpdateState({
      status: 'error',
      message: `下载更新失败：${error?.message || '网络错误'}`,
    });
  }
  return getUpdateState();
}

function installUpdate() {
  if (!app.isPackaged || updateState.status !== 'downloaded') return false;
  setImmediate(() => autoUpdater.quitAndInstall(true, true));
  return true;
}

const defaultConfig = {
  autoStart: true,
  refreshMs: DEFAULT_REFRESH_MS,
  position: 'bottom-right',
  margin: 0,
  displayId: null,
  sensors: cloneSensors(EMPTY_SENSORS),
  game: null,
  games: null,
};

function cloneSensors(source) {
  return {
    cpu: { ...EMPTY_SENSORS.cpu, ...(source?.cpu || {}) },
    gpu: { ...EMPTY_SENSORS.gpu, ...(source?.gpu || {}) },
  };
}

function sanitizeSensors(source) {
  const result = cloneSensors(EMPTY_SENSORS);
  for (const group of ['cpu', 'gpu']) {
    for (const metric of ['fan', 'temperature', 'frequency', 'power']) {
      const value = source?.[group]?.[metric];
      result[group][metric] = typeof value === 'string' ? value : '';
    }
  }
  return result;
}

function normalizeLoadedConfig(parsed) {
  const position = POSITIONS.some(([id]) => id === parsed.position)
    ? parsed.position
    : defaultConfig.position;
  return {
    autoStart: Boolean(parsed.autoStart),
    refreshMs: [1000, 2000, 5000].includes(Number(parsed.refreshMs))
      ? Number(parsed.refreshMs)
      : DEFAULT_REFRESH_MS,
    position,
    margin: Math.max(0, Math.min(200, Number(parsed.margin) || defaultConfig.margin)),
    displayId: parsed.displayId ?? null,
    sensors: sanitizeSensors(parsed.sensors),
    game: parsed.game && typeof parsed.game === 'object' ? parsed.game : null,
    games: Array.isArray(parsed.games) ? parsed.games : null,
  };
}

function loadConfig() {
  configPath = path.join(app.getPath('userData'), 'config.json');
  configBackupPath = path.join(app.getPath('userData'), 'config.backup.json');
  for (const candidate of [configPath, configBackupPath]) {
    try {
      if (!fs.existsSync(candidate)) continue;
      return normalizeLoadedConfig(JSON.parse(fs.readFileSync(candidate, 'utf8')));
    } catch {
      // A corrupt primary config should fall through to the backup.
    }
  }
  return {
    ...defaultConfig,
    sensors: cloneSensors(defaultConfig.sensors),
  };
}

function saveConfig() {
  if (!configPath) return;
  try {
    if (gameMode) {
      try {
        const gameState = gameMode.getState();
        config.game = gameState.config;
        config.games = gameState.games;
      } catch {
        // Keep the last known game settings if the helper files are mid-write.
      }
    }
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    if (configBackupPath) {
      fs.copyFileSync(configPath, configBackupPath);
    }
  } catch (error) {
    console.error('Could not save config:', error.message);
  }
}

function debounceSaveConfig() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveConfig, 400);
}

function syncGameConfigSnapshot() {
  if (!gameMode || !config) return;
  try {
    const gameState = gameMode.getState();
    const snapshot = JSON.stringify({
      game: gameState.config,
      games: gameState.games,
    });
    if (snapshot === lastGameSnapshot) return;
    lastGameSnapshot = snapshot;
    config.game = gameState.config;
    config.games = gameState.games;
    saveConfig();
  } catch {
    // The helper files may be between atomic writes; retry on the next tick.
  }
}

function getSelectedDisplay() {
  const displays = screen.getAllDisplays();
  return (
    displays.find((display) => String(display.id) === String(config.displayId)) ||
    screen.getPrimaryDisplay()
  );
}

function computeWindowPosition() {
  const area = getSelectedDisplay().workArea;
  const margin = Math.max(0, Math.min(200, Number(config.margin) || 0));
  const anchor = config.position || 'bottom-right';
  let x;
  let y;

  if (anchor.endsWith('left')) x = area.x + margin;
  else if (anchor.endsWith('right')) x = area.x + area.width - WINDOW_WIDTH - margin;
  else x = area.x + Math.round((area.width - WINDOW_WIDTH) / 2);

  if (anchor.startsWith('top')) y = area.y + margin;
  else if (anchor.startsWith('bottom')) y = area.y + area.height - currentWindowHeight - margin;
  else y = area.y + Math.round((area.height - currentWindowHeight) / 2);

  x = Math.max(area.x, Math.min(x, area.x + area.width - WINDOW_WIDTH));
  y = Math.max(area.y, Math.min(y, area.y + area.height - currentWindowHeight));
  return { x, y };
}

function applyWindowPosition() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const { x, y } = computeWindowPosition();
  mainWindow.setPosition(x, y, false);
}

function peripheralDeviceCount(state) {
  const seenKeys = new Set();
  const seenNames = new Set();
  let count = 0;
  const nameKey = (name) =>
    String(name || '')
      .toLowerCase()
      .replace(/^razer\s+/i, '')
      .replace(/\s+/g, ' ')
      .trim();
  const add = (device, source) => {
    const key = String(device?.key || device?.name || '').toLowerCase();
    if (!key || seenKeys.has(key)) return;
    if (source === 'usb' && seenNames.has(nameKey(device.name))) return;
    seenKeys.add(key);
    seenNames.add(nameKey(device.name));
    count += 1;
  };

  for (const device of Array.isArray(state?.razer?.devices) ? state.razer.devices : []) {
    add(device, 'razer');
  }
  for (const device of Array.isArray(state?.peripherals?.devices)
    ? state.peripherals.devices
    : []) {
    add(device, device.source);
  }
  return count;
}

function resizeForPeripheralCount(count) {
  const rows = Math.max(1, Math.min(8, Number(count) || 0));
  const targetHeight = BASE_WINDOW_HEIGHT + (rows - 3) * PERIPHERAL_ROW_HEIGHT;
  if (targetHeight === currentWindowHeight) return;

  currentWindowHeight = targetHeight;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const [width] = mainWindow.getSize();
  mainWindow.setResizable(true);
  mainWindow.setSize(width, targetHeight, false);
  mainWindow.setResizable(false);
  applyWindowPosition();
}

function startupShortcutPath() {
  return path.join(
    app.getPath('appData'),
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup',
    'Pulse.lnk',
  );
}

function applyAutoStart(enabled) {
  try {
    if (app.isPackaged) {
      const shortcutPath = startupShortcutPath();
      if (enabled) {
        const target = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
        fs.mkdirSync(path.dirname(shortcutPath), { recursive: true });
        const shortcut = {
          target,
          cwd: path.dirname(target),
          args: '',
          description: 'Pulse 桌面监控',
          icon: target,
          iconIndex: 0,
          appUserModelId: 'com.pulse.monitor',
        };
        const created = shell.writeShortcutLink(shortcutPath, 'create', shortcut) ||
          shell.writeShortcutLink(shortcutPath, 'replace', shortcut);
        if (!created) throw new Error('writeShortcutLink returned false');
        // Remove any legacy Run entry so Windows only shows one startup item.
        app.setLoginItemSettings({ openAtLogin: false });
      } else {
        if (fs.existsSync(shortcutPath)) fs.unlinkSync(shortcutPath);
        app.setLoginItemSettings({ openAtLogin: false });
      }
    } else {
      app.setLoginItemSettings({
        openAtLogin: enabled,
        path: process.execPath,
        args: [path.resolve(__dirname)],
      });
    }
  } catch (error) {
    console.error('Could not update login item:', error.message);
  }
}

function normalizeAccent(value) {
  const raw = String(value || '')
    .trim()
    .replace(/^#/, '');
  if (/^[0-9a-f]{8}$/i.test(raw)) return `#${raw.slice(0, 6)}`;
  if (/^[0-9a-f]{6}$/i.test(raw)) return `#${raw}`;
  return '#0078D4';
}

function getSystemTheme(accentOverride) {
  let accent = accentOverride;
  if (!accent) {
    try {
      accent = systemPreferences.getAccentColor();
    } catch {
      accent = '#0078D4';
    }
  }
  return {
    accent: normalizeAccent(accent),
    dark: nativeTheme.shouldUseDarkColors,
  };
}

function broadcastTheme(accentOverride) {
  const theme = getSystemTheme(accentOverride);
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('pulse:theme', theme);
  }
}

function sensorDirectory() {
  return path.join(app.getPath('userData'), 'sensors');
}

function sensorFile() {
  return path.join(sensorDirectory(), 'sensors.json');
}

function sensorHelperPath() {
  return path.join(sensorDirectory(), 'sensor-helper.ps1');
}

function sensorSetupPath() {
  return path.join(sensorDirectory(), 'sensor-setup.ps1');
}

function sensorSourcePaths() {
  if (app.isPackaged) {
    return {
      lhm: path.join(process.resourcesPath, 'lhm'),
      helper: path.join(process.resourcesPath, 'sensor-helper.ps1'),
      setup: path.join(process.resourcesPath, 'sensor-setup.ps1'),
    };
  }
  return {
    lhm: path.join(__dirname, 'vendor', 'lhm-net48'),
    helper: path.join(__dirname, 'vendor', 'sensor-helper.ps1'),
    setup: path.join(__dirname, 'vendor', 'sensor-setup.ps1'),
  };
}

function ensureSensorFiles() {
  const source = sensorSourcePaths();
  const dir = sensorDirectory();
  const lhmDir = path.join(dir, 'lhm');
  fs.mkdirSync(lhmDir, { recursive: true });

  if (!fs.existsSync(source.lhm) || !fs.existsSync(source.helper) || !fs.existsSync(source.setup)) {
    throw new Error('安装包中缺少硬件传感器组件');
  }

  fs.copyFileSync(source.helper, sensorHelperPath());
  fs.copyFileSync(source.setup, sensorSetupPath());

  if (!fs.existsSync(path.join(lhmDir, 'LibreHardwareMonitorLib.dll'))) {
    fs.cpSync(source.lhm, lhmDir, { recursive: true, force: true });
  }
}

async function runSensorSetup() {
  ensureSensorFiles();
  const setupPath = sensorSetupPath();
  const resultPath = path.join(sensorDirectory(), 'setup-result.json');
  if (fs.existsSync(resultPath)) {
    try {
      fs.unlinkSync(resultPath);
    } catch {
      // A stale result is harmless; it will be overwritten by the new run.
    }
  }
  const escaped = setupPath.replace(/'/g, "''");
  const command =
    `Start-Process -FilePath 'powershell.exe' -Verb RunAs ` +
    `-ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','${escaped}') -Wait`;

  await execFileAsync(
    POWERSHELL,
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
    { timeout: 180000, windowsHide: true, encoding: 'utf8' },
  );

  if (fs.existsSync(resultPath)) {
    try {
      const result = JSON.parse(fs.readFileSync(resultPath, 'utf8').replace(/^\uFEFF/, ''));
      if (!result.ok) throw new Error(result.error || '传感器任务创建失败');
    } catch (error) {
      if (error.code === 'ENOENT') throw error;
      throw new Error(error.message);
    }
  }
}

async function waitForSensors(timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (monitor) {
      monitor.getSensorMonitor().refresh();
      if (monitor.getSensorMonitor().getState().status === 'ok') return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

function updateTrayMenu() {
  if (!tray) return;
  const visible = Boolean(mainWindow && mainWindow.isVisible());
  const menu = Menu.buildFromTemplate([
    {
      label: visible ? '隐藏桌面组件' : '显示桌面组件',
      click: () => (visible ? hideWindow() : showWindow()),
    },
    { label: '设置…', click: () => openSettings() },
    {
      label:
        updateState.status === 'available' && updateState.version
          ? `发现新版本 v${updateState.version}…`
          : '检查更新…',
      click: () => {
        openSettings();
        setTimeout(() => checkForUpdates(), 500);
      },
    },
    { type: 'separator' },
    {
      label: '桌面位置',
      submenu: POSITIONS.map(([id, label]) => ({
        label,
        type: 'radio',
        checked: config.position === id,
        click: () => setConfig({ position: id }),
      })),
    },
    {
      label: '游戏加速',
      submenu: [
        {
          label: '立即加速',
          click: () => gameMode?.sendCommand('start'),
        },
        {
          label: '结束加速',
          click: () => gameMode?.sendCommand('stop'),
        },
        { type: 'separator' },
        { label: '游戏加速设置…', click: () => openSettings() },
      ],
    },
    {
      label: '开机自动启动',
      type: 'checkbox',
      checked: Boolean(config.autoStart),
      click: (item) => setConfig({ autoStart: item.checked }),
    },
    {
      label: '刷新频率',
      submenu: [1000, 2000, 5000].map((refreshMs) => ({
        label: refreshMs === 1000 ? '每秒' : `每 ${refreshMs / 1000} 秒`,
        type: 'radio',
        checked: Number(config.refreshMs) === refreshMs,
        click: () => setConfig({ refreshMs }),
      })),
    },
    {
      label: '刷新外设信息',
      click: () => {
        if (monitor) {
          monitor.refreshRazer();
          monitor.refreshPeripherals();
        }
      },
    },
    {
      label: '刷新硬件传感器',
      click: () => {
        if (monitor) monitor.getSensorMonitor().refresh();
      },
    },
    { type: 'separator' },
    { label: '打开配置文件位置', click: () => shell.showItemInFolder(configPath) },
    { label: '关于 Pulse', click: () => showAbout() },
    { type: 'separator' },
    { label: '退出 Pulse', click: () => quitApp() },
  ]);

  tray.setContextMenu(menu);
  tray.setToolTip(trayTooltip());
}

function trayTooltip() {
  if (!monitor) return 'Pulse · 桌面监控';
  const state = monitor.snapshot();
  const cpu = Number.isFinite(state.cpu.usage) ? `${Math.round(state.cpu.usage)}%` : '--';
  const gpu = Number.isFinite(state.gpu.usage) ? `${Math.round(state.gpu.usage)}%` : '--';
  const temperature = state.sensors?.values?.cpu?.temperature;
  const thermal = Number.isFinite(temperature) ? ` · ${Math.round(temperature)}°C` : '';
  const memory = formatMemoryShort(state.mem.used, state.mem.total);
  return `Pulse · CPU ${cpu}${thermal} · GPU ${gpu} · 内存 ${memory}`;
}

function formatMemoryShort(used, total) {
  if (!used || !total) return '--';
  return `${(used / 1024 ** 3).toFixed(0)}/${(total / 1024 ** 3).toFixed(0)} GB`;
}

// Portable builds extract the whole app into %TEMP%\3L... on every launch.
// The portable launcher removes it on a normal exit; a crash or forced kill
// leaves the old copy behind. Clean only stale Pulse copies, never the one we
// are currently running from and never unrelated temp directories.
function cleanupStalePortableTemp() {
  if (!app.isPackaged) return;
  try {
    const tempRoot = path.resolve(os.tmpdir());
    const currentDir = path.resolve(path.dirname(process.execPath));
    if (!currentDir.startsWith(`${tempRoot}${path.sep}`)) return;
    const cutoff = Date.now() - 2 * 60 * 60 * 1000;
    for (const entry of fs.readdirSync(tempRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('3L')) continue;
      const dir = path.join(tempRoot, entry.name);
      if (path.resolve(dir) === currentDir) continue;
      if (!fs.existsSync(path.join(dir, 'Pulse.exe'))) continue;
      let stat;
      try {
        stat = fs.statSync(dir);
      } catch {
        continue;
      }
      if (stat.mtimeMs > cutoff) continue;
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // A locked or already removed directory is harmless.
      }
    }
  } catch {
    // Temp cleanup is best-effort only.
  }
}

function createWindow() {
  const position = computeWindowPosition();

  mainWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: currentWindowHeight,
    x: position.x,
    y: position.y,
    show: false,
    frame: false,
    thickFrame: false,
    transparent: false,
    backgroundColor: '#0b1518',
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    roundedCorners: false,
    alwaysOnTop: false,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.showInactive();
    mainWindow.setSkipTaskbar(true);
  });

  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.send('pulse:theme', getSystemTheme());
    if (monitor) {
      mainWindow.webContents.send('pulse:metrics', monitor.snapshot());
      mainWindow.webContents.send('pulse:config', config);
    }

    if (screenshotTarget) {
      setTimeout(async () => {
        try {
          const image = await mainWindow.webContents.capturePage();
          fs.mkdirSync(path.dirname(screenshotTarget), { recursive: true });
          fs.writeFileSync(screenshotTarget, image.toPNG());
          console.log(`Screenshot saved to ${screenshotTarget}`);
        } catch (error) {
          console.error('Screenshot failed:', error);
        } finally {
          quitApp();
        }
      }, 5200);
    }
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());

  mainWindow.on('system-context-menu', (event) => {
    event.preventDefault();
    if (tray) tray.popUpContextMenu();
  });

  mainWindow.on('show', updateTrayMenu);
  mainWindow.on('hide', updateTrayMenu);

  mainWindow.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    hideWindow();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function showSettingsWindow() {
  if (!settingsWindow || settingsWindow.isDestroyed()) return;
  if (settingsWindow.isMinimized()) settingsWindow.restore();
  settingsWindow.setAlwaysOnTop(true, 'screen-saver');
  settingsWindow.show();
  settingsWindow.moveTop();
  settingsWindow.focus();
  setTimeout(() => {
    if (!settingsWindow || settingsWindow.isDestroyed()) return;
    if (settingsWindow.isMinimized()) {
      settingsWindow.restore();
      settingsWindow.show();
      settingsWindow.moveTop();
      settingsWindow.focus();
    }
  }, 300);
}

function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    showSettingsWindow();
    return settingsWindow;
  }

  settingsWindow = new BrowserWindow({
    width: SETTINGS_WIDTH,
    height: SETTINGS_HEIGHT,
    minWidth: 640,
    minHeight: 680,
    show: false,
    center: true,
    alwaysOnTop: true,
    title: 'Pulse 设置',
    backgroundColor: '#0b1518',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.loadFile(path.join(__dirname, 'src', 'settings.html'));
  settingsWindow.once('ready-to-show', () => {
    showSettingsWindow();
  });
  settingsWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  settingsWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  settingsWindow.webContents.on('did-finish-load', () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.webContents.send('pulse:theme', getSystemTheme());
      if (!settingsWindow.isVisible() || settingsWindow.isMinimized()) {
        showSettingsWindow();
      }
    }
  });
  settingsWindow.webContents.on('did-fail-load', (_event, code, description) => {
    console.error(`Settings failed to load: ${code} ${description}`);
  });
  settingsWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error(`Settings renderer gone: ${details.reason}`);
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.reload();
  });
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
  return settingsWindow;
}

function openSettings() {
  createSettingsWindow();
}

function setConfig(patch) {
  if (!config) return config;
  const previous = config;
  const next = { ...config, ...patch };

  if (next.autoStart !== previous.autoStart) applyAutoStart(Boolean(next.autoStart));
  if (Number(next.refreshMs) !== Number(previous.refreshMs) && monitor) {
    monitor.setIntervalMs(Number(next.refreshMs));
  }
  if (patch.sensors && monitor) {
    next.sensors = sanitizeSensors(patch.sensors);
    monitor.setSensorConfig(next.sensors);
  }

  config = next;
  if (
    next.position !== previous.position ||
    next.margin !== previous.margin ||
    next.displayId !== previous.displayId
  ) {
    applyWindowPosition();
  }
  saveConfig();
  updateTrayMenu();
  if (mainWindow) mainWindow.webContents.send('pulse:config', config);
  return config;
}

function getSettingsState() {
  const sensorState = monitor
    ? monitor.getSensorMonitor().getState()
    : {
        status: 'disabled',
        sensors: [],
        selected: { cpu: {}, gpu: {} },
        values: {
          cpu: { fanRpm: null, temperature: null, frequencyMHz: null, powerW: null },
          gpu: { fanRpm: null, temperature: null, frequencyMHz: null, powerW: null },
        },
        updatedAt: null,
        error: null,
      };

  const primaryId = String(screen.getPrimaryDisplay().id);
  return {
    version: app.getVersion(),
    config: {
      autoStart: config.autoStart,
      refreshMs: config.refreshMs,
      position: config.position,
      margin: config.margin,
      displayId: config.displayId === null ? null : String(config.displayId),
      sensors: config.sensors,
    },
    sensors: sensorState,
    displays: screen.getAllDisplays().map((display) => ({
      id: String(display.id),
      label: display.label || `显示器 ${display.id}`,
      width: display.size.width,
      height: display.size.height,
      primary: String(display.id) === primaryId,
    })),
    helperInstalled: fs.existsSync(sensorHelperPath()),
    positionOptions: POSITIONS.map(([id, label]) => ({ id, label })),
    theme: getSystemTheme(),
    game: gameMode ? gameMode.getState() : null,
  };
}

function saveSettings(patch) {
  const allowed = {};

  if (typeof patch?.autoStart === 'boolean') allowed.autoStart = patch.autoStart;
  if ([1000, 2000, 5000].includes(Number(patch?.refreshMs))) {
    allowed.refreshMs = Number(patch.refreshMs);
  }
  if (POSITIONS.some(([id]) => id === patch?.position)) allowed.position = patch.position;
  if (Number.isFinite(Number(patch?.margin))) {
    allowed.margin = Math.max(0, Math.min(200, Math.round(Number(patch.margin))));
  }
  if (patch?.displayId === null || typeof patch?.displayId === 'string') {
    allowed.displayId = patch.displayId;
  }
  if (patch?.sensors && typeof patch.sensors === 'object') {
    allowed.sensors = sanitizeSensors(patch.sensors);
  }

  setConfig(allowed);
  return getSettingsState();
}

async function enableHardwareSensors() {
  try {
    await runSensorSetup();
    const ready = await waitForSensors();
    return {
      ok: ready,
      error: ready ? null : '传感器任务已创建，但还没有收到数据',
      settings: getSettingsState(),
    };
  } catch (error) {
    return {
      ok: false,
      error: error && error.message ? error.message : String(error),
      settings: getSettingsState(),
    };
  }
}

function showWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (!mainWindow.isVisible()) mainWindow.showInactive();
  if (monitor) {
    monitor.refreshRazer();
    monitor.refreshPeripherals();
    monitor.getSensorMonitor().refresh();
  }
  updateTrayMenu();
}

function hideWindow(options = {}) {
  if (!mainWindow || !mainWindow.isVisible()) return;
  mainWindow.hide();
  updateTrayMenu();

  if (!options.quiet && !firstHideHintShown && tray) {
    firstHideHintShown = true;
    try {
      tray.displayBalloon({
        iconType: 'info',
        title: 'Pulse 仍在运行',
        content: '单击托盘图标可以重新显示桌面组件。',
      });
    } catch {
      // Balloon notifications are not available on every configuration.
    }
  }
}

function syncGameVisibility() {
  if (!gameMode || !mainWindow || mainWindow.isDestroyed()) return;
  const status = gameMode.getStatus();
  const active = Boolean(status.active) && !status.stale;

  if (active) {
    if (mainWindow.isAlwaysOnTop()) mainWindow.setAlwaysOnTop(false);
    if (mainWindow.isVisible()) {
      hiddenForGame = true;
      hideWindow({ quiet: true });
    }
    return;
  }

  if (hiddenForGame) {
    hiddenForGame = false;
    showWindow();
  }
}

function quitApp() {
  quitting = true;
  if (gameVisibilityTimer) clearInterval(gameVisibilityTimer);
  if (gameConfigSyncTimer) clearInterval(gameConfigSyncTimer);
  if (startupUpdateTimer) clearTimeout(startupUpdateTimer);
  if (monitor) monitor.stop();
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveConfig();
  }
  app.quit();
}

function showAbout() {
  const state = monitor ? monitor.snapshot() : null;
  const lines = [
    'Pulse · 桌面性能组件',
    '',
    state ? `CPU  ${state.cpu.name}` : 'CPU  --',
    state ? `GPU  ${state.gpu.name}` : 'GPU  --',
    '',
    '窗口固定在桌面，不会置顶，也不能用鼠标拖动。',
    '位置和传感器选择请在“设置…”中调整。',
    '',
    'CPU / GPU 风扇、温度、频率、功耗：LibreHardwareMonitor + PawnIO',
    'GPU 备用：NVIDIA nvidia-smi',
    'CPU 使用率 / 网络：Windows 性能计数器',
    '内存：systeminformation',
    '无线外设：node-hid / Windows PnP',
    '',
    `版本 ${app.getVersion()}`,
  ];
  dialog.showMessageBox(settingsWindow || mainWindow || undefined, {
    type: 'info',
    title: '关于 Pulse',
    message: 'Pulse',
    detail: lines.join('\n'),
    buttons: ['好'],
    noLink: true,
  });
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'icon.ico');
  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(icon.isEmpty() ? path.join(__dirname, 'assets', 'icon.png') : icon);
  tray.setToolTip('Pulse · 桌面监控');
  tray.on('click', () => {
    if (mainWindow && mainWindow.isVisible()) hideWindow();
    else showWindow();
  });
  tray.on('double-click', () => openSettings());
  updateTrayMenu();
}

function registerIpc() {
  ipcMain.handle('pulse:get-state', () => (monitor ? monitor.snapshot() : null));
  ipcMain.handle('pulse:get-config', () => config);
  ipcMain.handle('pulse:get-theme', () => getSystemTheme());
  ipcMain.handle('pulse:set-config', (_event, patch) => {
    const allowed = {};
    if (typeof patch?.autoStart === 'boolean') allowed.autoStart = patch.autoStart;
    if ([1000, 2000, 5000].includes(Number(patch?.refreshMs))) {
      allowed.refreshMs = Number(patch.refreshMs);
    }
    return setConfig(allowed);
  });

  ipcMain.handle('settings:get-state', () => getSettingsState());
  ipcMain.handle('settings:save', (_event, patch) => saveSettings(patch));
  ipcMain.handle('settings:enable-sensors', () => enableHardwareSensors());
  ipcMain.handle('settings:refresh-sensors', () => {
    if (monitor) monitor.getSensorMonitor().refresh();
    return getSettingsState();
  });
  ipcMain.handle('update:get-state', () => getUpdateState());
  ipcMain.handle('update:check', () => checkForUpdates());
  ipcMain.handle('update:download', () => downloadUpdate());
  ipcMain.handle('update:install', () => installUpdate());
  ipcMain.handle('game:get-state', () => (gameMode ? gameMode.getState() : null));
  ipcMain.handle('game:save', (_event, patch) => {
    if (!gameMode) return null;
    gameMode.saveConfig(patch);
    saveConfig();
    return gameMode.getState();
  });
  ipcMain.handle('game:install', async () => {
    if (!gameMode) return { ok: false, error: 'Game mode is unavailable.' };
    const result = await gameMode.install();
    return { ...result, state: result.state || gameMode.getState() };
  });
  ipcMain.handle('game:command', (_event, action) => {
    if (!gameMode) return { ok: false, error: 'Game mode is unavailable.' };
    return gameMode.sendCommand(action);
  });
  ipcMain.handle('game:add', async () => {
    if (!gameMode) return { ok: false, error: 'Game mode is unavailable.' };
    const result = await dialog.showOpenDialog(settingsWindow || mainWindow || undefined, {
      title: '添加游戏',
      buttonLabel: '添加',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '游戏程序', extensions: ['exe'] }],
    });
    if (result.canceled || !result.filePaths.length) {
      return { ok: false, canceled: true, state: gameMode.getState() };
    }
    const added = gameMode.addGames(
      result.filePaths.map((filePath) => ({ path: filePath })),
      'manual',
    );
    saveConfig();
    return { ok: true, added: added.added, state: added.state };
  });
  ipcMain.handle('game:remove', (_event, id) => {
    if (!gameMode) return { ok: false, error: 'Game mode is unavailable.' };
    const state = gameMode.removeGame(id);
    saveConfig();
    return { ok: true, state };
  });
  ipcMain.handle('game:import-steam', async () => {
    if (!gameMode) return { ok: false, error: 'Game mode is unavailable.' };
    const result = await gameMode.importSteam();
    saveConfig();
    return result;
  });
  ipcMain.handle('game:icon', async (_event, filePath) => {
    if (typeof filePath !== 'string' || !filePath) return null;
    if (gameIconCache.has(filePath)) return gameIconCache.get(filePath);
    if (!fs.existsSync(filePath)) {
      gameIconCache.set(filePath, null);
      return null;
    }
    try {
      const image = await app.getFileIcon(filePath, { size: 'normal' });
      const data = image && !image.isEmpty() ? image.toDataURL() : null;
      gameIconCache.set(filePath, data);
      return data;
    } catch {
      gameIconCache.set(filePath, null);
      return null;
    }
  });
  ipcMain.on('settings:close', () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
  });
  ipcMain.on('pulse:open-settings', () => openSettings());

  ipcMain.on('pulse:show-menu', () => {
    if (!tray) return;
    tray.popUpContextMenu();
  });
  ipcMain.on('pulse:hide', () => hideWindow());
  ipcMain.on('pulse:quit', () => quitApp());
}

app.on('second-instance', () => {
  showWindow();
});

app.whenReady().then(async () => {
  cleanupStalePortableTemp();
  initAutoUpdater();
  config = loadConfig();
  gameMode = new GameMode(app);
  gameMode.restoreFromConfig(config.game, config.games);
  gameMode.ensureFiles();
  lastGameSnapshot = JSON.stringify({
    game: gameMode.getConfig(),
    games: gameMode.getGames(),
  });
  config.game = gameMode.getConfig();
  config.games = gameMode.getGames();
  saveConfig();
  registerIpc();
  createWindow();
  createTray();
  gameVisibilityTimer = setInterval(syncGameVisibility, 1000);
  gameConfigSyncTimer = setInterval(syncGameConfigSnapshot, 10000);
  startupUpdateTimer = setTimeout(() => {
    if (!quitting && updateState.status === 'idle') checkForUpdates();
  }, 8000);

  nativeTheme.on('updated', () => broadcastTheme());
  try {
    systemPreferences.on('accent-color-changed', (_event, color) => broadcastTheme(color));
  } catch {
    // Accent color events are Windows/Linux only.
  }

  monitor = new MetricsMonitor({
    intervalMs: config.refreshMs,
    razerCachePath: path.join(app.getPath('userData'), 'razer-cache.json'),
    sensorFilePath: sensorFile(),
    sensorConfig: config.sensors,
  });
  monitor.on('update', (state) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pulse:metrics', state);
      resizeForPeripheralCount(peripheralDeviceCount(state));
    }
    if (tray) tray.setToolTip(trayTooltip());
  });
  monitor.on('warning', (error) => {
    const message = error && error.message ? error.message : String(error);
    if (!/not found|ENOENT|no GPU/i.test(message)) {
      console.warn('Metrics warning:', message);
    }
  });
  monitor.start();

  if (config.autoStart) applyAutoStart(true);
  if (openSettingsOnLaunch) openSettings();


  screen.on('display-metrics-changed', () => applyWindowPosition());
  screen.on('display-added', () => applyWindowPosition());
  screen.on('display-removed', () => applyWindowPosition());
});

app.on('before-quit', () => {
  quitting = true;
  if (monitor) monitor.stop();
});

app.on('window-all-closed', () => {
  if (quitting) app.quit();
});
