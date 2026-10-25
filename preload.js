'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pulse', {
  onMetrics(callback) {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('pulse:metrics', listener);
    return () => ipcRenderer.removeListener('pulse:metrics', listener);
  },
  onConfig(callback) {
    const listener = (_event, config) => callback(config);
    ipcRenderer.on('pulse:config', listener);
    return () => ipcRenderer.removeListener('pulse:config', listener);
  },
  onTheme(callback) {
    const listener = (_event, theme) => callback(theme);
    ipcRenderer.on('pulse:theme', listener);
    return () => ipcRenderer.removeListener('pulse:theme', listener);
  },
  getState: () => ipcRenderer.invoke('pulse:get-state'),
  getConfig: () => ipcRenderer.invoke('pulse:get-config'),
  getTheme: () => ipcRenderer.invoke('pulse:get-theme'),
  setConfig: (patch) => ipcRenderer.invoke('pulse:set-config', patch),
  openSettings: () => ipcRenderer.send('pulse:open-settings'),
  getSettingsState: () => ipcRenderer.invoke('settings:get-state'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  enableSensors: () => ipcRenderer.invoke('settings:enable-sensors'),
  refreshSensors: () => ipcRenderer.invoke('settings:refresh-sensors'),
  getUpdateState: () => ipcRenderer.invoke('update:get-state'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdate(callback) {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('pulse:update', listener);
    return () => ipcRenderer.removeListener('pulse:update', listener);
  },
  getGameState: () => ipcRenderer.invoke('game:get-state'),
  saveGame: (patch) => ipcRenderer.invoke('game:save', patch),
  installGameMode: () => ipcRenderer.invoke('game:install'),
  sendGameCommand: (action) => ipcRenderer.invoke('game:command', action),
  addGame: () => ipcRenderer.invoke('game:add'),
  removeGame: (id) => ipcRenderer.invoke('game:remove', id),
  getGameIcon: (filePath) => ipcRenderer.invoke('game:icon', filePath),
  importSteam: () => ipcRenderer.invoke('game:import-steam'),
  closeSettings: () => ipcRenderer.send('settings:close'),
  showMenu: () => ipcRenderer.send('pulse:show-menu'),
  hide: () => ipcRenderer.send('pulse:hide'),
  quit: () => ipcRenderer.send('pulse:quit'),
});
