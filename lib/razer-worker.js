'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');

const RAZER_VID = 0x1532;
const POLL_INTERVAL_MS = Math.max(10000, Number(workerData?.intervalMs) || 60000);
const READ_DELAY_MS = 340;
const REPORT_LENGTH = 91;
const CACHE_PATH = workerData?.cachePath || null;

let batteryCache = {};
if (CACHE_PATH) {
  try {
    const raw = fs.readFileSync(CACHE_PATH, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.batteries) {
      batteryCache = parsed.batteries;
    }
  } catch {
    // First run or unreadable cache; start empty.
  }
}

function saveBatteryCache() {
  if (!CACHE_PATH) return;
  try {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    fs.writeFileSync(
      CACHE_PATH,
      `${JSON.stringify({ updatedAt: Date.now(), batteries: batteryCache }, null, 2)}\n`,
      'utf8',
    );
  } catch {
    // A read-only/corrupt cache should never break device monitoring.
  }
}

// Battery-capable models whose firmware answers the classic OpenRazer
// transaction (command class 0x02, id 0x07, transaction id 0x1f).
const BATTERY_MODELS = new Map([
  [0x00a6, { name: 'Razer Viper V2 Pro', wiredPid: 0x00a5 }],
  [0x00a5, { name: 'Razer Viper V2 Pro', wiredPid: 0x00a5 }],
  [0x00c1, { name: 'Razer Viper V3 Pro', wiredPid: 0x00c0 }],
  [0x00c0, { name: 'Razer Viper V3 Pro', wiredPid: 0x00c0 }],
  [0x00b7, { name: 'Razer DeathAdder V3 Pro', wiredPid: 0x00b6 }],
  [0x00b6, { name: 'Razer DeathAdder V3 Pro', wiredPid: 0x00b6 }],
  [0x00bf, { name: 'Razer DeathAdder V4 Pro', wiredPid: 0x00be }],
  [0x00be, { name: 'Razer DeathAdder V4 Pro', wiredPid: 0x00be }],
  [0x00ab, { name: 'Razer Basilisk V3 Pro', wiredPid: 0x00aa }],
  [0x00aa, { name: 'Razer Basilisk V3 Pro', wiredPid: 0x00aa }],
  [0x00cd, { name: 'Razer Basilisk V3 Pro 35K', wiredPid: 0x00cc }],
  [0x00cc, { name: 'Razer Basilisk V3 Pro 35K', wiredPid: 0x00cc }],
  [0x0088, { name: 'Razer Basilisk Ultimate', wiredPid: 0x0086 }],
  [0x0086, { name: 'Razer Basilisk Ultimate', wiredPid: 0x0086 }],
  [0x00b0, { name: 'Razer Cobra Pro', wiredPid: 0x00af }],
  [0x00af, { name: 'Razer Cobra Pro', wiredPid: 0x00af }],
  [0x0090, { name: 'Razer Naga Pro', wiredPid: 0x008f }],
  [0x008f, { name: 'Razer Naga Pro', wiredPid: 0x008f }],
  [0x00a8, { name: 'Razer Naga V2 Pro', wiredPid: 0x00a7 }],
  [0x00a7, { name: 'Razer Naga V2 Pro', wiredPid: 0x00a7 }],
  [0x006f, { name: 'Razer Lancehead Wireless', wiredPid: 0x0070 }],
  [0x0070, { name: 'Razer Lancehead Wireless', wiredPid: 0x0070 }],
  [0x00d1, { name: 'Razer Pro Click V2', wiredPid: 0x00d0 }],
  [0x00d0, { name: 'Razer Pro Click V2', wiredPid: 0x00d0 }],
]);

const VIRTUAL_NAME = /control device|virtual|sound card|usb input device|hid-compliant/i;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function batteryReport() {
  const header = [0x00, 0x1f, 0x00, 0x00, 0x00, 0x02, 0x07, 0x80];
  let checksum = 0;
  for (let index = 2; index < header.length; index += 1) checksum ^= header[index];
  const payload = [...header, ...Array(80).fill(0), checksum, 0];
  return [0x00, ...payload];
}

