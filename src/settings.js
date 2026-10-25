'use strict';

const $ = (id) => document.getElementById(id);
const SENSOR_SELECTS = [...document.querySelectorAll('select[data-group]')];
const gameIconCache = new Map();

let state = null;
let local = {
  position: 'bottom-right',
  displayId: null,
  margin: 0,
  autoStart: false,
  refreshMs: 1000,
};

function shortHardware(name) {
  return String(name || '')
    .replace(/^NVIDIA\s+GeForce\s+/i, '')
    .replace(/^AMD\s+Radeon\s+/i, '');
}

function sensorUnit(type) {
  if (type === 'Fan') return 'RPM';
  if (type === 'Temperature') return '°C';
  if (type === 'Clock') return 'MHz';
  if (type === 'Power') return 'W';
  return '';
}

function formatValue(sensor) {
  if (!sensor || typeof sensor.value !== 'number' || !Number.isFinite(sensor.value)) return '--';
  return `${Math.round(sensor.value)} ${sensorUnit(sensor.type)}`.trim();
}

function isGpuSensor(sensor) {
  return /^Gpu/i.test(sensor.hardwareType || '');
}

function sensorsFor(group, metric) {
  const sensors = Array.isArray(state?.sensors?.sensors) ? state.sensors.sensors : [];
  if (group === 'gpu') {
    return sensors.filter((sensor) => isGpuSensor(sensor));
  }

  if (metric === 'fan') {
    return sensors.filter((sensor) => sensor.type === 'Fan' && !isGpuSensor(sensor));
  }
  if (metric === 'temperature') {
    return sensors.filter((sensor) => sensor.type === 'Temperature' && !isGpuSensor(sensor));
  }
  if (metric === 'frequency') {
    return sensors.filter((sensor) => sensor.type === 'Clock' && sensor.hardwareType === 'Cpu');
  }
  return sensors.filter((sensor) => sensor.type === 'Power' && sensor.hardwareType === 'Cpu');
}

function gpuSensorsFor(metric) {
  const type = {
    fan: 'Fan',
    temperature: 'Temperature',
    frequency: 'Clock',
    power: 'Power',
  }[metric];
  const sensors = Array.isArray(state?.sensors?.sensors) ? state.sensors.sensors : [];
  return sensors.filter((sensor) => sensor.type === type && isGpuSensor(sensor));
}

function sensorsForMetric(group, metric) {
  return group === 'gpu' ? gpuSensorsFor(metric) : sensorsFor(group, metric);
}

function fillSelect(select, group, metric) {
  const configured = state?.config?.sensors?.[group]?.[metric] || '';
  const sensors = sensorsForMetric(group, metric);
  select.textContent = '';

  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = sensors.length ? '自动选择（推荐）' : '无可用传感器';
  select.appendChild(auto);

  const groups = new Map();
  for (const sensor of sensors) {
    const hardware = shortHardware(sensor.hardware);
    if (!groups.has(hardware)) groups.set(hardware, []);
    groups.get(hardware).push(sensor);
  }

  for (const [hardware, items] of groups) {
    const optgroup = document.createElement('optgroup');
    optgroup.label = hardware;
    for (const sensor of items) {
      const option = document.createElement('option');
      option.value = sensor.id;
      option.textContent = `${sensor.name} — ${formatValue(sensor)}`;
      optgroup.appendChild(option);
    }
    select.appendChild(optgroup);
  }

  if (configured) {
    const exists = sensors.some((sensor) => sensor.id === configured);
    if (!exists) {
      const option = document.createElement('option');
      option.value = configured;
      option.textContent = '已失效的传感器';
      select.appendChild(option);
    }
  }

  select.disabled = sensors.length === 0;
  select.value = configured;
}

function currentSensor(group, metric) {
  return state?.sensors?.selected?.[group]?.[metric] || null;
}

function refreshCurrentValues() {
  for (const group of ['cpu', 'gpu']) {
    for (const metric of ['fan', 'temperature', 'frequency', 'power']) {
      const element = document.querySelector(`[data-current="${group}.${metric}"]`);
      if (!element) continue;
      const sensor = currentSensor(group, metric);
      element.textContent = sensor
        ? `当前：${formatValue(sensor)} · ${shortHardware(sensor.hardware)}`
        : '当前：--';
    }
  }
}

