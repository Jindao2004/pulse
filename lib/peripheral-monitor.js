'use strict';

const { EventEmitter } = require('node:events');
const { Worker } = require('node:worker_threads');
const path = require('node:path');

/**
 * Bluetooth and 2.4G USB-receiver peripherals. Runs in a worker because
 * Bluetooth discovery shells out to Windows PnP and receiver discovery uses
 * node-hid.
 */
class PeripheralMonitor extends EventEmitter {
  constructor({ intervalMs = 30000 } = {}) {
    super();
    this.intervalMs = intervalMs;
    this.worker = null;
    this.running = false;
    this.restartTimer = null;
    this.watchdog = null;
    this.lastMessageAt = 0;
    this.state = {
      devices: [],
      status: 'starting',
      error: null,
      updatedAt: null,
    };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._spawn();
  }

  stop() {
    this.running = false;
    clearTimeout(this.restartTimer);
    clearInterval(this.watchdog);
    this.restartTimer = null;
    this.watchdog = null;
    if (this.worker) {
      this.worker.removeAllListeners();
      this.worker.terminate().catch(() => {});
      this.worker = null;
    }
  }

  refresh() {
    if (this.worker) this.worker.postMessage({ type: 'refresh' });
  }

  snapshot() {
    return this.state;
  }

  _spawn() {
    if (!this.running) return;

    this.worker = new Worker(path.join(__dirname, 'peripherals-worker.js'), {
      workerData: { intervalMs: this.intervalMs },
      name: 'pulse-peripherals',
    });

    this.worker.on('message', (message) => {
      if (!message || typeof message !== 'object') return;
      this.lastMessageAt = Date.now();

      if (message.type === 'devices') {
        this.state = {
          devices: Array.isArray(message.devices) ? message.devices : [],
          status: message.status || 'ok',
          error: message.error || null,
          updatedAt: message.ts || Date.now(),
        };
        this.emit('update', this.state);
      } else if (message.type === 'error') {
        this.state = {
          devices: this.state.devices,
          status: 'error',
          error: message.message || 'Peripheral scan error',
          updatedAt: message.ts || Date.now(),
        };
        this.emit('update', this.state);
      }
    });

    this.worker.on('error', (error) => {
      this.state = {
        devices: [],
        status: 'error',
        error: error.message,
        updatedAt: Date.now(),
      };
      this.emit('update', this.state);
      this._scheduleRestart();
    });

    this.worker.on('exit', (code) => {
      this.worker = null;
      if (!this.running) return;
      if (code !== 0) {
        this.state = {
          devices: [],
          status: 'error',
          error: `Peripheral worker stopped (${code})`,
          updatedAt: Date.now(),
        };
        this.emit('update', this.state);
      }
      this._scheduleRestart();
    });

    this.lastMessageAt = Date.now();
    clearInterval(this.watchdog);
    this.watchdog = setInterval(() => {
      if (!this.worker) return;
      if (Date.now() - this.lastMessageAt > this.intervalMs * 2 + 15000) {
        this.worker.terminate().catch(() => {});
        this.worker = null;
        this.state = {
          devices: [],
          status: 'error',
          error: 'Peripheral scan timed out',
          updatedAt: Date.now(),
        };
        this.emit('update', this.state);
        this._scheduleRestart();
      }
    }, 15000);
  }

  _scheduleRestart() {
    if (!this.running || this.restartTimer) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.running && !this.worker) this._spawn();
    }, 60000);
  }
}

module.exports = { PeripheralMonitor };
