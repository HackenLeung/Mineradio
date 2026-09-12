'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const controls = fs.readFileSync(path.join(root, 'public/js/modules/05-playback/14-player-controls.js'), 'utf8');
const switchCore = fs.readFileSync(path.join(root, 'public/js/modules/05-playback/12-playback-switch-core.js'), 'utf8');
const graph = fs.readFileSync(path.join(root, 'public/js/modules/05-playback/08-audio-graph-controls.js'), 'utf8');
const output = fs.readFileSync(path.join(root, 'public/js/modules/05-playback/00-api-quality-output.js'), 'utf8');
const progress = fs.readFileSync(path.join(root, 'public/js/modules/06-lyrics/04-progress-seek.js'), 'utf8');
const fallback = fs.readFileSync(path.join(root, 'public/js/modules/05-playback/11-provider-fallback.js'), 'utf8');
const mediaSession = fs.readFileSync(path.join(root, 'public/js/modules/05-playback/14a-media-session.js'), 'utf8');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

function harness(options = {}) {
  const events = [];
  const posts = [];
  const intervals = new Set();
  const timeouts = new Set();
  let serial = 0;
  const ctx = vm.createContext({
    console: { log() {}, warn() {} },
    Date, Math, Number, String, Object, Array, Promise, isFinite,
    performance,
    setTimeout(fn, ms) { const id = setTimeout(fn, ms); timeouts.add(id); return id; },
    clearTimeout(id) { clearTimeout(id); timeouts.delete(id); },
    setInterval(fn, ms) { const id = setInterval(fn, ms); intervals.add(id); return id; },
    clearInterval(id) { clearInterval(id); intervals.delete(id); },
    audio: null,
    trackSwitchToken: 7,
    playQueue: [{ type: 'local', localKey: 'flac-a', name: 'FLAC test', localUrl: 'http://127.0.0.1/api/local-media?id=a' }],
    currentIdx: 0,
    playing: false,
    playbackResumeRecovery: { serial: 0, pending: false, timerIds: [], lastAttemptAt: 0 },
    PLAYBACK_RESUME_STALL_DELAYS: [1600, 3600],
    PLAYBACK_RESUME_LONG_PAUSE_MS: 8 * 60 * 1000,
    PLAYBACK_RESUME_LONG_PAUSE_PROVIDER_MS: { qq: 8 * 60 * 1000, kugou: 8 * 60 * 1000, netease: 12 * 60 * 1000 },
    queueItemKey: song => song.localKey || song.id,
    audioCtx: { state: 'running' },
    audioReady: true,
    source: {}, analyser: {}, beatAnalyser: {}, gainNode: {}, analysisSinkNode: null,
    audioSourceMedia: null,
    audioOutputDeviceId: '',
    uiSfxCtx: null,
    document: { getElementById: () => null },
    window: {},
    playMode: 'loop',
    fetch: async (url, init) => { posts.push(JSON.parse(init.body)); return { ok: true }; },
    restorePlaybackGain: () => events.push('gain'),
    setPlayIcon: () => {}, hideLoading: () => {}, forcePlaybackControlsInteractive: () => {},
    switchPlaybackVisualToEmily: () => {}, primeCinemaAfterTrackStart: () => {},
    schedulePlaybackAnalyserRecovery: () => {},
    normalizePlaybackProvider: () => 'netease', songProviderKey: () => 'netease',
    updatePlaybackProgressUi: () => {},
    showToast: text => events.push('toast:' + text),
    resetSmartCrossfade: () => {},
    scheduleSmartCrossfadePrepare: () => {},
    syncAudioOutputMirrors: () => {}, bindAudioOutputMirrorEvents: () => {}, renderAudioOutputDeviceUi: () => {},
    saveAudioOutputDevicePreference: () => {},
    bindPlaybackProgressEvents: () => {}, applyVolumeToAudio: () => {},
    progressDragState: { active: false, commitSerial: 0, resumePlaySerial: 0, previewDuration: 240 },
    clampRange: (value, min, max) => Math.max(min, Math.min(max, value)),
    getPlaybackDurationSeconds: () => 240,
    beginProgressPreviewHold: () => {}, finishProgressPreviewHold: () => {}, clearProgressPreviewHold: () => {},
    setAudioOutputGainImmediate: () => {}, renderProgressPreview: () => {}, syncBeatMapPlaybackCursor: () => {},
    Audio: function () { return makeMedia(options.replacement || {}); },
  });
  function makeMedia(overrides = {}) {
    const listeners = new Map();
    let position = overrides.currentTime || 0;
    let src = overrides.src === undefined ? 'http://127.0.0.1/api/local-media?id=a' : overrides.src;
    const media = {
      id: ++serial, currentSrc: '', duration: 240, readyState: 4, networkState: 1,
      paused: true, ended: false, seeking: false, error: null, volume: 0.7, muted: false,
      playbackRate: 1, autoplay: true, preload: 'auto', sinkId: '',
      __mineradioQueueItemKey: 'flac-a', __mineradioTrackSwitchToken: 7,
      buffered: { length: 1, start: () => 0, end: () => 240 },
      addEventListener(name, fn, opts) { if (!listeners.has(name)) listeners.set(name, new Map()); listeners.get(name).set(fn, opts); },
      removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
      emit(name) { for (const [fn, opts] of Array.from(listeners.get(name) || [])) { if (opts?.once) listeners.get(name).delete(fn); fn({ type: name }); } },
      pause() { events.push('pause:' + this.id); this.paused = true; this.emit('pause'); },
      load() { events.push('load:' + this.id); this.error = null; if (src) { this.readyState = 4; this.emit('loadedmetadata'); this.emit('canplay'); } },
      removeAttribute(name) { if (name === 'src') { src = ''; this.currentSrc = ''; this.readyState = 0; } },
      play() { events.push('play:' + this.id); this.paused = false; position += 0.1; this.emit('playing'); return Promise.resolve(); },
      setSinkId: async () => {},
      ...overrides,
    };
    Object.defineProperty(media, 'currentTime', { get: () => position, set: value => { if (media.readyState >= 1) { position = Number(value); media.seeking = false; } } });
    Object.defineProperty(media, 'src', { get: () => src, set: value => { src = value; } });
    return media;
  }
  vm.runInContext(switchCore, ctx);
  vm.runInContext(graph.slice(0, graph.indexOf('function resetPlaybackAudioGraphForSourceSwitch')), ctx);
  vm.runInContext(output.slice(output.indexOf('function setPlaybackOutputSink'), output.indexOf('function setAudioOutputDevice(deviceId')), ctx);
  vm.runInContext(controls.slice(0, controls.indexOf('async function playAudio')), ctx);
  vm.runInContext(progress.slice(progress.indexOf('function progressSeekTargetReached'), progress.indexOf('var progressBar =')), ctx);
  ctx.audio = makeMedia(options.media || {});
  ctx.ensurePlaybackAudioGraph = async reason => { events.push('graph:' + reason); await ctx.applyAudioOutputDevice(ctx.audio); return true; };
  // Watchdog races use the real asynchronous waiter, including cancellation.
  if (!options.realClockProgress) {
    ctx.waitForAudioPlaybackProgress = async (media, token, start) => {
      events.push('clock:' + media.id);
      return ctx.playbackAttemptStillCurrent(media, token, media.__mineradioPlaybackAttempt) && !media.paused && !media.seeking && media.currentTime > start + 0.04;
    };
  }
  return { ctx, events, posts, makeMedia, cleanup() { for (const id of intervals) clearInterval(id); for (const id of timeouts) clearTimeout(id); } };
}

