'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const integration = fs.readFileSync(path.join(root, 'public/js/modules/05-playback/18-cuefield-automix-integration.js'), 'utf8');
const playback = fs.readFileSync(path.join(root, 'public/js/modules/05-playback/13-playback-start-audio.js'), 'utf8');

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

test('smart transition and CueField AutoMix are mutually exclusive', () => {
  const setSmart = namedFunctionSource(integration, 'setSmartTransitionStyle');
  const toggleCuefield = namedFunctionSource(integration, 'toggleCuefieldAutoMix');
  const prepare = namedFunctionSource(integration, 'runCuefieldAutoMixPrepare');
  const execute = namedFunctionSource(integration, 'executeCuefieldAutoMix');
  assert.match(setSmart, /disableCuefieldAutoMixForSmartTransition/);
  assert.match(toggleCuefield, /setSmartTransitionStyle\('off', true\)/);
  assert.match(integration, /function cuefieldAutoMixEffectiveEnabled\([\s\S]*cuefieldAutoMixEnabled && !isSmartTransitionEnabled\(\)/);
  assert.match(prepare, /if \(cuefieldAutoMixBlockedByAlbumGapless\(currentIndex\)\) return/);
  assert.match(prepare, /if \(!cuefieldEnabled \|\| !cuefieldAutoMix\)[\s\S]*prepareSmartTransitionFallback/,
    'smart transition must bypass the upstream planner when it owns the transition');
  assert.match(execute, /prepareCuefieldPendingAudio\(pending\)/);
  assert.match(execute, /runCuefieldTimeline\(pending, nextMedia, transitionContext\)/);
  assert.match(execute, /cuefieldAutoMix:\s*true/);
  assert.match(execute, /smartTransition:\s*isSmartTransition/);
  assert.match(playback, /transitionHandoff = !!\(opts\.cuefieldAutoMix && opts\.preloadedAudio\)/);
  assert.match(playback, /claimCuefieldPreparedAudioForPlayback\(audio\)/);
});

test('prepared media must advance its clock before a transition can continue', async () => {
  const waitForProgress = vm.runInNewContext(`(${namedFunctionSource(integration, 'waitForCuefieldPlaybackProgress')})`, {
    cuefieldTransitionStillCurrent: () => true,
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
    `(${namedFunctionSource(integration, 'waitForAdoptedCuefieldPlaybackProgress')})`,
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
  const execute = namedFunctionSource(integration, 'executeCuefieldAutoMix');
  const recover = namedFunctionSource(integration, 'recoverCuefieldAutoMixEndedOutgoing');
  assert.match(execute, /cuefieldPromiseWithTimeout\(nextMedia\.play\(\), 3600/);
  assert.match(execute, /waitForCuefieldPlaybackProgress/);
  assert.match(execute, /waitForAdoptedCuefieldPlaybackProgress/);
  assert.match(execute, /SMART_TRANSITION_CLOCK_STALLED/);
  assert.match(execute, /replaceAudioElementForGraphRecovery\('cuefield-handoff-fallback'/);
  assert.match(execute, /runCuefieldNormalFallback/);
  assert.match(recover, /trackSwitchToken !== token/);
  assert.match(recover, /currentIdx !== index/);
  assert.match(recover, /nextTrack\(false\)/);
});
