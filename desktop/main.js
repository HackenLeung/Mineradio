const { app, BrowserWindow, ipcMain, shell, screen, session, globalShortcut, dialog, Tray, Menu } = require('electron');
const net = require('net');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

let mainWindow = null;
let localServer = null;
let mainServerPort = 0;
let desktopLyricsWindow = null;
let desktopLyricsState = {};
let desktopLyricsUserBounds = null;
let desktopLyricsProgrammaticMove = false;
let desktopLyricsPointerCapture = false;
let desktopLyricsMouseIgnored = null;
let desktopLyricsMousePoller = null;
let desktopLyricsMousePollerBuffer = '';
let desktopLyricsHotBounds = null;
let desktopLyricsLastMiddleAt = 0;
let wallpaperWindow = null;
let wallpaperState = {};
let cubeRemoteWindow = null;
let cubeRemoteFullscreenPoller = null;
let cubeRemoteFullscreenPollerBuffer = '';
let cubeRemoteFullscreenPollerRestartTimer = null;
let cubeRemoteFullscreenPollerRestartAttempts = 0;
let cubeRemoteExternalFullscreenActive = false;
let cubeRemoteHiddenByFullscreen = false;
let cubeRemoteDragCursor = null;
const CUBE_REMOTE_SKINS = {
  cube: { width: 136, height: 136 },
  bar: { width: 320, height: 84 },
  moon: { width: 248, height: 248 },
};
function clampCubeRemoteSkin(value) {
  const skin = String(value || 'cube');
  return CUBE_REMOTE_SKINS[skin] ? skin : 'cube';
}
let cubeRemoteState = {
  enabled: false,
  skin: 'cube',
  title: '未播放',
  artist: '',
  cover: '',
  playing: false,
  volume: 0.85,
  muted: false,
  lyricsEnabled: false,
  mainVisible: true,
};
let cubeRemoteUserBounds = null;
let htmlFullscreenActive = false;
let windowFullscreenActive = false;
let mainWindowStateTimer = null;
let mineradioTray = null;
let appQuitting = false;
let legacyUpdaterCleanupTimer = null;
let desktopBehaviorSettings = null;
let trayPlaybackState = { title: '未播放', artist: '', playing: false, volume: 1, cover: '', muted: false };
const registeredGlobalHotkeys = new Map();

const WINDOWED_ASPECT = 16 / 9;
const WINDOWED_SCALE = 3 / 4;
const WINDOWED_MARGIN = 32;
const MIN_WINDOWED_WIDTH = 960;
const MIN_WINDOWED_HEIGHT = 540;
const APP_NAME = 'Mineradio';
const APP_USER_MODEL_ID = 'com.mineradio.desktop';
const APP_ICON_ICO = path.join(__dirname, '..', 'build', 'icon.ico');
const DESKTOP_BEHAVIOR_FILE = 'desktop-behavior.json';
const DOWNLOAD_SETTINGS_FILE = 'download-settings.json';
const NETEASE_LOGIN_PARTITION = 'persist:mineradio-netease-login';
const NETEASE_LOGIN_URL = 'https://music.163.com/#/login';
const KUGOU_LOGIN_PARTITION = 'persist:mineradio-kugou-login';
const KUGOU_LOGIN_URL = 'https://www.kugou.com/';
const LOCAL_LIBRARY_AUDIO_EXTS = new Set(['.mp3', '.flac', '.wav', '.ogg', '.opus', '.m4a', '.mp4', '.aac', '.webm']);
const LOCAL_LIBRARY_COVER_EXTS = ['.jpg', '.jpeg', '.png', '.webp'];
const LOCAL_LIBRARY_LYRIC_EXTS = ['.lrc', '.txt'];
const LOCAL_LIBRARY_COVER_NAMES = ['cover', 'folder', 'front', 'album', 'artwork', '封面', '专辑封面'];
const LOCAL_LIBRARY_MIME = {
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.aac': 'audio/aac',
  '.webm': 'audio/webm',
};

function configureMineradioUserDataPath() {
  const configuredPath = String(process.env.MINERADIO_USER_DATA || '').trim();
  const userDataPath = configuredPath
    || (app.isPackaged ? path.join(path.dirname(process.execPath), 'user-data') : '');
  if (!userDataPath) return;

  const resolvedPath = path.resolve(userDataPath);
  app.setPath('userData', resolvedPath);
  app.setPath('sessionData', resolvedPath);
}

configureMineradioUserDataPath();

const CHROMIUM_PERFORMANCE_SWITCHES = [
  ['autoplay-policy', 'no-user-gesture-required'],
  ['ignore-gpu-blocklist'],
  ['enable-gpu-rasterization'],
  ['enable-oop-rasterization'],
  ['enable-zero-copy'],
  ['enable-accelerated-2d-canvas'],
  ['force_high_performance_gpu'],
  ['use-angle', 'd3d11'],
];
for (const [name, value] of CHROMIUM_PERFORMANCE_SWITCHES) {
  if (value == null) app.commandLine.appendSwitch(name);
  else app.commandLine.appendSwitch(name, value);
}
const gotSingleInstanceLock = app.requestSingleInstanceLock();

const NETEASE_LOGIN_COOKIE_PRIORITY = [
  'MUSIC_U',
  '__csrf',
  'NMTID',
  'MUSIC_A',
  '__remember_me',
  '_ntes_nuid',
  '_ntes_nnid',
  'WEVNSM',
  'WNMCID',
  'JSESSIONID-WYYY',
];
const KUGOU_LOGIN_COOKIE_PRIORITY = [
  'KuGoo',
  'kg_mid',
  'kg_dfid',
  'KugooID',
  'userid',
  'token',
  't',
];

function findOpenPort(startPort) {
  return new Promise((resolve, reject) => {
    function tryPort(port) {
      const tester = net.createServer();

      tester.once('error', (err) => {
        if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
          tryPort(port + 1);
          return;
        }
        reject(err);
      });

      tester.once('listening', () => {
        tester.close(() => resolve(port));
      });

      tester.listen(port, '127.0.0.1');
    }

    tryPort(startPort);
  });
}

function waitForServer(server) {
  if (!server || server.listening) return Promise.resolve();

  return new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
}

function sendWindowState(win) {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('desktop-window-state', getWindowState(win));
}

function sendGlobalHotkeyAction(action) {
  if (!mainWindow || mainWindow.isDestroyed() || !action) return;
  mainWindow.webContents.send('mineradio-global-hotkey', { action });
}

function unregisterMineradioGlobalHotkeys() {
  for (const accelerator of registeredGlobalHotkeys.keys()) {
    try { globalShortcut.unregister(accelerator); } catch (e) {}
  }
  registeredGlobalHotkeys.clear();
}

function configureMineradioGlobalHotkeys(bindings = []) {
  unregisterMineradioGlobalHotkeys();
  const results = [];
  const seen = new Set();
  for (const item of Array.isArray(bindings) ? bindings : []) {
    const action = item && String(item.action || '').trim();
    const accelerator = item && String(item.accelerator || '').trim();
    if (!action || !accelerator || seen.has(accelerator)) continue;
    seen.add(accelerator);
    let registered = false;
    try {
      registered = globalShortcut.register(accelerator, () => sendGlobalHotkeyAction(action));
    } catch (error) {
      registered = false;
    }
    if (registered) {
      registeredGlobalHotkeys.set(accelerator, action);
      results.push({ action, accelerator, ok: true });
    } else {
      results.push({
        action,
        accelerator,
        ok: false,
        conflict: {
          sourceName: '系统 / 其他软件',
          sourceIcon: 'warning',
          reason: '该组合键已被占用或被系统保留',
        },
      });
    }
  }
  return { ok: true, results };
}

function scheduleWindowStateSend(win, delay = 80) {
  if (!win || win.isDestroyed()) return;
  if (mainWindowStateTimer) clearTimeout(mainWindowStateTimer);
  mainWindowStateTimer = setTimeout(() => {
    mainWindowStateTimer = null;
    sendWindowState(win);
  }, delay);
}

function rectsOverlapOnY(a, b) {
  if (!a || !b) return false;
  const aTop = Number(a.y) || 0;
  const bTop = Number(b.y) || 0;
  const aBottom = aTop + (Number(a.height) || 0);
  const bBottom = bTop + (Number(b.height) || 0);
  return aBottom > bTop && bBottom > aTop;
}

function getDisplayState(win) {
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  const display = win && !win.isDestroyed()
    ? screen.getDisplayMatching(win.getBounds())
    : primary;
  const bounds = display && display.bounds ? display.bounds : primary.bounds;
  const displayId = display && display.id;
  const primaryId = primary && primary.id;
  const edgeTolerance = 2;
  const hasDisplayOnLeft = displays.some((candidate) => {
    if (!candidate || candidate.id === displayId || !candidate.bounds) return false;
    return rectsOverlapOnY(bounds, candidate.bounds)
      && Math.abs((candidate.bounds.x + candidate.bounds.width) - bounds.x) <= edgeTolerance;
  });
  const hasDisplayOnRight = displays.some((candidate) => {
    if (!candidate || candidate.id === displayId || !candidate.bounds) return false;
    return rectsOverlapOnY(bounds, candidate.bounds)
      && Math.abs((bounds.x + bounds.width) - candidate.bounds.x) <= edgeTolerance;
  });
  return {
    displayId,
    primaryDisplayId: primaryId,
    isPrimaryDisplay: !!(display && primary && display.id === primary.id),
    hasDisplayOnLeft,
    hasDisplayOnRight,
    displayBounds: bounds ? {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
    } : null,
  };
}

function getWindowState(win) {
  if (!win || win.isDestroyed()) return {
    isMaximized: false,
    isNativeFullScreen: false,
    isHtmlFullScreen: false,
    isWindowFullScreen: false,
    isFullScreen: false,
    isMinimized: false,
    isVisible: false,
    isFocused: false,
    isPrimaryDisplay: true,
    hasDisplayOnLeft: false,
    hasDisplayOnRight: false,
    displayBounds: null,
  };
  return {
    isMaximized: win.isMaximized(),
    isNativeFullScreen: win.isFullScreen(),
    isHtmlFullScreen: htmlFullscreenActive,
    isWindowFullScreen: windowFullscreenActive,
    isFullScreen: win.isFullScreen() || htmlFullscreenActive || windowFullscreenActive,
    isMinimized: win.isMinimized(),
    isVisible: win.isVisible(),
    isFocused: win.isFocused(),
    ...getDisplayState(win),
  };
}

function getSenderWindow(event) {
  return BrowserWindow.fromWebContents(event.sender);
}

function desktopBehaviorPath() {
  return path.join(app.getPath('userData'), DESKTOP_BEHAVIOR_FILE);
}

function normalizeDesktopLyricsBounds(bounds) {
  if (!bounds || typeof bounds !== 'object') return null;
  const next = {
    x: Number(bounds.x),
    y: Number(bounds.y),
    width: Number(bounds.width),
    height: Number(bounds.height),
  };
  if (![next.x, next.y, next.width, next.height].every(Number.isFinite)) return null;
  return {
    x: Math.round(next.x),
    y: Math.round(next.y),
    width: Math.round(Math.max(320, next.width)),
    height: Math.round(Math.max(180, next.height)),
  };
}

