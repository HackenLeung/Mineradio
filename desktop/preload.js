const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopWindow', {
  isDesktop: true,
  minimize: () => ipcRenderer.invoke('desktop-window-minimize'),
  toggleMaximize: () => ipcRenderer.invoke('desktop-window-toggle-maximize'),
  toggleFullscreen: () => ipcRenderer.invoke('desktop-window-toggle-fullscreen'),
  exitFullscreenWindowed: () => ipcRenderer.invoke('desktop-window-exit-fullscreen-windowed'),
  getState: () => ipcRenderer.invoke('desktop-window-get-state'),
  close: () => ipcRenderer.invoke('desktop-window-close'),
  openNeteaseMusicLogin: () => ipcRenderer.invoke('netease-music-open-login'),
  clearNeteaseMusicLogin: () => ipcRenderer.invoke('netease-music-clear-login'),
  openKugouMusicLogin: () => ipcRenderer.invoke('kugou-music-open-login'),
  clearKugouMusicLogin: () => ipcRenderer.invoke('kugou-music-clear-login'),
  openUpdateInstaller: (filePath) => ipcRenderer.invoke('mineradio-open-update-installer', filePath),
  restartApp: () => ipcRenderer.invoke('mineradio-restart-app'),
  configureGlobalHotkeys: (bindings) => ipcRenderer.invoke('mineradio-hotkeys-configure-global', bindings || []),
  getDesktopBehavior: () => ipcRenderer.invoke('mineradio-desktop-behavior-get'),
  setDesktopBehavior: (payload) => ipcRenderer.invoke('mineradio-desktop-behavior-set', payload || {}),
  updateTrayPlayback: (payload) => ipcRenderer.invoke('mineradio-tray-playback-update', payload || {}),
  setCubeRemoteEnabled: (enabled, payload) => ipcRenderer.invoke('mineradio-cube-remote-set-enabled', !!enabled, payload || {}),
  updateCubeRemote: (payload) => ipcRenderer.invoke('mineradio-cube-remote-update', payload || {}),
  onCubeRemoteCommand: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload || {});
    ipcRenderer.on('mineradio-cube-remote-command', listener);
    return () => ipcRenderer.removeListener('mineradio-cube-remote-command', listener);
  },
  onCubeRemoteEnabledState: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload || {});
    ipcRenderer.on('mineradio-cube-remote-enabled-state', listener);
    return () => ipcRenderer.removeListener('mineradio-cube-remote-enabled-state', listener);
  },
  onTrayCommand: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload || {});
    ipcRenderer.on('mineradio-tray-command', listener);
    return () => ipcRenderer.removeListener('mineradio-tray-command', listener);
  },
  exportJsonFile: (payload) => ipcRenderer.invoke('mineradio-export-json-file', payload || {}),
  importJsonFile: () => ipcRenderer.invoke('mineradio-import-json-file'),
  chooseLocalMusicFolder: () => ipcRenderer.invoke('mineradio-local-music-choose-folder'),
  scanLocalMusicFolder: (folderPath) => ipcRenderer.invoke('mineradio-local-music-scan-folder', folderPath),
  resolveLocalMusicFile: (filePath) => ipcRenderer.invoke('mineradio-local-music-resolve-file', filePath),
  openDownloadDir: () => ipcRenderer.invoke('mineradio-download-open-dir'),
  getDownloadDir: () => ipcRenderer.invoke('mineradio-download-get-dir'),
  setDownloadDir: () => ipcRenderer.invoke('mineradio-download-set-dir'),
  resetDownloadDir: () => ipcRenderer.invoke('mineradio-download-reset-dir'),
  onGlobalHotkey: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload || {});
    ipcRenderer.on('mineradio-global-hotkey', listener);
    return () => ipcRenderer.removeListener('mineradio-global-hotkey', listener);
  },
  setDesktopLyricsEnabled: (enabled, payload) => ipcRenderer.invoke('mineradio-desktop-lyrics-set-enabled', !!enabled, payload || {}),
  updateDesktopLyrics: (payload) => ipcRenderer.invoke('mineradio-desktop-lyrics-update', payload || {}),
  onDesktopLyricsLockState: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload || {});
    ipcRenderer.on('mineradio-desktop-lyrics-lock-state', listener);
    return () => ipcRenderer.removeListener('mineradio-desktop-lyrics-lock-state', listener);
  },
  onDesktopLyricsEnabledState: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload || {});
    ipcRenderer.on('mineradio-desktop-lyrics-enabled-state', listener);
    return () => ipcRenderer.removeListener('mineradio-desktop-lyrics-enabled-state', listener);
  },
  setWallpaperMode: (enabled, payload) => ipcRenderer.invoke('mineradio-wallpaper-set-enabled', !!enabled, payload || {}),
  updateWallpaperMode: (payload) => ipcRenderer.invoke('mineradio-wallpaper-update', payload || {}),
  onStateChange: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('desktop-window-state', listener);
    return () => ipcRenderer.removeListener('desktop-window-state', listener);
  },
});

window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.classList.add('desktop-shell-root');
  document.body.classList.add('desktop-shell');
});
