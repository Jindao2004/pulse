'use strict';

const { EventEmitter } = require('node:events');
const { execFile } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { promisify } = require('node:util');
const si = require('systeminformation');
const { TypeperfSampler } = require('./typeperf');
const { RazerMonitor } = require('./razer-monitor');
const { PeripheralMonitor } = require('./peripheral-monitor');
const { SensorMonitor } = require('./sensor-monitor');

const execFileAsync = promisify(execFile);

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const asNumber = (value) => {
  if (value === undefined || value === null) return null;
  const parsed = Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : null;
};

function findNvidiaSmi() {
  const candidates = ['nvidia-smi.exe'];
  if (process.env.SystemRoot) {
    candidates.push(path.join(process.env.SystemRoot, 'System32', 'nvidia-smi.exe'));
  }
  for (const candidate of candidates) {
    if (candidate.includes(path.sep) && !fs.existsSync(candidate)) continue;
    return candidate;
  }
  return 'nvidia-smi.exe';
}

const NVIDIA_SMI = findNvidiaSmi();
const NVIDIA_QUERY = [
  'name',
  'temperature.gpu',
  'utilization.gpu',
  'clocks.current.graphics',
  'power.draw',
  'power.limit',
  'fan.speed',
  'memory.total',
  'memory.used',
].join(',');

/**
 * Collects all system metrics and emits a single state object at a relaxed
 * cadence. CPU/network come from a persistent typeperf process; GPU comes from
 * nvidia-smi; memory and static information come from systeminformation.
 */
class MetricsMonitor extends EventEmitter {
  constructor({ intervalMs = 1000, razerCachePath = null, sensorFilePath = null, sensorConfig = null } = {}) {
    super();
    this.intervalMs = intervalMs;
    this.razerCachePath = razerCachePath;
    this.sensorFilePath = sensorFilePath;
    this.running = false;
    this._publishTimer = null;
    this._gpuBusy = false;
    this._memBusy = false;
    this._tempBusy = false;
    this._fallbackCpuBusy = false;
    this._fallbackNetBusy = false;
    this._gpuFailures = 0;
    this._fallbackStarted = false;

    this.state = {
      ts: Date.now(),
      cpu: {
        name: 'CPU',
        manufacturer: '',
        usage: 0,
        system: null,
        frequencyMHz: null,
        baseMHz: null,
        temperature: null,
        physicalCores: null,
        threads: null,
        powerW: null,
      },
      gpu: {
        name: '显卡',
        available: false,
        usage: null,
        temperature: null,
        frequencyMHz: null,
        powerW: null,
        powerLimitW: null,
        fanRpm: null,
        memUsed: null,
        memTotal: null,
      },
      mem: { used: null, total: null },
      net: { down: 0, up: 0 },
      razer: {
        devices: [],
        status: 'starting',
        error: null,
        updatedAt: null,
      },
      peripherals: {
        devices: [],
        status: 'starting',
        error: null,
        updatedAt: null,
      },
      sensors: {
        status: 'disabled',
        sensors: [],
        selected: { cpu: {}, gpu: {} },
        values: {
          cpu: { fanRpm: null, temperature: null, frequencyMHz: null, powerW: null },
          gpu: { fanRpm: null, temperature: null, frequencyMHz: null, powerW: null },
        },
        updatedAt: null,
        error: null,
      },
      status: {
        cpuSource: 'starting',
        gpuSource: 'starting',
        lastUpdate: null,
      },
    };

    this.sampler = new TypeperfSampler({ intervalMs });
    this.sampler.on('sample', (sample) => this._onTypeperfSample(sample));
    this.sampler.on('warning', (error) => {
      if (this.state.status.cpuSource !== 'fallback') {
        this.state.status.cpuSource = 'fallback';
        this._ensureFallback();
      }
      this.emit('warning', error);
    });

    this.razer = new RazerMonitor({ cachePath: this.razerCachePath });
    this.razer.on('update', (razer) => {
      this.state.razer = razer;
      this.state.status.lastUpdate = Date.now();
      this._publish();
    });

    this.peripherals = new PeripheralMonitor();
    this.peripherals.on('update', (peripherals) => {
      this.state.peripherals = peripherals;
      this.state.status.lastUpdate = Date.now();
      this._publish();
    });

    this.sensors = new SensorMonitor({
      filePath: this.sensorFilePath,
      config: sensorConfig,
    });
    this.sensors.on('update', (sensors) => {
      this.state.sensors = sensors;
      this.state.status.lastUpdate = Date.now();
      this._publish();
    });
  }