function desktopLyricsBoundsEqual(a, b) {
  if (!a || !b) return false;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

let desktopLyricsBoundsSaveTimer = null;
let desktopLyricsBoundsPending = null;

function flushDesktopLyricsBoundsSave() {
  if (desktopLyricsBoundsSaveTimer) {
    clearTimeout(desktopLyricsBoundsSaveTimer);
    desktopLyricsBoundsSaveTimer = null;
  }
  if (!desktopLyricsBoundsPending) return;
  const next = desktopLyricsBoundsPending;
  desktopLyricsBoundsPending = null;
  const current = readDesktopBehaviorSettings().desktopLyricsBounds;
  if (desktopLyricsBoundsEqual(current, next)) return;
  saveDesktopBehaviorSettings({ desktopLyricsBounds: next });
}

function rememberDesktopLyricsBoundsPersist(bounds, { immediate = false, clear = false } = {}) {
  if (clear) {
    desktopLyricsUserBounds = null;
    desktopLyricsBoundsPending = null;
    if (desktopLyricsBoundsSaveTimer) {
      clearTimeout(desktopLyricsBoundsSaveTimer);
      desktopLyricsBoundsSaveTimer = null;
    }
    if (readDesktopBehaviorSettings().desktopLyricsBounds) {
      saveDesktopBehaviorSettings({ desktopLyricsBounds: null });
    }
    return;
  }
  const next = normalizeDesktopLyricsBounds(bounds);
  if (!next) return;
  desktopLyricsUserBounds = next;
  desktopLyricsBoundsPending = next;
  if (immediate) {
    flushDesktopLyricsBoundsSave();
    return;
  }
  if (desktopLyricsBoundsSaveTimer) clearTimeout(desktopLyricsBoundsSaveTimer);
  desktopLyricsBoundsSaveTimer = setTimeout(() => {
    desktopLyricsBoundsSaveTimer = null;
    flushDesktopLyricsBoundsSave();
  }, 320);
}

function readDesktopBehaviorSettings() {
  if (desktopBehaviorSettings) return desktopBehaviorSettings;
  const defaults = {
    closeToTray: false,
    openAtLogin: false,
    immersiveAutoFullscreen: false,
    cubeRemote: false,
    cubeRemoteSkin: 'cube',
    cubeRemoteBounds: null,
    desktopLyrics: false,
    desktopLyricsBounds: null,
  };
  try {
    const raw = JSON.parse(fs.readFileSync(desktopBehaviorPath(), 'utf8')) || {};
    const cubeRemoteSkin = clampCubeRemoteSkin(raw.cubeRemoteSkin || 'cube');
    const bounds = raw.cubeRemoteBounds && typeof raw.cubeRemoteBounds === 'object'
      ? {
        x: Number(raw.cubeRemoteBounds.x),
        y: Number(raw.cubeRemoteBounds.y),
        width: Number(raw.cubeRemoteBounds.width),
        height: Number(raw.cubeRemoteBounds.height),
      }
      : null;
    const lyricsBounds = normalizeDesktopLyricsBounds(raw.desktopLyricsBounds);
    desktopBehaviorSettings = {
      closeToTray: raw.closeToTray === true,
      openAtLogin: raw.openAtLogin === true,
      immersiveAutoFullscreen: raw.immersiveAutoFullscreen === true,
      cubeRemote: raw.cubeRemote === true,
      cubeRemoteSkin,
      cubeRemoteBounds: bounds && [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
        ? normalizeCubeRemoteBounds(bounds, { skin: cubeRemoteSkin })
        : null,
      desktopLyrics: raw.desktopLyrics === true,
      desktopLyricsBounds: lyricsBounds,
    };
  } catch (_e) {
    desktopBehaviorSettings = defaults;
  }
  if (desktopBehaviorSettings.cubeRemoteBounds) {
    cubeRemoteUserBounds = { ...desktopBehaviorSettings.cubeRemoteBounds };
  }
  if (desktopBehaviorSettings.desktopLyricsBounds) {
    desktopLyricsUserBounds = { ...desktopBehaviorSettings.desktopLyricsBounds };
  }
  cubeRemoteState = {
    ...cubeRemoteState,
    skin: desktopBehaviorSettings.cubeRemoteSkin || 'cube',
  };
  return desktopBehaviorSettings;
}

function saveDesktopBehaviorSettings(next) {
  desktopBehaviorSettings = Object.assign({}, readDesktopBehaviorSettings(), next || {});
  try {
    fs.writeFileSync(desktopBehaviorPath(), JSON.stringify(desktopBehaviorSettings, null, 2), 'utf8');
  } catch (e) {
    console.warn('Desktop behavior save failed:', e.message);
  }
  try {
    app.setLoginItemSettings({ openAtLogin: !!desktopBehaviorSettings.openAtLogin, path: process.execPath });
  } catch (e) {
    console.warn('Login item update failed:', e.message);
  }
  ensureMineradioTray();
  updateMineradioTray();
  return Object.assign({}, desktopBehaviorSettings);
}

function destroyMineradioTray() {
  if (!mineradioTray) return;
  try { mineradioTray.destroy(); } catch (_e) {}
  mineradioTray = null;
}

let cubeRemoteBoundsSaveTimer = null;
let cubeRemoteBoundsPending = null;

function normalizeCubeRemoteBounds(bounds, state = cubeRemoteState) {
  if (!bounds) return null;
  const size = cubeRemoteSize(state);
  return {
    x: Math.round(Number(bounds.x) || 0),
    y: Math.round(Number(bounds.y) || 0),
    width: size.width,
    height: size.height,
  };
}

function cubeRemoteBoundsEqual(a, b) {
  if (!a || !b) return false;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function flushCubeRemoteBoundsSave() {
  if (cubeRemoteBoundsSaveTimer) {
    clearTimeout(cubeRemoteBoundsSaveTimer);
    cubeRemoteBoundsSaveTimer = null;
  }
  if (!cubeRemoteBoundsPending) return;
  const next = cubeRemoteBoundsPending;
  cubeRemoteBoundsPending = null;
  const current = readDesktopBehaviorSettings().cubeRemoteBounds;
  if (cubeRemoteBoundsEqual(current, next)) return;
  saveDesktopBehaviorSettings({ cubeRemoteBounds: next });
}

function rememberCubeRemoteBounds(bounds, { immediate = false } = {}) {
  const next = normalizeCubeRemoteBounds(bounds);
  if (!next) return;
  cubeRemoteUserBounds = next;
  cubeRemoteBoundsPending = next;
  if (immediate) {
    flushCubeRemoteBoundsSave();
    return;
  }
  if (cubeRemoteBoundsSaveTimer) clearTimeout(cubeRemoteBoundsSaveTimer);
  cubeRemoteBoundsSaveTimer = setTimeout(() => {
    cubeRemoteBoundsSaveTimer = null;
    flushCubeRemoteBoundsSave();
  }, 320);
}

function ensureMineradioTray() {
  if (mineradioTray || !fs.existsSync(APP_ICON_ICO)) return mineradioTray;
  mineradioTray = new Tray(APP_ICON_ICO);
  mineradioTray.setToolTip('Mineradio');
  mineradioTray.on('click', focusMainWindow);
  mineradioTray.on('double-click', focusMainWindow);
  updateMineradioTray();
  return mineradioTray;
}

function updateMineradioTray() {
  if (!mineradioTray) return;
  const songLabel = trayPlaybackState.title && trayPlaybackState.title !== '未播放'
    ? `${trayPlaybackState.title}${trayPlaybackState.artist ? ' - ' + trayPlaybackState.artist : ''}`
    : '未播放';
  const volume = Math.max(0, Math.min(1, Number(trayPlaybackState.volume) || 0));
  const sendTrayCommand = (command, payload = {}) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('mineradio-tray-command', { command, ...payload });
    }
  };
  mineradioTray.setToolTip(songLabel === '未播放' ? 'Mineradio' : `Mineradio\n${songLabel}`);
  mineradioTray.setContextMenu(Menu.buildFromTemplate([
    { label: songLabel.length > 52 ? songLabel.slice(0, 49) + '...' : songLabel, enabled: false },
    { type: 'separator' },
    { label: trayPlaybackState.playing ? '暂停' : '播放', click: () => sendTrayCommand('toggle-play') },
    { label: '上一曲', click: () => sendTrayCommand('previous') },
    { label: '下一曲', click: () => sendTrayCommand('next') },
    {
      label: `音量 ${Math.round(volume * 100)}%`,
      submenu: [
        { label: '音量 +10%', click: () => sendTrayCommand('volume', { value: 0.1 }) },
        { label: '音量 -10%', click: () => sendTrayCommand('volume', { value: -0.1 }) },
        { label: volume > 0.001 ? '静音' : '恢复音量', click: () => sendTrayCommand('mute') },
      ],
    },
    { type: 'separator' },
    { label: '打开 Mineradio', click: focusMainWindow },
    {
      label: '退出 Mineradio',
      click: () => {
        appQuitting = true;
        app.quit();
      },
    },
  ]));
}

function localMediaUrl(filePath) {
  if (!localServer || typeof localServer.registerLocalMediaPath !== 'function' || !mainServerPort) return '';
  const id = localServer.registerLocalMediaPath(filePath);
  return id ? `http://127.0.0.1:${mainServerPort}/api/local-media?id=${encodeURIComponent(id)}` : '';
}

let musicMetadataModulePromise = null;
let localAudioMetadataCache = null;
let localAudioMetadataCacheDirty = false;
let localAudioMetadataCacheSaveTimer = null;
let localAudioMetadataCacheSavePromise = Promise.resolve();
const LOCAL_AUDIO_METADATA_CACHE_LIMIT = 24000;

function localAudioMetadataCacheFile() {
  return path.join(app.getPath('userData'), 'local-audio-metadata-cache-v1.json');
}

function readLocalAudioMetadataCache() {
  if (localAudioMetadataCache) return localAudioMetadataCache;
  try {
    const parsed = JSON.parse(fs.readFileSync(localAudioMetadataCacheFile(), 'utf8'));
    localAudioMetadataCache = parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_error) {
    localAudioMetadataCache = {};
  }
  return localAudioMetadataCache;
}

function localAudioMetadataCacheKey(item) {
  if (!item || !item.filePath) return '';
  return [path.resolve(item.filePath).toLowerCase(), Number(item.size) || 0, Number(item.lastModified) || 0].join('|');
}

function applyLocalAudioMetadataRecord(item, record) {
  if (!item || !record) return item;
  if (record.title) item.embeddedTitle = record.title;
  if (record.artist) item.embeddedArtist = record.artist;
  if (Array.isArray(record.artists) && record.artists.length) item.embeddedArtists = record.artists.slice(0, 8);
  if (record.album) item.embeddedAlbum = record.album;
  if (Number(record.duration) > 0) item.embeddedDuration = Number(record.duration);
  if (Number(record.trackNo) > 0) item.embeddedTrackNo = Number(record.trackNo);
  item.embeddedMetadataParsed = record.parsed === true;
  return item;
}

function applyCachedLocalLibraryEntryMetadata(item) {
  const key = localAudioMetadataCacheKey(item);
  const record = key && readLocalAudioMetadataCache()[key];
  if (record) applyLocalAudioMetadataRecord(item, record);
  return !!record;
}

function saveLocalAudioMetadataCache() {
  if (!localAudioMetadataCacheDirty || !localAudioMetadataCache) return localAudioMetadataCacheSavePromise;
  localAudioMetadataCacheSavePromise = localAudioMetadataCacheSavePromise.catch(() => {}).then(async () => {
    if (!localAudioMetadataCacheDirty || !localAudioMetadataCache) return;
    const keys = Object.keys(localAudioMetadataCache);
    if (keys.length > LOCAL_AUDIO_METADATA_CACHE_LIMIT) {
      keys.sort((a, b) => Number(localAudioMetadataCache[b] && localAudioMetadataCache[b].cachedAt) - Number(localAudioMetadataCache[a] && localAudioMetadataCache[a].cachedAt));
      keys.slice(LOCAL_AUDIO_METADATA_CACHE_LIMIT).forEach((key) => { delete localAudioMetadataCache[key]; });
    }
    const payload = JSON.stringify(localAudioMetadataCache);
    localAudioMetadataCacheDirty = false;
    try {
      await fs.promises.writeFile(localAudioMetadataCacheFile(), payload, 'utf8');
    } catch (error) {
      localAudioMetadataCacheDirty = true;
      console.warn('Local audio metadata cache write failed:', error.message);
    }
  });
  return localAudioMetadataCacheSavePromise;
}

function scheduleLocalAudioMetadataCacheSave() {
  if (localAudioMetadataCacheSaveTimer) clearTimeout(localAudioMetadataCacheSaveTimer);
  localAudioMetadataCacheSaveTimer = setTimeout(() => {
    localAudioMetadataCacheSaveTimer = null;
    void saveLocalAudioMetadataCache();
  }, 1500);
}

function getMusicMetadataModule() {
  if (!musicMetadataModulePromise) {
    musicMetadataModulePromise = import('music-metadata').catch((error) => {
      console.warn('Local audio metadata parser unavailable:', error.message);
      return null;
    });
  }
  return musicMetadataModulePromise;
}

function cleanLocalAudioTag(value, maxLength = 320) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

async function enrichLocalLibraryEntryMetadata(item, force = false) {
  if (!item || !item.filePath) return item;
  if (!force && applyCachedLocalLibraryEntryMetadata(item)) return item;
  try {
    const parser = await getMusicMetadataModule();
    if (!parser || typeof parser.parseFile !== 'function') return item;
    const metadata = await parser.parseFile(item.filePath, { duration: true, skipCovers: true });
    const common = metadata && metadata.common || {};
    const format = metadata && metadata.format || {};
    const artists = (Array.isArray(common.artists) ? common.artists : [])
      .map((value) => cleanLocalAudioTag(value, 160))
      .filter(Boolean)
      .slice(0, 8);
    const artist = cleanLocalAudioTag(common.artist || common.albumartist || artists.join(' / '), 240);
    const title = cleanLocalAudioTag(common.title, 320);
    const album = cleanLocalAudioTag(common.album, 320);
    const duration = Number(format.duration) || 0;
    const trackNo = Number(common.track && common.track.no) || 0;
    const record = { parsed: true, title, artist, artists, album, duration, trackNo, cachedAt: Date.now() };
    applyLocalAudioMetadataRecord(item, record);
    const key = localAudioMetadataCacheKey(item);
    if (key) {
      readLocalAudioMetadataCache()[key] = record;
      localAudioMetadataCacheDirty = true;
    }
  } catch (error) {
    console.warn('Local audio metadata read failed:', path.basename(item.filePath), error.message);
  }
  return item;
}

async function enrichLocalLibraryEntriesMetadata(items, concurrency = 2, force = false) {
  if (!Array.isArray(items) || !items.length) return items;
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(Number(concurrency) || 4, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await enrichLocalLibraryEntryMetadata(items[index], force);
    }
  });
  await Promise.all(workers);
  await saveLocalAudioMetadataCache();
  return items;
}