test('paused local clock freeze rebuilds once and preserves position, queue and token', async t => {
  const h = harness({ media: { currentTime: 83, play() { this.paused = false; return Promise.resolve(); } } });
  t.after(h.cleanup);
  const old = h.ctx.audio;
  assert.equal(await h.ctx.attemptAudioPlay({ manual: true }), true);
  assert.notEqual(h.ctx.audio, old);
  assert.ok(h.ctx.audio.currentTime >= 83 && h.ctx.audio.currentTime < 84);
  assert.equal(h.ctx.audio.__mineradioQueueItemKey, 'flac-a');
  assert.equal(h.ctx.trackSwitchToken, 7);
  assert.equal(old.src, '');
  assert.deepEqual(h.posts.map(p => p.reason), ['playback-failed', 'recovery-start', 'recovery-succeeded']);
});

test('mid-song local recovery works without changing the queue', async t => {
  const h = harness({ media: { paused: false, currentTime: 117, __mineradioPlaybackDesired: true } });
  t.after(h.cleanup);
  const queue = h.ctx.playQueue;
  assert.equal(await h.ctx.recoverFrozenPlayback('clock-frozen', h.ctx.audio), true);
  assert.equal(h.ctx.playQueue, queue);
  assert.ok(h.ctx.audio.currentTime >= 117 && h.ctx.audio.currentTime < 118);
});

