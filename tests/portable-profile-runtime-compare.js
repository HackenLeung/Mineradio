'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function fileCount(directory) {
  let count = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) count += fileCount(target);
    else if (entry.isFile()) count += 1;
  }
  return count;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase();
}

const testRoot = path.resolve(process.argv[2] || '');
if (!testRoot || !fs.existsSync(testRoot)) {
  throw new Error('Usage: node portable-profile-runtime-compare.js <upgrade-test-root>');
}

const before = readJson(path.join(testRoot, 'before-overlay.json'));
const baseline = readJson(path.join(testRoot, 'baseline-runtime.json'));
const fixed = readJson(path.join(testRoot, 'fixed-runtime.json'));
const nestedInstallRoot = path.join(testRoot, 'Mineradio');
const installRoot = fs.existsSync(path.join(nestedInstallRoot, 'user-data')) ? nestedInstallRoot : testRoot;
const profile = path.join(installRoot, 'user-data');
const cacheSentinel = path.join(installRoot, 'MineradioCache', 'upgrade-preservation-sentinel.txt');
const baselineStorage = baseline.comparisonStorage || baseline.allStorage || {};
const fixedStorage = fixed.comparisonStorage || fixed.allStorage || {};

const stableKeys = [
  'apex-player-volume',
  'mineradio-account-view-mode-v1',
  'mineradio-active-account-provider-v1',
  'mineradio-controls-auto-hide-v1',
  'mineradio-custom-lyric-prefs-v1',
  'mineradio-custom-lyrics-v1',
  'mineradio-diy-player-mode-v1',
  'mineradio-free-camera-v1',
  'mineradio-local-library-folders-v2',
  'mineradio-upload-tip-seen',
  'mineradio-user-fx-archives-v1',
  'mineradio-visual-guide-seen-v2',
  'mineradio-weather-city',
];
stableKeys.forEach(key => assert.equal(fixedStorage[key], baselineStorage[key], `${key} changed across upgrade`));

function songIdentity(song) {
  song = song || {};
  return String(song.localKey || song.id || song.mid || song.hash || `${song.name || ''}|${song.artist || ''}`);
}

assert.equal(fixed.queueLength, baseline.queueLength, 'the complete legacy queue was not restored');
assert.deepEqual(fixed.queueIdentities, baseline.queueIdentities, 'the legacy queue order or contents changed');
assert.equal(fixed.currentIndex, baseline.currentIndex, 'the current legacy queue index changed');
assert.equal(songIdentity(fixed.currentSong), songIdentity(baseline.currentSong), 'the current legacy song was not restored');
assert.deepEqual(
  JSON.parse(fixedStorage['mineradio-local-library-folders-v2']),
  JSON.parse(baselineStorage['mineradio-local-library-folders-v2']),
  'local library folders changed'
);
assert(fixed.localMetadataCount > 0, 'local metadata was not hydrated');

['preset', 'intensity', 'lyricScale', 'lyricFont', 'lyricGlow', 'desktopLyrics', 'desktopLyricsSize', 'desktopLyricsFps', 'performanceQuality']
  .forEach(key => assert.deepEqual(fixed.fxState[key], baseline.fxState[key], `legacy visual setting ${key} was not restored`));
const legacyLineCount = Math.max(1, Number(baseline.fxState.stageLyricLines) || 1);
const expectedLyricMode = legacyLineCount === 2 ? 'dual' : legacyLineCount === 3 ? 'triple' : legacyLineCount >= 4 ? 'custom' : 'single';
assert.equal(fixed.fxState.lyricDisplayMode, expectedLyricMode, 'legacy lyric line mode was not restored');
if (expectedLyricMode === 'custom') {
  assert.equal(fixed.fxState.lyricCustomLineCount, Math.min(10, legacyLineCount), 'legacy custom lyric line count was not restored');
}
const legacyFx = baselineStorage['mineradio-lyric-layout-v1']
  ? JSON.parse(baselineStorage['mineradio-lyric-layout-v1'])
  : null;
assert.equal(
  fixed.smartTransitionStyle,
  legacyFx ? legacyFx.smartTransitionStyle : baseline.smartTransitionStyle,
  'smart transition style was not restored'
);
assert.equal(fixed.smartTransitionLeadSec, baseline.smartTransitionLeadSec, 'smart transition lead time changed');
assert.deepEqual(fixed.playbackTuning, baseline.playbackTuning, 'playback tuning changed');
assert.deepEqual(fixed.audioEffects, baseline.audioEffects, 'equalizer state changed');

assert(!fixed.status['/api/login/status'].probeError, `Netease login probe failed: ${fixed.status['/api/login/status'].probeError || ''}`);
assert(!fixed.status['/api/kugou/login/status'].probeError, `Kugou login probe failed: ${fixed.status['/api/kugou/login/status'].probeError || ''}`);
assert.equal(fixed.status['/api/login/status'].loggedIn, baseline.status['/api/login/status'].loggedIn, 'Netease login changed');
assert.equal(fixed.status['/api/kugou/login/status'].loggedIn, baseline.status['/api/kugou/login/status'].loggedIn, 'Kugou login changed');
assert.equal(fixed.status['/api/kugou/login/status'].hasCookie, baseline.status['/api/kugou/login/status'].hasCookie, 'Kugou cookie availability changed');

const afterCount = fileCount(profile);
assert(afterCount >= before.fileCount, `profile file count decreased: ${before.fileCount} -> ${afterCount}`);
for (const [relative, expectedHash] of Object.entries(before.keyFiles)) {
  if (expectedHash == null) continue;
  const file = path.join(profile, relative);
  assert(fs.existsSync(file), `key profile file was deleted: ${relative}`);
  if (Array.isArray(before.immutableKeyFiles) && before.immutableKeyFiles.includes(relative)) {
    assert.equal(sha256(file), expectedHash, `key profile file changed unexpectedly: ${relative}`);
  }
}
assert(fs.existsSync(cacheSentinel), 'adjacent MineradioCache was not preserved');
assert(!fs.existsSync(path.join(installRoot, 'MineradioCache', 'chromium', 'Mineradio')),
  'a second Chromium profile was created below the cache directory');

[
  path.join(testRoot, 'AppData', 'Roaming', 'Mineradio'),
  path.join(testRoot, 'AppData', 'Roaming', 'mineradio'),
].forEach(forbiddenProfile => {
  assert(!fs.existsSync(forbiddenProfile), `formal user data was written to AppData: ${forbiddenProfile}`);
});

const startupState = readJson(path.join(profile, 'startup-state.json'));
assert.equal(startupState.phase, 'ready', 'the upgraded app did not reach the ready phase');
assert.equal(path.resolve(startupState.userData), path.resolve(profile), 'userData did not use the adjacent complete profile');
assert.equal(path.resolve(startupState.sessionData), path.resolve(profile), 'sessionData moved away from the adjacent complete profile');

console.log(JSON.stringify({
  beforeFileCount: before.fileCount,
  afterFileCount: afterCount,
  queueLength: fixed.queueLength,
  currentSong: fixed.currentSong && (fixed.currentSong.name || fixed.currentSong.title),
  localMetadataCount: fixed.localMetadataCount,
  neteaseLoggedIn: fixed.status['/api/login/status'].loggedIn,
  kugouLoggedIn: fixed.status['/api/kugou/login/status'].loggedIn,
  kugouCookiePresent: fixed.status['/api/kugou/login/status'].hasCookie,
  profile,
}, null, 2));
