'use strict';

const RING_CIRCUMFERENCE = 2 * Math.PI * 51.5;
const $ = (id) => document.getElementById(id);

const ui = {
  widget: $('widget'),
  cpuMeta: $('cpu-meta'),
  cpuMetaText: $('cpu-meta-text'),
  cpuName: $('cpu-name'),
  cpuUsage: $('cpu-usage'),
  cpuRing: $('cpu-ring-progress'),
  cpuFanMetric: $('cpu-fan-metric'),
  cpuFan: $('cpu-fan'),
  cpuFanBar: $('cpu-fan-bar'),
  cpuTempMetric: $('cpu-temp-metric'),
  cpuTemp: $('cpu-temp'),
  cpuTempBar: $('cpu-temp-bar'),
  cpuFreqMetric: $('cpu-freq-metric'),
  cpuFreq: $('cpu-freq'),
  cpuFreqBar: $('cpu-freq-bar'),
  cpuPowerMetric: $('cpu-power-metric'),
  cpuPower: $('cpu-power'),
  cpuPowerBar: $('cpu-power-bar'),
  gpuSection: document.querySelector('.gpu-section'),
  gpuTitle: $('gpu-title'),
  gpuMeta: $('gpu-meta'),
  gpuMetaText: $('gpu-meta-text'),
  gpuUsage: $('gpu-usage'),
  gpuRing: $('gpu-ring-progress'),
  gpuFanMetric: $('gpu-fan-metric'),
  gpuFan: $('gpu-fan'),
  gpuFanBar: $('gpu-fan-bar'),
  gpuTempMetric: $('gpu-temp-metric'),
  gpuTemp: $('gpu-temp'),
  gpuTempBar: $('gpu-temp-bar'),
  gpuFreqMetric: $('gpu-freq-metric'),
  gpuFreq: $('gpu-freq'),
  gpuFreqBar: $('gpu-freq-bar'),
  gpuPowerMetric: $('gpu-power-metric'),
  gpuPower: $('gpu-power'),
  gpuPowerBar: $('gpu-power-bar'),
  memBar: $('mem-bar'),
  memPercent: $('mem-percent'),
  memUsed: $('mem-used'),
  memTotal: $('mem-total'),
  vramBar: $('vram-bar'),
  vramPercent: $('vram-percent'),
  vramUsed: $('vram-used'),
  vramTotal: $('vram-total'),
  netDown: $('net-down'),
  netDownUnit: $('net-down-unit'),
  netUp: $('net-up'),
  netUpUnit: $('net-up-unit'),
  razerCount: $('peripheral-count'),
  razerList: $('peripheral-list'),
  interval: $('interval'),
  updateBtn: $('update-btn'),
  settingsBtn: $('settings-btn'),
  menuBtn: $('menu-btn'),
  closeBtn: $('close-btn'),
};

let currentConfig = { refreshMs: 1000 };
let lastPainted = 0;

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function setText(element, value) {
  if (!element) return;
  const text = String(value);
  if (element.textContent !== text) element.textContent = text;
}

function setBar(element, percent) {
  if (!element) return;
  const value = isNumber(percent) ? clamp(percent, 0, 100) : 0;
  element.style.width = `${value}%`;
}

function setRing(element, percent) {
  if (!element) return;
  const value = isNumber(percent) ? clamp(percent, 0, 100) : 0;
  const offset = RING_CIRCUMFERENCE * (1 - value / 100);
  element.style.strokeDashoffset = String(offset);
}

function setMetricNa(element, isNa) {
  if (!element) return;
  element.classList.toggle('is-na', Boolean(isNa));
}

function numberOr(value, fallback = '--') {
  return isNumber(value) ? String(Math.round(value)) : fallback;
}

function formatCapacity(bytes, roundedTotal = false) {
  if (!isNumber(bytes) || bytes <= 0) return '--';
  const gib = bytes / 1024 ** 3;
  if (gib >= 1024) return `${(gib / 1024).toFixed(1)}T`;
  if (gib >= 100) return `${Math.round(gib)}G`;
  if (gib >= 10) {
    if (roundedTotal) return `${Math.round(gib)}G`;
    return `${(Math.round(gib * 10) / 10).toFixed(1).replace(/\.0$/, '')}G`;
  }
  return `${gib.toFixed(1)}G`;
}

