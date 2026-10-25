'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const POWERSHELL = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
);

const TASK_NAME = 'Pulse Game Helper';
const DEFAULT_TWEAKS = {
  preventSleep: true,
  highPerformance: true,
  clearClipboard: true,
  trimMemory: true,
  stickyKeys: true,
  cortana: true,
  backgroundApps: true,
  telemetry: true,
  errorReporting: true,
  windowsKey: false,
  gameDesktop: false,
};

const DEFAULT_CONFIG = {
  enabled: true,
  autoDetect: true,
  tweaks: { ...DEFAULT_TWEAKS },
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class GameMode {
  constructor(app) {
    this.app = app;
    this.dir = path.join(app.getPath('userData'), 'game');
    this.helperPath = path.join(this.dir, 'game-helper.ps1');
    this.setupPath = path.join(this.dir, 'game-setup.ps1');
    this.configPath = path.join(this.dir, 'config.json');
    this.statusPath = path.join(this.dir, 'status.json');
    this.commandPath = path.join(this.dir, 'command.json');
    this.resultPath = path.join(this.dir, 'setup-result.json');
    this.gamesPath = path.join(this.dir, 'games.json');
  }

  sourcePaths() {
    const root = this.app.isPackaged
      ? process.resourcesPath
      : path.join(__dirname, '..', 'vendor');
    return {
      helper: path.join(root, 'game-helper.ps1'),
      setup: path.join(root, 'game-setup.ps1'),
    };
  }

  ensureFiles() {
    fs.mkdirSync(this.dir, { recursive: true });
    const source = this.sourcePaths();
    if (fs.existsSync(source.helper)) {
      fs.copyFileSync(source.helper, this.helperPath);
    }
    if (fs.existsSync(source.setup)) {
      fs.copyFileSync(source.setup, this.setupPath);
    }
    if (!fs.existsSync(this.configPath)) {
      this.writeJson(this.configPath, DEFAULT_CONFIG);
    }
  }

  writeJson(filePath, value) {
    const temp = `${filePath}.tmp`;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(temp, filePath);
  }

  readJson(filePath) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
    } catch {
      return null;
    }
  }

  getConfig() {
    const saved = this.readJson(this.configPath) || {};
    const tweaks = { ...DEFAULT_TWEAKS, ...(saved.tweaks || {}) };
    return {
      enabled: saved.enabled !== false,
      autoDetect: saved.autoDetect !== false,
      tweaks,
    };
  }

  saveConfig(patch) {
    const current = this.getConfig();
    const next = {
      enabled: typeof patch?.enabled === 'boolean' ? patch.enabled : current.enabled,
      autoDetect:
        typeof patch?.autoDetect === 'boolean' ? patch.autoDetect : current.autoDetect,
      tweaks: { ...current.tweaks },
    };

    if (patch?.tweaks && typeof patch.tweaks === 'object') {
      for (const key of Object.keys(DEFAULT_TWEAKS)) {
        if (typeof patch.tweaks[key] === 'boolean') {
          next.tweaks[key] = patch.tweaks[key];
        }
      }
    }

    this.writeJson(this.configPath, next);
    return next;
  }

  getStatus() {
    const status = this.readJson(this.statusPath);
    if (!status) {
      return {
        active: false,
        game: null,
        applied: [],
        errors: [],
        admin: false,
        ts: 0,
        stale: true,
      };
    }
    return {
      ...status,
      stale: !status.ts || Date.now() - Number(status.ts) > 12000,
    };
  }

  getGames() {
    const stored = this.readJson(this.gamesPath);
    const games = Array.isArray(stored) ? stored : stored && typeof stored === 'object' ? [stored] : [];
    return games
      .filter((game) => game && typeof game === 'object' && (game.name || game.path))
      .map((game) => ({
        id: String(game.id || game.path || game.name || '').toLowerCase(),
        name: String(game.name || '未命名游戏'),
        path: String(game.path || ''),
        processName: String(game.processName || ''),
        source:
          game.source === 'manual'
            ? 'manual'
            : game.source === 'steam'
              ? 'steam'
              : 'auto',
        addedAt: Number(game.addedAt) || 0,
        lastPlayed: Number(game.lastPlayed) || 0,
        launches: Number(game.launches) || 0,
      }))
      .sort((a, b) => {
        if (b.lastPlayed !== a.lastPlayed) return b.lastPlayed - a.lastPlayed;
        return a.name.localeCompare(b.name, 'zh-CN');
      });
  }

  writeGames(games) {
    this.writeJson(this.gamesPath, games);
  }

  restoreFromConfig(gameConfig, games) {
    if (gameConfig && !fs.existsSync(this.configPath)) {
      this.writeJson(this.configPath, gameConfig);
    }
    if (Array.isArray(games) && games.length > 0) {
      const current = this.getGames();
      const byId = new Map(current.map((game) => [game.id, game]));
      let changed = false;
      for (const game of games) {
        const id = String(game?.id || game?.path || game?.name || '').toLowerCase();
        if (!id || byId.has(id)) continue;
        byId.set(id, game);
        changed = true;
      }
      if (changed) this.writeGames([...byId.values()]);
    }
  }

  addGames(inputs, source = 'manual') {
    const games = this.getGames();
    let added = 0;
    for (const input of Array.isArray(inputs) ? inputs : []) {
      const gamePath = String(input?.path || '').trim();
      if (!gamePath) continue;
      const parsed = path.parse(gamePath);
      const id = gamePath.toLowerCase();
      const existing = games.find((game) => game.id === id);
      if (existing) {
        if (!existing.name) existing.name = parsed.name;
        existing.path = gamePath;
        existing.processName = existing.processName || parsed.name;
        if (source === 'manual' || existing.source === 'auto') {
          existing.source = source;
        }
        continue;
      }
      games.push({
        id,
        name: String(input?.name || parsed.name || '未命名游戏'),
        path: gamePath,
        processName: String(input?.processName || parsed.name),
        source,
        addedAt: Date.now(),
        lastPlayed: 0,
        launches: 0,
      });
      added += 1;
    }
    this.writeGames(games);
    return { added, state: this.getState() };
  }

  addGame(input) {
    this.addGames([input], 'manual');
    return this.getState();
  }

  async findSteamLibraries() {
    const roots = new Set();
    try {
      const { stdout } = await execFileAsync(
        'reg.exe',
        ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'],
        { timeout: 5000, windowsHide: true, encoding: 'utf8' },
      );
      const match = String(stdout).match(/SteamPath\s+REG_SZ\s+(.+)/i);
      if (match) roots.add(match[1].trim().replace(/\//g, '\\'));
    } catch {
      // Registry lookup is optional; drive probing below is the fallback.
    }

    for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
      for (const sub of [
        'SteamLibrary',
        'Steam',
        'Program Files (x86)\\Steam',
        'Program Files\\Steam',
      ]) {
        const root = path.join(`${letter}:\\`, sub);
        if (fs.existsSync(path.join(root, 'steamapps'))) roots.add(root);
      }
    }

    const libraries = new Set();
    for (const root of roots) {
      if (fs.existsSync(path.join(root, 'steamapps'))) libraries.add(path.normalize(root));
      const vdf = path.join(root, 'steamapps', 'libraryfolders.vdf');
      try {
        const text = await fs.promises.readFile(vdf, 'utf8');
        for (const match of text.matchAll(/"path"\s+"([^"]+)"/gi)) {
          const library = path.normalize(match[1].replace(/\\\\/g, '\\'));
          if (fs.existsSync(path.join(library, 'steamapps'))) libraries.add(library);
        }
      } catch {
        // No libraryfolders.vdf at this root.
      }
    }
    return [...libraries];
  }

  async findSteamExecutable(gameDir, gameName) {
    const blockedDir =
      /^(redist|_commonredist|directx|vcredist|support|tools|easyanticheat|battleye|installers?|uninstall|crashreport|logs?)$/i;
    const blockedExe =
      /(unins|uninstall|setup|vc_redist|dxsetup|directx|crash|report|helper|benchmark|server|launcher|updater|patcher|easyanticheat|battleye|steam|epic|galaxy|socialclub|uplay|origin|vconsole|console|tool|editor|workshop|vrserver)/i;
    const candidates = [];
    const normalized = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

    const walk = async (dir, depth) => {
      if (depth > 5) return;
      let entries;
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (blockedDir.test(entry.name)) continue;
          await walk(full, depth + 1);
        } else if (/\.exe$/i.test(entry.name) && !blockedExe.test(entry.name)) {
          try {
            const stat = await fs.promises.stat(full);
            if (stat.size >= 256 * 1024) {
              candidates.push({ path: full, size: stat.size });
            }
          } catch {
            // Ignore unreadable files.
          }
        }
      }
    };
    await walk(gameDir, 0);
    if (!candidates.length) return null;

    const target = normalized(gameName);
    let best = null;
    let bestScore = -Infinity;
    for (const candidate of candidates) {
      const base = path.parse(candidate.path).name;
      let score = candidate.size / 1024;
      if (target && (normalized(base).includes(target) || target.includes(normalized(base)))) {
        score += 1_000_000;
      }
      if (/game|shipping|client/i.test(base)) score += 100_000;
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    return best;
  }

  async importSteam() {
    const libraries = await this.findSteamLibraries();
    if (!libraries.length) {
      return { ok: false, error: '没有找到 Steam 游戏库。', added: 0, total: 0 };
    }

    const entries = [];
    const seen = new Set();
    for (const library of libraries) {
      const steamapps = path.join(library, 'steamapps');
      let files;
      try {
        files = await fs.promises.readdir(steamapps);
      } catch {
        continue;
      }
      const manifests = files.filter((file) => /^appmanifest_.*\.acf$/i.test(file));
      for (const manifest of manifests) {
        try {
          const text = await fs.promises.readFile(path.join(steamapps, manifest), 'utf8');
          const nameMatch = text.match(/"name"\s+"([^"]*)"/i);
          const dirMatch = text.match(/"installdir"\s+"([^"]*)"/i);
          if (!nameMatch || !dirMatch) continue;
          const name = nameMatch[1].replace(/[™®]/g, '').trim();
          const installdir = dirMatch[1].trim();
          const gameDir = path.join(steamapps, 'common', installdir);
          if (!fs.existsSync(gameDir)) continue;
          const executable = await this.findSteamExecutable(gameDir, name);
          if (!executable) continue;
          const id = executable.path.toLowerCase();
          if (seen.has(id)) continue;
          seen.add(id);
          entries.push({
            path: executable.path,
            name,
            processName: path.parse(executable.path).name,
          });
        } catch {
          // Skip a malformed manifest.
        }
      }
    }

    const result = this.addGames(entries, 'steam');
    return {
      ok: true,
      added: result.added,
      total: entries.length,
      libraries: libraries.length,
      state: result.state,
    };
  }

  removeGame(id) {
    const normalized = String(id || '').toLowerCase();
    this.writeGames(this.getGames().filter((game) => game.id !== normalized));
    return this.getState();
  }

  getState() {
    const status = this.getStatus();
    const config = this.getConfig();
    const installed = fs.existsSync(this.statusPath);
    return {
      taskName: TASK_NAME,
      installed,
      running: installed && !status.stale,
      config,
      status,
      games: this.getGames(),
      tweaks: Object.entries(DEFAULT_TWEAKS).map(([id, enabled]) => ({
        id,
        enabled: Boolean(config.tweaks[id]),
        supported: true,
      })),
    };
  }

  async install() {
    this.ensureFiles();
    if (!fs.existsSync(this.setupPath)) {
      return { ok: false, error: 'Game helper setup script is missing.' };
    }
    if (fs.existsSync(this.resultPath)) {
      try {
        fs.unlinkSync(this.resultPath);
      } catch {
        // A stale result will be overwritten.
      }
    }

    const escaped = this.setupPath.replace(/'/g, "''");
    const command =
      `Start-Process -FilePath 'powershell.exe' -Verb RunAs ` +
      `-ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','${escaped}') -Wait`;
    try {
      await execFileAsync(
        POWERSHELL,
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
        { timeout: 180000, windowsHide: true, encoding: 'utf8' },
      );
    } catch (error) {
      return { ok: false, error: error.message };
    }

    const result = this.readJson(this.resultPath);
    if (result && result.ok === false) {
      return { ok: false, error: result.error || 'Could not install game helper.' };
    }

    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      if (!this.getStatus().stale) break;
      await sleep(400);
    }
    const status = this.getStatus();
    if (status.stale) {
      return {
        ok: false,
        error: '游戏加速服务已创建，但还没有收到运行状态，请稍后重试或重启服务。',
        state: this.getState(),
      };
    }
    return { ok: true, state: this.getState() };
  }

  sendCommand(action) {
    if (action !== 'start' && action !== 'stop') {
      return { ok: false, error: 'Unknown game mode command.' };
    }
    this.writeJson(this.commandPath, {
      action,
      ts: Date.now(),
    });
    return { ok: true, state: this.getState() };
  }
}

module.exports = { GameMode, DEFAULT_CONFIG, DEFAULT_TWEAKS, TASK_NAME };