test('repeated play requests share one in-flight request', async t => {
  const h = harness(); t.after(h.cleanup);
  const graphReady = deferred();
  h.ctx.ensurePlaybackAudioGraph = () => graphReady.promise;
  const first = h.ctx.attemptAudioPlay({ manual: true });
  const second = h.ctx.attemptAudioPlay({ manual: true });
  assert.equal(first, second);
  graphReady.resolve(true);
  assert.equal(await first, true);
  assert.equal(h.events.filter(e => e.startsWith('play:')).length, 1);
});

test('manual pause while output setup waits prevents later playback', async t => {
  const h = harness(); t.after(h.cleanup);
  const ready = deferred();
  h.ctx.ensurePlaybackAudioGraph = () => ready.promise;
  const pending = h.ctx.attemptAudioPlay({ manual: true });
  h.ctx.cancelPlaybackStart(h.ctx.audio, 'manual-pause');
  ready.resolve(true);
  assert.equal(await pending, false);
  assert.equal(h.events.filter(e => e.startsWith('play:')).length, 0);
});

test('replacement during graph setup is adopted before play', async t => {
  const h = harness(); t.after(h.cleanup);
  h.ctx.ensurePlaybackAudioGraph = async () => {
    h.ctx.replaceAudioElementForGraphRecovery('test-closed-context', { preservePlayback: true });
    return true;
  };
  const old = h.ctx.audio;
  assert.equal(await h.ctx.attemptAudioPlay({ manual: true }), true);
  assert.notEqual(h.ctx.audio, old);
  assert.equal(h.events.includes('play:' + old.id), false);
});

test('new track wins over an old pending start without pausing the new track', async t => {
  const h = harness(); t.after(h.cleanup);
  const ready = deferred();
  h.ctx.ensurePlaybackAudioGraph = () => ready.promise;
  const pending = h.ctx.attemptAudioPlay({ manual: true });
  const next = h.makeMedia({ paused: false, __mineradioTrackSwitchToken: 8 });
  h.ctx.trackSwitchToken = 8; h.ctx.audio = next;
  ready.resolve(true);
  assert.equal(await pending, false);
  assert.equal(next.paused, false);
  assert.equal(h.posts.length, 0);
});

test('cancelled seek completion cannot start an older request on the same element', async t => {
  const h = harness({ media: { currentTime: 30 } }); t.after(h.cleanup);
  const ready = deferred(); let calls = 0;
  h.ctx.ensurePlaybackAudioGraph = () => ++calls === 1 ? ready.promise : Promise.resolve(true);
  const old = h.ctx.attemptAudioPlay({ manual: true });
  h.ctx.cancelPlaybackStart(h.ctx.audio, 'seek');
  h.ctx.audio.currentTime = 90;
  const latest = h.ctx.attemptAudioPlay({ manual: true });
  assert.equal(await latest, true);
  ready.resolve(true);
  assert.equal(await old, false);
  assert.equal(h.events.filter(e => e.startsWith('play:')).length, 1);
  assert.ok(h.ctx.audio.currentTime >= 90);
});