  async start() {
    if (this.running) return;
    this.running = true;

    this.sampler.start();
    this.razer.start();
    this.peripherals.start();
    this.sensors.start();
    this._loadStaticInfo().catch((error) => this.emit('warning', error));
    this._pollMemory();
    this._pollGpu();
    this._pollTemperature();

    // Seed the UI immediately with systeminformation while typeperf warms up.
    // The heavier typeperf source takes over on its first sample.
    this.state.status.cpuSource = 'fallback';
    this._ensureFallback();

    this._memTimer = setInterval(() => this._pollMemory(), 2000);
    this._gpuTimer = setInterval(() => this._pollGpu(), this.intervalMs);
    this._tempTimer = setInterval(() => this._pollTemperature(), 5000);

    this._publish();
  }

  stop() {
    this.running = false;
    this.sampler.stop();
    this.razer.stop();
    this.peripherals.stop();
    this.sensors.stop();
    clearTimeout(this._fallbackGuard);
    clearTimeout(this._publishTimer);
    clearInterval(this._memTimer);
    clearInterval(this._gpuTimer);
    clearInterval(this._tempTimer);
    clearInterval(this._fallbackCpuTimer);
    clearInterval(this._fallbackNetTimer);
  }

  setIntervalMs(intervalMs) {
    if (!Number.isFinite(intervalMs) || intervalMs < 1000) return;
    this.intervalMs = intervalMs;
    this.sampler.setIntervalMs(intervalMs);
    if (this._gpuTimer) {
      clearInterval(this._gpuTimer);
      this._gpuTimer = setInterval(() => this._pollGpu(), intervalMs);
    }
  }

  snapshot() {
    return this.state;
  }

  refreshRazer() {
    this.razer.refresh();
  }

  refreshPeripherals() {
    this.peripherals.refresh();
  }

  setSensorConfig(config) {
    this.sensors.setConfig(config);
  }

  getSensorMonitor() {
    return this.sensors;
  }

  async _loadStaticInfo() {
    const results = await Promise.allSettled([si.cpu(), si.mem()]);

    if (results[0].status === 'fulfilled') {
      const cpu = results[0].value;
      this.state.cpu.name = (cpu.brand || 'CPU').trim();
      this.state.cpu.manufacturer = (cpu.manufacturer || '').trim();
      this.state.cpu.physicalCores = cpu.physicalCores || null;
      this.state.cpu.threads = cpu.cores || null;
      this.state.cpu.baseMHz = cpu.speed ? Math.round(cpu.speed * 1000) : null;
      if (!this.state.cpu.frequencyMHz) {
        this.state.cpu.frequencyMHz = this.state.cpu.baseMHz;
      }
    }

    if (results[1].status === 'fulfilled') {
      this.state.mem.total = results[1].value.total;
      this.state.mem.used = results[1].value.used;
    }

    this._publish();
  }

  _onTypeperfSample(sample) {
    const cpu = this.state.cpu;
    const previous = Number.isFinite(cpu.usage) ? cpu.usage : sample.cpu;
    cpu.usage = clamp(previous * 0.35 + sample.cpu * 0.65, 0, 100);
    cpu.system = sample.system;

    if (sample.performance !== null && cpu.baseMHz) {
      cpu.frequencyMHz = clamp(
        Math.round(cpu.baseMHz * (sample.performance / 100)),
        400,
        6500,
      );
    }

    this.state.net.down = Math.max(0, sample.rx);
    this.state.net.up = Math.max(0, sample.tx);
    this.state.status.cpuSource = 'typeperf';
    this.state.status.lastUpdate = Date.now();

    if (this._fallbackStarted) this._stopFallback();
    this._publish();
  }

  _ensureFallback() {
    if (this._fallbackStarted) return;
    this._fallbackStarted = true;

    this._fallbackCpuTimer = setInterval(() => this._pollFallbackCpu(), 1200);
    this._fallbackNetTimer = setInterval(() => this._pollFallbackNetwork(), 1200);
    this._pollFallbackCpu();
    this._pollFallbackNetwork();
  }

  _stopFallback() {
    this._fallbackStarted = false;
    clearInterval(this._fallbackCpuTimer);
    clearInterval(this._fallbackNetTimer);
    this._fallbackCpuTimer = null;
    this._fallbackNetTimer = null;
  }

