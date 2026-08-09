'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const storeSource = read('public/js/modules/05-playback/02a-listen-report-store.js');
const viewSource = read('public/js/modules/05-playback/03d-listen-report-view.js');
const posterSource = read('public/js/modules/05-playback/03e-listen-report-posters.js');
const statsSource = read('public/js/modules/05-playback/02-listen-stats.js');
const homeSource = read('public/js/modules/05-playback/04-home-empty-wallpaper.js');
const loaderSource = read('public/js/index-loader.js');
const htmlSource = read('public/index.html');
const cssSource = read('public/css/index.css');
const desktopSource = read('desktop/main.js');
const preloadSource = read('desktop/preload.js');

function createReportContext() {
  const values = new Map();
  const context = vm.createContext({
    console: { warn() {} },
    localStorage: {
      getItem(key) { return values.has(key) ? values.get(key) : null; },
      setItem(key, value) { values.set(key, String(value)); },
      removeItem(key) { values.delete(key); },
    },
    window: { indexedDB: null },
    document: {
      getElementById() { return null; },
      querySelectorAll() { return []; },
      addEventListener() {},
    },
    setTimeout,
    clearTimeout,
    requestAnimationFrame(callback) { callback(); },
    Date,
    Math,
    Number,
    String,
    Array,
    Object,
    Promise,
    JSON,
  });
  vm.runInContext(storeSource, context, { filename: '02a-listen-report-store.js' });
  vm.runInContext(viewSource, context, { filename: '03d-listen-report-view.js' });
  vm.runInContext(posterSource, context, { filename: '03e-listen-report-posters.js' });
  return context;
}

function installCanvasStub(context) {
  const gradient = { addColorStop() {} };
  const drawingContext = {
    beginPath() {},
    moveTo() {},
    lineTo() {},
    arcTo() {},
    arc() {},
    closePath() {},
    rect() {},
    clip() {},
    save() {},
    restore() {},
    fill() {},
    stroke() {},
    strokeRect() {},
    fillRect() {},
    fillText() {},
    drawImage() {},
    measureText(value) { return { width: String(value).length * 13 }; },
    createLinearGradient() { return gradient; },
    createRadialGradient() { return gradient; },
  };
  context.document.createElement = (tagName) => {
    assert.equal(tagName, 'canvas');
    return {
      width: 0,
      height: 0,
      getContext(type) {
        assert.equal(type, '2d');
        return drawingContext;
      },
      toDataURL(type) { return `data:${type};base64,poster`; },
    };
  };
}

test('monthly and yearly reports merge ranks by effective time with plays as the tie-breaker', () => {
  const context = createReportContext();
  const months = [
    {
      period: '2026-07',
      totalListenMs: 180000,
      sessions: 2,
      completed: 1,
      songs: {
        a: { key: 'a', name: 'A', artist: 'Artist A', listenMs: 60000, plays: 1, lastPlayedAt: 10 },
        b: { key: 'b', name: 'B', artist: 'Artist B', listenMs: 60000, plays: 2, lastPlayedAt: 9 },
      },
      artists: {
        'artist a': { name: 'Artist A', listenMs: 60000, plays: 1 },
        'artist b': { name: 'Artist B', listenMs: 60000, plays: 2 },
      },
      hours: Array(24).fill(0),
      days: { '2026-07-04': 180000 },
      firstRecordedAt: 10,
      lastRecordedAt: 20,
    },
    {
      period: '2026-08',
      totalListenMs: 120000,
      sessions: 1,
      completed: 1,
      songs: {
        a: { key: 'a', name: 'A', artist: 'Artist A', listenMs: 120000, plays: 1, lastPlayedAt: 30 },
      },
      artists: {
        'artist a': { name: 'Artist A', listenMs: 120000, plays: 1, lastPlayedAt: 30 },
      },
      hours: Array(24).fill(0),
      days: { '2026-08-01': 120000 },
      firstRecordedAt: 30,
      lastRecordedAt: 30,
    },
  ];

  const month = context.aggregateListenReportV3(months, 'month', '2026-07');
  assert.deepEqual(Array.from(month.songs, item => item.key), ['b', 'a']);
  assert.equal(month.sessions, 2);

  const year = context.aggregateListenReportV3(months, 'year', '2026');
  assert.equal(year.totalListenMs, 300000);
  assert.equal(year.sessions, 3);
  assert.equal(year.songs[0].key, 'a');
  assert.equal(year.songs[0].listenMs, 180000);
  assert.equal(Object.keys(year.days).length, 2);
});