function formatRate(bytesPerSecond) {
  if (!isNumber(bytesPerSecond) || bytesPerSecond <= 0) return ['0', 'B/s'];
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let value = bytesPerSecond;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  if (unit === 0) return [String(Math.round(value)), units[unit]];
  const digits = value < 10 ? 2 : value < 100 ? 1 : 0;
  return [value.toFixed(digits), units[unit]];
}

function applyConfig(config) {
  if (!config) return;
  currentConfig = { ...currentConfig, ...config };
  const seconds = Number(currentConfig.refreshMs) / 1000;
  setText(ui.interval, `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`);
}

function renderCpu(state) {
  const cpu = state.cpu || {};
  const sensorValues = state.sensors?.status === 'ok' ? state.sensors.values?.cpu : null;
  const hardwareSensors = Boolean(sensorValues);

  const usage = isNumber(cpu.usage) ? cpu.usage : null;
  setText(ui.cpuUsage, numberOr(usage));
  setRing(ui.cpuRing, usage);

  const physical = numberOr(cpu.physicalCores);
  const threads = numberOr(cpu.threads);
  setText(ui.cpuMetaText, `${physical} 核 / ${threads} 线程`);
  const cpuName = String(cpu.name || 'CPU')
    .replace(/\(R\)|\(TM\)/gi, '')
    .replace(/\s+\d+-Core Processor\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const manufacturer = String(cpu.manufacturer || '').trim();
  const displayName =
    manufacturer && !cpuName.toLowerCase().startsWith(manufacturer.toLowerCase())
      ? `${manufacturer} ${cpuName}`
      : cpuName;
  setText(ui.cpuName, displayName || 'CPU');
  ui.cpuMeta.title = cpu.name || 'CPU';

  const fan = sensorValues && isNumber(sensorValues.fanRpm) ? sensorValues.fanRpm : null;
  setText(ui.cpuFan, fan === null ? '--' : String(Math.round(fan)));
  setBar(ui.cpuFanBar, fan === null ? 0 : (fan / 2500) * 100);
  setMetricNa(ui.cpuFanMetric, fan === null);

  const temp = isNumber(sensorValues?.temperature)
    ? sensorValues.temperature
    : isNumber(cpu.temperature)
      ? cpu.temperature
      : null;
  setText(ui.cpuTemp, temp === null ? '--' : String(Math.round(temp)));
  setBar(ui.cpuTempBar, temp === null ? 0 : temp);
  setMetricNa(ui.cpuTempMetric, temp === null);

  const frequency = isNumber(sensorValues?.frequencyMHz)
    ? sensorValues.frequencyMHz
    : isNumber(cpu.frequencyMHz)
      ? cpu.frequencyMHz
      : null;
  const maxFrequency = Math.max(5000, (cpu.baseMHz || 3700) * 1.5);
  setText(ui.cpuFreq, frequency === null ? '--' : String(Math.round(frequency)));
  setBar(ui.cpuFreqBar, frequency === null ? 0 : (frequency / maxFrequency) * 100);
  setMetricNa(ui.cpuFreqMetric, frequency === null);

  const power = isNumber(sensorValues?.powerW) ? sensorValues.powerW : null;
  setText(ui.cpuPower, power === null ? '--' : String(Math.round(power)));
  setBar(ui.cpuPowerBar, power === null ? 0 : (power / 150) * 100);
  setMetricNa(ui.cpuPowerMetric, power === null);

  const hint = hardwareSensors ? '' : '在“设置”中启用硬件传感器后显示';
  ui.cpuFanMetric.title = hint;
  ui.cpuTempMetric.title = hint;
  ui.cpuPowerMetric.title = hint;
}

function renderGpu(state) {
  const gpu = state.gpu || {};
  const sensorValues = state.sensors?.status === 'ok' ? state.sensors.values?.gpu : null;
  const hasSensorValues =
    Boolean(sensorValues) &&
    ['fanRpm', 'temperature', 'frequencyMHz', 'powerW'].some((key) =>
      isNumber(sensorValues[key]),
    );

  const available =
    (Boolean(gpu.available) && isNumber(gpu.usage)) || hasSensorValues;
  ui.gpuSection.classList.toggle('is-offline', !available);
  setText(ui.gpuUsage, available && isNumber(gpu.usage) ? String(Math.round(gpu.usage)) : '--');
  setRing(ui.gpuRing, available ? gpu.usage : 0);

  const model = String(gpu.name || '')
    .replace(/^NVIDIA\s+GeForce\s+/i, '')
    .replace(/^AMD\s+Radeon\s+/i, '');
  setText(ui.gpuMetaText, available ? model || 'GPU' : '未检测到');
  ui.gpuMeta.classList.toggle('is-offline', !available);
  ui.gpuMeta.title = gpu.name || '显卡';
  ui.gpuTitle.title = gpu.name || '显卡';

  const fan = sensorValues?.fanRpm ?? gpu.fanRpm;
  setText(ui.gpuFan, isNumber(fan) ? String(Math.round(fan)) : '--');
  setBar(ui.gpuFanBar, isNumber(fan) ? (fan / 2500) * 100 : 0);
  setMetricNa(ui.gpuFanMetric, !isNumber(fan));

  const temp = sensorValues?.temperature ?? gpu.temperature;
  setText(ui.gpuTemp, isNumber(temp) ? String(Math.round(temp)) : '--');
  setBar(ui.gpuTempBar, isNumber(temp) ? temp : 0);
  setMetricNa(ui.gpuTempMetric, !isNumber(temp));

  const frequency = sensorValues?.frequencyMHz ?? gpu.frequencyMHz;
  setText(ui.gpuFreq, isNumber(frequency) ? String(Math.round(frequency)) : '--');
  setBar(ui.gpuFreqBar, isNumber(frequency) ? (frequency / 3000) * 100 : 0);
  setMetricNa(ui.gpuFreqMetric, !isNumber(frequency));

  const power = sensorValues?.powerW ?? gpu.powerW;
  setText(ui.gpuPower, isNumber(power) ? String(Math.round(power)) : '--');
  setBar(ui.gpuPowerBar, isNumber(power) ? (power / 250) * 100 : 0);
  setMetricNa(ui.gpuPowerMetric, !isNumber(power));
}

function renderMemory(mem) {
  const used = isNumber(mem.used) ? mem.used : null;
  const total = isNumber(mem.total) ? mem.total : null;
  const percent = used && total ? (used / total) * 100 : null;

  setBar(ui.memBar, percent);
  setText(ui.memPercent, percent === null ? '--%' : `${Math.round(percent)}%`);
  setText(ui.memUsed, formatCapacity(used));
  setText(ui.memTotal, ` / ${formatCapacity(total, true)}`);
}

function renderVram(gpu) {
  const used = isNumber(gpu.memUsed) ? gpu.memUsed : null;
  const total = isNumber(gpu.memTotal) ? gpu.memTotal : null;
  const percent = used && total ? (used / total) * 100 : null;

  setBar(ui.vramBar, percent);
  setText(ui.vramPercent, percent === null ? '--%' : `${Math.round(percent)}%`);
  setText(ui.vramUsed, formatCapacity(used));
  setText(ui.vramTotal, ` / ${formatCapacity(total, true)}`);
}

function renderNetwork(net) {
  const [downValue, downUnit] = formatRate(net.down);
  const [upValue, upUnit] = formatRate(net.up);
  setText(ui.netDown, downValue);
  setText(ui.netDownUnit, downUnit);
  setText(ui.netUp, upValue);
  setText(ui.netUpUnit, upUnit);
}

const DEVICE_ICONS = {
  mouse: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6.6" y="2.7" width="10.8" height="18.6" rx="5.2"/><path d="M12 2.7v6.4M9.2 9.1h5.6"/></svg>`,
  headset: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.2 13.2v-1.4a7.8 7.8 0 0 1 15.6 0v1.4"/><rect x="2.7" y="13" width="4.2" height="6.3" rx="1.6"/><rect x="17.1" y="13" width="4.2" height="6.3" rx="1.6"/></svg>`,
  keyboard: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.4" y="6.2" width="19.2" height="11.6" rx="2.1"/><path d="M5.6 9.8h.01M8.7 9.8h.01M11.8 9.8h.01M14.9 9.8h.01M18 9.8h.01M8 13.8h8"/></svg>`,
  dongle: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4.2" y="10" width="8.4" height="10.2" rx="2.2"/><path d="M6.6 10V6.7a2 2 0 0 1 2-2h1.4M16.2 9.3a6 6 0 0 1 0 8M19.4 6.6a9.6 9.6 0 0 1 0 13"/></svg>`,
  bluetooth: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 7.3 8 9.4-4 3.2V4.1l4 3.2-8 9.4"/></svg>`,
  speaker: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.2h3.8L13 5.2v13.6l-5.2-4H4z"/><path d="M16 9.4a4.2 4.2 0 0 1 0 5.2M18.6 6.8a7.8 7.8 0 0 1 0 10.4"/></svg>`,
  device: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3.2"/><circle cx="12" cy="12" r="2.2"/></svg>`,
};

function deviceIconFor(device) {
  if (device.transport === 'receiver') return DEVICE_ICONS.dongle;
  if (device.transport === 'bluetooth' && !/耳机|音频|音箱|扬声器|麦克风/.test(device.kind || '')) {
    return DEVICE_ICONS.bluetooth;
  }
  const kind = device.kind || '';
  if (kind.includes('鼠标')) return DEVICE_ICONS.mouse;
  if (kind.includes('扬声器') || kind.includes('音箱')) return DEVICE_ICONS.speaker;
  if (kind.includes('耳机') || kind.includes('音频') || kind.includes('麦克风')) {
    return DEVICE_ICONS.headset;
  }
  if (kind.includes('键盘') || kind.includes('键鼠')) return DEVICE_ICONS.keyboard;
  return DEVICE_ICONS.device;
}

function connectionBadge(device) {
  if (device.transport === 'bluetooth') return '蓝牙';
  if (device.transport === 'receiver') return '2.4G';
  if (device.wired || device.link === 'usb') return 'USB';
  return '已连接';
}

function makeDeviceBattery(device) {
  const wrapper = document.createElement('span');
  wrapper.className = 'razer-battery';

  if (isNumber(device.battery)) {
    const percent = clamp(device.battery, 0, 100);
    if (percent <= 15) wrapper.classList.add('low');
    else if (percent <= 40) wrapper.classList.add('mid');
    if (device.asleep) wrapper.classList.add('asleep');

    const shell = document.createElement('span');
    shell.className = 'battery-shell';
    const fill = document.createElement('i');
    fill.className = 'battery-fill';
    fill.style.width = `${percent}%`;
    shell.appendChild(fill);

    const text = document.createElement('b');
    text.className = 'battery-text';
    text.textContent = `${Math.round(percent)}%`;

    wrapper.title = device.asleep
      ? `设备休眠 · 上次电量 ${Math.round(percent)}%`
      : `电量 ${Math.round(percent)}%`;
    wrapper.append(shell, text);
    return wrapper;
  }

  const state = document.createElement('span');
  state.className = 'razer-state';
  if (device.asleep) {
    state.textContent = '休眠';
    state.title = '设备处于休眠状态，暂未返回电量';
  } else if (device.batterySupported) {
    state.textContent = '—';
    state.title = '暂时无法读取电量';
  } else {
    state.textContent = connectionBadge(device);
  }
  wrapper.appendChild(state);
  return wrapper;
}

function makeDeviceRow(device) {
  const row = document.createElement('div');
  row.className = 'razer-row';

  const icon = document.createElement('span');
  icon.className = 'razer-device-icon';
  if (device.transport) icon.classList.add(device.transport);
  icon.innerHTML = deviceIconFor(device);

  const info = document.createElement('span');
  info.className = 'razer-info';

  const name = document.createElement('span');
  name.className = 'razer-name';
  name.textContent = device.name || '无线设备';

  const kind = document.createElement('span');
  kind.className = 'razer-kind';
  let kindLabel = device.kind || '设备';
  if (device.source === 'razer' || !device.transport) {
    if (device.link === 'usb' && device.batterySupported) {
      kindLabel = `USB ${kindLabel.replace('无线', '')}`;
    }
  }
  if (device.asleep) kindLabel += ' · 休眠';
  kind.textContent = kindLabel;

  info.append(name, kind);
  row.append(icon, info, makeDeviceBattery(device));

  const batteryLabel = isNumber(device.battery)
    ? device.asleep
      ? `休眠 · 上次电量 ${Math.round(device.battery)}%`
      : `电量 ${Math.round(device.battery)}%`
    : device.asleep
      ? '休眠'
      : device.batterySupported
        ? '电量不可读'
        : connectionBadge(device);
  row.title = `${device.name || '无线设备'} · ${kindLabel} · ${batteryLabel}`;
  return row;
}

function renderPeripherals(razer, peripherals) {
  const sourceOrder = { razer: 0, bluetooth: 1, usb: 2, receiver: 3 };
  const seen = new Set();
  const seenNames = new Set();
  const devices = [];
  const nameKey = (name) =>
    String(name || '')
      .toLowerCase()
      .replace(/^razer\s+/i, '')
      .replace(/\s+/g, ' ')
      .trim();

  for (const device of Array.isArray(razer.devices) ? razer.devices : []) {
    const normalized = { ...device, source: 'razer' };
    const key = String(normalized.key || normalized.name).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    seenNames.add(nameKey(normalized.name));
    devices.push(normalized);
  }

  for (const device of Array.isArray(peripherals.devices) ? peripherals.devices : []) {
    const key = String(device.key || device.name).toLowerCase();
    if (seen.has(key)) continue;
    // USB audio often mirrors a Bluetooth/Razer headset. Keep the richer
    // wireless entry and only add the USB entry when it is a distinct device.
    if (device.source === 'usb' && seenNames.has(nameKey(device.name))) continue;
    seen.add(key);
    seenNames.add(nameKey(device.name));
    devices.push(device);
  }

  devices.sort((a, b) => {
    const batteryRank = Number(isNumber(b.battery) || b.batterySupported)
      - Number(isNumber(a.battery) || a.batterySupported);
    if (batteryRank !== 0) return batteryRank;

    const sourceRank = (sourceOrder[a.source] ?? 9) - (sourceOrder[b.source] ?? 9);
    if (sourceRank !== 0) return sourceRank;

    return String(a.name).localeCompare(String(b.name), 'zh-CN');
  });

  const razerStarting = razer.status === 'starting' && !devices.some((d) => d.source === 'razer');
  const peripheralsStarting =
    peripherals.status === 'starting' && !devices.some((d) => d.source !== 'razer');
  const starting = !devices.length && (razerStarting || peripheralsStarting);
  const bothError =
    !devices.length && razer.status === 'error' && peripherals.status === 'error';

  if (devices.length) {
    setText(ui.razerCount, `${devices.length} 台`);
  } else if (bothError) {
    setText(ui.razerCount, '不可用');
  } else if (starting) {
    setText(ui.razerCount, '检测中');
  } else {
    setText(ui.razerCount, '0 台');
  }

  ui.razerList.textContent = '';

  if (!devices.length) {
    const empty = document.createElement('div');
    empty.className = 'razer-empty';
    if (bothError) {
      empty.textContent = '无线外设检测不可用';
      empty.title = [razer.error, peripherals.error].filter(Boolean).join('\n');
    } else if (starting) {
      empty.textContent = '正在检测无线外设…';
    } else {
      empty.textContent = '未检测到无线外设';
    }
    ui.razerList.appendChild(empty);
    return;
  }

  for (const device of devices.slice(0, 8)) {
    ui.razerList.appendChild(makeDeviceRow(device));
  }
}

function render(state) {
  if (!state) return;
  lastPainted = Date.now();
  renderCpu(state);
  renderGpu(state);
  renderMemory(state.mem || {});
  renderVram(state.gpu || {});
  renderNetwork(state.net || {});
  renderPeripherals(state.razer || {}, state.peripherals || {});
}

function wireControls() {
  ui.settingsBtn.addEventListener('click', () => window.pulse.openSettings());
  ui.updateBtn.addEventListener('click', () => window.pulse.openSettings());
  ui.menuBtn.addEventListener('click', () => window.pulse.showMenu());
  ui.closeBtn.addEventListener('click', () => window.pulse.hide());

  window.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    window.pulse.showMenu();
  });

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') window.pulse.hide();
  });
}

async function boot() {
  wireControls();

  window.pulse.onMetrics(render);
  window.pulse.onConfig(applyConfig);
  window.pulse.onTheme((theme) => window.PulseTheme?.apply(theme));

  try {
    const [state, config, theme] = await Promise.all([
      window.pulse.getState(),
      window.pulse.getConfig(),
      window.pulse.getTheme(),
    ]);
    if (theme) window.PulseTheme?.apply(theme);
    applyConfig(config);
    if (state) render(state);
  } catch {
    // The first pushed update will populate the widget.
  }

  window.setTimeout(() => {
    if (!lastPainted) {
      document.documentElement.classList.add('waiting');
    }
  }, 2600);
}

boot();
