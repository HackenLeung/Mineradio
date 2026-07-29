'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const html = read('public/index.html');
const loader = read('public/js/index-loader.js');
const comments = read('public/js/modules/05-playback/06-track-detail-lyrics-actions.js');
const effects = read('public/js/modules/05-playback/08a-playback-tuning-eq.js');
const graph = read('public/js/modules/05-playback/08-audio-graph-controls.js');
const wallpaper = read('public/js/modules/07-fx/03-wallpaper-engine-library.js');
const hotkeys = read('public/js/modules/07-fx/06-hotkeys.js');
const preload = read('desktop/preload.js');
const desktopMain = read('desktop/main.js');
const defaults = read('public/js/modules/00-state/04-fx-defaults.js');
const smartTransition = read('public/js/modules/05-playback/18-smart-transition-integration.js');
const persistence = read('public/js/modules/02-visual/04-visual-settings-persistence.js');
const startup = read('public/js/modules/10-shell/05-startup-bindings.js');
const desktopShell = read('public/js/modules/10-shell/04-desktop-overlay-fullscreen.js');
const styles = read('public/css/index.css');
const consoleWorkspace = read('public/js/modules/07-fx/09-console-workspace.js');

function createWallpaperLinkHarness() {
  const start = wallpaper.indexOf('function setWallpaperEngineLink');
  const end = wallpaper.indexOf('\nvar desktopLockPending = false;', start);
  assert.ok(start >= 0 && end > start, 'Wallpaper Engine link implementation block must be extractable');
  const calls = { backgrounds: 0, controls: 0, saves: [], toasts: [] };
  const context = {
    fx: { wallpaperEngineLink: false },
    updateCustomBackgroundControls: () => { calls.backgrounds += 1; },
    updateLocalDesktopIntegrationControls: () => { calls.controls += 1; },
    saveLyricLayout: (options) => calls.saves.push(options),
    showToast: (message) => calls.toasts.push(message),
  };
  const factory = new Function('context', `with (context) {\n${wallpaper.slice(start, end)}\nreturn { setWallpaperEngineLink, toggleWallpaperEngineLink };\n}`);
  return { controls: factory(context), context, calls };
}

function createDesktopLockHarness(apiResult) {
  const start = wallpaper.indexOf('var desktopLockPending = false;');
  const end = wallpaper.indexOf('\nfunction deactivateWallpaperEngineBackground', start);
  assert.ok(start >= 0 && end > start, 'desktop lock implementation block must be extractable');
  const calls = { desired: [], saves: [], toasts: [], updates: 0, statuses: [] };
  const context = {
    fx: { desktopLock: false },
    getDesktopWindowApi: () => ({
      setDesktopLocked: async (desired) => {
        calls.desired.push(desired);
        if (apiResult instanceof Error) throw apiResult;
        return typeof apiResult === 'function' ? apiResult(desired) : apiResult;
      },
    }),
    updateLocalDesktopIntegrationControls: () => { calls.updates += 1; },
    applyDesktopWallpaperRuntimeStatus: (status) => calls.statuses.push(status),
    saveLyricLayout: (options) => calls.saves.push(options),
    showToast: (message) => calls.toasts.push(message),
  };
  const factory = new Function('context', `with (context) {\n${wallpaper.slice(start, end)}\nreturn { setDesktopLock, toggleDesktopLock };\n}`);
  return { controls: factory(context), context, calls };
}