test('failed local rebuild stops once, retaining a retryable song and progress', async t => {
  const frozen = { play() { this.paused = false; return Promise.resolve(); } };
  const h = harness({ media: { ...frozen, currentTime: 65 }, replacement: frozen }); t.after(h.cleanup);
  assert.equal(await h.ctx.attemptAudioPlay({ manual: true }), false);
  assert.equal(h.ctx.audio.id, 2);
  assert.equal(h.ctx.audio.currentTime, 65);
  assert.equal(h.ctx.audio.paused, true);
  assert.equal(h.ctx.audio.__mineradioPlaybackDesired, false);
  assert.equal(h.posts.at(-1).reason, 'recovery-failed');
  assert.equal(await h.ctx.recoverFrozenPlayback('clock-frozen', h.ctx.audio), false);
  assert.equal(h.ctx.audio.id, 2);
});

test('output sink changes are shared and finished before play; unchanged sink is untouched', async t => {
  const h = harness(); t.after(h.cleanup);
  const ready = deferred(); let writes = 0;
  h.ctx.audioOutputDeviceId = 'headphones';
  h.ctx.audio.setSinkId = async id => { writes++; await ready.promise; h.ctx.audio.sinkId = id; };
  const pending = h.ctx.attemptAudioPlay({ manual: true });
  await new Promise(setImmediate);
  assert.equal(h.events.some(e => e.startsWith('play:')), false);
  assert.equal(writes, 1);
  ready.resolve(); assert.equal(await pending, true);
  h.ctx.audio.paused = true;
  assert.equal(await h.ctx.attemptAudioPlay({ manual: true }), true);
  assert.equal(writes, 1);
});

test('metadata and seek settlement are required before resume can play', async t => {
  const h = harness({ media: { readyState: 0 } }); t.after(h.cleanup);
  h.ctx.scheduleAudioResumePosition(h.ctx.audio, 75, 7);
  const pending = h.ctx.attemptAudioPlay({ manual: true });
  await new Promise(setImmediate);
  assert.equal(h.ctx.audio.currentTime, 0);
  assert.equal(h.events.some(e => e.startsWith('play:')), false);
  h.ctx.audio.readyState = 4;
  h.ctx.audio.emit('loadedmetadata');
  assert.equal(await pending, true);
  assert.ok(h.ctx.audio.currentTime >= 75);
});

test('normal progress does not need or trigger any media rebuild', async t => {
  const h = harness(); t.after(h.cleanup);
  assert.equal(await h.ctx.attemptAudioPlay({ trackSwitch: true }), true);
  assert.equal(h.ctx.audio.id, 1);
  assert.equal(h.posts.length, 0);
  assert.equal(h.ctx.audio.autoplay, false);
});

test('a late seek completion cannot resume after a manual pause', async t => {
  const h = harness(); t.after(h.cleanup);
  const ready = deferred();
  h.ctx.waitForProgressSeekReady = () => ready.promise;
  h.ctx.commitProgressSeek(85, true);
  await new Promise(setImmediate);
  h.ctx.cancelPlaybackStart(h.ctx.audio, 'manual-pause');
  h.ctx.audio.pause();
  ready.resolve(true);
  await new Promise(setImmediate);
  assert.equal(h.ctx.audio.paused, true);
  assert.equal(h.events.filter(e => e.startsWith('play:')).length, 1);
});

test('pausing before metadata cancels old work but preserves the requested position for retry', async t => {
  const h = harness({ media: { readyState: 0 } }); t.after(h.cleanup);
  h.ctx.scheduleAudioResumePosition(h.ctx.audio, 75, 7);
  const pending = h.ctx.attemptAudioPlay({ manual: true });
  await new Promise(setImmediate);
  h.ctx.cancelPlaybackStart(h.ctx.audio, 'manual-pause');
  const cancelled = await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve('still-waiting'), 300))]);
  assert.equal(cancelled, false);
  h.ctx.audio.readyState = 4;
  h.ctx.audio.emit('loadedmetadata');
  assert.equal(h.ctx.audio.currentTime, 0, 'cancelled metadata callback must not seek');
  assert.equal(await h.ctx.attemptAudioPlay({ manual: true }), true);
  assert.ok(h.ctx.audio.currentTime >= 75, 'manual retry must restore the requested position');
});

