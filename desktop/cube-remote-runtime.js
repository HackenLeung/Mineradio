'use strict';

const DEFAULT_SKIN = 'cube';
const SKIN_SIZES = Object.freeze({
  cube: Object.freeze({ width: 136, height: 136 }),
  bar: Object.freeze({ width: 320, height: 84 }),
  moon: Object.freeze({ width: 248, height: 248 }),
});
const COMMANDS = new Set(['toggle-play', 'next', 'previous', 'set-volume', 'mute', 'toggle-lyrics']);

function clampSkin(value) {
  const skin = String(value || DEFAULT_SKIN);
  return Object.prototype.hasOwnProperty.call(SKIN_SIZES, skin) ? skin : DEFAULT_SKIN;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function normalizeBounds(bounds, skin) {
  if (!bounds || typeof bounds !== 'object') return null;
  const size = SKIN_SIZES[clampSkin(skin)];
  const x = Number(bounds.x);
  const y = Number(bounds.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: Math.round(x), y: Math.round(y), width: size.width, height: size.height };
}

function sanitizeState(payload, previous = {}) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const next = { ...previous };
  if (Object.prototype.hasOwnProperty.call(source, 'skin')) next.skin = clampSkin(source.skin);
  if (Object.prototype.hasOwnProperty.call(source, 'title')) next.title = String(source.title || '未播放').trim() || '未播放';
  if (Object.prototype.hasOwnProperty.call(source, 'artist')) next.artist = String(source.artist || '').trim();
  if (Object.prototype.hasOwnProperty.call(source, 'cover')) next.cover = String(source.cover || '').trim();
  if (Object.prototype.hasOwnProperty.call(source, 'playing')) next.playing = source.playing === true;
  if (Object.prototype.hasOwnProperty.call(source, 'volume')) next.volume = clampNumber(source.volume, 0, 1, 0);
  if (Object.prototype.hasOwnProperty.call(source, 'muted')) next.muted = source.muted === true;
  if (Object.prototype.hasOwnProperty.call(source, 'lyricsEnabled')) next.lyricsEnabled = source.lyricsEnabled === true;
  return next;
}

class CubeRemoteRuntime {
  constructor(options = {}) {
    this.BrowserWindow = options.BrowserWindow;
    this.ipcMain = options.ipcMain;
    this.screen = options.screen;
    this.spawn = options.spawn;
    this.fs = options.fs;
    this.path = options.path;
    this.preloadPath = options.preloadPath;
    this.userDataPath = options.userDataPath;
    this.getOverlayUrl = options.getOverlayUrl;
    this.getMainWindow = options.getMainWindow;
    this.focusMainWindow = options.focusMainWindow;
    this.toggleMainWindow = options.toggleMainWindow;
    this.isAppQuitting = options.isAppQuitting || (() => false);
    this.logger = options.logger || console;
    this.settingsPath = this.path.join(this.userDataPath, 'cube-remote.json');
    this.window = null;
    this.dragCursor = null;
    this.boundsSaveTimer = null;
    this.poller = null;
    this.pollerBuffer = '';
    this.pollerRestartTimer = null;
    this.pollerRestartAttempts = 0;
    this.externalFullscreen = false;
    this.hiddenByFullscreen = false;
    this.state = {
      enabled: false,
      skin: DEFAULT_SKIN,
      title: '未播放',
      artist: '',
      cover: '',
      playing: false,
      volume: 0.85,
      muted: false,
      lyricsEnabled: false,
      mainVisible: true,
    };
    this.settings = this._readSettings();
    this.state.skin = this.settings.skin;
    this.state.enabled = this.settings.enabled;
    this._registerIpc();
  }

  _readSettings() {
    const defaults = { enabled: false, skin: DEFAULT_SKIN, bounds: null };
    try {
      const raw = JSON.parse(this.fs.readFileSync(this.settingsPath, 'utf8')) || {};
      const skin = clampSkin(raw.skin);
      return {
        enabled: raw.enabled === true,
        skin,
        bounds: normalizeBounds(raw.bounds, skin),
      };
    } catch (_) {
      return defaults;
    }
  }