test('the active listening window rolls across midnight', () => {
  const context = createReportContext();
  const hours = Array(24).fill(0);
  hours[23] = 5000;
  hours[0] = 9000;
  hours[1] = 8000;
  const active = context.listenReportActiveWindow(hours);
  assert.equal(active.start, 23);
  assert.equal(active.end, 2);
  assert.equal(active.listenMs, 22000);
  assert.equal(active.label, '23:00 - 02:00');
});

test('all three poster templates render through the shared canvas dispatcher', () => {
  const context = createReportContext();
  installCanvasStub(context);
  const report = {
    mode: 'month',
    period: '2026-08',
    totalListenMs: 2520000,
    sessions: 11,
    hours: Array.from({ length: 24 }, (_, hour) => hour % 5 * 60000),
    days: { '2026-08-08': 1200000, '2026-08-09': 1320000 },
    songs: Array.from({ length: 5 }, (_, index) => ({
      name: `Track ${index + 1}`,
      artist: `Artist ${index + 1}`,
      listenMs: (index + 1) * 180000,
    })),
    artists: Array.from({ length: 5 }, (_, index) => ({
      name: `Artist ${index + 1}`,
      listenMs: (index + 1) * 180000,
    })),
  };

  const assets = {
    songImages: Array.from({ length: 7 }, () => ({ width: 640, height: 640 })),
    artistImages: Array.from({ length: 5 }, () => ({ width: 800, height: 1000 })),
  };
  for (const template of ['night', 'particle', 'glass']) {
    const canvas = context.renderModernListenReportPoster(report, template, assets);
    assert.equal(canvas.width, 1080);
    assert.equal(canvas.height, 1920);
  }
  assert.equal(context.listenReportPosterTemplate('unknown'), 'night');
});

test('artist references preserve provider IDs for poster avatar lookup', () => {
  const context = createReportContext();
  const refs = context.listenStatsV3ArtistRefs({
    artist: 'Artist A',
    provider: 'netease',
    artistRefs: [{ name: 'Artist A', id: 12345 }],
  });
  assert.equal(refs.length, 1);
  assert.equal(refs[0].name, 'Artist A');
  assert.equal(refs[0].id, '12345');
  assert.equal(refs[0].provider, 'netease');
});

test('legacy artist rows resolve an exact matching avatar through search and detail APIs', async () => {
  const context = createReportContext();
  const requests = [];
  context.apiJson = async (url) => {
    requests.push(url);
    if (url.startsWith('/api/search?')) {
      return {
        songs: [{ artist: 'Dominic Fike', artistId: 123, artists: [{ id: 123, name: 'Dominic Fike' }] }],
      };
    }
    if (url.startsWith('/api/artist/detail?')) {
      return { artist: { id: 123, name: 'Dominic Fike', avatar: 'https://example.com/artist.jpg' } };
    }
    return { songs: [] };
  };
  const avatar = await context.listenReportResolveArtistAvatar({ name: 'Dominic Fike' }, { songs: [] });
  assert.equal(avatar, 'https://example.com/artist.jpg');
  assert.match(requests[0], /^\/api\/search\?/);
  assert.match(requests[1], /^\/api\/artist\/detail\?id=123/);
});

