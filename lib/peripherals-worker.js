'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');

const execFileAsync = promisify(execFile);
const POLL_INTERVAL_MS = Math.max(10000, Number(workerData?.intervalMs) || 30000);
const POWERSHELL =
  process.env.SystemRoot
    ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';

let hid = null;
try {
  hid = require('node-hid');
} catch {
  // Bluetooth detection can still run without node-hid.
}

const BLUETOOTH_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[Windows.Devices.Bluetooth.BluetoothDevice, Windows.Devices.Bluetooth, ContentType=WindowsRuntime] | Out-Null
[Windows.Devices.Bluetooth.BluetoothLEDevice, Windows.Devices.Bluetooth, ContentType=WindowsRuntime] | Out-Null
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Await($WinRtTask, $ResultType) {
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.IsGenericMethod
  })[0]
  $netTask = $asTask.MakeGenericMethod($ResultType).Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}

$items = @()
$devices = @(Get-PnpDevice -Class Bluetooth |
  Where-Object {
    ($_.InstanceId -like 'BTHENUM\DEV_*' -or $_.InstanceId -like 'BTHLE\DEV_*') -and
    $_.Status -eq 'OK' -and $_.Present
  })
foreach ($device in $devices) {
  $address = ''
  if ($device.InstanceId -match 'DEV_([0-9A-Fa-f]{12})') {
    $address = $matches[1].ToUpper()
  }
  if (-not $address) { continue }

  # PnP "Present" is true for paired devices too. Ask the Bluetooth stack for
  # the real connection state before showing the device.
  $connected = $false
  try {
    $numericAddress = [Convert]::ToUInt64($address, 16)
    if ($device.InstanceId -like 'BTHLE*') {
      $bluetoothDevice = Await (
        [Windows.Devices.Bluetooth.BluetoothLEDevice]::FromBluetoothAddressAsync($numericAddress)
      ) ([Windows.Devices.Bluetooth.BluetoothLEDevice])
    } else {
      $bluetoothDevice = Await (
        [Windows.Devices.Bluetooth.BluetoothDevice]::FromBluetoothAddressAsync($numericAddress)
      ) ([Windows.Devices.Bluetooth.BluetoothDevice])
    }
    if ($bluetoothDevice -and $bluetoothDevice.ConnectionStatus -eq [Windows.Devices.Bluetooth.BluetoothConnectionStatus]::Connected) {
      $connected = $true
    }
  } catch {}
  if (-not $connected) { continue }

  $cod = 0
  $registryKey = 'HKLM:\SYSTEM\CurrentControlSet\Services\BTHPORT\Parameters\Devices\' + $address.ToLower()
  $entry = Get-ItemProperty $registryKey -ErrorAction SilentlyContinue
  if ($entry -and $entry.COD) { $cod = [uint32]$entry.COD }

  $items += [pscustomobject]@{
    name = [string]$device.FriendlyName
    instanceId = [string]$device.InstanceId
    address = $address
    cod = $cod
  }
}
@($items) | ConvertTo-Json -Compress -Depth 3
`;

const USB_AUDIO_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$items = @()
$devices = @(Get-PnpDevice -PresentOnly -Class MEDIA |
  Where-Object {
    $_.Status -eq 'OK' -and
    $_.InstanceId -like 'USB\*'
  })
foreach ($device in $devices) {
  $items += [pscustomobject]@{
    name = [string]$device.FriendlyName
    instanceId = [string]$device.InstanceId
  }
}
@($items) | ConvertTo-Json -Compress -Depth 3
`;

function bluetoothKind(cod, name) {
  const value = Number(cod) || 0;
  const major = (value >> 8) & 0x1f;
  const minor = (value >> 2) & 0x3f;

  if (value === 0) {
    const lower = String(name || '').toLowerCase();
    if (/headset|headphone|earbud|buds|耳机/.test(lower)) return '耳机';
    if (/speaker|soundbar|音箱/.test(lower)) return '音箱';
    if (/keyboard|键盘/.test(lower)) return '键盘';
    if (/mouse|鼠标/.test(lower)) return '鼠标';
    return '蓝牙设备';
  }

  if (major === 0x04) {
    if (minor === 0x06) return '耳机';
    if (minor === 0x01) return '耳麦';
    if (minor === 0x02) return '免提';
    if (minor === 0x05 || minor === 0x07) return '音箱';
    if (minor === 0x04) return '麦克风';
    return '音频设备';
  }
  if (major === 0x05) {
    if (minor === 0x01) return '键盘';
    if (minor === 0x02) return '鼠标';
    return '外设';
  }
  if (major === 0x01) return '电脑';
  if (major === 0x02) return '手机';
  if (major === 0x07) return '穿戴设备';
  return '蓝牙设备';
}

