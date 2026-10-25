'use strict';

const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');

const COUNTERS = [
  '\\Processor Information(_Total)\\% Processor Time',
  '\\Processor Information(_Total)\\% Processor Performance',
  '\\Processor Information(_Total)\\% Privileged Time',
  '\\Network Interface(*)\\Bytes Received/sec',
  '\\Network Interface(*)\\Bytes Sent/sec',
];

/** Minimal CSV row parser (handles the quoted PDH header and values). */
function parseCsv(line) {
  const cells = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (ch === ',' && !quoted) {
      cells.push(cell);
      cell = '';
    } else {
      cell += ch;
    }
  }
  cells.push(cell);
  return cells;
}

function safeNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number.parseFloat(String(value).replace(/,/g, ''));
  return Number.isFinite(number) ? number : null;
}

function isVirtualInterface(header) {
  return /loopback|isatap|teredo|pseudo[- ]?interface/i.test(header);
}

/**
 * Samples CPU load, CPU frequency and network throughput from one persistent
 * `typeperf` process. This is much lighter than spawning PowerShell every tick
 * and gives true per-second network rates.
 */
class TypeperfSampler extends EventEmitter {
  constructor({ intervalMs = 1000 } = {}) {
    super();
    this.intervalMs = intervalMs;
    this.child = null;
    this.stopped = true;
    this.header = null;
    this.restartTimer = null;
    this.startedAt = 0;
    this.lastSampleAt = 0;
    this.hasEverSampled = false;
    this.lastError = null;
  }

  setIntervalMs(intervalMs) {
    if (this.intervalMs === intervalMs) return;
    this.intervalMs = intervalMs;
    if (!this.stopped) {
      this.stop();
      this.start();
    }
  }

  start() {
    this.stopped = false;
    this._spawn();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (this.child) {
      this.child.removeAllListeners('exit');
      this.child.kill();
      this.child = null;
    }
    this.header = null;
  }

  _spawn() {
    if (this.stopped) return;

    const intervalSec = Math.max(1, Math.round(this.intervalMs / 1000));
    const args = [...COUNTERS, '-si', String(intervalSec)];
    this.header = null;
    this.startedAt = Date.now();

    let child;
    try {
      child = spawn('typeperf.exe', args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch (error) {
      this._scheduleRestart(error);
      return;
    }

    this.child = child;
    let pending = '';

    child.stdout.setEncoding('latin1');
    child.stdout.on('data', (chunk) => {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) this._handleLine(line.trim());
      }
    });

    child.once('error', (error) => {
      this._scheduleRestart(error);
    });

    child.once('exit', (code) => {
      if (this.child === child) this.child = null;
      if (this.stopped) return;
      this._scheduleRestart(new Error(`typeperf exited with code ${code}`));
    });
  }

  _scheduleRestart(error) {
    this.lastError = error;
    this.emit('warning', error);
    if (this.stopped || this.restartTimer) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this._spawn();
    }, 3000);
  }

  _handleLine(line) {
    if (!this.header) {
      if (!line.toUpperCase().includes('PDH-CSV')) return;
      this.header = parseCsv(line);
      return;
    }

    const cells = parseCsv(line);
    if (cells.length < 2) return;

    let cpu = null;
    let performance = null;
    let system = null;
    let rx = 0;
    let tx = 0;

    for (let i = 1; i < this.header.length; i += 1) {
      const header = this.header[i];
      const value = safeNumber(cells[i]);
      if (value === null) continue;

      if (header.includes('% Processor Performance')) {
        performance = value;
      } else if (header.includes('% Processor Time')) {
        cpu = value;
      } else if (header.includes('% Privileged Time')) {
        system = value;
      } else if (header.includes('Bytes Received/sec')) {
        if (!isVirtualInterface(header)) rx += Math.max(0, value);
      } else if (header.includes('Bytes Sent/sec')) {
        if (!isVirtualInterface(header)) tx += Math.max(0, value);
      }
    }

    if (cpu === null) return;

    this.lastSampleAt = Date.now();
    this.hasEverSampled = true;
    this.lastError = null;
    this.emit('sample', {
      ts: this.lastSampleAt,
      cpu: Math.min(100, Math.max(0, cpu)),
      system: system === null ? null : Math.min(100, Math.max(0, system)),
      performance,
      rx,
      tx,
    });
  }
}

module.exports = { TypeperfSampler, parseCsv };