  _saveSettings(patch = {}) {
    const skin = clampSkin(Object.prototype.hasOwnProperty.call(patch, 'skin') ? patch.skin : this.settings.skin);
    this.settings = {
      enabled: Object.prototype.hasOwnProperty.call(patch, 'enabled') ? patch.enabled === true : this.settings.enabled === true,
      skin,
      bounds: Object.prototype.hasOwnProperty.call(patch, 'bounds')
        ? normalizeBounds(patch.bounds, skin)
        : normalizeBounds(this.settings.bounds, skin),
    };
    try {
      this.fs.mkdirSync(this.userDataPath, { recursive: true });
      const temporary = `${this.settingsPath}.tmp`;
      this.fs.writeFileSync(temporary, JSON.stringify(this.settings, null, 2), 'utf8');
      this.fs.renameSync(temporary, this.settingsPath);
    } catch (error) {
      this.logger.warn('[CubeRemote] settings save failed:', error.message || error);
    }
    return this.getSettings();
  }

  getSettings() {
    return {
      enabled: this.settings.enabled === true,
      skin: clampSkin(this.settings.skin),
      bounds: this.settings.bounds ? { ...this.settings.bounds } : null,
    };
  }

  _mainWindowVisible() {
    const win = this.getMainWindow && this.getMainWindow();
    return !!(win && !win.isDestroyed() && win.isVisible() && !win.isMinimized());
  }

  _skinSize(skin = this.state.skin) {
    return { ...SKIN_SIZES[clampSkin(skin)] };
  }

  _constrainBounds(bounds, skin = this.state.skin) {
    const size = this._skinSize(skin);
    const source = normalizeBounds(bounds, skin) || this._defaultBounds(skin);
    const display = this.screen.getDisplayMatching(source);
    const area = display.workArea || display.bounds;
    const width = Math.min(size.width, area.width);
    const height = Math.min(size.height, area.height);
    return {
      x: Math.round(clampNumber(source.x, area.x, area.x + Math.max(0, area.width - width), area.x)),
      y: Math.round(clampNumber(source.y, area.y, area.y + Math.max(0, area.height - height), area.y)),
      width,
      height,
    };
  }

  _defaultBounds(skin = this.state.skin) {
    const size = this._skinSize(skin);
    const main = this.getMainWindow && this.getMainWindow();
    const display = main && !main.isDestroyed()
      ? this.screen.getDisplayMatching(main.getBounds())
      : this.screen.getPrimaryDisplay();
    const area = display.workArea || display.bounds;
    return {
      x: Math.round(area.x + area.width - size.width - 28),
      y: Math.round(area.y + area.height - size.height - 28),
      width: size.width,
      height: size.height,
    };
  }

  _resizeBounds(bounds, skin = this.state.skin) {
    const size = this._skinSize(skin);
    return this._constrainBounds({
      x: Math.round(bounds.x + (bounds.width - size.width) / 2),
      y: Math.round(bounds.y + (bounds.height - size.height) / 2),
      width: size.width,
      height: size.height,
    }, skin);
  }

  _rememberBounds(bounds, immediate = false) {
    this.settings.bounds = normalizeBounds(bounds, this.state.skin);
    if (this.boundsSaveTimer) clearTimeout(this.boundsSaveTimer);
    if (immediate) {
      this.boundsSaveTimer = null;
      this._saveSettings({ bounds: this.settings.bounds });
      return;
    }
    this.boundsSaveTimer = setTimeout(() => {
      this.boundsSaveTimer = null;
      this._saveSettings({ bounds: this.settings.bounds });
    }, 320);
  }

  _sendState() {
    if (!this.window || this.window.isDestroyed()) return;
    this.state.mainVisible = this._mainWindowVisible();
    this.window.webContents.send('mineradio-cube-remote-state', { ...this.state });
  }

  _broadcastEnabled() {
    const main = this.getMainWindow && this.getMainWindow();
    if (!main || main.isDestroyed()) return;
    main.webContents.send('mineradio-cube-remote-enabled-state', {
      enabled: this.state.enabled === true,
      skin: clampSkin(this.state.skin),
    });
  }

