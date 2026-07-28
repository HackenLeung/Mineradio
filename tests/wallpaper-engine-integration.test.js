'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Wallpaper Engine keeps the upstream runtime and adds one shared dim surface', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'public', 'css', 'index.css'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'public', 'js', 'modules', '07-fx', '03-wallpaper-engine-library.js'), 'utf8');
  const desktopRuntime = fs.readFileSync(path.join(root, 'desktop', 'wallpaper-engine-runtime.js'), 'utf8');
  const fullDesktopRuntime = fs.readFileSync(path.join(root, 'desktop', 'full-desktop-mode-runtime.js'), 'utf8');

  assert.equal((html.match(/id="wallpaper-engine-dim"/g) || []).length, 1);
  assert.match(html, /id="fx-wallpaperenginedim"[^>]+max="0\.85"/);
  assert.match(css, /body\.wallpaper-engine-active #wallpaper-engine-dim[\s\S]{0,140}var\(--wallpaper-engine-dim, \.18\)/);
  assert.match(renderer, /function loadWallpaperEngineLibrary\(force, showNotice\)/);
  assert.match(renderer, /function chooseWallpaperEngineDirectory\(\)/);
  assert.match(renderer, /function activateWallpaperEngineItem\(id\)/);
  assert.match(renderer, /function applyWallpaperEngineDim\(\)/);
  assert.match(desktopRuntime, /class WallpaperEngineRuntime/);
  assert.match(fullDesktopRuntime, /class FullDesktopModeRuntime/);
});

test('Wallpaper Engine dim value is clamped, persisted, restored, and bound to the appearance console', () => {
  const root = path.join(__dirname, '..');
  const defaults = fs.readFileSync(path.join(root, 'public', 'js', 'modules', '00-state', '04-fx-defaults.js'), 'utf8');
  const persistence = fs.readFileSync(path.join(root, 'public', 'js', 'modules', '02-visual', '04-visual-settings-persistence.js'), 'utf8');
  const bindings = fs.readFileSync(path.join(root, 'public', 'js', 'modules', '07-fx', '07-bindings-shelf-immersive.js'), 'utf8');
  const consoleWorkspace = fs.readFileSync(path.join(root, 'public', 'js', 'modules', '07-fx', '09-console-workspace.js'), 'utf8');
  assert.match(defaults, /wallpaperEngineDim: 0\.18/);
  assert.ok((persistence.match(/wallpaperEngineDim/g) || []).length >= 5);
  assert.match(bindings, /\['fx-wallpaperenginedim', 'wallpaperEngineDim'\]/);
  assert.match(bindings, /fx\.wallpaperEngineDim = clampRange\(fx\.wallpaperEngineDim, 0, 0\.85\)/);
  assert.match(consoleWorkspace, /fxConsoleItem\('fx-wallpaperenginedim', '壁纸暗度'/);
});
