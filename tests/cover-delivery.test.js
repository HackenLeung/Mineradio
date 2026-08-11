const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
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