test('artist avatar lookup retries after a temporary failure instead of caching an empty result forever', async () => {
  const context = createReportContext();
  let available = false;
  let requests = 0;
  context.apiJson = async (url) => {
    requests += 1;
    if (!available) throw new Error('TEMPORARY_FAILURE');
    if (url.startsWith('/api/search?')) {
      return { songs: [{ artists: [{ id: 456, name: 'RAYE' }] }] };
    }
    return { artist: { id: 456, name: 'RAYE', avatar: 'https://example.com/raye.jpg' } };
  };

  assert.equal(await context.listenReportResolveArtistAvatar({ name: 'RAYE' }, { songs: [] }), '');
  assert.deepEqual(Object.keys(context.listenReportViewState.artistAvatarCache), []);
  const failureKeys = Object.keys(context.listenReportViewState.artistAvatarFailureCache);
  assert.equal(failureKeys.length, 1);

  context.listenReportViewState.artistAvatarFailureCache[failureKeys[0]] = 0;
  available = true;
  const avatar = await context.listenReportResolveArtistAvatar({ name: 'RAYE' }, { songs: [] });
  assert.equal(avatar, 'https://example.com/raye.jpg');
  assert.ok(requests >= 4);
});

test('local and online songs are included while podcast and radio-program variants are excluded', () => {
  const context = createReportContext();
  const isMusic = context.listenStatsV3IsMusicRecord;
  assert.equal(isMusic({ key: 'local:a', type: 'local', localPath: 'D:\\Music\\a.flac' }), true);
  assert.equal(isMusic({ key: 'netease:1', type: 'song', provider: 'netease' }), true);
  assert.equal(isMusic({ key: 'weather:1', type: 'song', source: 'weather-radio' }), true);
  assert.equal(isMusic({ key: 'podcast:1', type: 'podcast' }), false);
  assert.equal(isMusic({ key: 'podcast:2', sourceType: 'podcast-voice' }), false);
  assert.equal(isMusic({ key: 'radio:1', type: 'podcast-radio' }), false);
  assert.equal(isMusic({ key: 'program:1', kind: 'dj_program' }), false);
  assert.equal(isMusic({ key: 'program:2', itemType: '电台节目' }), false);
});

test('completion is persisted even when all pending listening time was already flushed', async () => {
  const context = createReportContext();
  const writes = [];
  context.listenStatsV3DbPromise = null;
  context.listenStatsV3WriteQueue = Promise.resolve();
  context.listenStatsV3OpenDb = async () => ({});
  context.listenStatsV3PutContribution = async (db, period, record, contribution, flags) => {
    writes.push({ period, record, contribution, flags });
  };
  const session = {
    key: 'song:completed',
    song: { key: 'song:completed', type: 'song', name: 'Completed' },
    listenMs: 60000,
    maxProgress: 1,
    listenStatsV3Periods: {},
    listenStatsV3RecordedPeriods: {
      [context.listenStatsV3MonthKey(Date.now())]: true,
    },
  };

  assert.equal(await context.recordListenStatsV3Final(session, true), true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].contribution.listenMs, 0);
  assert.equal(writes[0].flags.addSession, false);
  assert.equal(writes[0].flags.addCompleted, true);
});

test('a failed IndexedDB write restores the pending contribution for retry', async () => {
  const context = createReportContext();
  const period = context.listenStatsV3MonthKey(Date.now());
  const contribution = {
    listenMs: 45000,
    hours: Array(24).fill(0),
    days: { [period + '-09']: 45000 },
  };
  const session = {
    key: 'song:retry',
    song: { key: 'song:retry', type: 'song', name: 'Retry' },
    listenMs: 45000,
    maxProgress: 0.4,
    listenStatsV3Periods: { [period]: contribution },
  };
  context.listenStatsV3WriteQueue = Promise.resolve();
  context.listenStatsV3OpenDb = async () => ({});
  context.listenStatsV3PutContribution = async () => {
    throw new Error('WRITE_FAILED');
  };

  assert.equal(await context.recordListenStatsV3Tick(session, true), false);
  assert.equal(session.listenStatsV3Periods[period].listenMs, 45000);
  assert.equal(session.listenStatsV3Periods[period].days[period + '-09'], 45000);

  const writes = [];
  context.listenStatsV3PutContribution = async (db, key, record, pending, flags) => {
    writes.push({ key, pending, flags });
  };
  assert.equal(await context.recordListenStatsV3Tick(session, true), true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].pending.listenMs, 45000);
  assert.deepEqual(Object.keys(session.listenStatsV3Periods), []);
});