function statusInfo() {
  const status = state?.sensors?.status || 'disabled';
  const count = Array.isArray(state?.sensors?.sensors) ? state.sensors.sensors.length : 0;
  if (status === 'ok') {
    return {
      text: '运行中',
      className: 'ok',
      meta: `${count} 个传感器 · ${new Date(state.sensors.updatedAt || Date.now()).toLocaleTimeString()}`,
      message: '',
      error: false,
    };
  }
  if (status === 'stale') {
    return {
      text: '数据已停止',
      className: 'warn',
      meta: `${count} 个传感器`,
      message: '后台传感器助手没有继续更新数据，可尝试重新启用。',
      error: true,
    };
  }
  if (status === 'error') {
    return {
      text: '异常',
      className: 'bad',
      meta: '',
      message: state?.sensors?.error || '读取硬件传感器失败。',
      error: true,
    };
  }
  return {
    text: '未启用',
    className: 'warn',
    meta: '',
    message: 'CPU 风扇 / 温度 / 功耗需要启用后台传感器助手。GPU 仍会使用 NVIDIA 驱动数据。',
    error: false,
  };
}

function renderSensorStatus() {
  const info = statusInfo();
  const pill = $('sensor-status');
  pill.textContent = info.text;
  pill.className = `status-pill ${info.className}`;
  $('sensor-meta').textContent = info.meta;
  $('sensor-message').textContent = info.message;
  $('sensor-message').classList.toggle('error', info.error);
  $('enable-sensors').textContent =
    state?.sensors?.status === 'ok'
      ? '重新启动后台传感器（管理员）'
      : '启用硬件传感器（管理员）';
}

function renderSensors() {
  for (const select of SENSOR_SELECTS) {
    fillSelect(select, select.dataset.group, select.dataset.metric);
  }
  refreshCurrentValues();
  renderSensorStatus();
}

function renderPositions() {
  const grid = $('position-grid');
  grid.textContent = '';
  for (const option of state.positionOptions || []) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'position-btn';
    button.dataset.position = option.id;
    button.title = option.label;
    button.setAttribute('aria-label', option.label);
    button.classList.toggle('active', local.position === option.id);
    button.addEventListener('click', () => {
      local.position = option.id;
      renderPositions();
    });
    grid.appendChild(button);
  }
}

function renderDisplays() {
  const select = $('display-select');
  select.textContent = '';
  const displays = state.displays || [];
  const fallback = displays.find((display) => display.primary)?.id || displays[0]?.id || '';
  const selected = local.displayId === null ? fallback : String(local.displayId);
  for (const display of displays) {
    const option = document.createElement('option');
    option.value = display.id;
    option.textContent = `${display.label} · ${display.width}×${display.height}${display.primary ? '（主屏）' : ''}`;
    select.appendChild(option);
  }
  select.value = displays.some((display) => display.id === selected) ? selected : fallback;
  if (!select.value && displays.length) select.value = displays[0].id;
}

function renderControls() {
  $('display-select').value = local.displayId === null
    ? String(state.displays?.find((display) => display.primary)?.id || '')
    : String(local.displayId);
  $('margin-input').value = String(local.margin);
  $('autostart-input').checked = Boolean(local.autoStart);
  $('refresh-select').value = String(local.refreshMs);
  $('version').textContent = `v${state.version}`;
}

function renderGame() {
  const game = state?.game;
  if (!game) return;
  const config = game.config || {};
  const status = game.status || {};
  const active = Boolean(status.active);
  const tweakInputs = [...document.querySelectorAll('[data-tweak]')];

  $('game-enabled').checked = config.enabled !== false;
  $('game-auto-detect').checked = config.autoDetect !== false;
  for (const input of tweakInputs) {
    input.checked = Boolean(config.tweaks?.[input.dataset.tweak]);
  }

  const selected = tweakInputs.filter((input) => input.checked && !input.disabled).length;
  $('game-count').textContent = String(selected);

  const statusPill = $('game-status');
  statusPill.classList.remove('ok', 'warn', 'bad');
  if (active) {
    statusPill.textContent = '加速中';
    statusPill.classList.add('ok');
  } else if (!game.installed) {
    statusPill.textContent = '未安装';
    statusPill.classList.add('warn');
  } else if (!game.running) {
    statusPill.textContent = '服务未运行';
    statusPill.classList.add('bad');
  } else {
    statusPill.textContent = '已就绪';
    statusPill.classList.add('ok');
  }

  $('game-current').textContent = active
    ? `加速中：${status.game?.name || '游戏'}`
    : game.running
      ? '等待游戏启动'
      : game.installed
        ? '加速服务未运行'
        : '安装后启用';

  $('game-toggle').textContent = active ? '结束加速' : '立即加速';
  $('game-toggle').disabled = !game.running;
  $('game-install').textContent = game.installed
    ? '重启加速服务'
    : '安装加速服务（管理员）';

  if (active && Array.isArray(status.errors) && status.errors.length > 0) {
    const message = $('game-message');
    message.classList.add('error');
    message.textContent = `部分项目未生效：${status.errors.slice(0, 2).join('；')}`;
  }

  renderGames();
}