  _applyFullscreenVisibility(active) {
    this.externalFullscreen = active === true;
    if (!this.window || this.window.isDestroyed()) return;
    if (this.externalFullscreen) {
      this.hiddenByFullscreen = true;
      if (this.window.isVisible()) this.window.hide();
      return;
    }
    if (!this.hiddenByFullscreen) return;
    this.hiddenByFullscreen = false;
    if (this.state.enabled) this.window.showInactive();
  }

  _schedulePollerRestart() {
    if (this.pollerRestartTimer || this.isAppQuitting() || !this.state.enabled || !this.window) return;
    const delay = Math.min(15000, 1200 * (2 ** Math.min(this.pollerRestartAttempts, 4)));
    this.pollerRestartAttempts += 1;
    this.pollerRestartTimer = setTimeout(() => {
      this.pollerRestartTimer = null;
      this._startFullscreenPoller();
    }, delay);
  }

  _startFullscreenPoller() {
    if (process.platform !== 'win32' || this.poller || !this.spawn) return;
    if (this.pollerRestartTimer) clearTimeout(this.pollerRestartTimer);
    this.pollerRestartTimer = null;
    const script = `
$ErrorActionPreference = "SilentlyContinue"
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class MineradioCubeFullscreen {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int Size; public RECT Monitor; public RECT WorkArea; public uint Flags; }
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
  $window = [MineradioCubeFullscreen]::GetForegroundWindow()
  [void]$classNameBuilder.Clear()
  [void][MineradioCubeFullscreen]::GetClassName($window, $classNameBuilder, $classNameBuilder.Capacity)
  $className = $classNameBuilder.ToString()
  $isShellSurface = @("Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd") -contains $className
  if ($window -ne [IntPtr]::Zero -and -not $isShellSurface -and [MineradioCubeFullscreen]::IsWindowVisible($window) -and -not [MineradioCubeFullscreen]::IsIconic($window)) {
    [uint32]$ownerPid = 0
    [void][MineradioCubeFullscreen]::GetWindowThreadProcessId($window, [ref]$ownerPid)
    if ($ownerPid -ne 0 -and $ownerPid -ne $mineradioPid) {
      $rect = New-Object MineradioCubeFullscreen+RECT
      $monitor = [MineradioCubeFullscreen]::MonitorFromWindow($window, 2)
      $info = New-Object MineradioCubeFullscreen+MONITORINFO
      $info.Size = [Runtime.InteropServices.Marshal]::SizeOf($info)
      if ([MineradioCubeFullscreen]::GetWindowRect($window, [ref]$rect) -and $monitor -ne [IntPtr]::Zero -and [MineradioCubeFullscreen]::GetMonitorInfo($monitor, [ref]$info)) {
        $isExternalFullscreen = $rect.Left -le ($info.Monitor.Left + 2) -and $rect.Top -le ($info.Monitor.Top + 2) -and $rect.Right -ge ($info.Monitor.Right - 2) -and $rect.Bottom -ge ($info.Monitor.Bottom - 2)
      }
    }
  }
  $state = if ($isExternalFullscreen) { "1" } else { "0" }
  if ($state -ne $lastState) { [Console]::Out.WriteLine("FULLSCREEN " + $state); [Console]::Out.Flush(); $lastState = $state }
  Start-Sleep -Milliseconds 350
}`;
    try {
      const poller = this.spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      this.poller = poller;
      poller.stdout.on('data', (chunk) => {
        this.pollerBuffer += chunk.toString('utf8');
        const lines = this.pollerBuffer.split(/\r?\n/);
        this.pollerBuffer = lines.pop() || '';
        lines.forEach((line) => {
          const match = line.trim().match(/^FULLSCREEN\s+([01])$/);
          if (!match) return;
          this.pollerRestartAttempts = 0;
          this._applyFullscreenVisibility(match[1] === '1');
        });
      });
      const onEnd = () => {
        if (this.poller !== poller) return;
        this.poller = null;
        this.pollerBuffer = '';
        this._applyFullscreenVisibility(false);
        this._schedulePollerRestart();
      };
      poller.on('exit', onEnd);
      poller.on('error', onEnd);
    } catch (_) {
      this.poller = null;
      this._applyFullscreenVisibility(false);
      this._schedulePollerRestart();
    }
  }