test('a pending backward seek takes precedence over the old media position during replacement', t => {
  const h = harness({ media: { currentTime: 83 } }); t.after(h.cleanup);
  h.ctx.audio.__mineradioPendingResumeSeconds = 30;
  h.ctx.audio.__mineradioPendingResumeToken = 7;
  h.ctx.replaceAudioElementForGraphRecovery('backward-seek');
  assert.equal(h.ctx.audio.currentTime, 30);
});

test('buffered online clock freezes use the same rebuild and keep the current source', async t => {
  const h = harness({ media: { currentTime: 60, paused: false, src: 'http://127.0.0.1/api/audio?url=remote' } }); t.after(h.cleanup);
  h.ctx.playQueue = [{ id: 'flac-a', name: 'online song' }];
  const old = h.ctx.audio;
  assert.equal(await h.ctx.recoverFrozenPlayback('clock-frozen', old), true);
  assert.notEqual(h.ctx.audio, old);
  assert.equal(h.ctx.audio.src, 'http://127.0.0.1/api/audio?url=remote');
  assert.ok(h.ctx.audio.currentTime >= 60);
  assert.equal(h.posts.at(-1).sourceKind, 'online');
});

test('network starvation keeps its grace period instead of immediately rebuilding', async t => {
  const h = harness({ media: { paused: false, readyState: 1, networkState: 2, src: 'http://127.0.0.1/api/audio?url=remote', buffered: { length: 0 } } }); t.after(h.cleanup);
  h.ctx.playQueue = [{ id: 'flac-a', name: 'online song' }];
  const old = h.ctx.audio;
  let scheduled = false;
  h.ctx.schedulePlaybackStallRecovery = () => { scheduled = true; };
  assert.equal(await h.ctx.recoverFrozenPlayback('clock-frozen', old), false);
  assert.equal(h.ctx.audio, old);
  assert.equal(scheduled, true);
});

for (const phase of ['network', 'audio-graph']) {
  test('an old ' + phase + ' watchdog cannot change playback after a new seek', async t => {
    const h = harness({ realClockProgress: true, media: {
      currentTime: 41.9, src: 'http://127.0.0.1/api/audio?url=remote', __mineradioQueueItemKey: 'online-a',
    } });
    t.after(h.cleanup);
    h.ctx.playQueue = [{ id: 'online-a', name: 'Online song' }];
    assert.equal(await h.ctx.attemptAudioPlay({ manual: true }), true);
    const media = h.ctx.audio;
    if (phase === 'network') { media.readyState = 1; media.networkState = 2; media.buffered = { length: 0 }; }

    // Start the watchdog now, then leave its asynchronous work in flight.
    let fireWatchdog;
    const setTimer = h.ctx.setTimeout;
    h.ctx.PLAYBACK_RESUME_STALL_DELAYS = [3600];
    h.ctx.setTimeout = (fn, ms) => ms === 3600 ? (fireWatchdog = fn, 0) : setTimer(fn, ms);
    const graphReady = deferred();
    h.ctx.ensurePlaybackAudioGraph = () => graphReady.promise;
    h.ctx.ensureAudiblePlaybackGain = () => h.events.push('watchdog-gain');
    h.ctx.recoverCurrentTrackPlaybackFromFreshUrl = async () => { h.events.push('watchdog-refresh'); return false; };
    h.ctx.schedulePlaybackStallRecovery('clock-frozen', { silent: true });
    assert.equal(typeof fireWatchdog, 'function');
    const oldWatchdog = fireWatchdog();

    media.readyState = 4;
    media.networkState = 1;
    media.buffered = { length: 1, start: () => 0, end: () => 240 };
    h.ctx.waitForProgressSeekReady = async () => true;
    h.ctx.commitProgressSeek(90, true);
    const newAttempt = media.__mineradioPlaybackAttempt;
    media.emit('timeupdate');
    if (phase === 'audio-graph') graphReady.resolve(true);
    await oldWatchdog;
    const wasCancelled = newAttempt.cancelled;
    graphReady.resolve(true);
    const started = await newAttempt.promise;

    assert.equal(wasCancelled, false, 'the old recovery must not cancel the new seek');
    assert.equal(started, true);
    assert.equal(media.paused, false);
    assert.equal(media.__mineradioPlaybackDesired, true);
    assert.ok(media.currentTime >= 90 && media.currentTime < 91);
    assert.equal(media.__mineradioPendingResumeSeconds, undefined, 'the old offset must not replace the new seek');
    assert.equal(h.events.includes('watchdog-gain'), false, 'stale graph completion must not change gain');
    assert.equal(h.events.includes('watchdog-refresh'), false, 'stale graph completion must not refresh the source');
  });
}