  async _pollFallbackCpu() {
    if (!this.running || this._fallbackCpuBusy) return;
    this._fallbackCpuBusy = true;
    try {
      const [load, speed] = await Promise.all([
        si.currentLoad(),
        si.cpuCurrentSpeed(),
      ]);
      if (!this._fallbackStarted) return;
      this.state.cpu.usage = clamp(load.currentLoad, 0, 100);
      this.state.cpu.system = clamp(load.currentLoadSystem, 0, 100);
      if (speed.avg > 0) {
        this.state.cpu.frequencyMHz = Math.round(speed.avg * 1000);
      }
      this.state.status.lastUpdate = Date.now();
      this._publish();
    } catch (error) {
      this.emit('warning', error);
    } finally {
      this._fallbackCpuBusy = false;
    }
  }

  async _pollFallbackNetwork() {
    if (!this.running || this._fallbackNetBusy) return;
    this._fallbackNetBusy = true;
    try {
      const stats = await si.networkStats();
      if (!this._fallbackStarted) return;
      let down = 0;
      let up = 0;
      for (const item of stats) {
        if (Number.isFinite(item.rx_sec)) down += item.rx_sec;
        if (Number.isFinite(item.tx_sec)) up += item.tx_sec;
      }
      this.state.net.down = Math.max(0, down);
      this.state.net.up = Math.max(0, up);
      this._publish();
    } catch (error) {
      this.emit('warning', error);
    } finally {
      this._fallbackNetBusy = false;
    }
  }

  async _pollMemory() {
    if (!this.running || this._memBusy) return;
    this._memBusy = true;
    try {
      const memory = await si.mem();
      this.state.mem.total = memory.total;
      this.state.mem.used = memory.used;
      this._publish();
    } catch (error) {
      this.emit('warning', error);
    } finally {
      this._memBusy = false;
    }
  }

  async _pollTemperature() {
    if (!this.running || this._tempBusy) return;
    this._tempBusy = true;
    try {
      const temperature = await si.cpuTemperature();
      const value = [temperature.main, temperature.max, temperature.socket?.[0]]
        .find((entry) => Number.isFinite(entry) && entry > 0);
      if (value !== undefined) {
        this.state.cpu.temperature = Math.round(value);
      }
      this._publish();
    } catch {
      // Temperature sensors are often unavailable on Windows without a driver.
    } finally {
      this._tempBusy = false;
    }
  }

  async _pollGpu() {
    if (!this.running || this._gpuBusy) return;
    this._gpuBusy = true;

    try {
      const { stdout } = await execFileAsync(
        NVIDIA_SMI,
        [`--query-gpu=${NVIDIA_QUERY}`, '--format=csv,noheader,nounits'],
        { timeout: 2500, windowsHide: true, maxBuffer: 1024 * 1024 },
      );

      const lines = String(stdout)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      if (!lines.length) throw new Error('nvidia-smi returned no GPU data');

      let best = null;
      let bestMemory = -1;
      for (const line of lines) {
        const parts = line.split(',').map((part) => part.trim());
        const memTotal = asNumber(parts[7]);
        if (memTotal !== null && memTotal > bestMemory) {
          best = parts;
          bestMemory = memTotal;
        }
      }
      best = best || lines[0].split(',').map((part) => part.trim());

      const gpu = this.state.gpu;
      gpu.name = best[0] || gpu.name;
      gpu.temperature = asNumber(best[1]);
      gpu.usage = asNumber(best[2]);
      gpu.frequencyMHz = asNumber(best[3]);
      gpu.powerW = asNumber(best[4]);
      gpu.powerLimitW = asNumber(best[5]);
      gpu.fanRpm = asNumber(best[6]);

      const memTotalMiB = asNumber(best[7]);
      const memUsedMiB = asNumber(best[8]);
      gpu.memTotal = memTotalMiB === null ? null : memTotalMiB * 1024 * 1024;
      gpu.memUsed = memUsedMiB === null ? null : memUsedMiB * 1024 * 1024;
      gpu.available = true;
      gpu.usage = gpu.usage === null ? null : clamp(gpu.usage, 0, 100);
      gpu.temperature = gpu.temperature === null ? null : clamp(gpu.temperature, 0, 120);
      this._gpuFailures = 0;
      this.state.status.gpuSource = 'nvidia-smi';
    } catch (error) {
      this._gpuFailures += 1;
      if (this._gpuFailures >= 2) {
        this.state.gpu.available = false;
        this.state.status.gpuSource = 'unavailable';
      }
      if (this._gpuFailures === 1) this.emit('warning', error);
    } finally {
      this._gpuBusy = false;
      this.state.status.lastUpdate = Date.now();
      this._publish();
    }
  }

  _publish() {
    if (this._publishTimer) return;
    this._publishTimer = setTimeout(() => {
      this._publishTimer = null;
      if (!this.running) return;
      this.emit('update', this.state);
    }, 60);
  }
}

module.exports = { MetricsMonitor };