function localLibraryEntryFromPath(filePath, rootPath) {
  const abs = path.resolve(String(filePath || ''));
  const ext = path.extname(abs).toLowerCase();
  if (!LOCAL_LIBRARY_AUDIO_EXTS.has(ext)) return null;
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch (_e) {
    return null;
  }
  if (!stat.isFile()) return null;
  const root = rootPath ? path.resolve(rootPath) : path.dirname(abs);
  const rel = path.relative(root, abs) || path.basename(abs);
  const dir = path.dirname(abs);
  const base = path.join(dir, path.basename(abs, ext));
  let sidecarCoverUrl = '';
  for (const coverExt of LOCAL_LIBRARY_COVER_EXTS) {
    const sameName = base + coverExt;
    if (fs.existsSync(sameName)) {
      sidecarCoverUrl = localMediaUrl(sameName);
      break;
    }
  }
  if (!sidecarCoverUrl) {
    for (const name of LOCAL_LIBRARY_COVER_NAMES) {
      for (const coverExt of LOCAL_LIBRARY_COVER_EXTS) {
        const candidate = path.join(dir, name + coverExt);
        if (fs.existsSync(candidate)) {
          sidecarCoverUrl = localMediaUrl(candidate);
          break;
        }
      }
      if (sidecarCoverUrl) break;
    }
  }
  let sidecarLyricText = '';
  let sidecarLyricPath = '';
  for (const lyricExt of LOCAL_LIBRARY_LYRIC_EXTS) {
    const candidate = base + lyricExt;
    try {
      const lyricStat = fs.statSync(candidate);
      if (lyricStat.isFile() && lyricStat.size > 0 && lyricStat.size <= 512 * 1024) {
        sidecarLyricText = fs.readFileSync(candidate, 'utf8');
        sidecarLyricPath = candidate;
        break;
      }
    } catch (_e) {}
  }
  return {
    fullPath: abs,
    filePath: abs,
    url: localMediaUrl(abs),
    name: path.basename(abs),
    relativePath: path.join(path.basename(root), rel).replace(/\\/g, '/'),
    webkitRelativePath: path.join(path.basename(root), rel).replace(/\\/g, '/'),
    size: stat.size,
    lastModified: Math.round(stat.mtimeMs),
    type: LOCAL_LIBRARY_MIME[ext] || '',
    sidecarCoverUrl,
    sidecarLyricText,
    sidecarLyricPath,
  };
}

async function scanLocalMusicFolder(folderPath) {
  const root = path.resolve(String(folderPath || ''));
  const rootStat = await fs.promises.stat(root);
  if (!rootStat.isDirectory()) throw new Error('LOCAL_LIBRARY_NOT_DIRECTORY');
  const files = [];
  const stack = [''];
  let visited = 0;
  while (stack.length) {
    const relDir = stack.pop();
    const absDir = path.join(root, relDir);
    let entries = [];
    try {
      entries = await fs.promises.readdir(absDir, { withFileTypes: true });
    } catch (_e) {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' }));
    for (const entry of entries) {
      visited += 1;
      if (visited > 60000) break;
      const rel = path.join(relDir, entry.name);
      const abs = path.join(root, rel);
      if (entry.isDirectory()) {
        stack.push(rel);
        continue;
      }
      if (!entry.isFile()) continue;
      const item = localLibraryEntryFromPath(abs, root);
      if (item) {
        applyCachedLocalLibraryEntryMetadata(item);
        files.push(item);
      }
    }
    if (visited > 60000) break;
  }
  return { ok: true, folderPath: root, files, truncated: visited > 60000 };
}

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
  sendWindowState(mainWindow);
  syncCubeMainVisibility();
  return true;
}

function mainWindowIsVisible() {
  return !!(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized());
}

function syncCubeMainVisibility() {
  cubeRemoteState = { ...cubeRemoteState, mainVisible: mainWindowIsVisible() };
  sendCubeRemoteState();
}

function toggleMainWindowVisibility() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (mainWindowIsVisible()) {
    mainWindow.hide();
    syncCubeMainVisibility();
    return false;
  }
  focusMainWindow();
  return true;
}

function getUpdateDownloadDir() {
  return path.join(app.getPath('userData'), 'updates');
}

function legacyUpdaterCacheDir() {
  const localAppData = String(process.env.LOCALAPPDATA || '').trim();
  if (process.platform !== 'win32' || !localAppData) return '';
  const parent = path.resolve(localAppData);
  const target = path.resolve(parent, 'mineradio-updater');
  return path.dirname(target) === parent ? target : '';
}

function cleanupLegacyUpdaterCache(attempt = 0) {
  legacyUpdaterCleanupTimer = null;
  const target = legacyUpdaterCacheDir();
  if (!target || !fs.existsSync(target)) return;
  fs.rm(target, { recursive: true, force: true }, (error) => {
    if (!error) {
      console.log(`Removed legacy updater cache: ${target}`);
      return;
    }
    if (appQuitting || attempt >= 4) {
      console.warn('Legacy updater cache cleanup failed:', error.message);
      return;
    }
    legacyUpdaterCleanupTimer = setTimeout(() => cleanupLegacyUpdaterCache(attempt + 1), 4000 * (attempt + 1));
  });
}

function scheduleLegacyUpdaterCacheCleanup() {
  if (legacyUpdaterCleanupTimer || !legacyUpdaterCacheDir()) return;
  legacyUpdaterCleanupTimer = setTimeout(() => cleanupLegacyUpdaterCache(0), 12000);
}

function shouldEnsureDesktopShortcut() {
  if (process.platform !== 'win32') return false;
  if (process.env.MINERADIO_NO_DESKTOP_SHORTCUT === '1') return false;
  return app.isPackaged || process.env.MINERADIO_CREATE_DESKTOP_SHORTCUT === '1';
}

function ensureDesktopShortcut() {
  if (!shouldEnsureDesktopShortcut()) return { ok: false, skipped: true };
  try {
    const shortcutPath = path.join(app.getPath('desktop'), `${APP_NAME}.lnk`);
    const target = process.execPath;
    const shortcut = {
      target,
      cwd: path.dirname(target),
      args: '',
      description: 'Mineradio desktop music player',
      icon: fs.existsSync(APP_ICON_ICO) ? APP_ICON_ICO : target,
      iconIndex: 0,
      appUserModelId: APP_USER_MODEL_ID,
    };

    if (fs.existsSync(shortcutPath) && shell.readShortcutLink) {
      try {
        const existing = shell.readShortcutLink(shortcutPath);
        if (existing && path.resolve(existing.target || '') === path.resolve(target) && String(existing.args || '') === '') {
          return { ok: true, path: shortcutPath, existing: true };
        }
      } catch (_) {}
      shell.writeShortcutLink(shortcutPath, 'replace', shortcut);
    } else {
      shell.writeShortcutLink(shortcutPath, 'create', shortcut);
    }
    return { ok: true, path: shortcutPath, created: true };
  } catch (e) {
    console.warn('Desktop shortcut creation skipped:', e.message);
    return { ok: false, error: e.message || 'DESKTOP_SHORTCUT_FAILED' };
  }
}

function parseCookieHeader(cookieText) {
  const out = {};
  String(cookieText || '').split(';').forEach((part) => {
    const raw = String(part || '').trim();
    if (!raw) return;
    const idx = raw.indexOf('=');
    if (idx <= 0) return;
    out[raw.slice(0, idx).trim()] = raw.slice(idx + 1).trim();
  });
  return out;
}

function neteaseCookieHasLogin(cookieText) {
  const obj = parseCookieHeader(cookieText);
  return !!obj.MUSIC_U;
}

function kugouCookieHasLogin(cookieText) {
  const obj = parseCookieHeader(cookieText);
  const userId = String(obj.userid || obj.KugooID || obj.kugou_id || '').replace(/\D/g, '');
  const authToken = obj.token || obj.KuGoo || obj.t || '';
  return !!(userId && authToken);
}

function isNeteaseCookieDomain(domain) {
  const normalized = String(domain || '').replace(/^\./, '').toLowerCase();
  return normalized === '163.com' || normalized.endsWith('.163.com') ||
    normalized === 'music.163.com' || normalized.endsWith('.music.163.com') ||
    normalized === 'netease.com' || normalized.endsWith('.netease.com');
}

function isKugouCookieDomain(domain) {
  const normalized = String(domain || '').replace(/^\./, '').toLowerCase();
  return normalized === 'kugou.com' || normalized.endsWith('.kugou.com') ||
    normalized === 'kgimg.com' || normalized.endsWith('.kgimg.com');
}

function buildCookieHeaderFor(cookies, isAllowedDomain, priority) {
  const picked = new Map();
  (cookies || []).forEach((cookie) => {
    if (!cookie || !cookie.name || !isAllowedDomain(cookie.domain)) return;
    picked.set(cookie.name, cookie.value || '');
  });

  const ordered = [];
  (priority || []).forEach((name) => {
    if (picked.has(name)) {
      ordered.push([name, picked.get(name)]);
      picked.delete(name);
    }
  });
  picked.forEach((value, name) => ordered.push([name, value]));

  return ordered
    .filter(([name, value]) => name && value != null && String(value) !== '')
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

async function readNeteaseLoginCookieHeader(cookieSession) {
  const cookies = await cookieSession.cookies.get({});
  return buildCookieHeaderFor(cookies, isNeteaseCookieDomain, NETEASE_LOGIN_COOKIE_PRIORITY);
}

async function readKugouLoginCookieHeader(cookieSession) {
  const cookies = await cookieSession.cookies.get({});
  return buildCookieHeaderFor(cookies, isKugouCookieDomain, KUGOU_LOGIN_COOKIE_PRIORITY);
}

async function openNeteaseMusicLoginWindow(owner) {
  const cookieSession = session.fromPartition(NETEASE_LOGIN_PARTITION);
  const initialCookie = await readNeteaseLoginCookieHeader(cookieSession);
  if (neteaseCookieHasLogin(initialCookie)) return { ok: true, cookie: initialCookie, reused: true };

  return new Promise((resolve) => {
    let settled = false;
    let pollTimer = null;

    const loginWindow = new BrowserWindow({
      width: 940,
      height: 760,
      minWidth: 780,
      minHeight: 580,
      parent: owner && !owner.isDestroyed() ? owner : undefined,
      modal: false,
      show: false,
      autoHideMenuBar: true,
      title: '小云登录',
      backgroundColor: '#111111',
      icon: APP_ICON_ICO,
      webPreferences: {
        partition: NETEASE_LOGIN_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    const finish = async (result) => {
      if (settled) return;
      settled = true;
      if (pollTimer) clearInterval(pollTimer);
      if (loginWindow && !loginWindow.isDestroyed()) {
        loginWindow.close();
      }
      resolve(result);
    };

    const checkCookies = async () => {
      try {
        const cookie = await readNeteaseLoginCookieHeader(cookieSession);
        if (neteaseCookieHasLogin(cookie)) {
          finish({ ok: true, cookie });
        }
      } catch (e) {
        console.warn('Netease login cookie check failed:', e.message);
      }
    };

    loginWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\/([^/]+\.)?(163|music\.163|netease)\.com/i.test(url)) {
        loginWindow.loadURL(url).catch((e) => console.warn('Netease login popup navigation failed:', e.message));
      } else if (/^https?:\/\//i.test(url)) {
        shell.openExternal(url).catch(() => {});
      }
      return { action: 'deny' };
    });

    loginWindow.webContents.on('did-finish-load', () => {
      checkCookies();
      loginWindow.webContents.executeJavaScript(`
        setTimeout(() => {
          const docs = [document];
          document.querySelectorAll('iframe').forEach((frame) => {
            try { if (frame.contentDocument) docs.push(frame.contentDocument); } catch (_) {}
          });
          for (const doc of docs) {
            const nodes = Array.from(doc.querySelectorAll('a, button, span, div'));
            const loginNode = nodes.find((node) => {
              const text = (node.textContent || '').trim();
              if (!/登录|立即登录/.test(text)) return false;
              const rect = node.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0;
            });
            if (loginNode) { loginNode.click(); return true; }
          }
          return false;
        }, 900);
      `, true).catch(() => {});
    });

    loginWindow.on('ready-to-show', () => loginWindow.show());
    loginWindow.on('closed', async () => {
      if (settled) return;
      if (pollTimer) clearInterval(pollTimer);
      try {
        const cookie = await readNeteaseLoginCookieHeader(cookieSession);
        resolve(neteaseCookieHasLogin(cookie)
          ? { ok: true, cookie }
          : { ok: false, cancelled: true, message: '小云登录窗口已关闭' });
      } catch (e) {
        resolve({ ok: false, error: e.message || '小云登录窗口已关闭' });
      }
    });

    pollTimer = setInterval(checkCookies, 1200);
    loginWindow.loadURL(NETEASE_LOGIN_URL).catch((e) => finish({ ok: false, error: e.message }));
  });
}

async function openKugouMusicLoginWindow(owner) {
  const cookieSession = session.fromPartition(KUGOU_LOGIN_PARTITION);
  await clearKugouMusicLoginSession();

  return new Promise((resolve) => {
    let settled = false;
    let pollTimer = null;

    const loginWindow = new BrowserWindow({
      width: 920,
      height: 720,
      minWidth: 760,
      minHeight: 560,
      parent: owner && !owner.isDestroyed() ? owner : undefined,
      modal: false,
      show: false,
      autoHideMenuBar: true,
      title: 'Kugou Music Login',
      backgroundColor: '#111111',
      icon: APP_ICON_ICO,
      webPreferences: {
        partition: KUGOU_LOGIN_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    const finish = async (result) => {
      if (settled) return;
      settled = true;
      if (pollTimer) clearInterval(pollTimer);
      if (loginWindow && !loginWindow.isDestroyed()) {
        loginWindow.close();
      }
      resolve(result);
    };

    const checkCookies = async () => {
      try {
        const cookie = await readKugouLoginCookieHeader(cookieSession);
        if (kugouCookieHasLogin(cookie)) {
          finish({ ok: true, cookie });
        }
      } catch (e) {
        console.warn('Kugou login cookie check failed:', e.message);
      }
    };

    const localJson = (pathname) => new Promise((ok, fail) => {
      const port = mainServerPort || Number(process.env.PORT) || 3000;
      const req = http.get(`http://127.0.0.1:${port}${pathname}`, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          try {
            const data = body ? JSON.parse(body) : {};
            if (res.statusCode >= 400) {
              const err = new Error(data.message || data.error || `HTTP_${res.statusCode}`);
              err.data = data;
              fail(err);
              return;
            }
            ok(data);
          } catch (e) {
            fail(e);
          }
        });
      });
      req.setTimeout(12000, () => req.destroy(new Error('Kugou login request timeout')));
      req.on('error', fail);
    });

    const startKugouQrLogin = async () => {
      try {
        const qr = await localJson('/api/kugou/login/qr/key?t=' + Date.now());
        const key = qr && (qr.key || qr.qrcode);
        if (!key || !qr.url) throw new Error('Kugou QR login URL missing');
        await loginWindow.loadURL(qr.url);
        const pollLogin = async () => {
          try {
            const data = await localJson('/api/kugou/login/qr/check?key=' + encodeURIComponent(key) + '&t=' + Date.now());
            if (data && data.code === 803 && data.loggedIn) {
              finish(Object.assign({ ok: true }, data));
            } else if (data && data.code === 800) {
              finish({ ok: false, error: data.message || 'Kugou QR expired, please try again' });
            }
          } catch (e) {
            console.warn('Kugou QR login check failed:', e.message);
          }
        };
        pollTimer = setInterval(pollLogin, 1200);
        pollLogin();
      } catch (e) {
        console.warn('Kugou QR login failed, falling back to web home:', e.message);
        pollTimer = setInterval(checkCookies, 1200);
        loginWindow.loadURL(KUGOU_LOGIN_URL).catch((err) => finish({ ok: false, error: err.message }));
      }
    };

    loginWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\/([^/]+\.)?kugou\.com/i.test(url) || /^https?:\/\/([^/]+\.)?kgimg\.com/i.test(url)) {
        loginWindow.loadURL(url).catch((e) => console.warn('Kugou login popup navigation failed:', e.message));
      } else if (/^https?:\/\//i.test(url)) {
        shell.openExternal(url).catch(() => {});
      }
      return { action: 'deny' };
    });

    loginWindow.webContents.on('did-finish-load', () => {
      checkCookies();
      loginWindow.webContents.executeJavaScript(`
        setTimeout(() => {
          const nodes = Array.from(document.querySelectorAll('a, button, span, div'));
          const loginNode = nodes.find((node) => {
            const text = (node.textContent || '').trim();
            if (!/登录|登陆|立即登录/.test(text)) return false;
            const rect = node.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          });
          if (loginNode) loginNode.click();
        }, 700);
      `, true).catch(() => {});
    });

    loginWindow.on('ready-to-show', () => loginWindow.show());
    loginWindow.on('closed', async () => {
      if (settled) return;
      if (pollTimer) clearInterval(pollTimer);
      try {
        const cookie = await readKugouLoginCookieHeader(cookieSession);
        resolve(kugouCookieHasLogin(cookie)
          ? { ok: true, cookie }
          : { ok: false, cancelled: true, message: 'Kugou login window closed' });
      } catch (e) {
        resolve({ ok: false, error: e.message || 'Kugou login window closed' });
      }
    });

    startKugouQrLogin();
  });
}

