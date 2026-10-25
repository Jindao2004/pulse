'use strict';

const { EventEmitter } = require('node:events');
const { Worker } = require('node:worker_threads');
const path = require('node:path');

/**
 * Runs Razer HID polling in a worker so feature-report reads (which are
 * synchronous in node-hid) never block the UI process.
 */
class RazerMonitor extends EventEmitter {
  constructor({ intervalMs = 60000, cachePath = null } = {}) {
    super();
    this.intervalMs = intervalMs;
    this.cachePath = cachePath;
    this.worker = null;
    this.running = false;
    this.restartTimer = null;
    this.lastMessageAt = 0;
    this.watchdog = null;
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

    this.worker = new Worker(path.join(__dirname, 'razer-worker.js'), {
      workerData: { intervalMs: this.intervalMs, cachePath: this.cachePath },
      name: 'pulse-razer-hid',
    });

    this.worker.on('message', (message) => {
      if (!message || typeof message !== 'object') return;
      this.lastMessageAt = Date.now();

      if (message.type === 'devices') {
        this.state = {
          devices: Array.isArray(message.devices) ? message.devices : [],
          status: 'ok',
          error: null,
          updatedAt: message.ts || Date.now(),
        };
        this.emit('update', this.state);
      } else if (message.type === 'error') {
        this.state = {
          devices: this.state.devices,
          status: 'error',
          error: message.message || 'Razer HID error',
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
          error: `Razer worker stopped (${code})`,
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
          error: 'Razer HID poll timed out',
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

module.exports = { RazerMonitor };