function formatGameTime(timestamp) {
  if (!timestamp) return '未启动';
  try {
    return new Date(timestamp).toLocaleDateString('zh-CN', {
      month: 'numeric',
      day: 'numeric',
    });
  } catch {
    return '未启动';
  }
}

function loadGameIcon(filePath, image, wrapper) {
  if (!filePath) return;
  const cached = gameIconCache.get(filePath);
  if (cached) {
    image.src = cached;
    wrapper.classList.add('has-icon');
    return;
  }
  if (cached === null) return;

  window.pulse.getGameIcon(filePath).then((data) => {
    gameIconCache.set(filePath, data || null);
    if (!data || !image.isConnected) return;
    image.src = data;
    wrapper.classList.add('has-icon');
  }).catch(() => {
    gameIconCache.set(filePath, null);
  });
}

function renderGames() {
  const list = $('game-games');
  if (!list) return;
  const games = Array.isArray(state?.game?.games) ? state.game.games : [];
  const active = Boolean(state?.game?.status?.active);
  const activeName = state?.game?.status?.game?.name || '';

  list.textContent = '';
  $('game-library-empty').style.display = games.length ? 'none' : '';

  for (const game of games) {
    const row = document.createElement('div');
    row.className = 'game-row';

    const icon = document.createElement('span');
    icon.className = 'game-icon';
    const fallback = document.createElement('span');
    fallback.className = 'game-icon-fallback';
    fallback.textContent = String(game.name || '?').trim().charAt(0).toUpperCase() || '?';
    const image = document.createElement('img');
    image.alt = '';
    icon.append(fallback, image);
    loadGameIcon(game.path, image, icon);

    const name = document.createElement('span');
    name.className = 'game-row-name';
    name.textContent = game.name || '未命名游戏';
    if (game.path) name.title = game.path;

    const tag = document.createElement('span');
    const isCurrent = active && activeName && game.name === activeName;
    const sourceClass =
      game.source === 'manual' ? ' manual' : game.source === 'steam' ? ' steam' : '';
    tag.className = `game-tag${sourceClass}`;
    tag.textContent = isCurrent
      ? '正在加速'
      : game.source === 'manual'
        ? '手动添加'
        : game.source === 'steam'
          ? 'Steam 导入'
          : '自动识别';

    const last = document.createElement('span');
    last.className = 'game-last';
    last.textContent = formatGameTime(game.lastPlayed);

    const remove = document.createElement('button');
    remove.className = 'game-remove';
    remove.type = 'button';
    remove.title = '从列表移除';
    remove.textContent = '×';
    remove.addEventListener('click', async () => {
      const result = await window.pulse.removeGame(game.id);
      if (result?.state) {
        state.game = result.state;
        renderGame();
      }
      $('game-library-message').textContent = '已从游戏列表移除。';
    });

    row.append(icon, name, tag, last, remove);
    list.appendChild(row);
  }
}

async function addGame() {
  const message = $('game-library-message');
  try {
    const result = await window.pulse.addGame();
    if (result?.canceled) return;
    if (result?.state) {
      state.game = result.state;
      renderGame();
    }
    message.classList.toggle('error', !result?.ok);
    message.textContent = result?.ok
      ? `已添加 ${result.added || 1} 个游戏。`
      : '添加游戏失败。';
  } catch (error) {
    message.classList.add('error');
    message.textContent = `添加失败：${error.message}`;
  }
}

async function importSteamGames() {
  const button = $('game-import-steam');
  const message = $('game-library-message');
  button.disabled = true;
  button.textContent = '扫描中…';
  message.classList.remove('error');
  message.textContent = '正在扫描 Steam 库，请稍候…';
  try {
    const result = await window.pulse.importSteam();
    if (result?.state) {
      state.game = result.state;
      renderGame();
    }
    message.classList.toggle('error', !result?.ok);
    if (!result?.ok) {
      message.textContent = `导入失败：${result?.error || '未知错误'}`;
    } else if (!result.total) {
      message.textContent = '没有找到可导入的 Steam 游戏。';
    } else {
      message.textContent = `扫描到 ${result.total} 个游戏，已加入 ${result.added} 个。`;
    }
  } catch (error) {
    message.classList.add('error');
    message.textContent = `导入失败：${error.message}`;
  } finally {
    button.disabled = false;
    button.textContent = '导入 Steam';
  }
}