test('quick comments expose read state and writable Netease/Qishui submission', () => {
  assert.match(html, /id="comment-btn"[\s\S]*toggleCommentPanel/);
  assert.match(html, /id="comment-panel"[\s\S]*id="comment-panel-compose"[\s\S]*id="comment-panel-list"/);
  assert.doesNotMatch(html, /class="mini-queue-head"[\s\S]{0,360}onclick="closeMiniQueue\(\)"/);
  assert.doesNotMatch(html, /class="comment-panel-head"[\s\S]{0,360}onclick="closeCommentPanel\(\)"/);
  assert.match(comments, /function submitQuickComment\(/);
  assert.match(comments, /onclick="openLocalMatchModal\(\)">匹配歌词和封面<\/button>/);
  assert.doesNotMatch(comments, />匹配在线信息<\/button>/);
  assert.match(comments, /ensureLoggedInForAction\(config\.provider\)/);
  assert.match(comments, /writeUrl: '\/api\/song\/comments\?id='/);
  assert.match(comments, /writeUrl: '\/api\/qishui\/song\/comments\?id='/);
  assert.match(comments, /provider: 'qq'[\s\S]*canWrite: false/);
});

test('playback tuning and six-band EQ are loaded and connected to the main audio graph', () => {
  assert.match(loader, /08a-playback-tuning-eq\.js/);
  assert.match(html, /id="playback-tuning-control"[\s\S]*id="playback-speed-slider"[\s\S]*id="playback-pitch-slider"/);
  assert.match(html, /id="fx-audio-fold"[\s\S]*id="audio-eq-grid"/);
  assert.match(consoleWorkspace, /key: 'extra', title: '额外', hint: '智能过渡 \/ 声音均衡器'[\s\S]*smart-transition-style-seg[\s\S]*t-audioEq[\s\S]*audio-preset-seg[\s\S]*audio-preamp[\s\S]*audio-eq-grid/);
  assert.match(styles, /#fx-panel #fx-console-motion-extra/);
  assert.equal((effects.match(/\{ label: '[^']+', freq:/g) || []).length, 6);
  assert.match(graph, /createPlaybackEffectGraph\(\)/);
  assert.match(graph, /configurePlaybackAudioElement\(audio\)/);
});

test('local matching keeps the restored neutral layout and refreshes local playback surfaces', () => {
  assert.match(comments, /class="local-match-track"[\s\S]*id="local-match-song-title"[\s\S]*class="local-match-provider-row"/);
  assert.doesNotMatch(comments, /class="local-match-close"/);
  assert.match(comments, /class="local-match-item"[\s\S]*local-match-item-cover[\s\S]*local-match-item-tail/);
  assert.match(comments, /syncResolvedLocalSongReferences\(song\)/);
  assert.match(comments, /fetchLyric\(activeSong, trackSwitchToken\)/);
  assert.match(styles, /\.local-match-modal\s*\{[\s\S]*background: linear-gradient\(145deg, rgba\(30, 31, 35, \.96\), rgba\(10, 11, 14, \.97\)\)/);
  assert.match(styles, /\.local-match-results::\-webkit-scrollbar-button\s*\{\s*display: none/);
});

test('Wallpaper Engine transparency link stays separate from the upstream wallpaper runtime', () => {
  assert.match(html, /id="t-wallpaperEngineLink"[\s\S]*toggleWallpaperEngineLink\(\)/);
  assert.match(html, /id="t-desktopLock"[\s\S]*toggleDesktopLock\(\)/);
  assert.match(wallpaper, /function setWallpaperEngineLink\([\s\S]*fx\.wallpaperEngineLink = enabled === true[\s\S]*saveLyricLayout\(\{ user: silent !== true, reason: 'wallpaperEngineLink' \}\)/);
  assert.doesNotMatch(wallpaper.match(/function toggleWallpaperEngineLink\([\s\S]*?\n\}/)?.[0] || '', /openWallpaperEngineLibrary|applyWallpaperEngineBackground/);
  assert.match(defaults, /wallpaperEngineLink: false/);
  assert.match(persistence, /wallpaperEngineLink: raw\.wallpaperEngineLink === true/);
  assert.match(persistence, /wallpaperEngineLink: fx\.wallpaperEngineLink === true/);
  assert.match(styles, /body\.wallpaper-engine-linked #custom-bg\s*\{[\s\S]*background: transparent !important/);
  assert.match(styles, /body\.wallpaper-engine-linked #custom-bg::after\s*\{[\s\S]*opacity: var\(--wallpaper-engine-dim, \.18\) !important/);
  assert.match(wallpaper, /function setDesktopLock\([\s\S]*api\.setDesktopLocked\(desired\)/);
  assert.match(wallpaper, /result\.ok !== true \|\| actual !== desired/);
  assert.match(wallpaper, /fx\.desktopLock = desired/);
  assert.match(preload, /setDesktopLocked: \(enabled\) => ipcRenderer\.invoke\('mineradio-main-desktop-lock'/);
  assert.match(preload, /onDesktopLockState:/);
  assert.match(desktopMain, /ipcMain\.handle\('mineradio-main-desktop-lock'[\s\S]*enableFullDesktopMode\(mainWindow, \{[\s\S]*interactive: false,[\s\S]*reason: 'local-desktop-lock'[\s\S]*closeWallpaperWindow\('local-desktop-unlock'\)/);
  assert.match(desktopMain, /mineradio-main-desktop-lock-state/);
  assert.match(defaults, /desktopLock: false/);
  assert.match(persistence, /desktopLock: raw\.desktopLock === true/);
  assert.match(persistence, /desktopLock: fx\.desktopLock === true/);
  assert.match(startup, /setDesktopLock\(fx\.desktopLock === true, true\)/);
  assert.match(hotkeys, /toggleDesktopInteraction'[\s\S]*setDesktopLock\(!\(fx && fx\.desktopLock === true\), false\)/);
});

test('Wallpaper Engine transparency link toggles, applies, and persists independently', () => {
  const harness = createWallpaperLinkHarness();
  assert.equal(harness.controls.toggleWallpaperEngineLink(), true);
  assert.equal(harness.context.fx.wallpaperEngineLink, true);
  assert.equal(harness.calls.backgrounds, 1);
  assert.equal(harness.calls.controls, 1);
  assert.deepEqual(harness.calls.saves, [{ user: true, reason: 'wallpaperEngineLink' }]);
  assert.match(harness.calls.toasts.at(-1), /联动已开启/);
});

test('desktop lock is reported as fullscreen and drives the renderer-only lock layout', () => {
  assert.match(desktopMain, /isDesktopLocked: desktopMode\.enabled === true/);
  assert.match(desktopMain, /isFullScreen:[^\n]*desktopMode\.enabled === true/);
  assert.match(desktopMain, /mineradio-main-desktop-lock-state[\s\S]*sendWindowState\(mainWindow\)/);
  assert.match(desktopShell, /classList\.toggle\('desktop-locked', isDesktopLocked\)/);
  assert.match(desktopShell, /isFullScreen = isDesktopLocked \|\|/);
  assert.match(desktopShell, /onDesktopLockState[\s\S]*applyState\(\{[\s\S]*isDesktopLocked: locked/);
  assert.match(styles, /body\.desktop-shell\.desktop-locked #bottom-bar[\s\S]*#fullscreen-diy-zone[\s\S]*pointer-events: none !important/);
  assert.match(styles, /body\.desktop-shell\.desktop-locked #desktop-mode-control-dock\s*\{\s*display: none !important/);
  assert.match(styles, /desktop-wallpaper-interactive:not\(\.desktop-locked\)[^\n]*#bottom-bar\.visible/);
});

test('local visual defaults match the established Mineradio layout', () => {
  assert.match(defaults, /lyricDisplayMode: 'single'/);
  assert.match(defaults, /lyricTranslationMode: 'current'/);
  assert.match(defaults, /lyricFont: 'song'/);
  assert.match(smartTransition, /var smartTransitionStyle = 'mirror'/);
  assert.match(defaults, /wallpaperFps: 30/);
});

test('desktop lock only persists an acknowledged native state', async () => {
  const success = createDesktopLockHarness({ ok: true, locked: true, status: { enabled: true } });
  assert.equal(await success.controls.setDesktopLock(true, false), true);
  assert.equal(success.context.fx.desktopLock, true);
  assert.deepEqual(success.calls.desired, [true]);
  assert.equal(success.calls.saves.length, 1);
  assert.match(success.calls.toasts.at(-1), /已锁定到桌面/);

  const failure = createDesktopLockHarness({ ok: false, locked: false, status: { enabled: false } });
  failure.context.fx.desktopLock = false;
  assert.equal(await failure.controls.setDesktopLock(true, false), false);
  assert.equal(failure.context.fx.desktopLock, false);
  assert.equal(failure.calls.saves.length, 0);
  assert.match(failure.calls.toasts.at(-1), /窗口状态未改变/);
});

test('desktop unlock restores state and handles a rejected IPC call', async () => {
  const unlock = createDesktopLockHarness({ ok: true, locked: false, status: { enabled: false } });
  unlock.context.fx.desktopLock = true;
  assert.equal(await unlock.controls.toggleDesktopLock(), true);
  assert.deepEqual(unlock.calls.desired, [false]);
  assert.equal(unlock.context.fx.desktopLock, false);
  assert.match(unlock.calls.toasts.at(-1), /恢复普通窗口/);

  const rejected = createDesktopLockHarness(new Error('synthetic IPC failure'));
  assert.equal(await rejected.controls.setDesktopLock(true, false), false);
  assert.equal(rejected.context.fx.desktopLock, false);
  assert.equal(rejected.calls.saves.length, 0);
  assert.match(rejected.calls.toasts.at(-1), /synthetic IPC failure/);
});
