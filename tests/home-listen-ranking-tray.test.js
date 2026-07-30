'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const html = read('public/index.html');
const loader = read('public/js/index-loader.js');
const ranking = read('public/js/modules/05-playback/03b-home-listen-ranking.js');
const stats = read('public/js/modules/05-playback/02-listen-stats.js');
const dashboard = read('public/js/modules/05-playback/03a-home-dashboard.js');
const homeActions = read('public/js/modules/05-playback/05-home-actions.js');
const queueSnapshot = read('public/js/modules/05-playback/09-queue-snapshot-autoplay.js');
const consoleWorkspace = read('public/js/modules/07-fx/09-console-workspace.js');
const css = read('public/css/index.css');
const preferences = read('public/js/modules/00-state/02-preferences-ui-modes.js');
const desktop = read('desktop/main.js');
const preload = read('desktop/preload.js');
const cubeRemote = read('public/js/modules/10-shell/04a-cube-remote-controller.js');
const server = read('server.js');

function namedFunctionSource(text, name) {
  const declaration = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(text);
  assert.ok(declaration, `expected ${name}()`);
  const bodyStart = text.indexOf('{', declaration.index + declaration[0].length);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = bodyStart; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'" || character === '`') { quote = character; continue; }
    if (character === '{') depth += 1;
    if (character === '}' && --depth === 0) return text.slice(declaration.index, index + 1);
  }
  throw new Error(`unterminated ${name}()`);
}

test('Home exposes platform-scoped listening rankings and the loader includes its module', () => {
  assert.match(html, /class="home-ranking-pair"[\s\S]*openHomeListenRanking\(\)/);
  for (const source of ['recent', 'netease', 'kugou', 'qq', 'local']) {
    assert.match(html, new RegExp(`data-listen-ranking-source="${source}"`));
  }
  assert.match(loader, /03b-home-listen-ranking\.js/);
  assert.match(server, /user_record/);
  assert.match(server, /pn === '\/api\/listen\/ranking'/);
});

test('ranking provider detection keeps local, QQ, Kugou, and Netease records separate', () => {
  const provider = vm.runInNewContext(`(${namedFunctionSource(ranking, 'homeListenRankingProvider')})`);
  assert.equal(provider({ localKey: 'a' }), 'local');
  assert.equal(provider({ key: 'qq:123' }), 'qq');
  assert.equal(provider({ provider: 'kugou' }), 'kugou');
  assert.equal(provider({ key: 'song:456' }), 'netease');
});

test('effective listening records retain provider and local restoration metadata', () => {
  assert.match(stats, /completed \|\| session\.listenMs >= 45000 \|\| session\.maxProgress >= 0\.5/);
  assert.match(stats, /songStat\.provider = record\.provider/);
  assert.match(stats, /songStat\.sourceKey = record\.sourceKey/);
  assert.match(stats, /songStat\.localPath = record\.localPath/);
  assert.match(stats, /songStat\.localKey = record\.localKey/);
});

test('continue listening restores the saved queue while recent playback opens chronological history', () => {
  const resume = namedFunctionSource(dashboard, 'resumeHomeDashboardPlayback');
  assert.match(html, /<div class="home-card-title">继续听<\/div>/);
  assert.match(resume, /homeListenSummary\(\)\.recent/);
  assert.match(resume, /playHomeRecentQueue\(recent\)/);
  assert.match(html, /onclick="openHomeListenRanking\('recent'\)"[\s\S]*<div class="home-card-title">最近播放<\/div>/);
  assert.match(ranking, /if \(source === 'recent'\)[\s\S]*listenStatsState\.history/);
  assert.match(ranking, /sort\(function \(a, b\) \{ return Number\(b\.playedAt/);
});

test('recent playback restores the persisted full queue, current item, mode, and progress', () => {
  const restoreRecent = namedFunctionSource(homeActions, 'playHomeRecentQueue');
  const hydrateQueue = vm.runInNewContext(`(${namedFunctionSource(queueSnapshot, 'hydrateLastPlaybackSnapshotQueue')})`, {
    hydrateCustomCover: (song) => song,
    queueItemKey: (song) => String(song && song.id || ''),
    Object,
    Array,
    Math,
    Number,
  });
  const restored = hydrateQueue({
    current: { id: 2, name: 'B' },
    currentIdx: 1,
    queue: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }, { id: 3, name: 'C' }],
  });
  assert.equal(restored.queue.length, 3);
  assert.equal(restored.index, 1);
  assert.match(html, /onclick="resumeHomeDashboardPlayback\(\)"[\s\S]*<div class="home-card-title">继续听<\/div>/);
  assert.match(dashboard, /上次队列 '[^']*' 首/);
  assert.match(restoreRecent, /playQueue = restoredQueue\.queue/);
  assert.match(restoreRecent, /currentIdx = restoredQueue\.index/);
  assert.match(restoreRecent, /if \(snapshot\.playMode\) playMode = snapshot\.playMode/);
  assert.match(restoreRecent, /resumeAt: resumeAt/);
  assert.doesNotMatch(restoreRecent, /preserveHomeState:\s*true/);
  assert.match(restoreRecent, /dismissHomePage\(\{ toast: false \}\)/);
  assert.match(restoreRecent, /skipShuffleOrder: true/);
});

test('Home discovery cards are two equal columns with matching heights and local search uses the application-styled label', () => {
  assert.match(css, /#empty-home \.home-insight-dock\s*\{[\s\S]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /#empty-home \.home-ranking-pair\s*\{[\s\S]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /#empty-home \.home-ranking-pair\s*\{[\s\S]*grid-auto-rows:\s*104px/);
  assert.match(css, /#empty-home \.home-ranking-entry\s*\{[\s\S]*min-height:\s*104px/);
  assert.match(css, /#empty-home \.home-listen-ranking-entry\s*\{[\s\S]*min-height:\s*104px/);
  assert.match(html, /class="local-library-search-title">搜索本地音乐<\/span>/);
  assert.match(css, /\.local-library-search-title\{/);
  assert.match(css, /\.local-library-search-wrap input\{[\s\S]*height:38px/);
});

test('queue hover actions center every icon and listening ranking rows fill the modal width', () => {
  assert.match(css, /\.qi-act\s*\{[\s\S]*?align-items:\s*center/);
  assert.match(css, /\.qi-act button\s*\{[\s\S]*?display:\s*inline-flex;[\s\S]*?align-items:\s*center;[\s\S]*?justify-content:\s*center/);
  assert.match(css, /\.home-listen-ranking-list\s*\{[\s\S]*?width:\s*100%/);
  assert.match(css, /\.home-listen-ranking-row\s*\{[\s\S]*?width:\s*100%/);
  assert.match(css, /\.home-listen-ranking-modal\s*\{[\s\S]*?background:\s*linear-gradient\(155deg, rgba\(19, 22, 27/);
});

test('Next Up only exposes a real queued successor and never synthesizes a single recommendation', () => {
  const nextInfo = namedFunctionSource(dashboard, 'homeDashboardNextQueueInfo');
  const nextAction = namedFunctionSource(dashboard, 'playHomeNextFromDock');
  assert.doesNotMatch(nextInfo, /homeDiscoverState|homeDashboardLocalSongs/);
  assert.match(nextInfo, /playQueue\.length > 1/);
  assert.match(nextInfo, /song: null, index: -1, queued: false/);
  assert.doesNotMatch(nextAction, /playQueue = \[cloneSong/);
  assert.match(dashboard, /'暂无下一首'/);
});

test('desktop lock appears immediately above the Wallpaper Engine library row without a separate link toggle', () => {
  const lockAt = consoleWorkspace.indexOf("fxConsoleItem('t-desktopLock'");
  const libraryAt = consoleWorkspace.indexOf("fxConsoleItem('wallpaper-engine-value'");
  assert.ok(lockAt >= 0 && libraryAt > lockAt);
  assert.doesNotMatch(consoleWorkspace, /t-wallpaperEngineLink|Wallpaper Engine 联动/);
});

test('tray is created at startup and the one-time default migration preserves later choices', () => {
  assert.match(desktop, /let closeBehavior = 'tray'/);
  assert.match(desktop, /app\.whenReady\(\)\.then\(async \(\) => \{\s*createOrUpdateTray\(\)/);
  assert.match(preferences, /CLOSE_BEHAVIOR_DEFAULT_MIGRATION_KEY/);
  assert.match(preferences, /localStorage\.setItem\(CLOSE_BEHAVIOR_STORE_KEY, 'tray'\)/);
  assert.match(preferences, /localStorage\.getItem\(CLOSE_BEHAVIOR_STORE_KEY\) \|\| 'tray'/);
});

test('tray restores playback status and the complete local playback control path', () => {
  assert.match(desktop, /let trayPlaybackState = \{/);
  assert.match(desktop, /tray\.setToolTip\(songLabel/);
  assert.match(desktop, /trayPlaybackState\.playing \? '暂停' : '播放'/);
  assert.match(desktop, /label: '上一曲'/);
  assert.match(desktop, /label: '下一曲'/);
  assert.match(desktop, /label: `音量 \$\{Math\.round\(volume \* 100\)\}%`/);
  assert.match(desktop, /trayPlaybackState\.muted \|\| volume <= 0\.001 \? '恢复音量' : '静音'/);
  assert.match(desktop, /label: '退出锁定模式'/);
  assert.match(desktop, /ipcMain\.handle\('mineradio-tray-playback-update'/);
  assert.match(desktop, /event\.sender !== mainWindow\.webContents/);
  assert.match(preload, /updateTrayPlayback: \(payload\) => ipcRenderer\.invoke\('mineradio-tray-playback-update'/);
  assert.match(preload, /onTrayCommand: \(callback\) =>/);
  assert.match(cubeRemote, /function pushTrayPlaybackState\(/);
  const handler = namedFunctionSource(cubeRemote, 'handleTrayCommand');
  assert.match(handler, /togglePlay\(\)/);
  assert.match(handler, /nextTrack\(true\)/);
  assert.match(handler, /prevTrack\(true\)/);
  assert.match(handler, /setVolume\(/);
  assert.match(handler, /toggleMute\(\)/);
});
