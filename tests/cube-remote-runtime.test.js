'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const {
  CubeRemoteRuntime,
  clampSkin,
  normalizeBounds,
  sanitizeState,
} = require('../desktop/cube-remote-runtime');

class FakeWebContents extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
  }

  send(channel, payload) {
    this.sent.push([channel, payload]);
  }
}

class FakeWindow extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
    this.visible = options.show === true;
    this.minimized = false;
    this.destroyed = false;
    this.webContents = new FakeWebContents();
    this.loadedUrl = '';
    this.calls = [];
    FakeWindow.instances.push(this);
  }

  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  isMinimized() { return this.minimized; }
  getBounds() { return { ...this.bounds }; }
  setBounds(bounds) { this.bounds = { ...bounds }; this.calls.push(['setBounds', { ...bounds }]); }
  setAlwaysOnTop(...args) { this.calls.push(['setAlwaysOnTop', ...args]); }
  setVisibleOnAllWorkspaces(...args) { this.calls.push(['setVisibleOnAllWorkspaces', ...args]); }
  showInactive() { this.visible = true; this.calls.push(['showInactive']); }
  hide() { this.visible = false; this.calls.push(['hide']); }
  loadURL(url) { this.loadedUrl = url; return Promise.resolve(); }
  close() { this.destroyed = true; this.emit('closed'); }
}
FakeWindow.instances = [];

function makeIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, handler) { handlers.set(channel, handler); },
  };
}

