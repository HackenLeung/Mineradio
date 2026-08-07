'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const html = read('public/index.html');
const css = read('public/css/index.css');
const loader = read('public/js/index-loader.js');
const downloads = read('public/js/modules/05-playback/06a-download-center.js');
const queue = read('public/js/modules/06-lyrics/01-playlist-panel-shell.js');
const search = read('public/js/modules/05-playback/07-search.js');
const detail = read('public/js/modules/06-lyrics/02-playlist-detail.js');
const local = read('public/js/modules/06-lyrics/05-upload-dragdrop.js');
const server = read('server.js');
const main = read('desktop/main.js');
const preload = read('desktop/preload.js');
const consoleWorkspace = read('public/js/modules/07-fx/09-console-workspace.js');

test('music download queue resolves Netease, QQ and Kugou without advertising unsupported sources', () => {
  assert.match(server, /const musicDownloadJobs = new Map\(\)/);
  assert.match(server, /async function resolveMusicDownloadUrl\(song, quality\)/);
  assert.match(server, /provider === 'qq'[\s\S]*handleQQSongUrl\(mid, mediaMid, quality, song\)/);
  assert.match(server, /provider === 'kugou'[\s\S]*handleKugouSongUrl/);
  assert.match(server, /if \(pn === '\/api\/download'\)/);
  assert.match(server, /if \(pn === '\/api\/download\/status'\)/);
  assert.match(server, /if \(pn === '\/api\/download\/cancel'\)/);
});

test('desktop exposes persistent download directory controls before the local server starts', () => {
  for (const channel of ['open', 'get', 'set', 'reset']) {
    assert.match(main, new RegExp("ipcMain\\.handle\\('mineradio-download-" + channel + "-dir'"));
  }
  assert.match(main, /process\.env\.MINERADIO_DOWNLOAD_DIR = readSavedDownloadDir\(\) \|\| defaultDownloadDir\(\)/);
  assert.match(preload, /openDownloadDir: \(\) => ipcRenderer\.invoke\('mineradio-download-open-dir'\)/);
  assert.match(preload, /showLocalMusicInFolder:/);
});

test('download center and hover actions are loaded through upstream modular entrypoints', () => {
  assert.match(loader, /06a-download-center\.js/);
  assert.match(html, /id="dl-center-btn"[\s\S]*toggleDownloadCenter\(\)/);
  assert.match(html, /id="download-center" class="download-center-panel"/);
  assert.match(css, /\.download-center-panel/);
  assert.match(downloads, /function queueSongFileActionHtml\(song, index\)/);
  assert.match(downloads, /isLocalDownloadSong\(song\)[\s\S]*showQueueLocalSongInFolder/);
  assert.match(queue, /queueSongFileActionHtml\(song, i\)/);
  assert.match(search, /downloadSongFromSearch\(/);
  assert.match(detail, /data-pl-detail-download/);
  assert.match(local, /localDetailFileActionHtml\(index\)/);
});

test('motion fold owns smart transition and visible desktop integrations without full desktop UI', () => {
  assert.match(html, /id="fx-overlay-fold"[\s\S]*<strong>动效<\/strong>/);
  assert.match(html, /id="t-desktopLock"[\s\S]*id="smart-transition-style-seg"/);
  assert.doesNotMatch(html, /t-wallpaperEngineLink|Wallpaper Engine 联动/);
  assert.doesNotMatch(html, /id="t-wallpaperMode"|完整桌面模式/);
  assert.doesNotMatch(consoleWorkspace, /t-wallpaperMode|完整桌面模式/);
  assert.match(css, /\.desktop-link-grid\{grid-template-columns:minmax\(0,1fr\)/);
  assert.match(css, /\.desktop-link-toggle/);
});

test('local secondary detail uses neutral glass instead of a full accent wash', () => {
  assert.match(css, /\.local-library-folder\.expanded\{border-color:rgba\(255,255,255/);
  assert.match(css, /\.pl-inline-detail\[data-local-detail\][^{]*\{border-color:rgba\(255,255,255/);
});