  _stopFullscreenPoller() {
    if (this.pollerRestartTimer) clearTimeout(this.pollerRestartTimer);
    this.pollerRestartTimer = null;
    const poller = this.poller;
    this.poller = null;
    this.pollerBuffer = '';
    this.pollerRestartAttempts = 0;
    this.externalFullscreen = false;
    this.hiddenByFullscreen = false;
    if (poller) {
      try { poller.kill(); } catch (_) {}
    }
  }

  create(payload = {}) {
    const previousSkin = this.state.skin;
    this.state = sanitizeState(payload, { ...this.state, enabled: true });
    this.state.enabled = true;
    if (this.window && !this.window.isDestroyed()) {
      if (previousSkin !== this.state.skin) {
        const bounds = this._resizeBounds(this.window.getBounds(), this.state.skin);
        this.window.setBounds(bounds, false);
        this._rememberBounds(bounds, true);
      }
      this._startFullscreenPoller();
      this._sendState();
      return this.window;
    }
    const bounds = this._constrainBounds(this.settings.bounds || this._defaultBounds(this.state.skin), this.state.skin);
    this.window = new this.BrowserWindow({
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
      title: 'Mineradio Music Remote',
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    try {
      this.window.setAlwaysOnTop(true, 'screen-saver');
      this.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } catch (error) {
      this.logger.warn('[CubeRemote] topmost setup skipped:', error.message || error);
    }
    this._startFullscreenPoller();
    this.window.once('ready-to-show', () => {
      if (!this.window || this.window.isDestroyed()) return;
      this.window.setBounds(this._constrainBounds(this.window.getBounds()), false);
      if (!this.externalFullscreen) this.window.showInactive();
      this._sendState();
    });
    this.window.webContents.once('did-finish-load', () => this._sendState());
    this.window.on('moved', () => {
      if (this.window && !this.window.isDestroyed()) this._rememberBounds(this.window.getBounds());
    });
    this.window.on('closed', () => {
      this._stopFullscreenPoller();
      this.window = null;
      this.state.enabled = false;
      this._saveSettings({ enabled: false });
      this._broadcastEnabled();
    });
    this.window.loadURL(this.getOverlayUrl('cube-remote.html')).catch((error) => {
      this.logger.warn('[CubeRemote] load failed:', error.message || error);
    });
    return this.window;
  }

  close(options = {}) {
    if (this.boundsSaveTimer) {
      clearTimeout(this.boundsSaveTimer);
      this.boundsSaveTimer = null;
      this._saveSettings({ bounds: this.settings.bounds });
    }
    this._stopFullscreenPoller();
    this.state.enabled = false;
    if (this.window && !this.window.isDestroyed()) {
      this.window.removeAllListeners('closed');
      this.window.close();
    }
    this.window = null;
    if (options.preserveEnabled !== true) this._saveSettings({ enabled: false });
    this._broadcastEnabled();
  }

  setEnabled(enabled, payload = {}) {
    const next = enabled === true;
    const skin = clampSkin(payload.skin || this.settings.skin || this.state.skin);
    this._saveSettings({ enabled: next, skin });
    if (next) this.create({ ...payload, skin, enabled: true });
    else this.close();
    this._broadcastEnabled();
    return { ok: true, enabled: next, skin };
  }

  update(payload = {}) {
    const previousSkin = this.state.skin;
    this.state = sanitizeState(payload, this.state);
    this.state.enabled = this.settings.enabled === true;
    if (previousSkin !== this.state.skin) this._saveSettings({ skin: this.state.skin });
    if (this.state.enabled) {
      if (this.window && !this.window.isDestroyed() && previousSkin !== this.state.skin) {
        const bounds = this._resizeBounds(this.window.getBounds(), this.state.skin);
        this.window.setBounds(bounds, false);
        this._rememberBounds(bounds, true);
      }
      this.create(this.state);
    }
    return { ok: true, enabled: this.state.enabled, skin: this.state.skin };
  }

  async _handleCommand(command, payload = {}) {
    const value = String(command || '').trim();
    if (value === 'open-main') {
      await Promise.resolve(this.focusMainWindow && this.focusMainWindow());
      this._sendState();
      return { ok: true, visible: this._mainWindowVisible() };
    }
    if (value === 'toggle-main') {
      const visible = await Promise.resolve(this.toggleMainWindow && this.toggleMainWindow());
      this._sendState();
      return { ok: true, visible: visible !== false };
    }
    if (!COMMANDS.has(value)) return { ok: false, error: 'CUBE_COMMAND_INVALID' };
    const main = this.getMainWindow && this.getMainWindow();
    if (!main || main.isDestroyed()) return { ok: false, error: 'MAIN_WINDOW_UNAVAILABLE' };
    main.webContents.send('mineradio-cube-remote-command', { command: value, ...(payload || {}) });
    return { ok: true };
  }

  _trustedEvent(event, allowRemote = false) {
    if (!event || !event.sender) return false;
    const main = this.getMainWindow && this.getMainWindow();
    if (main && !main.isDestroyed() && event.sender === main.webContents) return true;
    return allowRemote && !!(this.window && !this.window.isDestroyed() && event.sender === this.window.webContents);
  }

  _registerIpc() {
    const guarded = (handler, allowRemote = false) => async (event, ...args) => {
      if (!this._trustedEvent(event, allowRemote)) return { ok: false, error: 'UNTRUSTED_CUBE_REMOTE_IPC' };
      try { return await handler(...args); } catch (error) { return { ok: false, error: error.message || 'CUBE_REMOTE_FAILED' }; }
    };
    this.ipcMain.handle('mineradio-cube-remote-get-settings', guarded(() => this.getSettings()));
    this.ipcMain.handle('mineradio-cube-remote-set-enabled', guarded((enabled, payload) => this.setEnabled(enabled, payload || {})));
    this.ipcMain.handle('mineradio-cube-remote-update', guarded((payload) => this.update(payload || {})));
    this.ipcMain.handle('mineradio-cube-remote-command', guarded((command, payload) => this._handleCommand(command, payload || {}), true));
    this.ipcMain.handle('mineradio-cube-remote-set-dragging', guarded((dragging) => {
      this.dragCursor = dragging ? this.screen.getCursorScreenPoint() : null;
      return { ok: true };
    }, true));
    this.ipcMain.handle('mineradio-cube-remote-move-by', guarded((dx, dy) => {
      if (!this.window || this.window.isDestroyed()) return { ok: false, error: 'NO_CUBE_WINDOW' };
      const bounds = this.window.getBounds();
      const cursor = this.screen.getCursorScreenPoint();
      let moveX = clampNumber(dx, -240, 240, 0);
      let moveY = clampNumber(dy, -240, 240, 0);
      if (this.dragCursor) {
        moveX = clampNumber(cursor.x - this.dragCursor.x, -240, 240, 0);
        moveY = clampNumber(cursor.y - this.dragCursor.y, -240, 240, 0);
        this.dragCursor = cursor;
      }
      const next = this._constrainBounds({ ...bounds, x: bounds.x + moveX, y: bounds.y + moveY });
      this.window.setBounds(next, false);
      this._rememberBounds(next);
      return { ok: true, bounds: next };
    }, true));
    this.ipcMain.handle('mineradio-cube-remote-resize', guarded((payload = {}) => {
      if (!this.window || this.window.isDestroyed()) return { ok: false, error: 'NO_CUBE_WINDOW' };
      const skin = clampSkin(payload.skin || this.state.skin);
      this.state.skin = skin;
      this._saveSettings({ skin });
      const next = this._resizeBounds(this.window.getBounds(), skin);
      this.window.setBounds(next, false);
      this._rememberBounds(next, true);
      this._sendState();
      return { ok: true, skin, ...this._skinSize(skin) };
    }, true));
  }

  dispose() {
    this.close({ preserveEnabled: true });
  }
}

module.exports = {
  CubeRemoteRuntime,
  SKIN_SIZES,
  clampSkin,
  normalizeBounds,
  sanitizeState,
};