test('clearing report data stays ahead of writes queued while the clear is pending', async () => {
  const context = createReportContext();
  const order = [];
  let releaseWriteQueue;
  context.listenStatsV3WriteQueue = new Promise(resolve => { releaseWriteQueue = resolve; });
  context.listenStatsV3OpenDb = async () => ({
    transaction() {
      const transaction = {
        objectStore() {
          return {
            clear() {
              setTimeout(() => {
                order.push('clear');
                transaction.oncomplete();
              }, 0);
            },
          };
        },
      };
      return transaction;
    },
  });

  const clearing = context.clearListenStatsV3();
  const lateWrite = context.listenStatsV3WriteQueue.then(() => { order.push('late-write'); });
  context.listenStatsV3WriteQueue = lateWrite;
  releaseWriteQueue();
  await clearing;
  await lateWrite;
  assert.deepEqual(order, ['clear', 'late-write']);
});

test('the first preview render uses the latest template selected while assets are loading', async () => {
  const context = createReportContext();
  let resolveAssets;
  let renderedTemplate = '';
  const stage = {
    classList: { add() {}, remove() {} },
    setAttribute() {},
  };
  const confirm = { disabled: false };
  const image = { src: '' };
  context.listenReportElement = (id) => ({
    'listen-report-preview-stage': stage,
    'listen-report-preview-confirm': confirm,
    'listen-report-preview-image': image,
  })[id] || null;
  context.prepareListenReportPosterAssets = () => new Promise(resolve => { resolveAssets = resolve; });
  context.renderModernListenReportPoster = (report, template) => {
    renderedTemplate = template;
    return { toDataURL: () => `data:image/png;base64,${template}` };
  };
  context.listenReportViewState.report = {
    period: '2026-08',
    sessions: 1,
    songs: [{ name: 'Track' }],
  };
  context.listenReportViewState.previewTemplate = 'night';

  const rendering = context.updateListenReportPreviewImage();
  context.listenReportViewState.previewTemplate = 'particle';
  resolveAssets({});
  assert.equal(await rendering, true);
  assert.equal(renderedTemplate, 'particle');
  assert.match(context.listenReportViewState.previewFileName, /霓虹切片/);
});

test('image-led posters omit unavailable ranks instead of repeating first place', () => {
  const context = createReportContext();
  installCanvasStub(context);
  const report = {
    mode: 'month',
    period: '2026-08',
    totalListenMs: 60000,
    sessions: 1,
    hours: Array(24).fill(0),
    days: { '2026-08-10': 60000 },
    songs: [{ name: 'Only Track', artist: 'Only Artist', listenMs: 60000 }],
    artists: [{ name: 'Only Artist', listenMs: 60000 }],
  };
  const image = { width: 640, height: 640 };
  const tiles = [];
  context.listenReportPosterDrawTile = (ctx, art, item, rank, kind) => {
    tiles.push({ name: item.name, rank, kind });
  };

  context.renderListenReportCoverGridPoster(report, { songImages: [image], artistImages: [image] });
  assert.deepEqual(tiles, [
    { name: 'Only Track', rank: 1, kind: 'track' },
    { name: 'Only Artist', rank: 1, kind: 'artist' },
  ]);

  tiles.length = 0;
  context.renderListenReportArtistSpotlightPoster(report, { songImages: [image], artistImages: [image] });
  assert.deepEqual(tiles, []);
});