async function scanBluetooth() {
  const encoded = Buffer.from(BLUETOOTH_SCRIPT, 'utf16le').toString('base64');
  const { stdout } = await execFileAsync(
    POWERSHELL,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    {
      timeout: 8000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
    },
  );

  const text = String(stdout).replace(/^\uFEFF/, '').trim();
  if (!text) return [];

  const parsed = JSON.parse(text);
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const seen = new Set();

  return items
    .map((item) => {
      const name = String(item.name || '').trim();
      const id = String(item.instanceId || '');
      if (!name || seen.has(id)) return null;
      seen.add(id);
      return {
        key: `bluetooth:${id.toLowerCase()}`,
        name,
        kind: bluetoothKind(item.cod, name),
        transport: 'bluetooth',
        link: 'bluetooth',
        source: 'bluetooth',
        battery: null,
        batterySupported: false,
        asleep: false,
        wired: false,
        address: String(item.address || ''),
      };
    })
    .filter(Boolean);
}

function usbAudioKind(name) {
  const value = String(name || '').toLowerCase();
  if (/microphone|\bmic\b|麦克风/.test(value)) return '麦克风';
  if (/headset|headphone|耳机|耳麦/.test(value)) return '耳机';
  if (/speaker|soundbar|音箱|扬声器/.test(value)) return '扬声器';
  return '扬声器';
}

async function scanUsbAudio() {
  const encoded = Buffer.from(USB_AUDIO_SCRIPT, 'utf16le').toString('base64');
  const { stdout } = await execFileAsync(
    POWERSHELL,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    {
      timeout: 8000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
    },
  );

  const text = String(stdout).replace(/^\uFEFF/, '').trim();
  if (!text) return [];

  const parsed = JSON.parse(text);
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const seen = new Set();

  return items
    .map((item) => {
      const id = String(item.instanceId || '').trim();
      let name = String(item.name || '')
        .replace(/^PhiIips\s+/i, 'Philips ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!name || !id || seen.has(id)) return null;
      seen.add(id);
      return {
        key: `usb-audio:${id.toLowerCase()}`,
        name,
        kind: usbAudioKind(name),
        transport: 'usb',
        link: 'usb',
        source: 'usb',
        battery: null,
        batterySupported: false,
        asleep: false,
        wired: true,
      };
    })
    .filter(Boolean);
}

function scanReceivers() {
  if (!hid) return [];

  let devices = [];
  try {
    devices = hid.devices();
  } catch {
    return [];
  }

  const groups = new Map();

  for (const device of devices) {
    const product = String(device.product || '').trim();
    const manufacturer = String(device.manufacturer || '').trim();
    if (!product) continue;
    if (device.vendorId === 0x1532) continue; // Razer devices have their own provider.
    if (!/receiver|wireless|2\.4g|dongle/i.test(product)) continue;
    if (/bluetooth/i.test(product) || /bluetooth/i.test(manufacturer)) continue;

    const groupKey = `${device.vendorId}:${device.productId}:${product.toLowerCase()}`;
    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        key: `receiver:${groupKey}`,
        product,
        manufacturer,
        vendorId: device.vendorId,
        productId: device.productId,
        hasKeyboard: false,
        hasMouse: false,
        hasConsumer: false,
      });
    }

    const group = groups.get(groupKey);
    if (device.usagePage === 0x0001 && device.usage === 0x0006) group.hasKeyboard = true;
    if (device.usagePage === 0x0001 && device.usage === 0x0002) group.hasMouse = true;
    if (device.usagePage === 0x000c) group.hasConsumer = true;
  }

  return [...groups.values()].map((group) => {
    let kind = '接收器';
    if (group.hasKeyboard && group.hasMouse) kind = '键鼠';
    else if (group.hasMouse) kind = '鼠标';
    else if (group.hasKeyboard) kind = '键盘';
    else if (group.hasConsumer) kind = '多媒体';

    const name = /receiver|dongle/i.test(group.product)
      ? `${group.manufacturer || 'USB'} 接收器`
      : group.product.replace(/^Razer\s+/i, '');

    return {
      key: group.key,
      name,
      kind,
      transport: 'receiver',
      link: 'receiver',
      source: 'receiver',
      battery: null,
      batterySupported: false,
      asleep: false,
      wired: false,
      vendorId: group.vendorId,
      productId: group.productId,
    };
  });
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
    const receiverDevices = scanReceivers();

    // Show receiver devices immediately; Bluetooth enumeration takes a little
    // longer because it goes through the Windows PnP provider.
    parentPort?.postMessage({
      type: 'devices',
      devices: receiverDevices,
      status: 'ok',
      ts: Date.now(),
    });

    const [bluetoothResult, usbAudioResult] = await Promise.allSettled([
      scanBluetooth(),
      scanUsbAudio(),
    ]);
    const bluetoothDevices =
      bluetoothResult.status === 'fulfilled' ? bluetoothResult.value : [];
    const usbAudioDevices =
      usbAudioResult.status === 'fulfilled' ? usbAudioResult.value : [];
    const bluetoothError =
      bluetoothResult.status === 'rejected'
        ? bluetoothResult.reason?.message || String(bluetoothResult.reason)
        : null;
    const usbAudioError =
      usbAudioResult.status === 'rejected'
        ? usbAudioResult.reason?.message || String(usbAudioResult.reason)
        : null;
    const error = [bluetoothError, usbAudioError].filter(Boolean).join('; ') || null;

    parentPort?.postMessage({
      type: 'devices',
      devices: [...receiverDevices, ...bluetoothDevices, ...usbAudioDevices],
      status: error ? 'partial' : 'ok',
      error,
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