async function saveGamePatch(patch) {
  const next = await window.pulse.saveGame(patch);
  if (next) {
    state.game = next;
    renderGame();
  }
}

async function installGameMode() {
  const button = $('game-install');
  const message = $('game-message');
  button.disabled = true;
  message.classList.remove('error');
  message.textContent = '正在请求管理员权限，请稍候…';
  try {
    const result = await window.pulse.installGameMode();
    if (result.state) state.game = result.state;
    renderGame();
    message.classList.toggle('error', !result.ok);
    message.textContent = result.ok
      ? '游戏加速服务已启动，启动全屏游戏后会自动加速。'
      : `启动失败：${result.error || '未知错误'}`;
  } catch (error) {
    message.classList.add('error');
    message.textContent = `启动失败：${error.message}`;
  } finally {
    button.disabled = false;
  }
}

async function toggleGameSession() {
  const message = $('game-message');
  const active = Boolean(state.game?.status?.active);
  try {
    const result = await window.pulse.sendGameCommand(active ? 'stop' : 'start');
    if (result.state) state.game = result.state;
    renderGame();
    message.classList.toggle('error', !result.ok);
    message.textContent = result.ok
      ? active
        ? '已发送结束加速指令。'
        : '已发送加速指令。'
      : `操作失败：${result.error || '未知错误'}`;
  } catch (error) {
    message.classList.add('error');
    message.textContent = `操作失败：${error.message}`;
  }
}

function wireGame() {
  $('game-enabled').addEventListener('change', async (event) => {
    await saveGamePatch({ enabled: event.target.checked });
    $('game-message').textContent = event.target.checked ? '自动加速已开启。' : '自动加速已关闭。';
  });
  $('game-auto-detect').addEventListener('change', async (event) => {
    await saveGamePatch({ autoDetect: event.target.checked });
    $('game-message').textContent = event.target.checked
      ? '已开启游戏列表识别。'
      : '已关闭游戏列表识别，可用“立即加速”手动启动。';
  });
  for (const input of document.querySelectorAll('[data-tweak]')) {
    input.addEventListener('change', async () => {
      await saveGamePatch({ tweaks: { [input.dataset.tweak]: input.checked } });
      $('game-message').textContent = '加速项目已更新，将在下一次游戏会话生效。';
    });
  }
  $('game-install').addEventListener('click', installGameMode);
  $('game-toggle').addEventListener('click', toggleGameSession);
  $('game-add').addEventListener('click', addGame);
  $('game-import-steam').addEventListener('click', importSteamGames);
}

function applyState(next) {
  state = next;
  if (next?.theme) window.PulseTheme?.apply(next.theme);
  local = {
    position: next.config.position,
    displayId: next.config.displayId,
    margin: next.config.margin,
    autoStart: next.config.autoStart,
    refreshMs: next.config.refreshMs,
  };
  renderControls();
  renderDisplays();
  renderPositions();
  renderSensors();
  renderGame();
}

async function load() {
  try {
    applyState(await window.pulse.getSettingsState());
  } catch (error) {
    $('sensor-message').textContent = `读取设置失败：${error.message}`;
    $('sensor-message').classList.add('error');
  }
}

async function enableSensors() {
  const button = $('enable-sensors');
  const message = $('sensor-message');
  button.disabled = true;
  button.textContent = '等待管理员授权…';
  message.classList.remove('error');
  message.textContent = '正在创建后台传感器任务，请在 Windows 提示中允许管理员权限。';
  try {
    const result = await window.pulse.enableSensors();
    if (result.settings) {
      applyState(result.settings);
    }
    message.classList.toggle('error', !result.ok);
    message.textContent = result.ok
      ? '硬件传感器已启动。'
      : `启动失败：${result.error || '未知错误'}`;
  } catch (error) {
    message.classList.add('error');
    message.textContent = `启动失败：${error.message}`;
  } finally {
    button.disabled = false;
    renderSensorStatus();
  }
}

async function refreshSensors() {
  const message = $('sensor-message');
  try {
    const next = await window.pulse.refreshSensors();
    applyState(next);
    message.classList.remove('error');
    message.textContent = '传感器数据已刷新。';
  } catch (error) {
    message.classList.add('error');
    message.textContent = `刷新失败：${error.message}`;
  }
}