test('online retry reloads before restoring its offset and waits for new metadata', async t => {
  const loaded = deferred();
  const metadata = deferred();
  let playCalls = 0;
  const h = harness({ media: {
    currentTime: 75, src: 'http://127.0.0.1/api/audio?url=remote', __mineradioQueueItemKey: 'online-a',
    async play() {
      if (++playCalls === 1) throw Object.assign(new Error('AUDIO_PLAY_TIMEOUT'), { code: 'AUDIO_PLAY_TIMEOUT' });
      await metadata.promise;
      this.paused = false;
      this.currentTime += 0.1;
    },
    load() {
      // Native load() resets the clock even when metadata was already loaded.
      this.currentTime = 0;
      this.paused = true;
      this.readyState = 0;
      loaded.resolve();
    },
  } });
  t.after(h.cleanup);
  h.ctx.playQueue = [{ id: 'online-a', name: 'Online song' }];
  const media = h.ctx.audio;
  const pending = h.ctx.attemptAudioPlay({ trackSwitch: true, resumeRecovery: true });
  await loaded.promise;
  await new Promise(setImmediate);
  const playCallsBeforeMetadata = playCalls;
  media.readyState = 4;
  media.emit('loadedmetadata');
  media.emit('canplay');
  metadata.resolve();
  const started = await pending;

  assert.equal(playCallsBeforeMetadata, 1, 'retry must wait for the restored seek before native play');
  assert.equal(started, true);
  assert.equal(h.ctx.audio, media, 'a transient online timeout can reload the same media');
  assert.equal(playCalls, 2);
  assert.ok(media.currentTime >= 75 && media.currentTime < 76, 'retry must not restart at zero');
  assert.equal(media.__mineradioPendingResumeSeconds, undefined);
  assert.equal(h.posts.at(-1).reason, 'recovery-succeeded');
  assert.equal(h.posts.at(-1).resumeAt, 75);
});

test('a rebuilt audio context receives the selected output before native play', async t => {
  const h = harness(); t.after(h.cleanup);
  h.ctx.audioOutputDeviceId = 'headphones';
  h.ctx.audioCtx = { state: 'closed' };
  h.ctx.initAudio = () => {
    h.ctx.replaceAudioElementForGraphRecovery('closed-context');
    h.ctx.audioCtx = { state: 'running', sinkId: '', async setSinkId(id) { h.events.push('context-sink:' + id); this.sinkId = id; } };
    h.ctx.audioReady = true;
    h.ctx.audioSourceMedia = h.ctx.audio;
    h.ctx.source = {}; h.ctx.analyser = {}; h.ctx.beatAnalyser = {}; h.ctx.gainNode = {};
  };
  vm.runInContext(graph.slice(graph.indexOf('function resumeAudioAnalysis'), graph.indexOf('function ensureUiSfxContext')), h.ctx);
  assert.equal(await h.ctx.attemptAudioPlay({ manual: true }), true);
  assert.equal(h.ctx.audioCtx.sinkId, 'headphones');
  assert.ok(h.events.indexOf('context-sink:headphones') < h.events.findIndex(e => e.startsWith('play:')));
});

