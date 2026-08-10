'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const html = read('public/index.html');
const css = read('public/css/music-library-wall.css');
const loader = read('public/js/index-loader.js');
const state = read('public/js/modules/00-state/00-core-stores.js');
const homeDashboard = read('public/js/modules/05-playback/03a-home-dashboard.js');
const homeVisibility = read('public/js/modules/05-playback/04-home-empty-wallpaper.js');
const wall = read('public/js/modules/05-playback/03c-music-library-wall.js');
const playlistLoader = read('public/js/modules/06-lyrics/03-podcast-playlist-loaders.js');

assert.match(html, /css\/music-library-wall\.css/);
[
  'music-library-wall',
  'music-library-wall-back',
  'music-library-wall-title',
  'music-library-wall-status',
  'music-library-wall-play-all',
  'music-library-wall-content',
  'music-library-wall-grid',
].forEach(id => assert.match(html, new RegExp(`id="${id}"`), `${id} must exist in the main document`));

assert.match(loader, /js\/modules\/05-playback\/03c-music-library-wall\.js/);
assert.match(homeDashboard, /function openHomeDashboardLibrary\(\)[\s\S]{0,180}openMusicLibraryWall\(\)/);
assert.match(homeVisibility, /music-library-wall-active/);
assert.match(homeVisibility, /isMusicLibraryWallOpen\(\)[\s\S]{0,120}closeMusicLibraryWall\(\{ toHome: true/);

assert.match(wall, /function openMusicLibraryWall\(/);
assert.match(wall, /function closeMusicLibraryWall\(/);
assert.match(wall, /kind: 'local-all'/);
assert.match(wall, /kind: 'local-folder'/);
assert.match(wall, /kind: 'playlist'/);
assert.match(wall, /function musicLibraryWallVirtualWindow\(/);
assert.match(wall, /MUSIC_LIBRARY_WALL_OVERSCAN_ROWS/);
assert.match(wall, /detailScrollTops/);
assert.match(wall, /playlistTracksEndpoint\(detail\.provider, detail\.playlistId/);
assert.match(wall, /seedTracks: detail\.tracks/);
assert.match(wall, /startIndex: index/);
assert.match(wall, /preserveHomeState: false/);
assert.match(wall, /musicLibraryWallPlayTrack\(0\)/);
assert.match(wall, /event\.key !== 'Escape'/);
assert.match(wall, /requestNextPlaylistCatalogPage\('music-library-wall'\)/);
assert.match(wall, /var folderIndexes = item\.kind === 'local-folder'[\s\S]{0,240}return folderIndex; \}\)/,
  'opening a local wall must hydrate embedded covers without waiting for playback');
assert.match(wall, /\.then\(function \(\) \{ return hydrateLocalFolderPreview\(folderIndex\); \}\)\s*\n\s*\.then\(redrawHydratedWall\)/,
  'each folder must redraw as it finishes, so "all local" does not stay blank until the last folder is scanned');
assert.match(wall, /var redrawHydratedWall = function \(\)[\s\S]{0,260}detail\.scrollKey === detailScrollKey[\s\S]{0,120}renderMusicLibraryWallFromSources\(\)/,
  'a redraw from a stale hydration pass must not overwrite whichever library is open now');assert.match(wall, /hasMore: item\.kind === 'playlist',[\s\S]{0,220}loading: false/,
  'online L2 must start idle so the initial page request is not rejected as a duplicate');
assert.match(wall, /function musicLibraryWallSyncShelfTheme\([\s\S]{0,520}shelfAccentHex\([\s\S]{0,240}--mlw-shelf-accent-rgb/,
  'the cover wall must inherit the existing 3D shelf accent');
assert.match(wall, /setAttribute\('data-level', String\(musicLibraryWallState\.level\)\)/,
  'the transparent overlay must expose its level for minimal floating controls');
assert.match(wall, /var rowHeight = cardWidth \+ gap/,
  'cover-only cards must not reserve a persistent caption row');
assert.match(wall, /music-library-wall-art[\s\S]{0,260}music-library-wall-card-copy/,
  'titles and metadata must live inside the cover overlay');
assert.match(wall, /function musicLibraryWallUpdateCardTilt\(/);
assert.match(wall, /addEventListener\('pointermove'/);
assert.doesNotMatch(wall, /mouseenter[\s\S]{0,120}(playQueueAt|musicLibraryWallPlayTrack)/,
  'hover must not start playback');

assert.match(css, /\.music-library-wall-grid\s*\{[\s\S]{0,180}grid-template-columns:\s*repeat\(auto-fill, minmax\(156px, 1fr\)\)/);
assert.match(css, /#music-library-wall\s*\{[\s\S]{0,520}background:\s*transparent/,
  'the music library must reveal the existing stage instead of painting a page background');
assert.match(css, /\.music-library-wall-topbar\s*\{[\s\S]{0,340}height:\s*0[\s\S]{0,180}background:\s*none/,
  'the former full-width title bar must collapse into floating controls');
assert.match(css, /\.music-library-wall-heading\s*\{\s*display:\s*none\s*\}/);
assert.match(css, /body\.music-library-wall-active #top-right\s*\{[\s\S]{0,180}z-index:\s*26[\s\S]{0,160}pointer-events:\s*auto/,
  'the native Home and account controls must remain available above the stage overlay');
assert.match(css, /\.music-library-wall-content\s*\{[\s\S]{0,240}display:\s*flex[\s\S]{0,100}flex-direction:\s*column/);
assert.doesNotMatch(css, /\.music-library-wall-grid\s*\{[^}]*margin-top:\s*auto/,
  'short cover walls must stay aligned with the same top edge as multi-row walls');
assert.match(css, /\.music-library-wall-grid\s*\{[^}]*margin-bottom:\s*auto/,
  'unused vertical space should remain below a short cover wall');
assert.match(css, /\.music-library-wall-card:hover,[\s\S]{0,320}translateY\(-10px\)[\s\S]{0,80}scale\(1\.055\)/);
assert.match(css, /\.music-library-wall-card\s*\{[\s\S]{0,620}perspective:\s*820px/,
  'each cover owns its perspective so edge cards do not get pushed outside the viewport');
assert.match(css, /\.music-library-wall-card:hover \.music-library-wall-art,[\s\S]{0,420}translateZ\(34px\)[\s\S]{0,180}rotateY\(calc\(-1\.2deg \+ var\(--mlw-tilt-y\)\)\)/);
assert.match(css, /rotateX\(calc\(var\(--mlw-rack-x\) \+ var\(--mlw-tilt-x\)\)\)[\s\S]{0,140}rotateY\(calc\(var\(--mlw-rack-y\) \+ var\(--mlw-tilt-y\)\)\)/);
assert.match(css, /\.music-library-wall-art::after[\s\S]{0,420}var\(--mlw-glare-x\)/);
assert.match(css, /\.music-library-wall-card-copy\s*\{[\s\S]{0,340}opacity:\s*0/);
assert.match(css, /\.music-library-wall-card:hover \.music-library-wall-card-copy,[\s\S]{0,220}opacity:\s*1/);
assert.match(css, /body\.music-library-wall-active #bottom-bar[\s\S]{0,180}pointer-events:\s*auto/);
assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);

assert.match(state, /var playlistLoadRequestState = \{ token: 0, controller: null, timer: 0 \}/);
assert.match(playlistLoader, /playlistLoadRequestState\.controller\.abort\(\)/);
assert.match(playlistLoader, /playlistLoadRequestState\.token !== loadRequestToken/);
assert.match(playlistLoader, /firstPageController\.abort\(\)/);
assert.match(playlistLoader, /queueHydrationState = \{[\s\S]{0,620}queueRef: playQueue/);
assert.match(playlistLoader, /后续歌曲会按需流式加入队列/);

console.log('OK music-library-wall');