async function clearNeteaseMusicLoginSession() {
  const cookieSession = session.fromPartition(NETEASE_LOGIN_PARTITION);
  await cookieSession.clearStorageData({
    storages: ['cookies', 'localstorage', 'indexdb', 'cachestorage'],
  });
  return { ok: true };
}

async function clearKugouMusicLoginSession() {
  const cookieSession = session.fromPartition(KUGOU_LOGIN_PARTITION);
  await cookieSession.clearStorageData({
    storages: ['cookies', 'localstorage', 'indexdb', 'cachestorage'],
  });
  return { ok: true };
}

function getWindowedBounds(win) {
  const display = win && !win.isDestroyed()
    ? screen.getDisplayMatching(win.getBounds())
    : screen.getPrimaryDisplay();
  const area = display.workArea;
  const basis = display.bounds || area;
  const maxWidth = Math.max(640, area.width - WINDOWED_MARGIN);
  const maxHeight = Math.max(360, area.height - WINDOWED_MARGIN);

  let width = Math.round(basis.width * WINDOWED_SCALE);
  let height = Math.round(width / WINDOWED_ASPECT);
  const scaledHeight = Math.round(basis.height * WINDOWED_SCALE);

  if (height > scaledHeight) {
    height = scaledHeight;
    width = Math.round(height * WINDOWED_ASPECT);
  }

  if (width < MIN_WINDOWED_WIDTH && maxWidth >= MIN_WINDOWED_WIDTH && maxHeight >= MIN_WINDOWED_HEIGHT) {
    width = MIN_WINDOWED_WIDTH;
    height = MIN_WINDOWED_HEIGHT;
  }

  if (width > maxWidth) {
    width = maxWidth;
    height = Math.round(width / WINDOWED_ASPECT);
  }
  if (height > maxHeight) {
    height = maxHeight;
    width = Math.round(height * WINDOWED_ASPECT);
  }

  width = Math.round(width);
  height = Math.round(height);

  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height,
  };
}

function applyWindowedBounds(win) {
  if (!win || win.isDestroyed()) return;
  if (win.isMaximized()) win.unmaximize();
  win.setMinimumSize(MIN_WINDOWED_WIDTH, MIN_WINDOWED_HEIGHT);
  win.setBounds(getWindowedBounds(win), false);
  sendWindowState(win);
}

function exitFullscreenToWindow(win) {
  if (!win || win.isDestroyed()) return;
  windowFullscreenActive = false;

  if (!win.isFullScreen()) {
    applyWindowedBounds(win);
    return;
  }

  let applied = false;
  const applyOnce = () => {
    if (applied || !win || win.isDestroyed() || win.isFullScreen()) return;
    applied = true;
    applyWindowedBounds(win);
  };

  win.once('leave-full-screen', () => setTimeout(applyOnce, 50));
  win.setFullScreen(false);
  setTimeout(applyOnce, 500);
}

function toggleFullscreen(win) {
  if (!win || win.isDestroyed()) return;
  if (win.isFullScreen() || windowFullscreenActive) {
    exitFullscreenToWindow(win);
    return;
  }
  windowFullscreenActive = true;
  win.setFullScreen(true);
  sendWindowState(win);
}

function overlayUrl(page) {
  const port = mainServerPort || process.env.PORT || 3000;
  return `http://127.0.0.1:${port}/${page}`;
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function desktopLyricsDefaultBounds(payload = desktopLyricsState) {
  const display = desktopLyricsUserBounds
    ? screen.getDisplayMatching(desktopLyricsUserBounds)
    : screen.getPrimaryDisplay();
  const bounds = display.bounds;
  const yRatio = clampNumber(payload.y, 0.08, 0.92, 0.76);
  const width = Math.round(Math.min(Math.max(760, bounds.width * 0.46), 1040, bounds.width - 96));
  const height = Math.round(Math.min(Math.max(210, bounds.height * 0.22), 240, bounds.height - 96));
  return {
    x: Math.round(bounds.x + (bounds.width - width) / 2),
    y: Math.round(bounds.y + bounds.height * yRatio - height / 2),
    width,
    height,
  };
}

function constrainDesktopLyricsBounds(bounds) {
  const display = screen.getDisplayMatching(bounds);
  const area = display.bounds;
  const next = {
    ...bounds,
    width: Math.round(Math.min(Math.max(320, bounds.width), area.width)),
    height: Math.round(Math.min(Math.max(180, bounds.height), area.height)),
  };
  const maxX = area.x + Math.max(0, area.width - next.width);
  const maxY = area.y + Math.max(0, area.height - next.height);
  next.x = Math.round(clampNumber(next.x, area.x, maxX, area.x));
  next.y = Math.round(clampNumber(next.y, area.y, maxY, area.y));
  return next;
}

function setDesktopLyricsBounds(bounds) {
  if (!desktopLyricsWindow || desktopLyricsWindow.isDestroyed()) return;
  const nextBounds = constrainDesktopLyricsBounds(bounds);
  const currentBounds = desktopLyricsWindow.getBounds();
  if (
    currentBounds.x === nextBounds.x
    && currentBounds.y === nextBounds.y
    && currentBounds.width === nextBounds.width
    && currentBounds.height === nextBounds.height
  ) {
    return;
  }
  desktopLyricsProgrammaticMove = true;
  desktopLyricsWindow.setBounds(nextBounds, false);
  setTimeout(() => {
    desktopLyricsProgrammaticMove = false;
  }, 120);
}

function rememberDesktopLyricsBounds() {
  if (!desktopLyricsWindow || desktopLyricsWindow.isDestroyed() || desktopLyricsProgrammaticMove) return;
  rememberDesktopLyricsBoundsPersist(desktopLyricsWindow.getBounds());
}

function applyDesktopLyricsMouseBehavior() {
  if (!desktopLyricsWindow || desktopLyricsWindow.isDestroyed()) return;
  const locked = desktopLyricsState.clickThrough !== false;
  const shouldIgnore = locked || !desktopLyricsPointerCapture;
  if (desktopLyricsMouseIgnored === shouldIgnore) return;
  desktopLyricsMouseIgnored = shouldIgnore;
  desktopLyricsWindow.setIgnoreMouseEvents(shouldIgnore, { forward: true });
}

function desktopLyricsHotBoundsOnScreen() {
  if (!desktopLyricsWindow || desktopLyricsWindow.isDestroyed()) return null;
  const winBounds = desktopLyricsWindow.getBounds();
  const rel = desktopLyricsHotBounds;
  if (!rel) return winBounds;
  return {
    x: winBounds.x + rel.left,
    y: winBounds.y + rel.top,
    width: Math.max(1, rel.right - rel.left),
    height: Math.max(1, rel.bottom - rel.top),
  };
}

function pointInBounds(point, bounds) {
  if (!point || !bounds) return false;
  return point.x >= bounds.x
    && point.x <= bounds.x + bounds.width
    && point.y >= bounds.y
    && point.y <= bounds.y + bounds.height;
}

function handleDesktopLyricsGlobalMiddleClick() {
  if (!desktopLyricsWindow || desktopLyricsWindow.isDestroyed()) return;
  if (!desktopLyricsState.enabled) return;
  const now = Date.now();
  if (now - desktopLyricsLastMiddleAt < 260) return;
  const point = screen.getCursorScreenPoint();
  if (!pointInBounds(point, desktopLyricsHotBoundsOnScreen())) return;
  desktopLyricsLastMiddleAt = now;
  const nextLocked = desktopLyricsState.clickThrough === false;
  desktopLyricsState = { ...desktopLyricsState, clickThrough: nextLocked };
  desktopLyricsPointerCapture = !nextLocked;
  applyDesktopLyricsMouseBehavior();
  broadcastDesktopLyricsLockState();
}

function startDesktopLyricsMousePoller() {
  if (process.platform !== 'win32' || desktopLyricsMousePoller) return;
  const script = `
$ErrorActionPreference = "SilentlyContinue"
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class MineradioMousePoll {
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
}
"@
$prev = $false
while ($true) {
  $down = (([MineradioMousePoll]::GetAsyncKeyState(4) -band 0x8000) -ne 0)
  if ($down -and -not $prev) {
    [Console]::Out.WriteLine("MMB")
    [Console]::Out.Flush()
  }
  $prev = $down
  Start-Sleep -Milliseconds 24
}
`;
  try {
    desktopLyricsMousePoller = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    desktopLyricsMousePoller.stdout.on('data', (chunk) => {
      desktopLyricsMousePollerBuffer += chunk.toString('utf8');
      const lines = desktopLyricsMousePollerBuffer.split(/\r?\n/);
      desktopLyricsMousePollerBuffer = lines.pop() || '';
      lines.forEach((line) => {
        if (line.trim() === 'MMB') handleDesktopLyricsGlobalMiddleClick();
      });
    });
    desktopLyricsMousePoller.on('exit', () => {
      desktopLyricsMousePoller = null;
      desktopLyricsMousePollerBuffer = '';
    });
    desktopLyricsMousePoller.on('error', () => {
      desktopLyricsMousePoller = null;
      desktopLyricsMousePollerBuffer = '';
    });
  } catch (e) {
    desktopLyricsMousePoller = null;
    desktopLyricsMousePollerBuffer = '';
  }
}

function stopDesktopLyricsMousePoller() {
  if (!desktopLyricsMousePoller) return;
  try {
    desktopLyricsMousePoller.kill();
  } catch (e) {}
  desktopLyricsMousePoller = null;
  desktopLyricsMousePollerBuffer = '';
}

function broadcastDesktopLyricsLockState() {
  const locked = desktopLyricsState.clickThrough !== false;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('mineradio-desktop-lyrics-lock-state', { locked });
  }
  sendDesktopLyricsState();
}

function broadcastDesktopLyricsEnabledState(enabled) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('mineradio-desktop-lyrics-enabled-state', { enabled: !!enabled });
  }
}

function positionDesktopLyricsWindow(payload = desktopLyricsState, options = {}) {
  if (!desktopLyricsWindow || desktopLyricsWindow.isDestroyed()) return;
  const shouldUseManualBounds = desktopLyricsUserBounds && !options.force;
  const defaultBounds = desktopLyricsDefaultBounds(payload);
  if (shouldUseManualBounds) {
    const savedCenterX = desktopLyricsUserBounds.x + desktopLyricsUserBounds.width / 2;
    const savedCenterY = desktopLyricsUserBounds.y + desktopLyricsUserBounds.height / 2;
    setDesktopLyricsBounds({
      x: Math.round(savedCenterX - defaultBounds.width / 2),
      y: Math.round(savedCenterY - defaultBounds.height / 2),
      width: defaultBounds.width,
      height: defaultBounds.height,
    });
  } else {
    setDesktopLyricsBounds(defaultBounds);
  }
  if (typeof desktopLyricsWindow.setOpacity === 'function') {
    desktopLyricsWindow.setOpacity(clampNumber(payload.opacity, 0.28, 1, 0.92));
  }
}