test('an unplugged output explicitly settles on the default sink before playback', async t => {
  const h = harness(); t.after(h.cleanup);
  h.ctx.audioOutputDeviceId = 'missing-device';
  h.ctx.audio.sinkId = 'previous-device';
  h.ctx.audio.setSinkId = async id => {
    h.events.push('sink:' + id);
    if (id) throw Object.assign(new Error('device unplugged'), { name: 'NotFoundError' });
    h.ctx.audio.sinkId = id;
  };
  assert.equal(await h.ctx.attemptAudioPlay({ manual: true }), true);
  assert.equal(h.ctx.audioOutputDeviceId, '');
  assert.equal(h.ctx.audio.sinkId, '');
  assert.ok(h.events.indexOf('sink:') < h.events.findIndex(e => e.startsWith('play:')));
});

test('pause after replacement but before output setup finishes cancels the shared request', async t => {
  const h = harness(); t.after(h.cleanup);
  const ready = deferred();
  h.ctx.ensurePlaybackAudioGraph = async () => {
    h.ctx.replaceAudioElementForGraphRecovery('pending-output');
    await ready.promise;
    return true;
  };
  const pending = h.ctx.attemptAudioPlay({ manual: true });
  h.ctx.pauseAudioPlayback();
  ready.resolve();
  assert.equal(await pending, false);
  assert.equal(h.ctx.audio.paused, true);
  assert.equal(h.events.some(e => e.startsWith('play:')), false);
});

test('real pause event bindings recover an unexpected pause and respect manual pause', async t => {
  const h = harness(); t.after(h.cleanup);
  h.ctx.playbackTransitionHasAudibleNextDeck = () => false;
  h.ctx.saveLastPlaybackSnapshot = () => {};
  vm.runInContext(progress.slice(progress.indexOf('function bindPlaybackProgressEvents'), progress.indexOf('function emitProgressDragParticles')), h.ctx);
  h.ctx.bindPlaybackProgressEvents(h.ctx.audio);
  assert.equal(await h.ctx.attemptAudioPlay({ manual: true }), true);
  const old = h.ctx.audio;
  old.pause();
  await new Promise(setImmediate);
  if (h.ctx.playbackStartAttempt) await h.ctx.playbackStartAttempt.promise;
  assert.notEqual(h.ctx.audio, old);
  assert.equal(h.ctx.audio.paused, false);
  assert.ok(h.posts.some(p => p.reason === 'unexpected-pause'));
  h.ctx.pauseAudioPlayback();
  const paused = h.ctx.audio;
  await new Promise(setImmediate);
  assert.equal(h.ctx.audio, paused);
  assert.equal(paused.paused, true);
  assert.equal(paused.__mineradioPlaybackDesired, false);
});