function makeRuntime(directory, options = {}) {
  const ipcMain = makeIpcMain();
  const mainWindow = new FakeWindow({ x: 100, y: 80, width: 1280, height: 720, show: true });
  const screen = {
    getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
    getDisplayMatching: () => ({ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
    getCursorScreenPoint: () => ({ x: 800, y: 500 }),
  };
  let focused = 0;
  let toggled = 0;
  const runtime = new CubeRemoteRuntime({
    BrowserWindow: FakeWindow,
    ipcMain,
    screen,
    spawn: null,
    fs,
    path,
    preloadPath: 'D:\\projects\\Mineradio\\desktop\\overlay-preload.js',
    userDataPath: directory,
    getOverlayUrl: (page) => `http://127.0.0.1:3000/${page}`,
    getMainWindow: () => mainWindow,
    focusMainWindow: () => { focused += 1; return true; },
    toggleMainWindow: () => { toggled += 1; return false; },
    isAppQuitting: () => false,
    logger: { warn() {} },
    ...options,
  });
  return { runtime, ipcMain, mainWindow, counts: () => ({ focused, toggled }) };
}

test('cube remote helpers reject unknown skins and normalize persisted bounds', () => {
  assert.equal(clampSkin('moon'), 'moon');
  assert.equal(clampSkin('unknown'), 'cube');
  assert.deepEqual(normalizeBounds({ x: 14.7, y: -2.2, width: 999, height: 999 }, 'bar'), {
    x: 15, y: -2, width: 320, height: 84,
  });
  assert.equal(normalizeBounds({ x: 'bad', y: 1 }, 'cube'), null);
  assert.deepEqual(sanitizeState({ playing: 1, volume: 7, title: '  ', skin: 'bad' }, {}), {
    skin: 'cube', title: '未播放', playing: false, volume: 1,
  });
});

test('enabling creates one hardened overlay, resizes skins, and persists position', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-cube-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  FakeWindow.instances.length = 0;
  const { runtime, mainWindow } = makeRuntime(directory);

  const enabled = runtime.setEnabled(true, { skin: 'bar', title: '测试歌曲', playing: true, volume: 0.4 });
  const remote = runtime.window;
  assert.deepEqual(enabled, { ok: true, enabled: true, skin: 'bar' });
  assert.equal(FakeWindow.instances.length, 2);
  assert.equal(remote.options.frame, false);
  assert.equal(remote.options.transparent, true);
  assert.equal(remote.options.nodeIntegration, undefined);
  assert.equal(remote.options.webPreferences.nodeIntegration, false);
  assert.equal(remote.options.webPreferences.contextIsolation, true);
  assert.equal(remote.loadedUrl, 'http://127.0.0.1:3000/cube-remote.html');
  assert.deepEqual({ width: remote.bounds.width, height: remote.bounds.height }, { width: 320, height: 84 });

  remote.emit('ready-to-show');
  remote.webContents.emit('did-finish-load');
  assert.equal(remote.visible, true);
  assert.equal(remote.webContents.sent.at(-1)[0], 'mineradio-cube-remote-state');
  assert.equal(remote.webContents.sent.at(-1)[1].mainVisible, true);

  runtime.update({ skin: 'moon' });
  assert.deepEqual({ width: remote.bounds.width, height: remote.bounds.height }, { width: 248, height: 248 });
  remote.setBounds({ x: 260, y: 180, width: 248, height: 248 });
  remote.emit('moved');
  runtime.close({ preserveEnabled: true });

  const saved = JSON.parse(fs.readFileSync(path.join(directory, 'cube-remote.json'), 'utf8'));
  assert.equal(saved.enabled, true);
  assert.equal(saved.skin, 'moon');
  assert.deepEqual(saved.bounds, { x: 260, y: 180, width: 248, height: 248 });
  assert.equal(mainWindow.webContents.sent.at(-1)[0], 'mineradio-cube-remote-enabled-state');
});

test('IPC accepts only the main or remote sender and forwards bounded commands', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-cube-ipc-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  FakeWindow.instances.length = 0;
  const { runtime, ipcMain, mainWindow, counts } = makeRuntime(directory);
  runtime.setEnabled(true, { skin: 'cube' });
  const remote = runtime.window;
  const command = ipcMain.handlers.get('mineradio-cube-remote-command');
  const getSettings = ipcMain.handlers.get('mineradio-cube-remote-get-settings');

  assert.deepEqual(await getSettings({ sender: {} }), { ok: false, error: 'UNTRUSTED_CUBE_REMOTE_IPC' });
  assert.equal((await getSettings({ sender: mainWindow.webContents })).enabled, true);
  assert.deepEqual(await command({ sender: remote.webContents }, 'arbitrary-code', {}), { ok: false, error: 'CUBE_COMMAND_INVALID' });
  assert.deepEqual(await command({ sender: remote.webContents }, 'toggle-play', {}), { ok: true });
  assert.equal(mainWindow.webContents.sent.at(-1)[0], 'mineradio-cube-remote-command');
  assert.equal(mainWindow.webContents.sent.at(-1)[1].command, 'toggle-play');
  assert.deepEqual(await command({ sender: remote.webContents }, 'toggle-main', {}), { ok: true, visible: false });
  assert.equal(counts().toggled, 1);
});

test('renderer assets and preload wiring keep the feature in upstream module order', () => {
  const root = path.join(__dirname, '..');
  const loader = fs.readFileSync(path.join(root, 'public', 'js', 'index-loader.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'desktop', 'preload.js'), 'utf8');
  const overlay = fs.readFileSync(path.join(root, 'desktop', 'overlay-preload.js'), 'utf8');
  const remoteHtml = fs.readFileSync(path.join(root, 'public', 'cube-remote.html'), 'utf8');
  assert.match(loader, /10-shell\/04-desktop-overlay-fullscreen\.js'[\s\S]{0,120}10-shell\/04a-cube-remote-controller\.js'[\s\S]{0,120}10-shell\/05-startup-bindings\.js'/);
  assert.match(html, /id="t-cubeRemote"/);
  assert.equal((html.match(/data-cube-remote-skin=/g) || []).length, 3);
  assert.match(preload, /getCubeRemoteSettings/);
  assert.match(preload, /onCubeRemoteCommand/);
  assert.match(overlay, /sendCubeCommand/);
  assert.match(overlay, /moveCubeBy/);
  assert.match(remoteHtml, /Content-Security-Policy/);
  assert.match(remoteHtml, /id="skin-cube"/);
  assert.match(remoteHtml, /id="skin-bar"/);
  assert.match(remoteHtml, /id="skin-moon"/);
});