test('report UI, v3 collection, navigation, and PNG export stay connected', () => {
  const statsAt = loaderSource.indexOf('02-listen-stats.js');
  const storeAt = loaderSource.indexOf('02a-listen-report-store.js');
  const viewAt = loaderSource.indexOf('03d-listen-report-view.js');
  const posterAt = loaderSource.indexOf('03e-listen-report-posters.js');
  assert.ok(statsAt >= 0 && storeAt > statsAt && viewAt > storeAt && posterAt > viewAt);
  assert.match(statsSource, /trackListenStatsV3Delta\(session, now, delta\)/);
  assert.match(statsSource, /recordListenStatsV3Final\(session, !!completed\)/);
  assert.match(statsSource, /sourceType: song\.sourceType \|\| ''/);
  assert.match(htmlSource, /onclick="openHomeInsight\(\)">查看报告<\/button>/);
  assert.match(htmlSource, /id="listen-report-view" class="modal-mask listen-report-mask"/);
  assert.match(htmlSource, /class="modal listen-report-modal"/);
  assert.match(htmlSource, /data-listen-report-mode="month"/);
  assert.match(htmlSource, /data-listen-report-mode="year"/);
  assert.match(htmlSource, /id="listen-report-preview-mask"/);
  assert.match(htmlSource, /id="listen-report-preview-image"/);
  assert.match(htmlSource, /id="listen-report-preview-confirm"[^>]*>导出图片<\/button>/);
  assert.match(htmlSource, /data-listen-report-template="night"/);
  assert.match(htmlSource, /data-listen-report-template="particle"/);
  assert.match(htmlSource, /data-listen-report-template="glass"/);
  assert.match(htmlSource, /封面矩阵/);
  assert.match(htmlSource, /霓虹切片/);
  assert.match(htmlSource, /主角登场/);
  assert.doesNotMatch(htmlSource.slice(htmlSource.indexOf('id="listen-report-template-picker"'), htmlSource.indexOf('id="listen-report-preview-stage"')), /listen-report-template-swatch/);
  assert.doesNotMatch(htmlSource.slice(htmlSource.indexOf('id="listen-report-view"'), htmlSource.indexOf('id="home-platform-recommend-mask"')), /有效播放|有效收听|有效听歌/);
  assert.match(viewSource, /slice\(0, 10\)/);
  assert.match(viewSource, /report\.songs\.slice\(0, 5\)/);
  assert.match(viewSource, /canvas\.width = 1080/);
  assert.match(viewSource, /canvas\.height = 1920/);
  assert.match(viewSource, /function renderListenReportNightPoster\(report\)/);
  assert.match(viewSource, /function renderListenReportParticlePoster\(report\)/);
  assert.match(viewSource, /function renderListenReportGlassPoster\(report\)/);
  assert.match(viewSource, /function renderListenReportPoster\(report, template\)/);
  assert.match(viewSource, /function setListenReportPreviewTemplate\(template\)/);
  assert.match(viewSource, /renderModernListenReportPoster\(report, template, assets\)/);
  assert.match(viewSource, /listenReportPosterTemplateLabel\(template\)/);
  assert.match(viewSource, /templatePicker\.addEventListener\('click'/);
  assert.match(posterSource, /function prepareListenReportPosterAssets\(report\)/);
  assert.match(posterSource, /function renderListenReportCoverGridPoster\(report, assets\)/);
  assert.match(posterSource, /function renderListenReportCoverSlicesPoster\(report, assets\)/);
  assert.match(posterSource, /function renderListenReportArtistSpotlightPoster\(report, assets\)/);
  assert.doesNotMatch(posterSource.slice(posterSource.indexOf('function renderListenReportCoverSlicesPoster'), posterSource.indexOf('function renderListenReportArtistSpotlightPoster')), /MOST ACTIVE HOURS|listenReportActiveWindow/);
  assert.doesNotMatch(posterSource.slice(posterSource.indexOf('function renderListenReportCoverSlicesPoster'), posterSource.indexOf('function renderListenReportArtistSpotlightPoster')), /firstSong\.name|firstSong\.artist/);
  assert.match(posterSource, /var y = 320 \+ index \* 320/);
  assert.doesNotMatch(posterSource.slice(posterSource.indexOf('var artistImages = await Promise.all'), posterSource.indexOf('var assets = { songImages')), /songImages\[index\]|songImages\[0\]/);
  assert.doesNotMatch(posterSource, /900 112px/);
  assert.match(posterSource, /coverProxySrc\(source\)/);
  assert.match(posterSource, /function hydrateListenReportArtistImages\(rows, report\)/);
  assert.match(posterSource, /entry\.art\.replaceChildren\(image\)/);
  assert.doesNotMatch(posterSource.slice(posterSource.indexOf('function hydrateListenReportArtistImages'), posterSource.indexOf('async function prepareListenReportPosterAssets')), /entry\.art\.textContent\s*=\s*''/);
  assert.match(posterSource, /\/api\/artist\/detail\?id=/);
  assert.match(posterSource, /\/api\/qq\/artist\/detail\?mid=/);
  assert.match(statsSource, /artistRefs: listenStatsArtistRefs\(song\)/);
  assert.match(cssSource, /\.listen-report-artist-art img\s*\{[\s\S]*object-fit:\s*cover/);
  assert.match(viewSource, /function showListenReportPreviewDialog\(show\)/);
  assert.match(viewSource, /function confirmExportListenReportImage\(\)/);
  assert.match(viewSource, /previewDataUrl = canvas\.toDataURL\('image\/png'\)/);
  assert.doesNotMatch(viewSource.slice(viewSource.indexOf('async function exportListenReportImage'), viewSource.indexOf('function showListenReportPreviewDialog')), /exportPngFile/);
  assert.match(viewSource.slice(viewSource.indexOf('async function confirmExportListenReportImage'), viewSource.indexOf('function showListenReportClearDialog')), /exportPngFile/);
  assert.doesNotMatch(viewSource, /次有效播放/);
  assert.match(viewSource, /image\.addEventListener\('error'[\s\S]*art\.classList\.remove\('has-cover'\)[\s\S]*image\.remove\(\)/);
  assert.match(cssSource, /\.listen-report-song-art img\s*\{[\s\S]*object-fit:\s*contain/);
  assert.match(homeSource, /listenReportViewState\.open[\s\S]*closeListenReportView\(\)/);
  assert.match(cssSource, /\.modal\.listen-report-modal\s*\{[\s\S]*background:\s*linear-gradient\(155deg, rgba\(19, 22, 27/);
  assert.match(cssSource, /\.modal\.listen-report-modal\s*\{[\s\S]*height:\s*min\(860px, calc\(100vh - 120px\)\)/);
  assert.match(cssSource, /\.listen-report-modal \.listen-report-summary-band\s*\{[\s\S]*min-height:\s*176px;[\s\S]*padding:\s*18px 0;[\s\S]*align-items:\s*center/);
  assert.match(cssSource, /\.listen-report-modal \.listen-report-content::-webkit-scrollbar\s*,[\s\S]*width:\s*5px/);
  assert.match(cssSource, /\.modal-mask\.listen-report-clear-mask\s*\{[\s\S]*z-index:\s*7900/);
  assert.match(cssSource, /\.modal-mask\.listen-report-preview-mask\s*\{[\s\S]*z-index:\s*8000/);
  assert.match(desktopSource, /ipcMain\.handle\('mineradio-export-png-file'/);
  assert.match(desktopSource, /\^data:image\\\/png;base64/);
  assert.match(preloadSource, /exportPngFile: \(payload\) => ipcRenderer\.invoke\('mineradio-export-png-file'/);
});
