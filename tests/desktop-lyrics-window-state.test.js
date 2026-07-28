'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  DesktopLyricsWindowState,
  normalizeBounds,
  constrainBounds,
} = require('../desktop/desktop-lyrics-window-state');

const screenApi = {
  getDisplayMatching: () => ({ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }),
  getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }),
};

test('desktop lyric bounds normalize and return off-screen windows to a visible display', () => {
  assert.deepEqual(normalizeBounds({ x: 20.4, y: 10.6, width: 120, height: 80 }), {
    x: 20, y: 11, width: 320, height: 180,
  });
  assert.equal(normalizeBounds({ x: 'bad', y: 0, width: 800, height: 220 }), null);
  assert.deepEqual(constrainBounds({ x: 2500, y: -500, width: 900, height: 220 }, screenApi), {
    x: 1020, y: 0, width: 900, height: 220,
  });
});

test('desktop lyric bounds persist, restore, clear, and flush on disposal', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-desktop-lyrics-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const state = new DesktopLyricsWindowState({ fs, path, screen: screenApi, userDataPath: directory, logger: { warn() {} } });
  state.remember({ x: 120, y: 240, width: 860, height: 230 });
  state.dispose();

  const restored = new DesktopLyricsWindowState({ fs, path, screen: screenApi, userDataPath: directory, logger: { warn() {} } });
  assert.deepEqual(restored.getBounds(), { x: 120, y: 240, width: 860, height: 230 });
  restored.clear();
  assert.equal(restored.getBounds(), null);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'desktop-lyrics-window.json'), 'utf8')), { bounds: null });
});

test('desktop lyric renderer keeps approved readability, compact layout, and upstream custom fonts', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'public', 'desktop-lyrics.html'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8');
  assert.match(html, /padding:54px 54px 48px/);
  assert.match(html, /padding:\.56em var\(--lyric-edge-width\) \.68em/);
  assert.match(html, /drop-shadow\(0 1px 2\.4px rgba\(4,6,12,\.58\)\)/);
  assert.match(html, /-webkit-text-stroke:\.18px rgba\(255,255,255,\.72\)/);
  assert.match(html, /function applyCustomFontPayload\(font\)/);
  assert.match(html, /new FontFace/);
  assert.match(main, /closeDesktopLyricsWindow\(\{ preserveEnabled: true, silent: true \}\)/);
  assert.match(main, /desktopLyricsWindowState\.remember\(desktopLyricsWindow\.getBounds\(\), \{ immediate: true \}\)/);
});