function sendDesktopLyricsState() {
  if (!desktopLyricsWindow || desktopLyricsWindow.isDestroyed()) return;
  desktopLyricsWindow.webContents.send('mineradio-desktop-lyrics-state', desktopLyricsState);
}

function createDesktopLyricsWindow(payload = {}) {
  const previousY = desktopLyricsState.y;
  const previousOpacity = desktopLyricsState.opacity;
  desktopLyricsState = { ...desktopLyricsState, ...payload, enabled: true };
  const hasY = Object.prototype.hasOwnProperty.call(payload || {}, 'y');
  const nextY = clampNumber(desktopLyricsState.y, 0.08, 0.92, 0.76);
  const yChanged = hasY && Number.isFinite(Number(previousY)) && Math.abs(nextY - clampNumber(previousY, 0.08, 0.92, 0.76)) > 0.001;
  const opacityChanged = Object.prototype.hasOwnProperty.call(payload || {}, 'opacity')
    && Math.abs(clampNumber(desktopLyricsState.opacity, 0.28, 1, 0.92) - clampNumber(previousOpacity, 0.28, 1, 0.92)) > 0.001;
  if (yChanged) rememberDesktopLyricsBoundsPersist(null, { clear: true });
  if (readDesktopBehaviorSettings().desktopLyrics !== true) {
    saveDesktopBehaviorSettings({ desktopLyrics: true });
  }
  if (desktopLyricsWindow && !desktopLyricsWindow.isDestroyed()) {
    if (yChanged) {
      positionDesktopLyricsWindow(desktopLyricsState, { force: yChanged });
    } else if (opacityChanged && typeof desktopLyricsWindow.setOpacity === 'function') {
      desktopLyricsWindow.setOpacity(clampNumber(desktopLyricsState.opacity, 0.28, 1, 0.92));
    }
    applyDesktopLyricsMouseBehavior();
    sendDesktopLyricsState();
    return desktopLyricsWindow;
  }

  desktopLyricsWindow = new BrowserWindow({
    width: 920,
    height: 190,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: true,
    focusable: false,
    skipTaskbar: true,
    show: false,
    title: 'Mineradio Desktop Lyrics',
    webPreferences: {
      preload: path.join(__dirname, 'overlay-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  try {
    desktopLyricsWindow.setAlwaysOnTop(true, 'screen-saver');
    desktopLyricsWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } catch (e) {
    console.warn('Desktop lyrics topmost setup skipped:', e.message);
  }
  startDesktopLyricsMousePoller();
  applyDesktopLyricsMouseBehavior();
  positionDesktopLyricsWindow(desktopLyricsState, { force: yChanged || !desktopLyricsUserBounds });
  desktopLyricsWindow.once('ready-to-show', () => {
    if (!desktopLyricsWindow || desktopLyricsWindow.isDestroyed()) return;
    desktopLyricsWindow.showInactive();
    sendDesktopLyricsState();
  });
  desktopLyricsWindow.webContents.once('did-finish-load', sendDesktopLyricsState);
  desktopLyricsWindow.on('closed', () => {
    desktopLyricsWindow = null;
    desktopLyricsMouseIgnored = null;
  });
  desktopLyricsWindow.on('moved', rememberDesktopLyricsBounds);
  desktopLyricsWindow.loadURL(overlayUrl('desktop-lyrics.html')).catch((e) => console.warn('Desktop lyrics load failed:', e.message));
  return desktopLyricsWindow;
}

function closeDesktopLyricsWindow(options = {}) {
  const fromUser = options.fromUser === true;
  desktopLyricsState = { ...desktopLyricsState, enabled: false };
  desktopLyricsPointerCapture = false;
  desktopLyricsMouseIgnored = null;
  desktopLyricsHotBounds = null;
  stopDesktopLyricsMousePoller();
  if (desktopLyricsWindow && !desktopLyricsWindow.isDestroyed()) {
    if (fromUser) sendDesktopLyricsState();
    desktopLyricsWindow.close();
  }
  desktopLyricsWindow = null;
  // 退出/主窗口销毁时只拆窗口，不要把“桌面歌词开启”偏好改成关闭并回写前端
  if (fromUser) {
    if (readDesktopBehaviorSettings().desktopLyrics !== false) {
      saveDesktopBehaviorSettings({ desktopLyrics: false });
    }
    broadcastDesktopLyricsEnabledState(false);
  }
}

function nativeWindowHandleDecimal(win) {
  const handle = win.getNativeWindowHandle();
  if (process.arch === 'x64') return handle.readBigUInt64LE(0).toString();
  return String(handle.readUInt32LE(0));
}

function attachWallpaperToWorkerW(win) {
  if (process.platform !== 'win32' || !win || win.isDestroyed()) return;
  const hwnd = nativeWindowHandleDecimal(win);
  const script = `
$ErrorActionPreference = "Stop"
if (-not ("MineradioNativeWin" -as [type])) {
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class MineradioNativeWin {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr childAfter, string className, string windowName);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SetParent(IntPtr hWndChild, IntPtr hWndNewParent);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam, uint fuFlags, uint uTimeout, out IntPtr lpdwResult);
}
"@
}
$progman = [MineradioNativeWin]::FindWindow("Progman", $null)
$result = [IntPtr]::Zero
[MineradioNativeWin]::SendMessageTimeout($progman, 0x052C, [IntPtr]::Zero, [IntPtr]::Zero, 0, 1000, [ref]$result) | Out-Null
$script:workerw = [IntPtr]::Zero
$enum = [MineradioNativeWin+EnumWindowsProc]{
  param([IntPtr]$top, [IntPtr]$param)
  $shell = [MineradioNativeWin]::FindWindowEx($top, [IntPtr]::Zero, "SHELLDLL_DefView", $null)
  if ($shell -ne [IntPtr]::Zero) {
    $script:workerw = [MineradioNativeWin]::FindWindowEx([IntPtr]::Zero, $top, "WorkerW", $null)
  }
  return $true
}
[MineradioNativeWin]::EnumWindows($enum, [IntPtr]::Zero) | Out-Null
if ($script:workerw -eq [IntPtr]::Zero) { $script:workerw = $progman }
$target = [IntPtr]::new([Int64]${hwnd})
[MineradioNativeWin]::SetParent($target, $script:workerw) | Out-Null
[MineradioNativeWin]::SetWindowPos($target, [IntPtr]::Zero, 0, 0, 0, 0, 0x0013) | Out-Null
`;
  execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    windowsHide: true,
    timeout: 5000,
  }, (error) => {
    if (error) console.warn('Wallpaper WorkerW attach failed:', error.message);
  });
}

function positionWallpaperWindow() {
  if (!wallpaperWindow || wallpaperWindow.isDestroyed()) return;
  const bounds = screen.getPrimaryDisplay().bounds;
  wallpaperWindow.setBounds(bounds, false);
}

function sendWallpaperState() {
  if (!wallpaperWindow || wallpaperWindow.isDestroyed()) return;
  wallpaperWindow.webContents.send('mineradio-wallpaper-state', wallpaperState);
}

function createWallpaperWindow(payload = {}) {
  wallpaperState = { ...wallpaperState, ...payload, enabled: true };
  if (wallpaperWindow && !wallpaperWindow.isDestroyed()) {
    positionWallpaperWindow();
    sendWallpaperState();
    return wallpaperWindow;
  }
  const bounds = screen.getPrimaryDisplay().bounds;
  wallpaperWindow = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: false,
    backgroundColor: '#050608',
    hasShadow: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    show: false,
    title: 'Mineradio Wallpaper',
    webPreferences: {
      preload: path.join(__dirname, 'overlay-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  wallpaperWindow.setIgnoreMouseEvents(true, { forward: true });
  wallpaperWindow.once('ready-to-show', () => {
    if (!wallpaperWindow || wallpaperWindow.isDestroyed()) return;
    positionWallpaperWindow();
    wallpaperWindow.showInactive();
    attachWallpaperToWorkerW(wallpaperWindow);
    sendWallpaperState();
  });
  wallpaperWindow.webContents.once('did-finish-load', sendWallpaperState);
  wallpaperWindow.on('closed', () => {
    wallpaperWindow = null;
  });
  wallpaperWindow.loadURL(overlayUrl('wallpaper.html')).catch((e) => console.warn('Wallpaper load failed:', e.message));
  return wallpaperWindow;
}

function closeWallpaperWindow() {
  wallpaperState = { ...wallpaperState, enabled: false };
  if (wallpaperWindow && !wallpaperWindow.isDestroyed()) {
    sendWallpaperState();
    wallpaperWindow.close();
  }
  wallpaperWindow = null;
}

function cubeRemoteSize(state = {}) {
  const skin = clampCubeRemoteSkin(state.skin || cubeRemoteState.skin || 'cube');
  return { ...(CUBE_REMOTE_SKINS[skin] || CUBE_REMOTE_SKINS.cube) };
}

function cubeRemoteDefaultBounds(state = {}) {
  const size = cubeRemoteSize(state);
  const display = (mainWindow && !mainWindow.isDestroyed())
    ? screen.getDisplayMatching(mainWindow.getBounds())
    : screen.getPrimaryDisplay();
  const area = display.workArea || display.bounds;
  const margin = 28;
  return constrainCubeRemoteBounds({
    x: Math.round(area.x + area.width - size.width - margin),
    y: Math.round(area.y + area.height - size.height - margin),
    width: size.width,
    height: size.height,
  });
}

function resizeCubeRemoteBounds(bounds, state = {}, keepLeft = false) {
  const size = cubeRemoteSize(state);
  return constrainCubeRemoteBounds({
    x: keepLeft ? bounds.x : Math.round(bounds.x + (bounds.width - size.width) / 2),
    y: Math.round(bounds.y + (bounds.height - size.height) / 2),
    width: size.width,
    height: size.height,
  }, state);
}

function constrainCubeRemoteBounds(bounds, state = cubeRemoteState) {
  const size = cubeRemoteSize(state);
  const source = bounds || cubeRemoteDefaultBounds(state);
  const display = screen.getDisplayMatching(source);
  const area = display.workArea || display.bounds;
  const next = {
    ...source,
    width: Math.round(Math.min(size.width, area.width)),
    height: Math.round(Math.min(size.height, area.height)),
  };
  const maxX = area.x + Math.max(0, area.width - next.width);
  const maxY = area.y + Math.max(0, area.height - next.height);
  next.x = Math.round(clampNumber(next.x, area.x, maxX, area.x));
  next.y = Math.round(clampNumber(next.y, area.y, maxY, area.y));
  return next;
}

function sendCubeRemoteState() {
  if (!cubeRemoteWindow || cubeRemoteWindow.isDestroyed()) return;
  cubeRemoteWindow.webContents.send('mineradio-cube-remote-state', cubeRemoteState);
}

function broadcastCubeRemoteEnabledState(enabled, extra = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('mineradio-cube-remote-enabled-state', {
      enabled: !!enabled,
      skin: clampCubeRemoteSkin(extra.skin || cubeRemoteState.skin || readDesktopBehaviorSettings().cubeRemoteSkin || 'cube'),
    });
  }
}

function applyCubeRemoteFullscreenVisibility(externalFullscreen) {
  cubeRemoteExternalFullscreenActive = !!externalFullscreen;
  if (!cubeRemoteWindow || cubeRemoteWindow.isDestroyed()) return;

  if (cubeRemoteExternalFullscreenActive) {
    cubeRemoteHiddenByFullscreen = true;
    if (cubeRemoteWindow.isVisible()) cubeRemoteWindow.hide();
    return;
  }

  if (!cubeRemoteHiddenByFullscreen) return;
  cubeRemoteHiddenByFullscreen = false;
  if (cubeRemoteState.enabled) cubeRemoteWindow.showInactive();
}

function scheduleCubeRemoteFullscreenPollerRestart() {
  if (cubeRemoteFullscreenPollerRestartTimer || appQuitting || !cubeRemoteState.enabled) return;
  if (!cubeRemoteWindow || cubeRemoteWindow.isDestroyed()) return;
  const delay = Math.min(15000, 1200 * (2 ** Math.min(cubeRemoteFullscreenPollerRestartAttempts, 4)));
  cubeRemoteFullscreenPollerRestartAttempts += 1;
  cubeRemoteFullscreenPollerRestartTimer = setTimeout(() => {
    cubeRemoteFullscreenPollerRestartTimer = null;
    startCubeRemoteFullscreenPoller();
  }, delay);
}

function startCubeRemoteFullscreenPoller() {
  if (process.platform !== 'win32' || cubeRemoteFullscreenPoller) return;
  if (cubeRemoteFullscreenPollerRestartTimer) {
    clearTimeout(cubeRemoteFullscreenPollerRestartTimer);
    cubeRemoteFullscreenPollerRestartTimer = null;
  }
  const script = `
$ErrorActionPreference = "SilentlyContinue"
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class MineradioFullscreenPoll {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  [StructLayout(LayoutKind.Sequential)]
  public struct MONITORINFO {
    public int Size;
    public RECT Monitor;
    public RECT WorkArea;
    public uint Flags;
  }

  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out RECT rect);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr window, StringBuilder className, int maxCount);
}
"@
$mineradioPid = ${process.pid}
$lastState = $null
$classNameBuilder = New-Object System.Text.StringBuilder 256
while ($true) {
  $isExternalFullscreen = $false
  $window = [MineradioFullscreenPoll]::GetForegroundWindow()
  [void]$classNameBuilder.Clear()
  [void][MineradioFullscreenPoll]::GetClassName($window, $classNameBuilder, $classNameBuilder.Capacity)
  $className = $classNameBuilder.ToString()
  $isShellSurface = @("Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd") -contains $className
  if ($window -ne [IntPtr]::Zero -and
      -not $isShellSurface -and
      [MineradioFullscreenPoll]::IsWindowVisible($window) -and
      -not [MineradioFullscreenPoll]::IsIconic($window)) {
    [uint32]$ownerPid = 0
    [void][MineradioFullscreenPoll]::GetWindowThreadProcessId($window, [ref]$ownerPid)
    if ($ownerPid -ne 0 -and $ownerPid -ne $mineradioPid) {
      $rect = New-Object MineradioFullscreenPoll+RECT
      $monitor = [MineradioFullscreenPoll]::MonitorFromWindow($window, 2)
      $info = New-Object MineradioFullscreenPoll+MONITORINFO
      $info.Size = [Runtime.InteropServices.Marshal]::SizeOf($info)
      if ([MineradioFullscreenPoll]::GetWindowRect($window, [ref]$rect) -and
          $monitor -ne [IntPtr]::Zero -and
          [MineradioFullscreenPoll]::GetMonitorInfo($monitor, [ref]$info)) {
        $tolerance = 2
        $isExternalFullscreen = (
          $rect.Left -le ($info.Monitor.Left + $tolerance) -and
          $rect.Top -le ($info.Monitor.Top + $tolerance) -and
          $rect.Right -ge ($info.Monitor.Right - $tolerance) -and
          $rect.Bottom -ge ($info.Monitor.Bottom - $tolerance)
        )
      }
    }
  }

  $state = if ($isExternalFullscreen) { "1" } else { "0" }
  if ($state -ne $lastState) {
    [Console]::Out.WriteLine("FULLSCREEN " + $state)
    [Console]::Out.Flush()
    $lastState = $state
  }
  Start-Sleep -Milliseconds 350
}
`;

  try {
    const poller = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    cubeRemoteFullscreenPoller = poller;
    poller.stdout.on('data', (chunk) => {
      cubeRemoteFullscreenPollerBuffer += chunk.toString('utf8');
      const lines = cubeRemoteFullscreenPollerBuffer.split(/\r?\n/);
      cubeRemoteFullscreenPollerBuffer = lines.pop() || '';
      lines.forEach((line) => {
        const match = line.trim().match(/^FULLSCREEN\s+([01])$/);
        if (match) {
          cubeRemoteFullscreenPollerRestartAttempts = 0;
          applyCubeRemoteFullscreenVisibility(match[1] === '1');
        }
      });
    });
    const handlePollerEnd = () => {
      if (cubeRemoteFullscreenPoller !== poller) return;
      cubeRemoteFullscreenPoller = null;
      cubeRemoteFullscreenPollerBuffer = '';
      applyCubeRemoteFullscreenVisibility(false);
      scheduleCubeRemoteFullscreenPollerRestart();
    };
    poller.on('exit', handlePollerEnd);
    poller.on('error', handlePollerEnd);
  } catch (_e) {
    cubeRemoteFullscreenPoller = null;
    cubeRemoteFullscreenPollerBuffer = '';
    applyCubeRemoteFullscreenVisibility(false);
    scheduleCubeRemoteFullscreenPollerRestart();
  }
}

function stopCubeRemoteFullscreenPoller() {
  if (cubeRemoteFullscreenPollerRestartTimer) {
    clearTimeout(cubeRemoteFullscreenPollerRestartTimer);
    cubeRemoteFullscreenPollerRestartTimer = null;
  }
  const poller = cubeRemoteFullscreenPoller;
  cubeRemoteFullscreenPoller = null;
  cubeRemoteFullscreenPollerBuffer = '';
  cubeRemoteFullscreenPollerRestartAttempts = 0;
  cubeRemoteExternalFullscreenActive = false;
  cubeRemoteHiddenByFullscreen = false;
  if (!poller) return;
  try {
    poller.kill();
  } catch (_e) {}
}

function createCubeRemoteWindow(payload = {}) {
  const behavior = readDesktopBehaviorSettings();
  const nextSkin = clampCubeRemoteSkin(payload.skin || behavior.cubeRemoteSkin || cubeRemoteState.skin || 'cube');
  cubeRemoteState = {
    ...cubeRemoteState,
    ...(payload || {}),
    skin: nextSkin,
    enabled: true,
  };
  if (cubeRemoteWindow && !cubeRemoteWindow.isDestroyed()) {
    startCubeRemoteFullscreenPoller();
    sendCubeRemoteState();
    return cubeRemoteWindow;
  }

  const bounds = cubeRemoteUserBounds
    ? constrainCubeRemoteBounds(resizeCubeRemoteBounds(cubeRemoteUserBounds, cubeRemoteState))
    : cubeRemoteDefaultBounds(cubeRemoteState);

  cubeRemoteWindow = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: true,
    focusable: true,
    skipTaskbar: true,
    show: false,
    alwaysOnTop: true,
    title: 'Mineradio Cube Remote',
    webPreferences: {
      preload: path.join(__dirname, 'overlay-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  try {
    cubeRemoteWindow.setAlwaysOnTop(true, 'screen-saver');
    cubeRemoteWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } catch (e) {
    console.warn('Cube remote topmost setup skipped:', e.message);
  }
  try {
    cubeRemoteWindow.setBounds(constrainCubeRemoteBounds(cubeRemoteWindow.getBounds()), false);
  } catch (_e) {}
  startCubeRemoteFullscreenPoller();
  cubeRemoteWindow.once('ready-to-show', () => {
    if (!cubeRemoteWindow || cubeRemoteWindow.isDestroyed()) return;
    try {
      cubeRemoteWindow.setBounds(constrainCubeRemoteBounds(cubeRemoteWindow.getBounds()), false);
    } catch (_e) {}
    if (!cubeRemoteExternalFullscreenActive) cubeRemoteWindow.showInactive();
    sendCubeRemoteState();
  });
  cubeRemoteWindow.webContents.once('did-finish-load', sendCubeRemoteState);
  cubeRemoteWindow.on('moved', () => {
    if (!cubeRemoteWindow || cubeRemoteWindow.isDestroyed()) return;
    rememberCubeRemoteBounds(cubeRemoteWindow.getBounds());
  });
  cubeRemoteWindow.on('closed', () => {
    stopCubeRemoteFullscreenPoller();
    cubeRemoteWindow = null;
    flushCubeRemoteBoundsSave();
    cubeRemoteState = { ...cubeRemoteState, enabled: false };
    saveDesktopBehaviorSettings({ cubeRemote: false });
    broadcastCubeRemoteEnabledState(false);
  });
  cubeRemoteWindow.loadURL(overlayUrl('cube-remote.html')).catch((e) => {
    console.warn('Cube remote load failed:', e.message);
  });
  return cubeRemoteWindow;
}

function closeCubeRemoteWindow({ fromSettings = false } = {}) {
  flushCubeRemoteBoundsSave();
  stopCubeRemoteFullscreenPoller();
  cubeRemoteState = { ...cubeRemoteState, enabled: false };
  if (cubeRemoteWindow && !cubeRemoteWindow.isDestroyed()) {
    cubeRemoteWindow.removeAllListeners('closed');
    cubeRemoteWindow.close();
  }
  cubeRemoteWindow = null;
  if (!fromSettings) saveDesktopBehaviorSettings({ cubeRemote: false });
  broadcastCubeRemoteEnabledState(false);
}

function setCubeRemoteEnabled(enabled, payload = {}) {
  const value = !!enabled;
  const nextSkin = clampCubeRemoteSkin(payload.skin || readDesktopBehaviorSettings().cubeRemoteSkin || 'cube');
  saveDesktopBehaviorSettings({ cubeRemote: value, cubeRemoteSkin: nextSkin });
  if (value) {
    createCubeRemoteWindow({
      ...trayPlaybackState,
      title: trayPlaybackState.title || '未播放',
      artist: trayPlaybackState.artist || '',
      volume: trayPlaybackState.volume,
      playing: !!trayPlaybackState.playing,
      cover: trayPlaybackState.cover || '',
      muted: !!trayPlaybackState.muted,
      mainVisible: mainWindowIsVisible(),
      ...payload,
      skin: nextSkin,
      enabled: true,
    });
    broadcastCubeRemoteEnabledState(true);
  } else {
    closeCubeRemoteWindow({ fromSettings: true });
  }
  return { ok: true, enabled: value, skin: nextSkin };
}

function closeOverlayWindows() {
  closeDesktopLyricsWindow();
  closeCubeRemoteWindow({ fromSettings: true });
  closeWallpaperWindow();
}

ipcMain.handle('desktop-window-minimize', (event) => {
  getSenderWindow(event)?.minimize();
});

ipcMain.handle('desktop-window-toggle-maximize', (event) => {
  toggleFullscreen(getSenderWindow(event));
});

ipcMain.handle('desktop-window-toggle-fullscreen', (event) => {
  toggleFullscreen(getSenderWindow(event));
});

ipcMain.handle('desktop-window-exit-fullscreen-windowed', (event) => {
  exitFullscreenToWindow(getSenderWindow(event));
});

ipcMain.handle('desktop-window-get-state', (event) => {
  return getWindowState(getSenderWindow(event));
});

ipcMain.handle('desktop-window-close', (event) => {
  getSenderWindow(event)?.close();
});

ipcMain.handle('mineradio-desktop-behavior-get', () => {
  ensureMineradioTray();
  return readDesktopBehaviorSettings();
});

ipcMain.handle('mineradio-desktop-behavior-set', (_event, payload = {}) => {
  const next = {};
  if (Object.prototype.hasOwnProperty.call(payload, 'closeToTray')) next.closeToTray = payload.closeToTray === true;
  if (Object.prototype.hasOwnProperty.call(payload, 'openAtLogin')) next.openAtLogin = payload.openAtLogin === true;
  if (Object.prototype.hasOwnProperty.call(payload, 'immersiveAutoFullscreen')) next.immersiveAutoFullscreen = payload.immersiveAutoFullscreen === true;
  if (Object.prototype.hasOwnProperty.call(payload, 'cubeRemoteSkin')) next.cubeRemoteSkin = clampCubeRemoteSkin(payload.cubeRemoteSkin);
  const wantsRemoteToggle = Object.prototype.hasOwnProperty.call(payload, 'cubeRemote');
  const remoteEnabled = wantsRemoteToggle ? payload.cubeRemote === true : null;
  // 开关统一走 setCubeRemoteEnabled；皮肤可先写入行为配置
  const saved = Object.keys(next).length ? saveDesktopBehaviorSettings(next) : readDesktopBehaviorSettings();
  if (Object.prototype.hasOwnProperty.call(next, 'cubeRemoteSkin')) {
    cubeRemoteState = { ...cubeRemoteState, skin: next.cubeRemoteSkin };
    if (cubeRemoteWindow && !cubeRemoteWindow.isDestroyed()) {
      const bounds = cubeRemoteWindow.getBounds();
      const sized = resizeCubeRemoteBounds(bounds, cubeRemoteState);
      cubeRemoteWindow.setBounds(sized, false);
      rememberCubeRemoteBounds(cubeRemoteWindow.getBounds(), { immediate: true });
      sendCubeRemoteState();
    }
  }
  if (wantsRemoteToggle) {
    setCubeRemoteEnabled(remoteEnabled, {
      skin: (next.cubeRemoteSkin || saved.cubeRemoteSkin || cubeRemoteState.skin || 'cube'),
    });
  }
  return readDesktopBehaviorSettings();
});

ipcMain.handle('mineradio-tray-playback-update', (_event, payload = {}) => {
  trayPlaybackState = {
    title: String(payload.title || '未播放').trim() || '未播放',
    artist: String(payload.artist || '').trim(),
    playing: payload.playing === true,
    volume: Math.max(0, Math.min(1, Number(payload.volume) || 0)),
    cover: String(payload.cover || '').trim(),
    muted: payload.muted === true,
  };
  ensureMineradioTray();
  updateMineradioTray();
  if (cubeRemoteWindow && !cubeRemoteWindow.isDestroyed()) {
    cubeRemoteState = {
      ...cubeRemoteState,
      title: trayPlaybackState.title,
      artist: trayPlaybackState.artist,
      cover: trayPlaybackState.cover,
      playing: trayPlaybackState.playing,
      volume: trayPlaybackState.volume,
      muted: trayPlaybackState.muted,
    };
    sendCubeRemoteState();
  }
  return { ok: true };
});

ipcMain.handle('mineradio-cube-remote-set-enabled', (_event, enabled, payload) => {
  try {
    return setCubeRemoteEnabled(!!enabled, payload || {});
  } catch (e) {
    return { ok: false, error: e.message || 'CUBE_REMOTE_FAILED' };
  }
});

ipcMain.handle('mineradio-cube-remote-update', (_event, payload = {}) => {
  try {
    const nextPayload = { ...(payload || {}) };
    if (Object.prototype.hasOwnProperty.call(nextPayload, 'skin')) {
      nextPayload.skin = clampCubeRemoteSkin(nextPayload.skin);
      saveDesktopBehaviorSettings({ cubeRemoteSkin: nextPayload.skin });
    }
    const prevSkin = cubeRemoteState.skin;
    cubeRemoteState = { ...cubeRemoteState, ...nextPayload };
    if (cubeRemoteState.enabled) {
      if (!cubeRemoteWindow || cubeRemoteWindow.isDestroyed()) createCubeRemoteWindow(cubeRemoteState);
      else {
        if (prevSkin !== cubeRemoteState.skin) {
          const bounds = cubeRemoteWindow.getBounds();
          const sized = resizeCubeRemoteBounds(bounds, cubeRemoteState);
          cubeRemoteWindow.setBounds(sized, false);
          rememberCubeRemoteBounds(cubeRemoteWindow.getBounds());
        }
        sendCubeRemoteState();
      }
    }
    return { ok: true, skin: cubeRemoteState.skin };
  } catch (e) {
    return { ok: false, error: e.message || 'CUBE_REMOTE_UPDATE_FAILED' };
  }
});

ipcMain.handle('mineradio-cube-remote-command', (_event, command, payload = {}) => {
  try {
    const cmd = String(command || '').trim();
    if (!cmd) return { ok: false, error: 'CUBE_COMMAND_EMPTY' };
    if (cmd === 'open-main') {
      focusMainWindow();
      return { ok: true };
    }
    if (cmd === 'toggle-main') {
      const visible = toggleMainWindowVisibility();
      return { ok: true, visible };
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('mineradio-cube-remote-command', { command: cmd, ...(payload || {}) });
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || 'CUBE_COMMAND_FAILED' };
  }
});

ipcMain.handle('mineradio-cube-remote-move-by', (_event, dx, dy) => {
  try {
    if (!cubeRemoteWindow || cubeRemoteWindow.isDestroyed()) return { ok: false, error: 'NO_CUBE_WINDOW' };
    const bounds = cubeRemoteWindow.getBounds();
    const cursor = screen.getCursorScreenPoint();
    let moveX = clampNumber(dx, -240, 240, 0);
    let moveY = clampNumber(dy, -240, 240, 0);
    if (cubeRemoteDragCursor) {
      moveX = clampNumber(cursor.x - cubeRemoteDragCursor.x, -240, 240, 0);
      moveY = clampNumber(cursor.y - cubeRemoteDragCursor.y, -240, 240, 0);
      cubeRemoteDragCursor = cursor;
    }
    const size = cubeRemoteSize(cubeRemoteState);
    const next = constrainCubeRemoteBounds({
      ...bounds,
      x: Math.round(bounds.x + moveX),
      y: Math.round(bounds.y + moveY),
      width: size.width,
      height: size.height,
    });
    cubeRemoteWindow.setBounds(next, false);
    rememberCubeRemoteBounds(cubeRemoteWindow.getBounds());
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || 'CUBE_MOVE_FAILED' };
  }
});

ipcMain.handle('mineradio-cube-remote-set-dragging', (_event, dragging) => {
  cubeRemoteDragCursor = dragging ? screen.getCursorScreenPoint() : null;
  return { ok: true };
});

ipcMain.handle('mineradio-cube-remote-resize', (_event, payload = {}) => {
  try {
    if (!cubeRemoteWindow || cubeRemoteWindow.isDestroyed()) return { ok: false, error: 'NO_CUBE_WINDOW' };
    if (payload && payload.skin) {
      cubeRemoteState = { ...cubeRemoteState, skin: clampCubeRemoteSkin(payload.skin) };
      saveDesktopBehaviorSettings({ cubeRemoteSkin: cubeRemoteState.skin });
    }
    const size = cubeRemoteSize(cubeRemoteState);
    const bounds = cubeRemoteWindow.getBounds();
    const next = constrainCubeRemoteBounds({
      x: Math.round(bounds.x + (bounds.width - size.width) / 2),
      y: Math.round(bounds.y + (bounds.height - size.height) / 2),
      width: size.width,
      height: size.height,
    });
    cubeRemoteWindow.setBounds(next, false);
    rememberCubeRemoteBounds(cubeRemoteWindow.getBounds());
    sendCubeRemoteState();
    return { ok: true, skin: cubeRemoteState.skin, ...size };
  } catch (e) {
    return { ok: false, error: e.message || 'CUBE_RESIZE_FAILED' };
  }
});

ipcMain.handle('mineradio-hotkeys-configure-global', (_event, bindings) => {
  return configureMineradioGlobalHotkeys(bindings);
});

ipcMain.handle('mineradio-export-json-file', async (event, payload = {}) => {
  try {
    const owner = getSenderWindow(event);
    const defaultName = String(payload.defaultName || 'mineradio-export.json').replace(/[\\/:*?"<>|]+/g, '-');
    const result = await dialog.showSaveDialog(owner, {
      title: '导出 Mineradio 存档',
      defaultPath: defaultName.toLowerCase().endsWith('.json') ? defaultName : `${defaultName}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    const text = typeof payload.text === 'string' ? payload.text : JSON.stringify(payload.data || {}, null, 2);
    fs.writeFileSync(result.filePath, text, 'utf8');
    return { ok: true, filePath: result.filePath };
  } catch (e) {
    return { ok: false, error: e.message || 'EXPORT_FAILED' };
  }
});

ipcMain.handle('mineradio-import-json-file', async (event) => {
  try {
    const owner = getSenderWindow(event);
    const result = await dialog.showOpenDialog(owner, {
      title: '导入 Mineradio 存档',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePaths || !result.filePaths[0]) return { ok: false, canceled: true };
    const filePath = result.filePaths[0];
    const text = fs.readFileSync(filePath, 'utf8');
    return { ok: true, filePath, text };
  } catch (e) {
    return { ok: false, error: e.message || 'IMPORT_FAILED' };
  }
});

ipcMain.handle('mineradio-local-music-choose-folder', async (event) => {
  try {
    const owner = getSenderWindow(event);
    const result = await dialog.showOpenDialog(owner, {
      title: '选择本地音乐文件夹',
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths || !result.filePaths[0]) return { ok: false, canceled: true };
    return await scanLocalMusicFolder(result.filePaths[0]);
  } catch (e) {
    return { ok: false, error: e.message || 'LOCAL_LIBRARY_CHOOSE_FAILED' };
  }
});

function downloadSettingsPath() {
  return path.join(app.getPath('userData'), DOWNLOAD_SETTINGS_FILE);
}

function defaultDownloadDir() {
  return path.join(app.getPath('music'), 'Mineradio');
}

function readSavedDownloadDir() {
  try {
    const raw = JSON.parse(fs.readFileSync(downloadSettingsPath(), 'utf8')) || {};
    const dir = String(raw.dir || '').trim();
    return dir || '';
  } catch (_e) {
    return '';
  }
}

function saveDownloadDir(dir) {
  try {
    fs.writeFileSync(downloadSettingsPath(), JSON.stringify({ dir: String(dir || '') }, null, 2), 'utf8');
  } catch (e) {
    console.warn('Download dir save failed:', e.message);
  }
}


function currentDownloadDir() {
  return process.env.MINERADIO_DOWNLOAD_DIR || defaultDownloadDir();
}

ipcMain.handle('mineradio-download-open-dir', async () => {
  try {
    const dir = currentDownloadDir();
    fs.mkdirSync(dir, { recursive: true });
    const error = await shell.openPath(dir);
    return error ? { ok: false, error } : { ok: true, dir };
  } catch (e) {
    return { ok: false, error: e.message || 'OPEN_DIR_FAILED' };
  }
});

ipcMain.handle('mineradio-download-get-dir', () => {
  return { dir: currentDownloadDir(), isDefault: !readSavedDownloadDir() };
});

ipcMain.handle('mineradio-download-set-dir', async (event) => {
  try {
    const owner = getSenderWindow(event);
    const result = await dialog.showOpenDialog(owner, {
      title: '选择下载文件夹',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: currentDownloadDir(),
    });
    if (result.canceled || !result.filePaths || !result.filePaths[0]) return { ok: false, canceled: true };
    const dir = result.filePaths[0];
    process.env.MINERADIO_DOWNLOAD_DIR = dir;
    saveDownloadDir(dir);
    return { ok: true, dir };
  } catch (e) {
    return { ok: false, error: e.message || 'SET_DIR_FAILED' };
  }
});

ipcMain.handle('mineradio-download-reset-dir', async () => {
  try {
    const dir = defaultDownloadDir();
    process.env.MINERADIO_DOWNLOAD_DIR = dir;
    saveDownloadDir('');
    return { ok: true, dir, isDefault: true };
  } catch (e) {
    return { ok: false, error: e.message || 'RESET_DIR_FAILED' };
  }
});

ipcMain.handle('mineradio-local-music-scan-folder', async (_event, folderPath) => {
  try {
    if (!folderPath) return { ok: false, error: 'LOCAL_LIBRARY_PATH_EMPTY' };
    return await scanLocalMusicFolder(folderPath);
  } catch (e) {
    return { ok: false, error: e.message || 'LOCAL_LIBRARY_SCAN_FAILED' };
  }
});

ipcMain.handle('mineradio-local-music-resolve-file', async (_event, filePath, options) => {
  try {
    if (!filePath) return { ok: false, error: 'LOCAL_LIBRARY_FILE_PATH_EMPTY' };
    const file = localLibraryEntryFromPath(filePath, path.dirname(path.resolve(String(filePath))));
    if (!file) return { ok: false, error: 'LOCAL_LIBRARY_FILE_MISSING' };
    await enrichLocalLibraryEntryMetadata(file);
    if (!(options && options.deferCacheSave)) scheduleLocalAudioMetadataCacheSave();
    return { ok: true, file };
  } catch (e) {
    return { ok: false, error: e.message || 'LOCAL_LIBRARY_FILE_RESOLVE_FAILED' };
  }
});

ipcMain.handle('mineradio-local-audio-metadata-cache-flush', async () => {
  try {
    if (localAudioMetadataCacheSaveTimer) {
      clearTimeout(localAudioMetadataCacheSaveTimer);
      localAudioMetadataCacheSaveTimer = null;
    }
    await saveLocalAudioMetadataCache();
    if (localAudioMetadataCacheDirty) return { ok: false, error: 'LOCAL_AUDIO_METADATA_CACHE_WRITE_FAILED' };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || 'LOCAL_AUDIO_METADATA_CACHE_FLUSH_FAILED' };
  }
});

function localLyricsCachePath(cacheKey) {
  const hash = crypto.createHash('sha256').update(String(cacheKey || '')).digest('hex');
  return path.join(app.getPath('userData'), 'local-lyrics-cache', `${hash}.json`);
}

const LOCAL_LYRICS_CACHE_MAX_FILES = 6000;
const LOCAL_LYRICS_CACHE_MAX_BYTES = 256 * 1024 * 1024;
const LOCAL_LYRICS_CACHE_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;
let localLyricsCacheCleanupAt = 0;
let localLyricsCacheCleanupPromise = null;

function scheduleLocalLyricsCacheCleanup() {
  if (localLyricsCacheCleanupPromise || Date.now() - localLyricsCacheCleanupAt < 6 * 60 * 60 * 1000) return;
  localLyricsCacheCleanupAt = Date.now();
  localLyricsCacheCleanupPromise = (async () => {
    const dir = path.dirname(localLyricsCachePath('cleanup'));
    let names = [];
    try { names = await fs.promises.readdir(dir); } catch (error) {
      if (error && error.code !== 'ENOENT') console.warn('Local lyrics cache cleanup failed:', error.message);
      return;
    }
    const files = (await Promise.all(names.filter((name) => name.endsWith('.json')).map(async (name) => {
      const filePath = path.join(dir, name);
      try {
        const stat = await fs.promises.stat(filePath);
        return { filePath, size: stat.size, touchedAt: Math.max(stat.mtimeMs, stat.atimeMs) };
      } catch (_error) { return null; }
    }))).filter(Boolean).sort((a, b) => b.touchedAt - a.touchedAt);
    let keptBytes = 0;
    let keptFiles = 0;
    const now = Date.now();
    const expired = [];
    files.forEach((file) => {
      const canKeep = keptFiles < LOCAL_LYRICS_CACHE_MAX_FILES &&
        keptBytes + file.size <= LOCAL_LYRICS_CACHE_MAX_BYTES &&
        now - file.touchedAt <= LOCAL_LYRICS_CACHE_MAX_AGE_MS;
      if (canKeep) {
        keptFiles += 1;
        keptBytes += file.size;
      } else {
        expired.push(file.filePath);
      }
    });
    await Promise.all(expired.map(async (filePath) => {
      try { await fs.promises.unlink(filePath); } catch (_error) {}
    }));
  })().catch((error) => {
    console.warn('Local lyrics cache cleanup failed:', error.message);
  }).finally(() => { localLyricsCacheCleanupPromise = null; });
}

function localOnlineMetadataCacheFile() {
  return path.join(app.getPath('userData'), 'local-online-metadata-cache-v1.json');
}

let localOnlineMetadataCacheWritePromise = Promise.resolve();

ipcMain.handle('mineradio-local-online-metadata-cache-get', async () => {
  try {
    const payload = JSON.parse(await fs.promises.readFile(localOnlineMetadataCacheFile(), 'utf8'));
    return { ok: true, payload: payload && typeof payload === 'object' ? payload : {} };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: true, payload: {} };
    return { ok: false, error: e.message || 'LOCAL_ONLINE_METADATA_CACHE_READ_FAILED' };
  }
});

ipcMain.handle('mineradio-local-online-metadata-cache-set', async (_event, payload) => {
  const source = payload && typeof payload === 'object' ? payload : {};
  const keys = Object.keys(source).slice(-24000);
  const safePayload = {};
  keys.forEach((key) => {
    if (key && source[key] && typeof source[key] === 'object') safePayload[String(key).slice(0, 2048)] = source[key];
  });
  localOnlineMetadataCacheWritePromise = localOnlineMetadataCacheWritePromise.catch(() => {}).then(() => fs.promises.writeFile(localOnlineMetadataCacheFile(), JSON.stringify(safePayload), 'utf8'));
  try {
    await localOnlineMetadataCacheWritePromise;
    return { ok: true, count: keys.length };
  } catch (e) {
    return { ok: false, error: e.message || 'LOCAL_ONLINE_METADATA_CACHE_WRITE_FAILED' };
  }
});

ipcMain.handle('mineradio-local-lyrics-cache-get', async (_event, cacheKey) => {
  try {
    if (!cacheKey) return { ok: false, error: 'LOCAL_LYRIC_CACHE_KEY_EMPTY' };
    const payload = JSON.parse(await fs.promises.readFile(localLyricsCachePath(cacheKey), 'utf8'));
    const now = new Date();
    fs.promises.utimes(localLyricsCachePath(cacheKey), now, now).catch(() => {});
    scheduleLocalLyricsCacheCleanup();
    return { ok: true, payload };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: true, payload: null };
    return { ok: false, error: e.message || 'LOCAL_LYRIC_CACHE_READ_FAILED' };
  }
});

ipcMain.handle('mineradio-local-lyrics-cache-set', async (_event, cacheKey, payload) => {
  try {
    if (!cacheKey) return { ok: false, error: 'LOCAL_LYRIC_CACHE_KEY_EMPTY' };
    const safePayload = {
      provider: String(payload && payload.provider || '').slice(0, 24),
      songId: String(payload && payload.songId || '').slice(0, 160),
      lyric: String(payload && payload.lyric || '').slice(0, 1024 * 1024),
      yrc: String(payload && payload.yrc || '').slice(0, 1024 * 1024),
      updatedAt: Date.now(),
    };
    const filePath = localLyricsCachePath(cacheKey);
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, JSON.stringify(safePayload), 'utf8');
    scheduleLocalLyricsCacheCleanup();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || 'LOCAL_LYRIC_CACHE_WRITE_FAILED' };
  }
});

ipcMain.handle('mineradio-local-music-show-in-folder', async (_event, filePath) => {
  try {
    if (!filePath) return { ok: false, error: 'LOCAL_LIBRARY_FILE_PATH_EMPTY' };
    const target = path.resolve(String(filePath));
    if (!fs.existsSync(target)) {
      return { ok: false, error: 'LOCAL_LIBRARY_FILE_MISSING' };
    }
    const stat = fs.statSync(target);
    if (stat.isDirectory()) {
      const error = await shell.openPath(target);
      return error ? { ok: false, error } : { ok: true };
    }
    if (!stat.isFile()) {
      return { ok: false, error: 'LOCAL_LIBRARY_FILE_MISSING' };
    }
    shell.showItemInFolder(target);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || 'LOCAL_LIBRARY_SHOW_IN_FOLDER_FAILED' };
  }
});

ipcMain.handle('netease-music-open-login', async (event) => {
  return openNeteaseMusicLoginWindow(getSenderWindow(event));
});

ipcMain.handle('netease-music-clear-login', async () => {
  return clearNeteaseMusicLoginSession();
});

ipcMain.handle('kugou-music-open-login', async (event) => {
  return openKugouMusicLoginWindow(getSenderWindow(event));
});

ipcMain.handle('kugou-music-clear-login', async () => {
  return clearKugouMusicLoginSession();
});

ipcMain.handle('mineradio-open-update-installer', async (_event, filePath) => {
  try {
    const target = path.resolve(String(filePath || ''));
    const updateDir = path.resolve(getUpdateDownloadDir());
    if (!target || !target.startsWith(updateDir + path.sep)) {
      return { ok: false, error: 'INVALID_UPDATE_PATH' };
    }
    if (!fs.existsSync(target)) return { ok: false, error: 'UPDATE_FILE_MISSING' };
    const error = await shell.openPath(target);
    return error ? { ok: false, error } : { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || 'OPEN_UPDATE_FAILED' };
  }
});

ipcMain.handle('mineradio-restart-app', async () => {
  try {
    app.relaunch();
    app.exit(0);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || 'RESTART_FAILED' };
  }
});

ipcMain.handle('mineradio-desktop-lyrics-set-enabled', async (_event, enabled, payload) => {
  try {
    if (enabled) {
      createDesktopLyricsWindow(payload || {});
      broadcastDesktopLyricsEnabledState(true);
    } else {
      closeDesktopLyricsWindow({ fromUser: true });
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || 'DESKTOP_LYRICS_FAILED' };
  }
});

ipcMain.handle('mineradio-desktop-lyrics-update', async (_event, payload) => {
  try {
    const nextState = { ...desktopLyricsState, ...(payload || {}) };
    if (nextState.enabled) {
      createDesktopLyricsWindow(payload || {});
    } else if (desktopLyricsWindow && !desktopLyricsWindow.isDestroyed()) {
      desktopLyricsState = nextState;
      sendDesktopLyricsState();
    } else {
      desktopLyricsState = nextState;
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || 'DESKTOP_LYRICS_UPDATE_FAILED' };
  }
});

ipcMain.handle('mineradio-desktop-lyrics-set-dragging', async () => {
  return { ok: true };
});

ipcMain.handle('mineradio-desktop-lyrics-set-pointer-capture', async (_event, active) => {
  try {
    desktopLyricsPointerCapture = !!active;
    applyDesktopLyricsMouseBehavior();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || 'DESKTOP_LYRICS_POINTER_FAILED' };
  }
});

ipcMain.handle('mineradio-desktop-lyrics-set-hot-bounds', async (_event, bounds) => {
  try {
    const left = clampNumber(bounds && bounds.left, -2000, 4000, 0);
    const top = clampNumber(bounds && bounds.top, -2000, 4000, 0);
    const right = clampNumber(bounds && bounds.right, left + 1, 6000, left + 1);
    const bottom = clampNumber(bounds && bounds.bottom, top + 1, 6000, top + 1);
    desktopLyricsHotBounds = { left, top, right, bottom };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || 'DESKTOP_LYRICS_HOT_BOUNDS_FAILED' };
  }
});

ipcMain.handle('mineradio-desktop-lyrics-set-lock-state', async (_event, locked) => {
  try {
    desktopLyricsState = { ...desktopLyricsState, clickThrough: !!locked };
    if (desktopLyricsState.clickThrough !== false) desktopLyricsPointerCapture = false;
    applyDesktopLyricsMouseBehavior();
    broadcastDesktopLyricsLockState();
    return { ok: true, locked: desktopLyricsState.clickThrough !== false };
  } catch (e) {
    return { ok: false, error: e.message || 'DESKTOP_LYRICS_LOCK_FAILED' };
  }
});

ipcMain.handle('mineradio-desktop-lyrics-move-by', async (_event, dx, dy) => {
  try {
    if (!desktopLyricsWindow || desktopLyricsWindow.isDestroyed()) return { ok: false, error: 'NO_DESKTOP_LYRICS_WINDOW' };
    if (desktopLyricsState.clickThrough !== false) return { ok: false, error: 'DESKTOP_LYRICS_LOCKED' };
    const bounds = desktopLyricsWindow.getBounds();
    const next = {
      ...bounds,
      x: Math.round(bounds.x + clampNumber(dx, -160, 160, 0)),
      y: Math.round(bounds.y + clampNumber(dy, -160, 160, 0)),
    };
    desktopLyricsWindow.setBounds(next, false);
    rememberDesktopLyricsBoundsPersist(desktopLyricsWindow.getBounds(), { immediate: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || 'DESKTOP_LYRICS_MOVE_FAILED' };
  }
});

ipcMain.handle('mineradio-wallpaper-set-enabled', async (_event, enabled, payload) => {
  try {
    if (enabled) createWallpaperWindow(payload || {});
    else closeWallpaperWindow();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || 'WALLPAPER_FAILED' };
  }
});

ipcMain.handle('mineradio-wallpaper-update', async (_event, payload) => {
  try {
    wallpaperState = { ...wallpaperState, ...(payload || {}) };
    if (wallpaperState.enabled) {
      createWallpaperWindow(wallpaperState);
      if (wallpaperWindow && !wallpaperWindow.isDestroyed()) {
        positionWallpaperWindow();
        sendWallpaperState();
      }
    } else if (wallpaperWindow && !wallpaperWindow.isDestroyed()) {
      sendWallpaperState();
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || 'WALLPAPER_UPDATE_FAILED' };
  }
});

async function createWindow() {
  htmlFullscreenActive = false;
  windowFullscreenActive = false;
  saveDesktopBehaviorSettings(readDesktopBehaviorSettings());
  ensureMineradioTray();
  const port = await findOpenPort(3000);
  mainServerPort = port;

  process.env.HOST = '127.0.0.1';
  process.env.PORT = String(port);
  process.env.COOKIE_FILE = path.join(app.getPath('userData'), '.cookie');
  process.env.KUGOU_COOKIE_FILE = path.join(app.getPath('userData'), '.kugou-cookie');
  process.env.MINERADIO_UPDATE_DIR = getUpdateDownloadDir();
  process.env.MINERADIO_DOWNLOAD_DIR = readSavedDownloadDir() || defaultDownloadDir();
  localServer = require(path.join(__dirname, '..', 'server.js'));
  await waitForServer(localServer);

  const initialBounds = getWindowedBounds();

  mainWindow = new BrowserWindow({
    ...initialBounds,
    minWidth: 960,
    minHeight: 540,
    show: false,
    frame: false,
    fullscreen: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: true,
    autoHideMenuBar: true,
    title: APP_NAME,
    icon: APP_ICON_ICO,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.once('did-finish-load', () => {
    sendWindowState(mainWindow);
  });

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && (input.key === 'Escape' || input.code === 'Escape') && mainWindow.isFullScreen()) {
      event.preventDefault();
      exitFullscreenToWindow(mainWindow);
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    sendWindowState(mainWindow);
  });

  mainWindow.on('maximize', () => sendWindowState(mainWindow));
  mainWindow.on('unmaximize', () => sendWindowState(mainWindow));
  mainWindow.on('minimize', () => {
    sendWindowState(mainWindow);
    syncCubeMainVisibility();
  });
  mainWindow.on('restore', () => {
    sendWindowState(mainWindow);
    syncCubeMainVisibility();
  });
  mainWindow.on('show', () => {
    sendWindowState(mainWindow);
    syncCubeMainVisibility();
  });
  mainWindow.on('hide', () => {
    sendWindowState(mainWindow);
    syncCubeMainVisibility();
  });
  mainWindow.on('focus', () => sendWindowState(mainWindow));
  mainWindow.on('blur', () => sendWindowState(mainWindow));
  mainWindow.on('move', () => scheduleWindowStateSend(mainWindow));
  mainWindow.on('resize', () => scheduleWindowStateSend(mainWindow));
  mainWindow.on('close', (event) => {
    if (appQuitting) return;
    if (readDesktopBehaviorSettings().closeToTray) {
      event.preventDefault();
      mainWindow.hide();
      updateMineradioTray();
    }
  });
  mainWindow.on('closed', () => {
    if (mainWindowStateTimer) {
      clearTimeout(mainWindowStateTimer);
      mainWindowStateTimer = null;
    }
    closeOverlayWindows();
    mainWindow = null;
  });
  mainWindow.on('enter-full-screen', () => {
    windowFullscreenActive = true;
    sendWindowState(mainWindow);
  });
  mainWindow.on('leave-full-screen', () => {
    windowFullscreenActive = false;
    setTimeout(() => applyWindowedBounds(mainWindow), 50);
  });
  mainWindow.on('enter-html-full-screen', () => {
    htmlFullscreenActive = true;
    sendWindowState(mainWindow);
  });
  mainWindow.on('leave-html-full-screen', () => {
    htmlFullscreenActive = false;
    setTimeout(() => applyWindowedBounds(mainWindow), 50);
  });

  await mainWindow.loadURL(`http://127.0.0.1:${port}`);
  if (readDesktopBehaviorSettings().cubeRemote) {
    createCubeRemoteWindow({ enabled: true });
    broadcastCubeRemoteEnabledState(true);
  }
}

app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_ID);

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!focusMainWindow()) {
      app.whenReady().then(() => createWindow()).catch((e) => console.error('Second instance window restore failed:', e));
    }
  });

  app.whenReady().then(async () => {
    screen.on('display-metrics-changed', () => {
      positionDesktopLyricsWindow();
      positionWallpaperWindow();
      scheduleWindowStateSend(mainWindow);
    });
    screen.on('display-added', () => scheduleWindowStateSend(mainWindow));
    screen.on('display-removed', () => scheduleWindowStateSend(mainWindow));
    await createWindow();
    scheduleLegacyUpdaterCacheCleanup();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else focusMainWindow();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    appQuitting = true;
    if (legacyUpdaterCleanupTimer) {
      clearTimeout(legacyUpdaterCleanupTimer);
      legacyUpdaterCleanupTimer = null;
    }
    unregisterMineradioGlobalHotkeys();
    flushCubeRemoteBoundsSave();
    flushDesktopLyricsBoundsSave();
    closeOverlayWindows();
    if (localServer && localServer.close) localServer.close();
  });
}
