'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const server = read('server.js');
const wall = read('public/js/modules/05-playback/03c-music-library-wall.js');
const queueLoader = read('public/js/modules/06-lyrics/03-podcast-playlist-loaders.js');
const playback = read('public/js/modules/05-playback/13-playback-start-audio.js');
const playbackSnapshot = read('public/js/modules/05-playback/09-queue-snapshot-autoplay.js');
const coverMap = read('public/js/modules/05-playback/01-cover-custom-map.js');
const lyrics = read('public/js/modules/06-lyrics/00-lyrics-fetch-parse.js');
const lyricTiming = read('public/js/modules/06-lyrics/06-lyric-timing-offset.js');
const lyricActions = read('public/js/modules/05-playback/06-track-detail-lyrics-actions.js');

assert.match(server, /user_cloud,\s*user_cloud_detail/);
assert.match(server, /song_cloud_download: enhancedNeteaseCloudDownload/);
assert.match(server, /if \(pn === '\/api\/user\/cloud'\)/);
assert.match(server, /if \(pn === '\/api\/user\/cloud\/detail'\)/);
assert.match(server, /handleNeteaseCloudSongUrl/);
assert.match(server, /if \(pn === '\/api\/cloud\/lyric'\)/);
assert.match(server, /cloudPlaybackRequested \? sendPrivateJSON : sendJSON/);
assert.match(server, /sendPrivateJSON\(res, \{\s*provider: 'netease',\s*cloud: true/);
assert.match(server, /requireLogin\(res, sendPrivateJSON\)/);
assert.match(server, /cloudSource: 'netease-cloud'/);

assert.match(wall, /kind: 'netease-cloud'/);
assert.match(wall, /\/api\/user\/cloud\?limit=/);
assert.match(wall, /'netease-cloud:' \+ \(detail\.playlistId/);
assert.match(queueLoader, /raw\.indexOf\('netease-cloud:'\)/);
assert.match(queueLoader, /source\.provider === 'netease-cloud'/);
assert.match(playback, /var cloudParam = song && \(song\.cloudSong/);
assert.match(playback, /\+ cloudParam \+ neteasePlaybackMatchQuery/);
assert.match(playbackSnapshot, /'cloudSong', 'cloudSource', 'cloudId'/);
assert.match(playbackSnapshot, /netease-cloud:' \+ \(song\.cloudId/);
assert.match(coverMap, /netease-cloud:' \+ \(song\.cloudId/);
assert.match(coverMap, /cloudLyricRematchCoverForSong/);
assert.match(coverMap, /getCustomCoverForSong\(song\)/);
assert.match(wall, /return songCoverSrc\(song, 400\)/);
assert.match(playback, /function playbackSongCover\(song\)/);
assert.match(playback, /loadCoverFromUrl\(playbackSongCover\(song\), coverOpts\)/);
assert.match(playbackSnapshot, /var restoredCover = !isLocal && typeof songCoverSrc === 'function'/);
assert.match(lyrics, /\/api\/cloud\/lyric\?id=/);
assert.match(lyrics, /function setCloudLyricRematch\(/);
assert.match(lyrics, /function cloudLyricRematchCoverFromCandidate\(/);
assert.match(lyrics, /cover: rematchCover/);
assert.match(lyrics, /function syncCloudLyricRematchCover\(/);
assert.match(lyrics, /function cloudLyricRematchOriginalCover\(/);
assert.match(lyrics, /target\.cover = cover \|\| originalCover/);
assert.match(lyrics, /if \(rematch\) return lyricEndpointForSong\(rematch\)/);
assert.match(lyrics, /cloudRematchIdentityAtStart/);
assert.match(lyricTiming, /song\.cloudSong \|\| song\.cloudSource === 'netease-cloud'/);
assert.match(lyricActions, /localMatchModalState\.mode = isCloudSong \? 'cloud' : 'local'/);
assert.match(lyricActions, /async function applyCloudLyricMatchCandidate\(/);
assert.match(lyricActions, /apiJson\(lyricEndpointForSong\(metadata\)/);
assert.match(lyricActions, /setCloudLyricRematch\(song, metadata\)/);
assert.match(lyricActions, /var tokenAtStart = trackSwitchToken/);
assert.match(lyricActions, /localMatchModalState\.applyRequest === applyRequest/);
assert.match(lyricActions, /trackSwitchToken === tokenAtStart/);
assert.match(lyricActions, /searchButtonEl\) searchButtonEl\.disabled = false/);
assert.match(lyricActions, /已重新匹配歌词和封面/);
assert.match(lyricActions, /自定义封面仍在生效/);

const rematchStart = lyrics.indexOf('var NETEASE_CLOUD_LYRIC_REMATCH_STORE_KEY');
const rematchEnd = lyrics.indexOf('function lyricTranslationTextFromAliases');
assert.ok(rematchStart >= 0 && rematchEnd > rematchStart);

const rematchStorage = new Map();
const rematchContext = {
  localStorage: {
    getItem(key) { return rematchStorage.has(key) ? rematchStorage.get(key) : null; },
    setItem(key, value) { rematchStorage.set(key, String(value)); }
  },
  normalizePlaybackProvider(provider) {
    return ['netease', 'qq', 'kugou'].includes(provider) ? provider : 'netease';
  },
  getCustomCoverForSong(song) {
    return song && song.customCover || '';
  },
  playQueue: [],
  musicLibraryWallState: null
};
vm.createContext(rematchContext);
vm.runInContext(lyrics.slice(rematchStart, rematchEnd), rematchContext);

const currentCloud = {
  cloudSong: true,
  cloudSource: 'netease-cloud',
  cloudId: 'cloud-cover-1',
  id: 'cloud-cover-1',
  cover: 'https://cover.example/original.jpg'
};
const queuedCloud = Object.assign({}, currentCloud);
const customCoverCloud = Object.assign({}, currentCloud, {
  cover: 'https://cover.example/custom-default.jpg',
  customCover: 'data:image/png;base64,custom'
});
rematchContext.playQueue.push(currentCloud, queuedCloud, customCoverCloud);

assert.equal(rematchContext.setCloudLyricRematch(currentCloud, {
  provider: 'netease',
  id: 'online-cover-1',
  albumPicUrl: 'https://cover.example/matched.jpg'
}), true);
assert.equal(rematchContext.cloudLyricRematchCoverForSong(currentCloud), 'https://cover.example/matched.jpg');
assert.equal(rematchContext.cloudLyricRematchOriginalCoverForSong(currentCloud), 'https://cover.example/original.jpg');
assert.equal(queuedCloud.cover, 'https://cover.example/matched.jpg');
assert.equal(customCoverCloud.cover, 'https://cover.example/custom-default.jpg');
assert.equal(
  rematchContext.cloudLyricRematchCoverForSong(Object.assign({}, currentCloud, { cloudLyricRematch: null })),
  'https://cover.example/matched.jpg'
);
assert.equal(rematchContext.setCloudLyricRematch(currentCloud, {
  provider: 'netease',
  id: 'online-cover-2'
}), true);
assert.equal(rematchContext.cloudLyricRematchCoverForSong(currentCloud), '');
assert.equal(rematchContext.cloudLyricRematchOriginalCoverForSong(currentCloud), 'https://cover.example/original.jpg');
assert.equal(currentCloud.cover, 'https://cover.example/original.jpg');
assert.equal(queuedCloud.cover, 'https://cover.example/original.jpg');
assert.equal(customCoverCloud.cover, 'https://cover.example/custom-default.jpg');

// 网易搜索结果里 al.pic 是纯数字图片 ID。它曾被当成封面地址写进 song.cover 和
// localStorage，浏览器按相对路径请求成 localhost:3000/1099511689… 刷一屏 404。
// 按「像不像地址」筛而不是按字段名删：酷狗的 pic 确实是真地址，不能一刀切。
assert.match(lyrics, /function isCloudLyricRematchCoverUrl\(/);
assert.equal(rematchContext.isCloudLyricRematchCoverUrl('109951168971888100'), false);
assert.equal(rematchContext.isCloudLyricRematchCoverUrl('https://p1.music.126.net/x.jpg'), true);
assert.equal(rematchContext.isCloudLyricRematchCoverUrl('data:image/png;base64,AAAA'), true);
assert.equal(rematchContext.isCloudLyricRematchCoverUrl(''), false);

// 候选里只有数字 picId 时必须判成「没有封面」，而不是把数字当地址用。
assert.equal(rematchContext.cloudLyricRematchCoverFromCandidate({ album: { pic: 109951168971888100 } }), '');
// 数字 picId 不能挡住同一候选里真正可用的地址。
assert.equal(
  rematchContext.cloudLyricRematchCoverFromCandidate({
    picUrl: '109951168971888100',
    albumPicUrl: 'https://p1.music.126.net/real.jpg'
  }),
  'https://p1.music.126.net/real.jpg'
);

// 坏值不能被当成「原封面」存下来，否则恢复等于恢复成 404。
const poisonedCloud = {
  cloudSong: true,
  cloudSource: 'netease-cloud',
  cloudId: 'cloud-poisoned',
  id: 'cloud-poisoned',
  cover: '109951168971888100'
};
rematchContext.playQueue.push(poisonedCloud);
assert.equal(rematchContext.setCloudLyricRematch(poisonedCloud, {
  provider: 'netease',
  id: 'online-poisoned',
  album: { pic: 109951168971882800 }
}), true);
assert.equal(rematchContext.cloudLyricRematchCoverForSong(poisonedCloud), '');
assert.equal(rematchContext.cloudLyricRematchOriginalCoverForSong(poisonedCloud), '',
  'a poisoned song.cover must not be stored as the restore target');
assert.equal(poisonedCloud.cover, '', 'the numeric picId must not survive on the song object');

// 归一化是所有来源的唯一入口：localStorage 老数据里的坏 originalCover 也要筛掉。
assert.equal(
  rematchContext.normalizeNeteaseCloudLyricRematchCandidate({
    provider: 'netease', id: 'stale', originalCover: '109951168971888100'
  }).originalCover,
  ''
);

const actionsStart = lyricActions.indexOf('var localMatchModalState = {');
const actionsEnd = lyricActions.indexOf('function openTrackDetailModal(');
assert.ok(actionsStart >= 0 && actionsEnd > actionsStart);

function makeCloudRematchActionContext() {
  const elements = {
    'local-match-status': { textContent: '' },
    'local-match-search-btn': { disabled: false },
    'local-match-modal': {}
  };
  const calls = { applied: 0, persisted: [], cached: [], covers: [] };
  const pendingResponses = [];
  const pendingProviderWaits = [];
  const context = {
    document: {
      getElementById(id) { return elements[id] || null; }
    },
    trackSwitchToken: 1,
    miniQueueOpen: false,
    activeSong: null,
    currentCoverSong() { return context.activeSong; },
    compactLocalOnlineMetadata(candidate, provider) {
      return Object.assign({ provider, source: provider }, candidate);
    },
    neteaseCloudLyricRematchSongKey(song) {
      return song && song.cloudSong && song.cloudId ? 'netease-cloud:' + song.cloudId : '';
    },
    lyricEndpointForSong() { return '/api/test-lyric'; },
    apiJson() {
      return new Promise(resolve => pendingResponses.push(resolve));
    },
    parseLyricResponseToOriginalState() { return { usableLyric: true }; },
    setCloudLyricRematch(song, metadata) {
      song.cloudLyricRematch = metadata;
      calls.persisted.push(metadata.id);
      return true;
    },
    cloudLyricRematchIdentity(metadata) { return metadata && metadata.id || ''; },
    cloudLyricRematchCoverForSong(song) { return song && song.cloudLyricRematch && song.cloudLyricRematch.cover || ''; },
    mergeInlineLyricResponseForSong(song, response) { return response; },
    writePersistentLyricCache(song, response) { calls.cached.push({ song, response }); },
    applyFetchedLyricResponse() {
      calls.applied += 1;
      return { usableLyric: true };
    },
    getCustomCoverForSong() { return ''; },
    songCoverSrc(song) { return song && song.cover || ''; },
    coverUrlWithSize(url) { return url; },
    loadCoverFromUrl(url) { calls.covers.push(url); },
    safeRenderQueuePanel() {},
    safeShelfRebuild() {},
    renderMusicLibraryWallFromSources() {},
    updateControlTrackInfo() {},
    syncMediaSessionState() {},
    updateCustomCoverButton() {},
    closeGsapModal() {},
    showToast() {}
  };
  vm.createContext(context);
  vm.runInContext(lyricActions.slice(actionsStart, actionsEnd), context);
  return { context, calls, pendingResponses, pendingProviderWaits };
}

async function verifyCloudRematchAsyncGuards() {
  const sourceSong = { cloudSong: true, cloudId: 'source-song', id: 'source-song', cover: 'source-cover' };
  const nextSong = { cloudSong: true, cloudId: 'next-song', id: 'next-song', cover: 'next-cover' };
  const staleBeforeRequest = makeCloudRematchActionContext();
  staleBeforeRequest.context.activeSong = sourceSong;
  staleBeforeRequest.context.localMatchModalState.song = sourceSong;
  staleBeforeRequest.context.localMatchModalState.session = 1;
  staleBeforeRequest.context.waitForLocalLyricProvider = () => new Promise(resolve => {
    staleBeforeRequest.pendingProviderWaits.push(resolve);
  });
  const staleBeforeRequestPromise = staleBeforeRequest.context.applyCloudLyricMatchCandidate(sourceSong, {
    id: 'cancelled-before-request'
  }, 'netease');
  assert.equal(staleBeforeRequest.pendingProviderWaits.length, 1);
  staleBeforeRequest.context.localMatchModalState.applyRequest += 1;
  staleBeforeRequest.pendingProviderWaits[0]();
  await staleBeforeRequestPromise;
  assert.equal(staleBeforeRequest.pendingResponses.length, 0, 'an invalidated request must not start a lyric fetch after provider throttling');

  const switched = makeCloudRematchActionContext();
  switched.context.activeSong = sourceSong;
  switched.context.localMatchModalState.song = sourceSong;
  switched.context.localMatchModalState.session = 1;
  const switchedRequest = switched.context.applyCloudLyricMatchCandidate(sourceSong, {
    id: 'matched-source', cover: 'matched-cover'
  }, 'netease');
  assert.equal(switched.pendingResponses.length, 1);
  switched.context.trackSwitchToken = 2;
  switched.context.activeSong = nextSong;
  switched.pendingResponses[0]({ lyric: '[00:00.00] matched' });
  await switchedRequest;
  assert.equal(switched.calls.applied, 0, 'a response for the old track must not replace current lyrics');
  assert.deepEqual(switched.calls.persisted, ['matched-source']);
  assert.equal(switched.calls.cached.length, 1, 'the selected old track should still keep its lyric cache');
  assert.equal(switched.calls.cached[0].song, sourceSong);

  const noCoverSong = { cloudSong: true, cloudId: 'no-cover-song', id: 'no-cover-song', cover: 'original-cover' };
  const noCover = makeCloudRematchActionContext();
  noCover.context.activeSong = noCoverSong;
  noCover.context.localMatchModalState.song = noCoverSong;
  noCover.context.localMatchModalState.session = 1;
  const noCoverRequest = noCover.context.applyCloudLyricMatchCandidate(noCoverSong, {
    id: 'no-cover-choice'
  }, 'netease');
  noCover.pendingResponses[0]({ lyric: '[00:00.00] no cover' });
  await noCoverRequest;
  assert.deepEqual(noCover.calls.covers, ['original-cover'], 'a coverless match must refresh the player with the fallback art');

  const raced = makeCloudRematchActionContext();
  raced.context.activeSong = sourceSong;
  raced.context.localMatchModalState.song = sourceSong;
  raced.context.localMatchModalState.session = 1;
  const firstRequest = raced.context.applyCloudLyricMatchCandidate(sourceSong, {
    id: 'first-choice', cover: 'first-cover'
  }, 'netease');
  const secondRequest = raced.context.applyCloudLyricMatchCandidate(sourceSong, {
    id: 'second-choice', cover: 'second-cover'
  }, 'netease');
  assert.equal(raced.pendingResponses.length, 2);
  raced.pendingResponses[1]({ lyric: '[00:00.00] second' });
  await secondRequest;
  raced.pendingResponses[0]({ lyric: '[00:00.00] first' });
  await firstRequest;
  assert.deepEqual(raced.calls.persisted, ['second-choice'], 'only the newest candidate may commit its result');
  assert.equal(raced.calls.applied, 1);
}

verifyCloudRematchAsyncGuards().then(() => {
  console.log('OK netease-cloud-integration');
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
