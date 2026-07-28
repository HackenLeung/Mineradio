'use strict';

const SETTINGS_FILE = 'desktop-lyrics-window.json';

function normalizeBounds(bounds) {
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

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function constrainBounds(bounds, screenApi) {
  const source = normalizeBounds(bounds);
  if (!source || !screenApi) return source;
  const display = typeof screenApi.getDisplayMatching === 'function'
    ? screenApi.getDisplayMatching(source)
    : screenApi.getPrimaryDisplay();
  const area = display && (display.bounds || display.workArea);
  if (!area) return source;
  const width = Math.min(source.width, area.width);
  const height = Math.min(source.height, area.height);
  return {
    x: Math.round(clampNumber(source.x, area.x, area.x + Math.max(0, area.width - width))),
    y: Math.round(clampNumber(source.y, area.y, area.y + Math.max(0, area.height - height))),
    width: Math.round(width),
    height: Math.round(height),
  };
}

class DesktopLyricsWindowState {
  constructor(options = {}) {
    this.fs = options.fs;
    this.path = options.path;
    this.screen = options.screen;
    this.logger = options.logger || console;
    this.settingsPath = this.path.join(options.userDataPath, SETTINGS_FILE);
    this.bounds = this._read();
    this.pendingBounds = null;
    this.saveTimer = null;
  }

  _read() {
    try {
      const raw = JSON.parse(this.fs.readFileSync(this.settingsPath, 'utf8')) || {};
      return normalizeBounds(raw.bounds);
    } catch (_) {
      return null;
    }
  }

  _write() {
    try {
      this.fs.mkdirSync(this.path.dirname(this.settingsPath), { recursive: true });
      this.fs.writeFileSync(this.settingsPath, JSON.stringify({ bounds: this.bounds }, null, 2), 'utf8');
    } catch (error) {
      this.logger.warn('[DesktopLyrics] window state save failed:', error.message || error);
    }
  }

  getBounds() {
    return this.bounds ? { ...this.bounds } : null;
  }

  constrain(bounds) {
    return constrainBounds(bounds, this.screen);
  }

  remember(bounds, options = {}) {
    const next = normalizeBounds(bounds);
    if (!next) return this.getBounds();
    this.bounds = next;
    this.pendingBounds = next;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (options.immediate === true) this.flush();
    else {
      this.saveTimer = setTimeout(() => {
        this.saveTimer = null;
        this.flush();
      }, 320);
    }
    return this.getBounds();
  }

  clear() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.pendingBounds = null;
    this.bounds = null;
    this._write();
  }

  flush() {
    if (!this.pendingBounds) return;
    this.pendingBounds = null;
    this._write();
  }

  dispose() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.flush();
  }
}

module.exports = {
  DesktopLyricsWindowState,
  normalizeBounds,
  constrainBounds,
};