function cleanProductName(product) {
  return String(product || '')
    .replace(/^razer\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function deviceKind(product, pid) {
  const name = product.toLowerCase();
  if (/hammerhead|blackshark|kraken|barracuda|moray|electra|thresher|nari|op[us]?/.test(name)) {
    return '耳机';
  }
  if (/viper|deathadder|basilisk|naga|cobra|lancehead|mamba|orochi|pro click|abyssus/.test(name)) {
    return '鼠标';
  }
  if (/huntsman|blackwidow|ornata|cynosa|tartarus|keyboard|gameboard/.test(name)) {
    return '键盘';
  }
  if (/leviathan|nommo|speaker|audio/.test(name)) {
    return '音箱';
  }
  if (/kishi|razer edge|controller|gamepad/.test(name)) {
    return '手柄';
  }
  if (BATTERY_MODELS.has(pid)) return '鼠标';
  return '设备';
}

function scorePath(device) {
  let score = 0;
  if (device.usagePage === 0x0001 && device.usage === 0x0002) score += 80;
  if (device.interface === 0) score += 40;
  if (/MI_00/i.test(device.path || '')) score += 30;
  return score;
}

const workingPaths = new Map();

async function readBattery(group) {
  let candidates = group.hidDevices
    .filter((device) => Boolean(device.path))
    .sort((a, b) => scorePath(b) - scorePath(a));

  const cached = workingPaths.get(group.key);
  if (cached) {
    const cachedDevice = candidates.find((device) => device.path === cached);
    if (cachedDevice) {
      candidates = [cachedDevice, ...candidates.filter((device) => device.path !== cached)];
    }
  }

  const report = batteryReport();
  let lastError = null;

  for (const candidate of candidates.slice(0, 4)) {
    let device = null;
    try {
      device = new hid.HID(candidate.path);
      device.sendFeatureReport(report);
      await sleep(READ_DELAY_MS);
      const response = device.getFeatureReport(0x00, REPORT_LENGTH);

      if (
        !response ||
        response.length < 11 ||
        response[6] !== 0x02 ||
        response[7] !== 0x07
      ) {
        lastError = new Error('Unexpected battery report');
        continue;
      }

      // Status 0x04 is the firmware's "not ready / asleep" reply.
      if (response[1] === 0x04) return { battery: null, asleep: true };
      if (response[1] !== 0x02) {
        lastError = new Error(`Battery query status ${response[1]}`);
        continue;
      }

      const raw = response[10];
      workingPaths.set(group.key, candidate.path);
      if (raw === 0) return { battery: null, asleep: true };
      return {
        battery: Math.max(0, Math.min(100, Math.round((raw / 255) * 100))),
        asleep: false,
      };
    } catch (error) {
      lastError = error;
    } finally {
      try {
        device?.close();
      } catch {
        // Ignore close failures; the next scan opens a fresh handle.
      }
    }
  }

  if (lastError) workingPaths.delete(group.key);
  return { battery: null, asleep: false };
}

function discover() {
  const all = hid
    .devices()
    .filter(
      (device) =>
        device.vendorId === RAZER_VID &&
        device.product &&
        !VIRTUAL_NAME.test(device.product),
    );

  const groups = new Map();
  for (const device of all) {
    const name = cleanProductName(device.product);
    if (!name) continue;
    const key = name.toLowerCase();
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        name,
        pids: new Set(),
        hidDevices: [],
      });
    }
    const group = groups.get(key);
    group.pids.add(device.productId);
    group.hidDevices.push(device);
  }

  return [...groups.values()]
    .map((group) => {
      const pids = [...group.pids];
      const batteryModel = pids.map((pid) => BATTERY_MODELS.get(pid)).find(Boolean) || null;
      const wiredPresent = pids.some((pid) => pid === batteryModel?.wiredPid);
      const kind = deviceKind(group.name, pids[0]);
      return {
        key: group.key,
        name: group.name,
        kind: batteryModel ? (kind === '鼠标' ? '无线鼠标' : kind) : kind,
        wired: pids.includes(0x058c),
        batterySupported: Boolean(batteryModel),
        battery: null,
        asleep: false,
        link: wiredPresent ? 'usb' : 'wireless',
        hidDevices: group.hidDevices,
      };
    })
    .sort((a, b) => {
      if (a.batterySupported !== b.batterySupported) return a.batterySupported ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

function publicDevice(device) {
  return {
    key: device.key,
    name: device.name,
    kind: device.kind,
    battery: Number.isFinite(device.battery)
      ? device.battery
      : Number.isFinite(batteryCache[device.key])
        ? batteryCache[device.key]
        : null,
    asleep: device.asleep,
    batterySupported: device.batterySupported,
    wired: device.wired,
    link: device.link,
  };
}

let hid;
try {
  hid = require('node-hid');
} catch (error) {
  if (parentPort) {
    parentPort.postMessage({
      type: 'error',
      message: `node-hid unavailable: ${error.message}`,
    });
  }
  throw error;
}

let busy = false;
let queued = false;

async function scan() {
  if (busy) {
    queued = true;
    return;
  }
  busy = true;

  try {
    const devices = discover();

    parentPort?.postMessage({
      type: 'devices',
      devices: devices.map(publicDevice),
      status: 'ok',
      ts: Date.now(),
    });

    for (const device of devices) {
      if (device.batterySupported) {
        const result = await readBattery(device);
        if (Number.isFinite(result.battery)) {
          device.battery = result.battery;
          batteryCache[device.key] = result.battery;
          saveBatteryCache();
        } else {
          device.battery = Number.isFinite(batteryCache[device.key])
            ? batteryCache[device.key]
            : null;
        }
        device.asleep = result.asleep;
      }
    }

    parentPort?.postMessage({
      type: 'devices',
      devices: devices.map(publicDevice),
      status: 'ok',
      ts: Date.now(),
    });
  } catch (error) {
    parentPort?.postMessage({
      type: 'error',
      message: error && error.message ? error.message : String(error),
      ts: Date.now(),
    });
  } finally {
    busy = false;
    if (queued) {
      queued = false;
      scan();
    }
  }
}

if (parentPort) {
  parentPort.on('message', (message) => {
    if (message && message.type === 'refresh') scan();
  });

  scan();
  setInterval(scan, POLL_INTERVAL_MS);
} 
