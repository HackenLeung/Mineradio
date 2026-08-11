const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const coverMap = read('public/js/modules/05-playback/01-cover-custom-map.js');
const delivery = read('public/js/modules/05-playback/16-cover-delivery.js');
const playbackStart = read('public/js/modules/05-playback/13-playback-start-audio.js');
const playlistLoader = read('public/js/modules/06-lyrics/03-podcast-playlist-loaders.js');
const loader = read('public/js/index-loader.js');
const click = read('public/js/modules/04-shelf/05-card-interactions.js');
const content = read('public/js/modules/04-shelf/03-content-list-manager.js');
const libraryWall = read('public/js/modules/05-playback/03c-music-library-wall.js');
const lyricsState = read('public/js/modules/02-visual/02-lyrics-state-layout.js');
const lyricsRender = read('public/js/modules/02-visual/14-stage-lyrics-rendering.js');
const mainLoop = read('public/js/modules/11-main-loop.js');
const libraryWallHtml = read('public/index.html');
const libraryWallCss = read('public/css/music-library-wall.css');

test('cover delivery is loaded after the control-glass module', () => {
  assert.match(loader, /15-control-glass-animations\.js'[\s\S]*16-cover-delivery\.js/);
  assert.match(loader, /16-cover-delivery\.js'[\s\S]*18-smart-transition-integration\.js/);
});

test('music library wall track cards own the delivery entry point', () => {
  assert.match(libraryWall, /function musicLibraryWallCommitTrackPlayback\(detail, index, opts\)/);
  assert.match(libraryWall, /function musicLibraryWallPlayTrack\(index, sourceCard\)/);
  assert.match(libraryWall, /startCoverDeliveryFromMusicLibraryCard\(sourceCard, detail\.tracks\[index\]/);
  assert.match(libraryWall, /onPlaybackReady: playTrack/);
  assert.match(libraryWall, /musicLibraryWallPlayTrack\(Number\(trackCard\.getAttribute\('data-mlw-track-index'\)\) \|\| 0, trackCard\)/);
  assert.doesNotMatch(click, /startCoverDeliveryFromShelfRow/);
  assert.doesNotMatch(content, /beginCoverDelivery|getCoverDeliverySource|deliverying/);
});

test('delivery has the requested motion, Three Points particle layer, and beat linkage', () => {
  assert.match(delivery, /scale:\s*0\.70/);
  assert.match(delivery, /coverDeliveryQuadratic/);
  assert.match(delivery, /new THREE\.Points/);
  assert.match(delivery, /attribute vec3 color/);
  assert.match(delivery, /uBass/);
  assert.match(delivery, /uBeat/);
  assert.match(delivery, /uTreble/);
  assert.match(delivery, /triggerRipple\(0, 0/);
  assert.match(delivery, /yoyo:\s*true/);
  assert.match(delivery, /setControlCoverSrc/);
  assert.match(delivery, /animateWallpaperEngineControlGlassSurface/);
  assert.match(delivery, /deliveryScale/);
  assert.match(delivery, /function coverDeliveryCreateMusicLibrarySource\(card, song\)/);
  assert.match(delivery, /function startCoverDeliveryFromMusicLibraryCard\(card, song, options\)/);
  assert.match(delivery, /is-cover-delivering/);
  assert.match(delivery, /function coverDeliveryStartPlayback/);
  assert.match(delivery, /coverDeliveryCancel\(reason \|\| 'aborted'\);[\s\S]*coverDeliveryStartPlayback\(state\)/);
  assert.match(delivery, /coverDeliveryAbort\(state, 'cover-load-failed'\)/);
  assert.match(delivery, /function coverDeliveryPreparePlayback\(opts\)/);
  assert.match(delivery, /coverDeliveryToken/);
  assert.match(delivery, /state\.onPlaybackReady\(playbackOptions\)/);
  assert.match(delivery, /image\.complete && imageUrl && typeof image\.naturalWidth === 'number' && image\.naturalWidth === 0/);
});

test('delivery token is validated by the playback root and survives the playlist handoff', () => {
  assert.match(playbackStart, /coverDeliveryPreparePlayback\(opts\)/);
  assert.match(playbackStart, /delete opts\.coverDeliveryToken/);
  assert.match(libraryWall, /coverDeliveryToken: opts\.coverDeliveryToken/);
  assert.match(playlistLoader, /coverDeliveryToken: opts\.coverDeliveryToken/);
});

test('lyrics scale remains owned by the lyrics frame update and receives deliveryScale', () => {
  assert.match(lyricsState, /deliveryScale:\s*1/);
  assert.match(lyricsRender, /layoutScale \* stageLyrics\.lockFitScale \* clampRange\(deliveryScale/);
  assert.match(mainLoop, /tickCoverDeliveryParticles\(dt\)/);
  assert.match(delivery, /lyricsPulseToken/);
  assert.match(delivery, /gsap\.timeline\(/);
  assert.match(delivery, /onComplete: settleScale/);
});

test('local library wall exposes search, current-track locate, and back-to-top controls', () => {
  assert.match(libraryWallHtml, /id="music-library-wall-search"/);
  assert.match(libraryWallHtml, /id="music-library-wall-locate-current"/);
  assert.match(libraryWallHtml, /id="music-library-wall-to-top"/);
  assert.match(libraryWall, /function musicLibraryWallTrackMatchesQuery\(song, query\)/);
  assert.match(libraryWall, /function musicLibraryWallFindCurrentTrackIndex\(detail\)/);
  assert.match(libraryWall, /function musicLibraryWallLocateCurrentTrack\(\)/);
  assert.match(libraryWall, /function musicLibraryWallQueueTrackNext\(index\)/);
  assert.match(libraryWall, /data-mlw-track-next/);
  assert.doesNotMatch(libraryWall, /data-mlw-track-next="1"[\s\S]{0,300}<span>下一首播放<\/span>/);
  assert.match(libraryWall, /queueDetailSongNext\(song\)/);
  assert.match(libraryWall, /isSameLocalLibrarySong\(song, current\)/);
  assert.match(libraryWall, /function musicLibraryWallScrollToTop\(\)/);
  assert.match(libraryWall, /function musicLibraryWallHighlightLocateCard\(card, targetIndex\)/);
  assert.match(libraryWall, /locateTargetIndex/);
  assert.match(libraryWall, /musicLibraryWallState\.locateTargetIndex === index/);
  assert.match(libraryWall, /musicLibraryWallTrackCardHtml\(items\[index\]\.song, items\[index\]\.index\)/);
  assert.match(libraryWallCss, /#music-library-wall\[data-local-search="true"\] \.music-library-wall-content/);
  assert.match(libraryWallCss, /::-webkit-search-cancel-button[\s\S]{0,180}display:\s*none/);
  assert.match(libraryWallCss, /\.music-library-wall-card\.is-locate-highlight/);
  assert.match(libraryWallCss, /music-library-wall-locate-pulse \.72s/);
  assert.match(libraryWallCss, /\.music-library-wall-card-next/);
  assert.match(libraryWallCss, /\.music-library-wall-card-next\s*\{[^}]*width:\s*34px[^}]*height:\s*34px[^}]*border-radius:\s*50%/);
  assert.doesNotMatch(libraryWallCss, /\.music-library-wall-queue-next/);
  assert.doesNotMatch(libraryWall, /music-library-wall-queue-next|musicLibraryWallQueueHoveredTrackNext/);
  assert.match(libraryWallCss, /right:\s*calc\(clamp\(24px, 4vw, 64px\) \+ 80px\)/);
});

// 网易的 al.pic / pic 是纯数字图片 ID 而不是地址。它一旦当成 <img src>，
// 浏览器按相对路径解析成 http://localhost:3000/109951168971888100 刷一屏 404，
// 而且坏值会写进 song.cover 和 localStorage 长期生效。这里把守卫按行为钉住。
test('cover guard rejects bare numeric picIds and keeps real addresses', () => {
  const guardStart = coverMap.indexOf('function isInlineCoverSrc');
  const guardEnd = coverMap.indexOf('function songCustomCoverKey');
  assert.ok(guardStart >= 0 && guardEnd > guardStart, 'cover guard helpers must exist');
  const sandbox = { encodeURIComponent, Date };
  vm.runInNewContext(coverMap.slice(guardStart, guardEnd), sandbox, { filename: 'cover-guard.js' });

  // 真实 404 里出现过的 picId，结尾的 0 是 JSON float64 精度丢失留下的。
  assert.equal(sandbox.isUsableCoverSrc('109951168971888100'), false);
  assert.equal(sandbox.isUsableCoverSrc('109951168971882800'), false);
  assert.equal(sandbox.isUsableCoverSrc(109951168971888100), false, 'numeric type must be rejected too');

  assert.equal(sandbox.isUsableCoverSrc('https://p1.music.126.net/x/y.jpg'), true);
  assert.equal(sandbox.isUsableCoverSrc('data:image/png;base64,AAAA'), true);
  assert.equal(sandbox.isUsableCoverSrc('blob:http://localhost:3000/abc'), true);
  // 相对代理路径和桌面端 sidecar 的绝对地址都必须放行，否则本地封面会被误杀。
  assert.equal(sandbox.isUsableCoverSrc('/api/cover?url=x'), true);
  assert.equal(sandbox.isUsableCoverSrc('http://127.0.0.1:3000/api/local-media?id=1'), true);
  assert.equal(sandbox.isUsableCoverSrc(''), false);
  assert.equal(sandbox.isUsableCoverSrc(null), false);

  // 坏值也是真值：用 `a || b` 会让它挡住后面本来能用的字段，必须逐个筛。
  assert.equal(
    sandbox.firstUsableCoverSrc(['109951168971888100', 'https://p1.music.126.net/real.jpg']),
    'https://p1.music.126.net/real.jpg',
    'a bad leading value must not shadow a usable later field',
  );
  assert.equal(sandbox.firstUsableCoverSrc(['', null, '109951168971888100']), '');

  // 最后一道：坏值进到尺寸拼接也必须变成空串，而不是被当相对路径放出去。
  assert.equal(sandbox.coverUrlWithSize('109951168971888100', 400), '');
  assert.equal(
    sandbox.coverUrlWithSize('https://p1.music.126.net/real.jpg', 400),
    'https://p1.music.126.net/real.jpg?param=400y400',
  );
  assert.equal(sandbox.coverUrlWithSize('data:image/png;base64,AAAA', 400), 'data:image/png;base64,AAAA');
});
