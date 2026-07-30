'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const integrationPath = path.join(root, 'public/js/modules/05-playback/18-smart-transition-integration.js');
const integration = fs.readFileSync(integrationPath, 'utf8');
const playback = fs.readFileSync(path.join(root, 'public/js/modules/05-playback/13-playback-start-audio.js'), 'utf8');
const trackDetail = fs.readFileSync(path.join(root, 'public/js/modules/05-playback/06-track-detail-lyrics-actions.js'), 'utf8');
const loader = fs.readFileSync(path.join(root, 'public/js/index-loader.js'), 'utf8');
const particles = fs.readFileSync(path.join(root, 'public/js/modules/02-visual/00-pointer-cover-particles.js'), 'utf8');
const mainLoop = fs.readFileSync(path.join(root, 'public/js/modules/11-main-loop.js'), 'utf8');

function namedFunctionSource(text, name) {
  const declaration = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(text);
  assert.ok(declaration, `expected ${name}()`);
  const bodyStart = text.indexOf('{', declaration.index + declaration[0].length);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = bodyStart; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'" || character === '`') { quote = character; continue; }
    if (character === '{') depth += 1;
    if (character === '}' && --depth === 0) return text.slice(declaration.index, index + 1);
  }
  throw new Error(`unterminated ${name}()`);
}

function fakeMedia() {
  const listeners = new Map();
  return {
    currentTime: 0,
    paused: false,
    ended: false,
    error: null,
    addEventListener(name, callback) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(callback);
    },
    removeEventListener(name, callback) {
      if (listeners.has(name)) listeners.get(name).delete(callback);
    },
    emit(name) {
      for (const callback of listeners.get(name) || []) callback({ type: name });
    },
  };
}

test('smart transition owns the crossfade path without the removed upstream AutoMix modules', () => {
  const setSmart = namedFunctionSource(integration, 'setSmartTransitionStyle');
  const prepare = namedFunctionSource(integration, 'runSmartCrossfadePrepare');
  const execute = namedFunctionSource(integration, 'executeSmartCrossfade');
  assert.equal(fs.existsSync(path.join(root, 'public/js/modules/05-playback/16-cuefield-automix-core.js')), false);
  assert.equal(fs.existsSync(path.join(root, 'public/js/modules/05-playback/17-cuefield-timeline-executor.js')), false);
  assert.match(loader, /18-smart-transition-integration\.js/);
  assert.doesNotMatch(loader, /cuefield|automix/i);
  assert.doesNotMatch(integration, /cuefield|automix/i);
  assert.match(setSmart, /scheduleSmartCrossfadePrepare/);
  assert.match(prepare, /if \(smartCrossfadeBlockedByAlbumGapless\(currentIndex\)\) return/);
  assert.match(prepare, /prepareSmartTransitionFallback\(token, currentIndex\)/);
  assert.match(execute, /prepareSmartTransitionPendingAudio\(pending\)/);
  assert.match(execute, /runSmartTransitionTimeline\(pending, nextMedia, transitionContext\)/);
  assert.match(execute, /smartTransitionHandoff:\s*true/);
  assert.match(execute, /smartTransition:\s*isSmartTransition/);
  assert.match(playback, /transitionHandoff = !!\(opts\.smartTransitionHandoff && opts\.preloadedAudio\)/);
  assert.match(playback, /claimSmartTransitionPreparedAudioForPlayback\(audio\)/);
});

test('album detail no longer exposes or activates a separate gapless mode', () => {
  assert.doesNotMatch(trackDetail, /album-gapless-toggle|renderAlbumGaplessButton|toggleAlbumGaplessPlayback/);
  assert.doesNotMatch(trackDetail, /detailAlbumGapless|setAlbumGaplessPlaybackContext|__albumGaplessKey/);
  assert.match(trackDetail, /playQueue\s*=\s*detailAlbumSongs\.map\(cloneSong\)/);
});

test('smart transition drives the real cover-particle shader and commits the decoded cover at handoff', () => {
  const execute = namedFunctionSource(integration, 'executeSmartCrossfade');
  assert.match(particles, /uSmartCoverTex/);
  assert.match(particles, /uSmartCoverT/);
  assert.match(particles, /uSmartCoverMode/);
  assert.match(particles, /vec3 smartCoverMixColor\(/);
  assert.match(particles, /float smartCoverMask\(/);
  assert.ok((particles.match(/smartCoverMixColor\(/g) || []).length >= 4);
  assert.match(particles, /uSmartCoverMode, uBloomSize/);
  assert.doesNotMatch(particles, /replace\('uniform float uMouseActive, uPixel, uColorMixT, uLoading;'/);
  assert.match(mainLoop, /tickSmartCoverTransition\(now\)/);
  assert.match(execute, /startSmartCoverTransition\(playQueue\[pending\.nextIndex\]/);
  assert.match(execute, /commitSmartCoverTextureForHandoff\(playQueue\[pending\.nextIndex\]\)/);
  assert.match(execute, /coverCommitted:\s*coverCommitted/);
  assert.match(playback, /qualitySwitch \|\| opts\.coverCommitted/);
  assert.match(playback, /localCover && !opts\.coverCommitted/);
});

test('local transition reuses a valid local URL without resolving the file again', async () => {
  const descriptorSource = namedFunctionSource(integration, 'smartCrossfadeAudioDescriptor');
  let resolveCalls = 0;
  const sandbox = {
    smartTransitionSongKey: () => 'local:one',
    smartTransitionAudioDescriptorCache: {},
    ensureFreshLocalPlaybackUrl: () => { resolveCalls += 1; return true; },
    Promise,
    Date,
  };
  const descriptorFor = vm.runInNewContext(`(${descriptorSource})`, sandbox);
  const descriptor = await descriptorFor({ type: 'local', localUrl: 'mineradio-local://one', localMissing: false });
  assert.equal(resolveCalls, 0);
  assert.equal(descriptor.proxyUrl, 'mineradio-local://one');
  assert.equal(descriptor.local, true);

  sandbox.smartTransitionAudioDescriptorCache = {};
  await descriptorFor({ type: 'local', localUrl: 'mineradio-local://stale', localMissing: true });
  assert.equal(resolveCalls, 1);
});

test('local transition preload stays on direct volume until main-player handoff', () => {
  const prepareSource = namedFunctionSource(integration, 'prepareSmartTransitionPendingAudio');
  let graphCalls = 0;
  const created = [];
  function FakeAudio() {
    const media = {
      src: '',
      volume: 1,
      muted: false,
      readyState: 1,
      load() {},
      addEventListener() {},
    };
    created.push(media);
    return media;
  }
  const sandbox = {
    smartTransitionPendingDescriptor: pending => pending.audioUrl,
    stopSmartTransitionPreparedAudio() {},
    smartTransitionTimelineExecution: () => ({ bStart: 0 }),
    smartTransitionCreatePreparedAudioGraph() { graphCalls += 1; },
    smartTransitionWriteIncomingGain(media, value) { media.volume = value; },
    smartTransitionSetMediaTime() {},
    smartCrossfadePreparedAudio: null,
    Audio: FakeAudio,
  };
  const prepare = vm.runInNewContext(`(${prepareSource})`, sandbox);
  const pending = {
    audioUrl: {
      proxyUrl: 'mineradio-local://one',
      playbackData: { url: 'mineradio-local://one', local: true },
      local: true,
    },
  };
  const media = prepare(pending);
  assert.equal(graphCalls, 0);
  assert.equal(media.__mineradioPreparedAudioGraph, undefined);
  assert.equal(media.__mineradioSmartTransitionDirectVolume, true);
  assert.equal(media.volume, 0);
  assert.equal(media.src, 'mineradio-local://one');
});

test('local handoff carries the incoming deck gain into the main playback envelope', () => {
  const localPlayback = namedFunctionSource(playback, 'playLocalQueueSong');
  assert.match(localPlayback, /transitionAdoptedGain = transitionHandoff \? clampRange\(Number\(audio\.volume\) \|\| 0, 0, 1\) : 0/);
  assert.match(localPlayback, /if \(transitionHandoff\) setAudioOutputGainImmediate\(transitionAdoptedGain\)/);
  assert.match(localPlayback, /else applyVolumeToAudio\(\)/);
});

test('prepared media must advance its clock before a transition can continue', async () => {
  const waitForProgress = vm.runInNewContext(`(${namedFunctionSource(integration, 'waitForSmartTransitionPlaybackProgress')})`, {
    smartTransitionTransitionStillCurrent: () => true,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    isFinite,
    Number,
    Math,
  });

  const progressing = fakeMedia();
  setTimeout(() => {
    progressing.currentTime = 0.08;
    progressing.emit('timeupdate');
  }, 80);
  assert.equal(await waitForProgress({}, progressing, {}, 0, 700), true);

  const stalled = fakeMedia();
  assert.equal(await waitForProgress({}, stalled, {}, 0, 520), false);
});

test('adopted media must keep advancing after it becomes the main player', async () => {
  const progressing = fakeMedia();
  const sandbox = {
    audio: progressing,
    trackSwitchToken: 9,
    currentIdx: 3,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    isFinite,
    Number,
    Math,
  };
  const waitForProgress = vm.runInNewContext(
    `(${namedFunctionSource(integration, 'waitForAdoptedSmartTransitionPlaybackProgress')})`,
    sandbox,
  );
  setTimeout(() => {
    progressing.currentTime = 0.12;
    progressing.emit('timeupdate');
  }, 80);
  assert.equal(await waitForProgress(progressing, 9, 3, 0, 700), true);

  const stalled = fakeMedia();
  sandbox.audio = stalled;
  assert.equal(await waitForProgress(stalled, 9, 3, 0, 650), false);
});

test('failed start has timeout, clock-stall detection, and ordinary playback fallback', () => {
  const execute = namedFunctionSource(integration, 'executeSmartCrossfade');
  const recover = namedFunctionSource(integration, 'recoverSmartCrossfadeEndedOutgoing');
  assert.match(execute, /smartTransitionPromiseWithTimeout\(nextMedia\.play\(\), 3600/);
  assert.match(execute, /waitForSmartTransitionPlaybackProgress/);
  assert.match(execute, /waitForAdoptedSmartTransitionPlaybackProgress/);
  assert.match(execute, /SMART_TRANSITION_CLOCK_STALLED/);
  assert.match(execute, /replaceAudioElementForGraphRecovery\('smart-transition-handoff-fallback'/);
  assert.match(execute, /runSmartTransitionNormalFallback/);
  assert.match(recover, /trackSwitchToken !== token/);
  assert.match(recover, /currentIdx !== index/);
  assert.match(recover, /nextTrack\(false\)/);
});
