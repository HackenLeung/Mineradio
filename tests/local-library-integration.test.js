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
const beatAnalysis = read('public/js/modules/03-beat/01-audio-beat-analysis.js');
const coverLoading = read('public/js/modules/03-beat/05-cover-loading-crop.js');
const customCoverMap = read('public/js/modules/05-playback/01-cover-custom-map.js');
const playbackStart = read('public/js/modules/05-playback/13-playback-start-audio.js');
const playlistDetail = read('public/js/modules/06-lyrics/02-playlist-detail.js');
const pointerLayer = read('public/js/modules/02-visual/00-pointer-cover-particles.js');
const indexHtml = read('public/index.html');
const indexCss = read('public/css/index.css');
const renderState = read('public/js/modules/00-state/01-perf-render-state.js');

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
  'getLocalLibraryFolders',
  'setLocalLibraryFolders',
  'getCustomCovers',
  'setCustomCovers',
  'getLocalLyricsCache',
  'setLocalLyricsCache',
  'getLocalOnlineMetadataCache',
  'setLocalOnlineMetadataCache',
].forEach(name => assert.match(preload, new RegExp(`${name}:`), `${name} must be exposed through preload`));

assert.match(upload, /function restoreLocalLibraryFolders\(/);
assert.match(upload, /await hydrateLocalLibraryFolderPaths\(\)/);
assert.match(upload, /setLocalLibraryFolders\(normalized\)/);
assert.match(upload, /updateLocalLibraryFolder\(paths\[i\], \[\], \{ restoreError:/);
assert.match(upload, /folder\.restoreError \? \('读取失败/);
assert.match(upload, /function rebindRestoredLocalQueueSongs\(/);
assert.match(upload, /function hydrateLocalFolderPreview\(/);
assert.match(upload, /Math\.min\(3, songs\.length\)/);
assert.match(upload, /Object\.assign\(song, cloneSong\(fresh\), \{ localMissing: false \}\)/);
assert.match(upload, /embeddedMediaParsed: file\.embeddedMediaParsed === true/);
assert.match(upload, /provider: provider,[\s\S]{0,500}albumAudioId:[\s\S]{0,250}mixSongId:/);
assert.match(upload, /function compactLocalOnlineMetadata\(/);
assert.match(upload, /source: provider/);
assert.match(upload, /albumId: song\.albumId \|\| song\.album_id/);
assert.match(upload, /artists: Array\.isArray\(song\.artists\)/);
assert.match(upload, /sidecarCover \|\| song\.embeddedCover \|\| song\.cover/);
assert.match(upload, /function localLibraryDetailHtml\(/);
assert.match(upload, /data-local-detail-row/);
assert.doesNotMatch(upload, /var songs = expanded \?/);
assert.match(upload, /syncResolvedLocalSongReferences\(song\)/);
assert.match(upload, /localLibrarySongs[\s\S]{0,260}localFolderPlaylists[\s\S]{0,260}playQueue/);
assert.match(upload, /function matchLocalFolderLyrics\(/);
assert.match(upload, /function matchLocalSongLyricsWithRetry\(/);
assert.match(upload, /function hasReusableLocalLyricMatch\(/);
assert.match(upload, /function readReusableLocalLyricCache\(/);
assert.match(upload, /getLocalLyricsCache\(cacheKey\)/);
assert.match(upload, /function localFolderHasUsableLyricPayload\(/);
assert.match(upload, /parseLyricResponseToOriginalState\(song \|\| \{\}, payload \|\| \{\}\)/);
assert.match(upload, /cached && cached\.ok && localFolderHasUsableLyricPayload\(song, cached\.payload\)/);
assert.match(upload, /return \{ reused: true, source: 'cache', provider: provider/);
assert.match(upload, /return \{ reused: false, source: 'remote', provider: provider/);
assert.match(upload, /if \(result && result\.reused\) localFolderLyricMatchState\.skipped \+= 1/);
assert.doesNotMatch(upload, /applyLocalOnlineMetadata\(song, metadata\);[\s\S]{0,100}syncResolvedLocalSongReferences\(song\);[\s\S]{0,50}return true;/);
assert.match(upload, /function hasReusableLocalOnlineMetadata\(/);
assert.match(upload, /function normalizeStoredLocalOnlineMetadata\(/);
assert.match(upload, /var LOCAL_LYRIC_MATCH_PROVIDERS = \['netease', 'kugou', 'qq'\]/);
assert.match(upload, /LOCAL_LYRIC_PROVIDER_INTERVAL_MS = \{ netease: 1100, kugou: 420, qq: 420 \}/);
assert.match(upload, /function waitForLocalLyricProvider\(/);
assert.match(upload, /function noteLocalLyricProviderResult\(/);
assert.match(upload, /操作频繁/);
assert.match(upload, /too many requests/);
assert.match(upload, /rate\.\?limit/);
assert.match(upload, /Math\.min\(30000, 4000 \* Math\.pow\(2, count - 1\)\)/);
assert.match(upload, /while \(true\)[\s\S]*availableAt <= now[\s\S]*await localLyricMatchDelay/,
  'queued workers must re-check a provider cooldown after another request is rate-limited');
assert.match(upload, /function isLocalLyricMatchProvider\(/);
assert.match(upload, /function localLyricMatchProviderOrder\(/);
assert.match(upload, /function isAcceptableLocalLyricCandidate\(/);
assert.match(upload, /function resolveLocalOnlineLyricMatch\(/);
assert.match(upload, /LOCAL_ONLINE_LYRIC_EMPTY/);
assert.match(upload, /!localFolderHasUsableLyricPayload\(song, response\)/);
assert.match(upload, /savedPayload = savedOnlineSong \? await readReusableLocalLyricCache/);
assert.match(upload, /provider: savedMetadata\.provider, metadata: savedMetadata, payload: savedPayload/);
assert.match(upload, /ranked\.slice\(0, 2\)/);
assert.doesNotMatch(upload, /providers = \[savedMetadata\.provider\]/);
assert.match(upload, /syncLocalMetadata\(song, metadata\);[\s\S]{0,180}return \{ reused: false, source: 'remote'/);
assert.match(upload, /return await resolveLocalOnlineLyricMatch\(song, desktopApi\)/);
assert.match(upload, /localFolderLyricMatchState\.skipped \+= 1|skipped \+= 1/);
assert.match(upload, /else pendingSongs\.push\(song\)/);
assert.match(upload, /applyStoredLocalMetadataToLibrary\(\)/);
assert.match(upload, /await hydrateLocalMetadataFromDisk\(\)/);
assert.match(upload, /id="folder-lyric-match-/);
assert.match(upload, /'匹配歌词'/);
assert.match(upload, /folder-lyric-match-btn' \+ \(localFolderLyricMatchState\.active/);
assert.doesNotMatch(upload, /\(expanded \? '关闭' : '查看'\)/);
assert.match(indexHtml, /id="local-lyric-match-chip"/);
assert.match(indexCss, /\.local-library-folder\{[^}]*grid-template-columns:44px minmax\(0,1fr\);[^}]*overflow:hidden/);
assert.match(indexCss, /\.local-library-name,\.local-library-sub\{[^}]*display:block;[^}]*text-overflow:ellipsis/);
assert.match(indexCss, /\.local-library-folder:hover \.folder-lyric-match-btn/);

assert.match(coverLoading, /isInlineCoverSrc\(directUrl\)[\s\S]{0,120}applyCoverDataUrl\(directUrl, opts\)/);
assert.match(desktopMain, /local-library-folders-v1\.json/);
assert.match(desktopMain, /custom-covers-v1\.json/);
['tlyric', 'ytlrc', 'romalrc', 'yromalrc', 'klyric', 'qrc', 'roma', 'trans'].forEach((field) => {
  assert.match(desktopMain, new RegExp(`${field}: String\\(payload`), `persistent local lyric cache must retain ${field}`);
});
assert.match(desktopMain, /item\.embeddedMediaParsed = true/);
assert.match(customCoverMap, /function hydrateCustomCoverMapFromDisk\(/);
assert.match(customCoverMap, /Object\.assign\(\{\}, result\.payload, customCoverMap \|\| \{\}\)/);
assert.match(customCoverMap, /localLibrarySongs\) \? localLibrarySongs : \[\]\)\.forEach\(hydrateCustomCover\)/);
assert.match(customCoverMap, /setCustomCovers\(customCoverMap \|\| \{\}\)/);
assert.match(playbackStart, /!song\.localUrl \|\| \(!song\.customCover && !song\.sidecarCover && !song\.embeddedCover && !song\.embeddedMediaParsed\)/);
assert.match(indexHtml, /id="playlist-detail-panel"/);
assert.match(upload, /data-local-detail-current="1">定位当前歌曲/);
assert.match(upload, /function locateCurrentLocalLibraryTrack\(/);
assert.match(upload, /localLibraryDetailState\.renderLimit = index \+ 1/);
assert.match(upload, /data-local-detail-row="' \+ index/);
assert.match(playlistDetail, /closest\('\[data-local-detail-current\]'\)/);
assert.match(indexCss, /\.pl-detail-row\.is-current-located/);
assert.match(indexCss, /playlist-panel-sticky \.panel-tabs\s*\{[\s\S]{0,180}grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\)/);
assert.match(indexCss, /\.panel-tab\s*\{[\s\S]{0,420}white-space:\s*nowrap/);
assert.match(indexCss, /#playlist-detail-panel\.show\s*\{[\s\S]{0,120}pointer-events:\s*auto/);
assert.match(renderState, /var PLAYLIST_DETAIL_ROW_STEP = 50/);
assert.match(indexCss, /#playlist-detail-panel \.pl-inline-detail\s*\{[\s\S]{0,260}background:\s*transparent !important/);
assert.match(indexCss, /#playlist-detail-panel \.pl-detail-row\s*\{[\s\S]{0,320}min-height:\s*44px;[\s\S]{0,320}background:\s*rgba\(8, 10, 14, \.92\) !important/);
assert.doesNotMatch(playlistDetail, /entries\.push\(\{ type: 'detail'/);
assert.match(playlistDetail, /document\.getElementById\('playlist-detail-panel'\)/);
assert.match(pointerLayer, /#playlist-detail-panel/);

assert.match(queueSnapshot, /function playbackRestoreSongSnapshot\(song, minimal\)/);
assert.doesNotMatch(queueSnapshot, /playQueue\.slice\(0, 120\)/);
assert.doesNotMatch(queueSnapshot, /PLAYBACK_SNAPSHOT_QUEUE_LIMIT|limit:\s*\d+/);
assert.match(queueSnapshot, /var attempts = \[\s*\{ minimal: false \},\s*\{ minimal: true \}/);
assert.match(queueSnapshot, /var packed = sourceQueue\.map/);
assert.match(queueSnapshot, /var PLAYBACK_SNAPSHOT_IDENTITY_KEYS = \[/);
assert.match(queueSnapshot, /function playbackSnapshotSafeUrl\(value\)/);
assert.match(queueSnapshot, /\^data:/);
assert.match(queueSnapshot, /'localPath'.*'localFolderPath'.*'localFolderName'/s);
assert.match(queueSnapshot, /if \(snapshot\.playMode\) playMode = snapshot\.playMode/);
assert.match(queueSnapshot, /currentLocalSong = isLocal \? playQueue\[currentIdx\] : null/);

assert.match(beatCacheModal, /var cached = getLocalBeatEntry\(song\.localKey, 'mr'\)/);
assert.match(beatCacheModal, /readBeatDiskCache\(localBeatDiskKey\(song\.localKey, 'mr'\)\)/);
assert.match(beatCacheModal, /function scheduleDefaultLocalMrAnalysis\(/);
assert.match(beatCacheModal, /startLocalBeatAnalysis\('mr', \{ background: true, lowImpact: true, silent: true/);
assert.match(beatCacheModal, /background: options\.background === true/);
assert.match(beatCacheModal, /lowImpact: options\.lowImpact === true/);
assert.doesNotMatch(beatCacheModal.slice(beatCacheModal.indexOf('function prepareLocalBeatAnalysis'), beatCacheModal.indexOf('function scheduleDefaultLocalMrAnalysis')), /openLocalBeatModal\(/);
assert.match(beatAnalysis, /var frameSampleStride = options\.lowImpact \? 3 : 1/);
assert.match(beatAnalysis, /var frameYieldInterval = options\.lowImpact \? 180 : 520/);
assert.match(indexCss, /#local-beat-modal\s*\{\s*pointer-events:\s*none/s);
assert.match(indexCss, /#local-beat-modal \.local-beat-modal\s*\{\s*pointer-events:\s*auto/s);

const inlineBranch = lyrics.indexOf("var inlineText = String(song.localLyricText || song.embeddedLyrics || '')");
const onlineBranch = lyrics.indexOf('var onlineSong = localOnlineSongForMetadata(song)');
const resolverBranch = lyrics.indexOf('if (typeof resolveLocalOnlineLyricMatch');
const remoteFetch = lyrics.indexOf('var response = await apiJson(lyricEndpointForSong(onlineSong))');
assert.ok(inlineBranch >= 0 && resolverBranch > inlineBranch && onlineBranch > resolverBranch && remoteFetch > onlineBranch,
  'sidecar and embedded lyrics must win, then the verified resolver must run before legacy remote fallback');
assert.match(lyrics, /getLocalLyricsCache\(cacheKey\)/);
assert.match(lyrics, /setLocalLyricsCache\(cacheKey, response \|\| \{\}\)/);
assert.match(lyrics, /resolveLocalOnlineLyricMatch\(song, window\.desktopWindow\)/);
assert.match(lyrics, /!isLocalLyricMatchProvider\(provider\)\) return null/);
assert.match(lyrics, /fallback && fallback\.payload/);
assert.match(lyrics, /var resolved = await resolveLocalOnlineLyricMatch\(song, window\.desktopWindow\)/);
assert.doesNotMatch(lyrics.slice(lyrics.indexOf('async function fetchLocalSongLyric'), lyrics.indexOf('async function fetchLyric')), /resolveLocalOnlineMetadata\(song, token\)/);
assert.match(read('public/js/modules/05-playback/06-track-detail-lyrics-actions.js'), /var providers = \[\{ key: 'netease'.*\{ key: 'kugou'.*\{ key: 'qq'/s);
assert.doesNotMatch(read('public/js/modules/05-playback/06-track-detail-lyrics-actions.js'), /var providers = \[[^\]]*qishui[^\]]*spotify/);

console.log('OK local-library-integration');