function captureSelections() {
  const values = {};
  for (const select of SENSOR_SELECTS) {
    values[`${select.dataset.group}.${select.dataset.metric}`] = select.value;
  }
  return values;
}

function restoreSelections(values) {
  for (const select of SENSOR_SELECTS) {
    const value = values[`${select.dataset.group}.${select.dataset.metric}`];
    if (value && [...select.options].some((option) => option.value === value)) {
      select.value = value;
    }
  }
}

async function refreshDynamic() {
  if (!state) return;
  try {
    const next = await window.pulse.getSettingsState();
    const previousCount = state.sensors?.sensors?.length || 0;
    const nextCount = next.sensors?.sensors?.length || 0;
    const previousStatus = state.sensors?.status;
    const nextStatus = next.sensors?.status;
    const selections = captureSelections();
    state = next;
    renderSensorStatus();
    refreshCurrentValues();
    renderGame();
    if (previousCount !== nextCount || previousStatus !== nextStatus) {
      renderSensors();
      restoreSelections(selections);
    }
  } catch {
    // Keep the last good settings view.
  }
}

async function save() {
  const button = $('save-btn');
  const note = $('save-note');
  button.disabled = true;
  note.classList.remove('error');
  note.textContent = '正在保存…';

  const sensors = { cpu: {}, gpu: {} };
  for (const select of SENSOR_SELECTS) {
    sensors[select.dataset.group][select.dataset.metric] = select.value;
  }

  const patch = {
    autoStart: $('autostart-input').checked,
    refreshMs: Number($('refresh-select').value),
    position: local.position,
    margin: Math.max(0, Math.min(200, Number($('margin-input').value) || 0)),
    displayId: $('display-select').value || null,
    sensors,
  };

  try {
    applyState(await window.pulse.saveSettings(patch));
    window.pulse.closeSettings();
  } catch (error) {
    note.classList.add('error');
    note.textContent = `保存失败：${error.message}`;
    button.disabled = false;
  }
}

function wire() {
  $('enable-sensors').addEventListener('click', enableSensors);
  $('refresh-sensors').addEventListener('click', refreshSensors);
  $('save-btn').addEventListener('click', save);
  $('cancel-btn').addEventListener('click', () => window.pulse.closeSettings());
  $('display-select').addEventListener('change', (event) => {
    local.displayId = event.target.value || null;
  });
  $('update-action').addEventListener('click', handleUpdateAction);
  wireGame();
}

let updaterState = null;

function renderUpdate(next) {
  if (!next) return;
  updaterState = next;
  const status = $('update-status');
  const hint = $('update-hint');
  const button = $('update-action');
  const progress = $('update-progress');
  const fill = $('update-progress-fill');
  const version = next.currentVersion ? `当前版本 ${next.currentVersion}` : '';
  status.textContent = version;
  hint.classList.toggle('error', next.status === 'error');
  hint.textContent = next.message || '点击检查更新';

  const percent = Math.max(0, Math.min(100, Number(next.percent) || 0));
  const showProgress = next.status === 'downloading' || next.status === 'downloaded';
  progress.hidden = !showProgress;
  fill.style.width = `${percent}%`;

  if (next.status === 'checking') {
    button.textContent = '检查中…';
    button.disabled = true;
  } else if (next.status === 'available') {
    button.textContent = '下载更新';
    button.disabled = false;
  } else if (next.status === 'downloading') {
    button.textContent = '下载中…';
    button.disabled = true;
  } else if (next.status === 'downloaded') {
    button.textContent = '重启并安装';
    button.disabled = false;
  } else {
    button.textContent = '检查更新';
    button.disabled = false;
  }
}

async function handleUpdateAction() {
  if (!updaterState) return;
  const button = $('update-action');
  button.disabled = true;
  try {
    if (updaterState.status === 'available') {
      renderUpdate(await window.pulse.downloadUpdate());
    } else if (updaterState.status === 'downloaded') {
      const started = await window.pulse.installUpdate();
      if (!started) {
        renderUpdate({
          ...updaterState,
          status: 'error',
          message: '安装更新失败，请重新下载。',
        });
      }
    } else {
      renderUpdate(await window.pulse.checkForUpdates());
    }
  } catch (error) {
    renderUpdate({
      ...updaterState,
      status: 'error',
      message: `更新操作失败：${error.message}`,
    });
  }
}

wire();
window.pulse.onTheme((theme) => window.PulseTheme?.apply(theme));
window.pulse.onUpdate(renderUpdate);
window.pulse.getUpdateState().then(renderUpdate).catch(() => {});
load();
setInterval(refreshDynamic, 2000);