for (const reason of ['manual-pause', 'mv-open']) {
  test(reason + ' during fresh-url recovery preserves the paused source instead of marking it failed', async t => {
    const h = harness({ media: {
      currentTime: 75, src: 'http://127.0.0.1/api/audio?url=remote', __mineradioQueueItemKey: 'online-a',
    } });
    t.after(h.cleanup);
    h.ctx.playQueue = [{ id: 'online-a', name: 'Online song', artist: 'Artist' }];
    h.ctx.normalizeMatchText = value => String(value || '').toLowerCase();
    h.ctx.audioFadeSerial = 0;
    h.ctx.clearAudioFadeTimers = () => {};
    vm.runInContext(fallback, h.ctx);
    h.ctx.playbackResumeRecovery.lastAttemptAt = -5000;
    const graphReady = deferred();
    h.ctx.ensurePlaybackAudioGraph = () => graphReady.promise;
    // Enter the queue-start phase after fetching the fresh URL. Its internal
    // track switch must keep the transaction alive until the user cancels it.
    h.ctx.playQueueAt = async () => {
      h.ctx.trackSwitchToken++;
      h.ctx.pauseCurrentAudioForTrackSwitch();
      h.ctx.audio.__mineradioTrackSwitchToken = h.ctx.trackSwitchToken;
      return h.ctx.attemptAudioPlay({ manual: true, trackSwitch: true, resumeRecovery: true });
    };
    const media = h.ctx.audio;
    const src = media.src;
    const pending = h.ctx.recoverCurrentTrackPlaybackFromFreshUrl('long-pause-stale-source', { resumeAt: 75, silent: true });
    await new Promise(setImmediate);
    const recovery = h.ctx.activeSourceFallbackRecovery;
    assert.ok(recovery && !recovery.cancelled, 'internal track switches must retain their recovery transaction');
    if (reason === 'manual-pause') h.ctx.pauseAudioPlayback();
    else { h.ctx.cancelPlaybackStart(media, reason); media.pause(); }
    graphReady.resolve(true);
    assert.equal(await pending, false);
    assert.equal(media.src, src, 'cancelling must not clear the playable source');
    assert.equal(media.currentTime, 75);
    assert.equal(media.paused, true);
    assert.equal(media.__mineradioQueueItemKey, 'online-a');
    assert.equal(h.ctx.playQueue[0]._lastPlaybackFailAt, undefined);
    assert.equal(recovery.cancelled, true);
    assert.equal(recovery.terminal, false);
    h.ctx.ensurePlaybackAudioGraph = async () => true;
    assert.equal(await h.ctx.attemptAudioPlay({ manual: true }), true, 'the retained source can resume');
    assert.ok(media.currentTime >= 75);
  });
}

test('an unexpected pause while buffering retains position and accepts a media-key retry', async t => {
  const h = harness({ media: {
    currentTime: 45, src: 'http://127.0.0.1/api/audio?url=remote', __mineradioQueueItemKey: 'online-a',
  } });
  t.after(h.cleanup);
  h.ctx.playQueue = [{ id: 'online-a', name: 'Online song' }];
  h.ctx.saveLastPlaybackSnapshot = () => {};
  vm.runInContext(progress.slice(progress.indexOf('function bindPlaybackProgressEvents'), progress.indexOf('function emitProgressDragParticles')), h.ctx);
  h.ctx.bindPlaybackProgressEvents(h.ctx.audio);
  assert.equal(await h.ctx.attemptAudioPlay({ manual: true }), true);
  const media = h.ctx.audio;
  const src = media.src;
  const position = media.currentTime;
  media.readyState = 1;
  media.networkState = 2;
  media.buffered = { length: 0 };
  media.pause();
  await new Promise(setImmediate);
  assert.equal(media.__mineradioPlaybackDesired, false, 'a paused network stall must leave a retryable state');
  assert.equal(h.ctx.audio, media, 'network starvation must not rebuild the decoder');
  assert.equal(media.src, src);
  assert.equal(media.__mineradioPendingResumeSeconds, position);
  assert.equal(h.ctx.playbackResumeRecovery.timerIds.length, 0, 'paused media cannot run the playing-only watchdogs');
  const actions = {};
  let retry;
  h.ctx.navigator = { mediaSession: { setActionHandler: (name, fn) => { actions[name] = fn; } } };
  h.ctx.togglePlay = () => { retry = h.ctx.attemptAudioPlay({ manual: true }); };
  vm.runInContext(mediaSession, h.ctx);
  h.ctx.bindMediaSessionActions();
  media.networkState = 1;
  media.buffered = { length: 1, start: () => 0, end: () => 240 };
  actions.play();
  assert.ok(retry, 'the system play action must reach the retry');
  assert.equal(await retry, true);
  assert.equal(h.ctx.audio, media);
  assert.equal(media.paused, false);
  assert.ok(media.currentTime >= position && media.currentTime < position + 1);
});
