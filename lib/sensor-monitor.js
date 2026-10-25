'use strict';

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const EMPTY_CONFIG = {
  cpu: { fan: '', temperature: '', frequency: '', power: '' },
  gpu: { fan: '', temperature: '', frequency: '', power: '' },
};

const isGpu = (sensor) => /^Gpu/i.test(sensor.hardwareType || '');
const isCpu = (sensor) => sensor.hardwareType === 'Cpu';

function cloneConfig(config) {
  return {
    cpu: { ...EMPTY_CONFIG.cpu, ...(config?.cpu || {}) },
    gpu: { ...EMPTY_CONFIG.gpu, ...(config?.gpu || {}) },
  };
}

function valueOf(sensor) {
  if (!sensor || typeof sensor.value !== 'number' || !Number.isFinite(sensor.value)) return null;
  return sensor.value;
}

function pickById(sensors, id) {
  if (!id) return null;
  return sensors.find((sensor) => sensor.id === id) || null;
}

function autoCpuFan(sensors) {
  const fans = sensors.filter((sensor) => sensor.type === 'Fan' && !isGpu(sensor));
  return (
    fans.find((sensor) => sensor.id === '/lpc/it8665e/0/fan/0') ||
    fans.find((sensor) => sensor.id.includes('/fan/0')) ||
    fans[0] ||
    null
  );
}

function autoCpuTemperature(sensors) {
  const temps = sensors.filter((sensor) => sensor.type === 'Temperature' && isCpu(sensor));
  return (
    temps.find((sensor) => /Tctl\/Tdie/i.test(sensor.name)) ||
    temps.find((sensor) => /Tdie|Tctl/i.test(sensor.name)) ||
    temps[0] ||
    null
  );
}

function autoCpuFrequency(sensors) {
  const clocks = sensors.filter((sensor) => sensor.type === 'Clock' && isCpu(sensor));
  return (
    clocks.find((sensor) => sensor.name === 'Cores (Average)') ||
    clocks.find((sensor) => /Average/i.test(sensor.name)) ||
    clocks.find((sensor) => sensor.id === '/amdcpu/0/clock/1') ||
    clocks[0] ||
    null
  );
}

function autoCpuPower(sensors) {
  const powers = sensors.filter((sensor) => sensor.type === 'Power' && isCpu(sensor));
  return powers.find((sensor) => sensor.name === 'Package') || powers[0] || null;
}

function autoGpuFan(sensors) {
  const fans = sensors.filter((sensor) => sensor.type === 'Fan' && isGpu(sensor));
  return fans.find((sensor) => /Fan 1/i.test(sensor.name)) || fans[0] || null;
}

function autoGpuTemperature(sensors) {
  const temps = sensors.filter((sensor) => sensor.type === 'Temperature' && isGpu(sensor));
  return temps.find((sensor) => sensor.name === 'GPU Core') || temps[0] || null;
}

function autoGpuFrequency(sensors) {
  const clocks = sensors.filter((sensor) => sensor.type === 'Clock' && isGpu(sensor));
  return clocks.find((sensor) => sensor.name === 'GPU Core') || clocks[0] || null;
}

function autoGpuPower(sensors) {
  const powers = sensors.filter((sensor) => sensor.type === 'Power' && isGpu(sensor));
  return powers.find((sensor) => sensor.name === 'GPU Package') || powers[0] || null;
}

const AUTO = {
  cpu: {
    fan: autoCpuFan,
    temperature: autoCpuTemperature,
    frequency: autoCpuFrequency,
    power: autoCpuPower,
  },
  gpu: {
    fan: autoGpuFan,
    temperature: autoGpuTemperature,
    frequency: autoGpuFrequency,
    power: autoGpuPower,
  },
};

class SensorMonitor extends EventEmitter {
  constructor({ filePath, config } = {}) {
    super();
    this.filePath = filePath;
    this.config = cloneConfig(config);
    this.timer = null;
    this.running = false;
    this.state = {
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
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.refresh();
    this.timer = setInterval(() => this.refresh(), 1000);
  }

  stop() {
    this.running = false;
    clearInterval(this.timer);
    this.timer = null;
  }

  setConfig(config) {
    this.config = cloneConfig(config);
    this._resolve();
    this.emit('update', this.state);
  }

  refresh() {
    if (!this.running) return;

    if (!this.filePath) {
      this._setUnavailable('disabled', 'Sensor helper path not configured');
      return;
    }

    let stat;
    try {
      stat = fs.statSync(this.filePath);
    } catch {
      this._setUnavailable('disabled', '硬件传感器尚未启用');
      return;
    }

    try {
      const raw = fs.readFileSync(this.filePath, 'utf8').replace(/^\uFEFF/, '');
      const payload = JSON.parse(raw);
      if (!payload || !Array.isArray(payload.sensors)) {
        throw new Error('Invalid sensor data');
      }

      const age = Date.now() - Number(payload.ts || 0);
      const stale = age > 5000 || Date.now() - stat.mtimeMs > 5000;
      this.state.sensors = payload.sensors;
      this.state.updatedAt = Number(payload.ts || stat.mtimeMs);
      this.state.error = payload.error || null;
      this._resolve();
      this.state.status = stale ? 'stale' : 'ok';
      this.emit('update', this.state);
    } catch (error) {
      this.state.status = 'error';
      this.state.error = error.message;
      this.emit('update', this.state);
    }
  }

  getState() {
    return this.state;
  }

  _setUnavailable(status, error) {
    const changed =
      this.state.status !== status ||
      this.state.sensors.length !== 0 ||
      this.state.error !== error;
    this.state = {
      ...this.state,
      status,
      sensors: [],
      selected: { cpu: {}, gpu: {} },
      values: {
        cpu: { fanRpm: null, temperature: null, frequencyMHz: null, powerW: null },
        gpu: { fanRpm: null, temperature: null, frequencyMHz: null, powerW: null },
      },
      error,
    };
    if (changed) this.emit('update', this.state);
  }

  _resolve() {
    const sensors = this.state.sensors;
    const selected = { cpu: {}, gpu: {} };
    const values = {
      cpu: { fanRpm: null, temperature: null, frequencyMHz: null, powerW: null },
      gpu: { fanRpm: null, temperature: null, frequencyMHz: null, powerW: null },
    };

    for (const group of ['cpu', 'gpu']) {
      for (const metric of ['fan', 'temperature', 'frequency', 'power']) {
        const configuredId = this.config[group]?.[metric] || '';
        const configured = pickById(sensors, configuredId);
        const sensor = configured || AUTO[group][metric](sensors);
        selected[group][metric] = sensor
          ? {
              id: sensor.id,
              name: sensor.name,
              hardware: sensor.hardware,
              hardwareType: sensor.hardwareType,
              type: sensor.type,
              value: sensor.value,
              configured: Boolean(configured),
            }
          : null;

        const value = valueOf(sensor);
        if (group === 'cpu') {
          if (metric === 'fan') values.cpu.fanRpm = value;
          else if (metric === 'temperature') values.cpu.temperature = value;
          else if (metric === 'frequency') values.cpu.frequencyMHz = value;
          else values.cpu.powerW = value;
        } else if (metric === 'fan') values.gpu.fanRpm = value;
        else if (metric === 'temperature') values.gpu.temperature = value;
        else if (metric === 'frequency') values.gpu.frequencyMHz = value;
        else values.gpu.powerW = value;
      }
    }

    this.state.selected = selected;
    this.state.values = values;
  }
}

module.exports = { SensorMonitor, EMPTY_SENSOR_CONFIG: EMPTY_CONFIG };
