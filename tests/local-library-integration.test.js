'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const packageJson = JSON.parse(read('package.json'));
const desktopMain = read('desktop/main.js');
const preload = read('desktop/preload.js');
const upload = read('public/js/modules/06-lyrics/05-upload-dragdrop.js');
const lyrics = read('public/js/modules/06-lyrics/00-lyrics-fetch-parse.js');
const queueSnapshot = read('public/js/modules/05-playback/09-queue-snapshot-autoplay.js');
const beatCacheModal = read('public/js/modules/03-beat/03-local-beat-cache-modal.js');
const indexHtml = read('public/index.html');
const indexCss = read('public/css/index.css');

assert.equal(packageJson.dependencies['music-metadata'], '11.14.0');
assert.match(desktopMain, /import\('music-metadata'\)/);
assert.match(desktopMain, /LOCAL_LIBRARY_AUDIO_EXTS/);
assert.match(desktopMain, /sidecarCoverUrl/);
assert.match(desktopMain, /sidecarLyricText/);
assert.match(desktopMain, /embeddedCover/);
assert.match(desktopMain, /embeddedLyrics/);
assert.match(desktopMain, /parseFile\(item\.filePath, \{ duration: true, skipCovers: false \}\)/);

[
  'chooseLocalMusicFolder',
  'scanLocalMusicFolder',
  'resolveLocalMusicFile',
  'getLocalLyricsCache',
  'setLocalLyricsCache',
  'getLocalOnlineMetadataCache',
  'setLocalOnlineMetadataCache',
].forEach(name => assert.match(preload, new RegExp(`${name}:`), `${name} must be exposed through preload`));

assert.match(upload, /function restoreLocalLibraryFolders\(/);
assert.match(upload, /function rebindRestoredLocalQueueSongs\(/);
assert.match(upload, /function hydrateLocalFolderPreview\(/);
assert.match(upload, /Math\.min\(3, songs\.length\)/);
assert.match(upload, /Object\.assign\(song, cloneSong\(fresh\), \{ localMissing: false \}\)/);
assert.match(upload, /provider: provider,[\s\S]{0,500}albumAudioId:[\s\S]{0,250}mixSongId:/);
assert.match(upload, /sidecarCover \|\| song\.embeddedCover \|\| song\.cover/);

assert.match(queueSnapshot, /var packedQueue = Array\.isArray\(playQueue\) \? playQueue\.map/);
assert.doesNotMatch(queueSnapshot, /playQueue\.slice\(0, 120\)/);
assert.match(queueSnapshot, /var limits = \[packedQueue\.length, 1000, 500, 200, 80\]/);
assert.match(queueSnapshot, /'localPath'.*'localFolderPath'.*'localLyricText'.*'embeddedLyrics'/s);
assert.match(queueSnapshot, /if \(snapshot\.playMode\) playMode = snapshot\.playMode/);
assert.match(queueSnapshot, /currentLocalSong = isLocal \? playQueue\[currentIdx\] : null/);

assert.match(beatCacheModal, /function isLocalBeatAnalysisSkipped\(song\)/);
assert.match(beatCacheModal, /if \(isLocalBeatAnalysisSkipped\(song\)\) return/);
assert.match(beatCacheModal, /localBeatSkipPrefs\[song\.localKey\] = Date\.now\(\)/);
assert.match(indexHtml, /id="local-beat-later-btn"[^>]+onclick="deferLocalBeatAnalysis\(\)"/);
assert.match(indexCss, /#local-beat-modal\s*\{\s*pointer-events:\s*none/s);
assert.match(indexCss, /#local-beat-modal \.local-beat-modal\s*\{\s*pointer-events:\s*auto/s);

const inlineBranch = lyrics.indexOf("var inlineText = String(song.localLyricText || song.embeddedLyrics || '')");
const onlineBranch = lyrics.indexOf('var onlineSong = localOnlineSongForMetadata(song)');
const remoteFetch = lyrics.indexOf('var response = await apiJson(lyricEndpointForSong(onlineSong))');
assert.ok(inlineBranch >= 0 && onlineBranch > inlineBranch && remoteFetch > onlineBranch,
  'sidecar and embedded lyrics must win before cached or remote online lyrics');
assert.match(lyrics, /getLocalLyricsCache\(cacheKey\)/);
assert.match(lyrics, /setLocalLyricsCache\(cacheKey, response \|\| \{\}\)/);

console.log('OK local-library-integration');
