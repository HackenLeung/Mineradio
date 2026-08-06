const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appRoot = path.resolve(__dirname, '..');
const fallbackPath = path.join(appRoot, 'public', 'js', 'modules', '05-playback', '11-provider-fallback.js');
const startPath = path.join(appRoot, 'public', 'js', 'modules', '05-playback', '13-playback-start-audio.js');
const controlsPath = path.join(appRoot, 'public', 'js', 'modules', '05-playback', '14-player-controls.js');
const graphPath = path.join(appRoot, 'public', 'js', 'modules', '05-playback', '08-audio-graph-controls.js');
const switchCorePath = path.join(appRoot, 'public', 'js', 'modules', '05-playback', '12-playback-switch-core.js');
const smartTransitionPath = path.join(appRoot, 'public', 'js', 'modules', '05-playback', '18-smart-transition-integration.js');
const beatPrefetchPath = path.join(appRoot, 'public', 'js', 'modules', '03-beat', '00-tempo-worker-cache-prefetch.js');
const progressPath = path.join(appRoot, 'public', 'js', 'modules', '06-lyrics', '04-progress-seek.js');
const fallbackText = fs.readFileSync(fallbackPath, 'utf8');
const startText = fs.readFileSync(startPath, 'utf8');
const controlsText = fs.readFileSync(controlsPath, 'utf8');
const graphText = fs.readFileSync(graphPath, 'utf8');
const switchCoreText = fs.readFileSync(switchCorePath, 'utf8');
const smartTransitionText = fs.readFileSync(smartTransitionPath, 'utf8');
const beatPrefetchText = fs.readFileSync(beatPrefetchPath, 'utf8');
const progressText = fs.readFileSync(progressPath, 'utf8');

function extractFunction(sourceText, functionName) {
  const start = sourceText.indexOf(`function ${functionName}(`);
  assert.notStrictEqual(start, -1, `missing function ${functionName}`);
  const bodyStart = sourceText.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = bodyStart; index < sourceText.length; index += 1) {
    const char = sourceText[index];
    const next = sourceText[index + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') { blockComment = false; index += 1; }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '/' && next === '/') { lineComment = true; index += 1; continue; }
    if (char === '/' && next === '*') { blockComment = true; index += 1; continue; }
    if (char === '\'' || char === '"' || char === '`') { quote = char; continue; }
    if (char === '{') depth += 1;
    if (char === '}' && --depth === 0) return sourceText.slice(start, index + 1);
  }
  assert.fail(`unterminated function ${functionName}`);
}

function createMedia() {
  return {
    src: 'https://old.invalid/audio',
    paused: false,
    ended: false,
    onended: function () {},
    __mineradioQueueItemKey: 'old',
    pause() { this.paused = true; },
    removeAttribute(name) { if (name === 'src') this.src = ''; },
    load() {},
  };
}

function createDeferredSeekMedia(src) {
  const listeners = {};
  let currentTime = 0;
  const media = {
    src: src || '',
    currentSrc: src || '',
    paused: false,
    ended: false,
    preload: 'auto',
    playbackRate: 1,
    readyState: 0,
    duration: 0,
    onended: null,
    onloadedmetadata: null,
    pause() { this.paused = true; },
    load() {},
    addEventListener(type, handler, options) {
      (listeners[type] || (listeners[type] = [])).push({ handler, once: !!(options && options.once) });
    },
    removeEventListener(type, handler) {
      if (!listeners[type]) return;
      listeners[type] = listeners[type].filter(item => item.handler !== handler);
    },
    emit(type) {
      const handlers = (listeners[type] || []).slice();
      handlers.forEach(item => {
        if (item.once) this.removeEventListener(type, item.handler);
        item.handler.call(this, { type });
      });
      const propertyHandler = this['on' + type];
      if (typeof propertyHandler === 'function') propertyHandler.call(this, { type });
    },
  };
  Object.defineProperty(media, 'currentTime', {
    get() { return currentTime; },
    set(value) {
      // Simulate Chromium's pre-metadata seek behavior during a frozen recovery.
      if (this.readyState >= 1) currentTime = Number(value) || 0;
    },
  });
  return media;
}

function testPendingResumeSurvivesGraphRecovery() {
  const oldMedia = createDeferredSeekMedia('https://old.invalid/audio');
  let replacement = null;
  let progressUpdates = 0;
  const sandbox = {
    console: { warn() {} },
    Math,
    Number,
    isFinite,
    setTimeout() { return 1; },
    clearTimeout() {},
    trackSwitchToken: 9,
    audio: oldMedia,
    audioReady: false,
    audioCtx: null,
    source: null,
    audioSourceMedia: null,
    analyser: null,
    beatAnalyser: null,
    gainNode: null,
    analysisSinkNode: null,
    bindPlaybackProgressEvents() {},
    applyVolumeToAudio() {},
    applyAudioOutputDevice() {},
    updatePlaybackProgressUi() { progressUpdates++; },
    Audio: function Audio() {
      replacement = createDeferredSeekMedia('');
      return replacement;
    },
  };
  vm.runInNewContext(switchCoreText, sandbox, { filename: switchCorePath });
  const graphRecoveryText = graphText.slice(0, graphText.indexOf('function resetPlaybackAudioGraphForSourceSwitch'));
  vm.runInNewContext(graphRecoveryText, sandbox, { filename: graphPath });

  sandbox.scheduleAudioResumePosition(oldMedia, 83, 9);
  assert.strictEqual(oldMedia.currentTime, 0, 'the frozen source must still retain its pending seek');
  assert.strictEqual(oldMedia.__mineradioPendingResumeSeconds, 83);
  assert.strictEqual(sandbox.replaceAudioElementForGraphRecovery('test', { preservePlayback: true }), true);
  assert(replacement, 'graph recovery must create a replacement media element');
  assert.strictEqual(replacement.__mineradioPendingResumeSeconds, 83);
  assert.strictEqual(replacement.__mineradioPendingResumeToken, 9);

  replacement.readyState = 1;
  replacement.duration = 180;
  replacement.emit('loadedmetadata');
  assert.strictEqual(replacement.currentTime, 83, 'the replacement must seek after metadata arrives');
  assert.strictEqual(replacement.__mineradioPendingResumeSeconds, undefined, 'the seek is cleared only after its clock confirms it');
  assert(progressUpdates > 0, 'the restored seek must refresh playback progress');

  const nextTrackMedia = createDeferredSeekMedia('https://old.invalid/next');
  nextTrackMedia.__mineradioPendingResumeSeconds = 47;
  nextTrackMedia.__mineradioPendingResumeToken = 9;
  sandbox.audio = nextTrackMedia;
  assert.strictEqual(sandbox.replaceAudioElementForGraphRecovery('new-track', { preservePlayback: false }), true);
  assert.strictEqual(replacement.__mineradioPendingResumeSeconds, undefined, 'a source switch must not inherit the old track seek');
}

function testNetworkStarvationRetainsSourceAndResumePosition() {
  const notices = [];
  const media = {
    src: 'http://127.0.0.1:3000/api/audio?url=remote',
    currentSrc: 'http://127.0.0.1:3000/api/audio?url=remote',
    currentTime: 83,
    readyState: 1,
    networkState: 2,
    NETWORK_LOADING: 2,
    paused: false,
    ended: false,
    error: null,
    buffered: { length: 0, start() { return 0; }, end() { return 0; } },
    __mineradioQueueItemKey: 'netease:network-a',
    __mineradioTrackSwitchToken: 9,
    pause() { this.paused = true; },
  };
  const sandbox = {
    Date,
    Math,
    Number,
    String,
    isFinite,
    audio: media,
    trackSwitchToken: 9,
    playQueue: [{ provider: 'netease', id: 'network-a' }],
    currentIdx: 0,
    playing: true,
    playbackResumeRecovery: { pausedAt: 0, lastNetworkStallNoticeAt: 0 },
    queueItemKey(song) { return `${song.provider}:${song.id}`; },
    restorePlaybackGain() {},
    setPlayIcon(value) { sandbox.iconPlaying = value; },
    hideLoading() {},
    forcePlaybackControlsInteractive() {},
    syncPlaybackStateFromAudioEvent(reason) { sandbox.syncReason = reason; },
    showSourceFallbackNotice(title, body) { notices.push({ title, body }); },
  };
  const functions = [
    'audioBufferedLeadSeconds',
    'audioPlaybackWaitingForNetwork',
    'audioPlaybackHasTransientNetworkFailure',
    'clearRecoverableNetworkPlaybackStall',
    'playbackMediaHasRecoverableNetworkStall',
    'settleRecoverableNetworkPlaybackStall',
  ].map(name => extractFunction(controlsText, name)).join('\n');
  vm.runInNewContext(functions, sandbox, { filename: controlsPath });

  assert.strictEqual(sandbox.audioPlaybackWaitingForNetwork(media), true);
  assert.strictEqual(sandbox.settleRecoverableNetworkPlaybackStall(media, 9, 83, true), true);
  assert.strictEqual(media.src, 'http://127.0.0.1:3000/api/audio?url=remote');
  assert.strictEqual(media.__mineradioQueueItemKey, 'netease:network-a');
  assert.strictEqual(media.__mineradioTrackSwitchToken, 9);
  assert.strictEqual(media.__mineradioPendingResumeSeconds, 83);
  assert.strictEqual(media.__mineradioPendingResumeToken, 9);
  assert.strictEqual(sandbox.playbackResumeRecovery.pausedPosition, 83);
  assert.strictEqual(sandbox.playbackMediaHasRecoverableNetworkStall(media, 9), true);
  assert.strictEqual(sandbox.playing, false);
  assert.strictEqual(sandbox.iconPlaying, false);
  assert.strictEqual(sandbox.syncReason, 'network-stalled');
  assert.strictEqual(notices.length, 1);

  assert(/scheduleAudioResumePosition\(expectedMedia, recoverableResumeAt, expectedToken\)/.test(controlsText));
  assert(/waitForAudioResumePosition\(expectedMedia, recoverableResumeAt, expectedToken, 1800\)/.test(controlsText));

  const graphClockStall = {
    src: media.src,
    currentSrc: media.currentSrc,
    currentTime: 83,
    readyState: 4,
    networkState: 1,
    NETWORK_LOADING: 2,
    paused: false,
    ended: false,
    error: null,
    buffered: { length: 1, start() { return 80; }, end() { return 100; } },
  };
  assert.strictEqual(sandbox.audioPlaybackWaitingForNetwork(graphClockStall), false, 'a buffered graph-clock freeze must remain eligible for media rebuild');

  const failedProxy = Object.assign({}, graphClockStall, {
    readyState: 0,
    networkState: 3,
    error: { code: 4 },
    buffered: { length: 0 },
  });
  assert.strictEqual(sandbox.audioPlaybackHasTransientNetworkFailure(failedProxy), true, 'a failed remote proxy response must remain recoverable');
  const retrySource = extractFunction(controlsText, 'retryTrackSwitchAudioPlayOnce');
  assert(/audioErrorHasCode\(originalErr, 'AUDIO_CLOCK_STALLED'\)/.test(retrySource));
  assert(!/audioErrorHasCode\(originalErr, 'AUDIO_NETWORK_STALLED'\)[\s\S]*rebuildTrackSwitchMediaAfterClockStall/.test(retrySource));
}

function createSandbox(queue, statusOverrides) {
  const notices = [];
  const statuses = Object.assign({
    netease: { loggedIn: true },
    qq: { loggedIn: false, playbackKeyReady: false },
    kugou: { loggedIn: false, playbackKeyReady: false },
  }, statusOverrides || {});
  const sandbox = {
    console,
    Promise,
    Date,
    Object,
    Array,
    Math,
    Number,
    String,
    setTimeout,
    clearTimeout,
    requestAnimationFrame(fn) { fn(); },
    normalizePlaybackProvider(provider) {
      return ['qq', 'kugou', 'qishui', 'spotify'].includes(provider) ? provider : 'netease';
    },
    songProviderKey(song) { return song && song.provider || 'netease'; },
    platformStatus(provider) { return statuses[provider] || { loggedIn: false }; },
    accountProviderOrder() { return ['netease', 'qq', 'kugou']; },
    providerVipLevel() { return 'none'; },
    queueItemKey(song) { return (song && song.provider || '') + ':' + (song && (song.id || song.mid) || ''); },
    hydrateCustomCover(song) { return song; },
    sourceCandidateRejectReason() { return ''; },
    cloneSong(song) { return Object.assign({}, song); },
    normalizePlaybackQuality(value) { return value || 'hires'; },
    normalizePlaybackQualityForProvider(value) { return value || 'hires'; },
    getProviderPlaybackQuality() { return 'hires'; },
    playbackQualityLabel(value) { return value; },
    markPlaybackQualityRuntimeCap() {},
    playQueue: queue,
    currentIdx: 0,
    trackSwitchToken: 1,
    audio: createMedia(),
    audioFadeSerial: 0,
    playToggleBusy: true,
    playing: true,
    miniQueueOpen: false,
    playbackResumeRecovery: { serial: 3, pending: false, timerIds: [] },
    hideLoading() {},
    forcePlaybackControlsInteractive() {},
    clearAudioFadeTimers() {},
    resetSmartCrossfade() { sandbox.smartTransitionClears = (sandbox.smartTransitionClears || 0) + 1; },
    clearPlaybackResumeWatchdogs() { sandbox.watchdogClears = (sandbox.watchdogClears || 0) + 1; },
    setPlayIcon(value) { sandbox.iconPlaying = value; },
    syncPlaybackStateFromAudioEvent() {},
    safeRenderQueuePanel() {},
    safeShelfRebuild() {},
    updateControlTrackInfo() {},
    showToast() {},
    showSourceFallbackNotice(title, body) { notices.push({ title, body }); },
    document: { getElementById() { return null; }, body: { appendChild() {} } },
    apiJson: async function () { return { songs: [] }; },
    playQueueAt: async function () { return false; },
    notices,
  };
  vm.runInNewContext(fallbackText, sandbox, { filename: fallbackPath });
  sandbox.showSourceFallbackNotice = function (title, body) { notices.push({ title, body }); };
  return sandbox;
}

async function testFiniteQueueRecovery() {
  const queue = Array.from({ length: 20 }, (_, index) => ({
    provider: 'netease',
    id: 'song-' + index,
    name: 'Song ' + index,
    artist: 'Artist ' + index,
  }));
  const sandbox = createSandbox(queue);
  let childCalls = 0;
  let recovery = null;
  sandbox.playQueueAt = async function (idx, opts) {
    childCalls++;
    recovery = recovery || opts.sourceFallbackRecovery;
    sandbox.currentIdx = idx;
    sandbox.trackSwitchToken++;
    return sandbox.tryAutoPlaybackFallback(
      sandbox.playQueue[idx],
      { category: 'url_unavailable' },
      idx,
      sandbox.trackSwitchToken,
      opts
    );
  };
  const result = await sandbox.tryAutoPlaybackFallback(queue[0], { category: 'url_unavailable' }, 0, 1, {});
  assert.strictEqual(result, false);
  assert.strictEqual(childCalls, 2, 'recovery may advance at most two queue entries');
  assert(recovery && recovery.terminal, 'the finite recovery transaction must settle');
  assert.strictEqual(recovery.queueAdvances, 2);
  assert.strictEqual(sandbox.activeSourceFallbackRecovery, null);
  assert.strictEqual(sandbox.audio.src, '');
  assert.strictEqual(sandbox.audio.onended, null);
  assert.strictEqual(sandbox.playbackResumeRecovery.serial, 4, 'terminal state invalidates late media watchdogs');
  assert.strictEqual(sandbox.notices.filter(item => item.title === '当前没有可用音源').length, 1);
}

async function testDuplicateSongProviderDeduplication() {
  const source = { provider: 'netease', id: 'source-a', name: 'Same Song', artist: 'Same Artist' };
  const duplicate = { provider: 'netease', id: 'source-b', name: 'Same Song', artist: 'Same Artist' };
  const sandbox = createSandbox([source, duplicate], {
    qq: { loggedIn: true, playbackKeyReady: true },
  });
  let searchCalls = 0;
  let childCalls = 0;
  sandbox.apiJson = async function () {
    searchCalls++;
    return {
      songs: [{ provider: 'qq', id: 'qq-a', mid: 'qq-a', name: source.name, artist: source.artist }],
    };
  };
  sandbox.playQueueAt = async function () {
    childCalls++;
    sandbox.trackSwitchToken++;
    return false;
  };
  const result = await sandbox.tryAutoPlaybackFallback(source, { category: 'url_unavailable' }, 0, 1, {});
  assert.strictEqual(result, false);
  assert.strictEqual(searchCalls, 1, 'the same song/provider pair must be searched once');
  assert.strictEqual(childCalls, 1);
  assert.strictEqual(sandbox.playQueue[0].provider, 'netease', 'failed provisional source must roll back');
  assert.strictEqual(sandbox.playQueue[1], duplicate, 'duplicate queue item must not be scanned again');
}

async function testLateAsyncCannotReviveTerminal() {
  const source = { provider: 'netease', id: 'late-a', name: 'Late Song', artist: 'Late Artist' };
  const sandbox = createSandbox([source], {
    qq: { loggedIn: true, playbackKeyReady: true },
  });
  let resolveSearch;
  let childCalls = 0;
  sandbox.apiJson = function () {
    return new Promise(resolve => { resolveSearch = resolve; });
  };
  sandbox.playQueueAt = async function () {
    childCalls++;
    return true;
  };
  const pending = sandbox.tryAutoPlaybackFallback(source, { category: 'url_unavailable' }, 0, 1, {});
  await Promise.resolve();
  const recovery = sandbox.activeSourceFallbackRecovery;
  assert(recovery, 'recovery must exist while provider search is pending');
  const settled = sandbox.settleSourceFallbackTerminal(0, 1, 'stop', { sourceFallbackRecovery: recovery });
  assert.strictEqual(settled, false);
  const secondSettle = sandbox.settleSourceFallbackTerminal(0, 1, 'duplicate', { sourceFallbackRecovery: recovery });
  assert.strictEqual(secondSettle, false);
  resolveSearch({
    songs: [{ provider: 'qq', id: 'late-qq', mid: 'late-qq', name: source.name, artist: source.artist }],
  });
  const result = await pending;
  assert.strictEqual(result, false);
  assert.strictEqual(childCalls, 0, 'late search completion must not start playback');
  assert.strictEqual(sandbox.playQueue[0], source);
  assert.strictEqual(sandbox.notices.filter(item => item.title === '当前没有可用音源').length, 1);
}

async function testDeadlineAndManualSupersession() {
  const source = { provider: 'netease', id: 'deadline-a', name: 'Deadline Song', artist: 'Deadline Artist' };
  const sandbox = createSandbox([source], {
    qq: { loggedIn: true, playbackKeyReady: true },
  });
  let resolveSearch;
  let childCalls = 0;
  sandbox.apiJson = function () {
    return new Promise(resolve => { resolveSearch = resolve; });
  };
  sandbox.playQueueAt = async function () {
    childCalls++;
    return true;
  };
  const pending = sandbox.tryAutoPlaybackFallback(source, { category: 'url_unavailable' }, 0, 1, {});
  await Promise.resolve();
  const recovery = sandbox.activeSourceFallbackRecovery;
  recovery.deadlineAt = Date.now() - 1;
  resolveSearch({ songs: [] });
  assert.strictEqual(await pending, false);
  assert.strictEqual(childCalls, 0);
  assert.strictEqual(recovery.terminal, true, 'expired recovery must settle once');

  sandbox.audio = createMedia();
  sandbox.currentIdx = 0;
  sandbox.trackSwitchToken = 2;
  const superseded = sandbox.ensureSourceFallbackRecovery({}, source, 0, 2);
  assert.strictEqual(sandbox.beginSourceFallbackPlaybackInvocation({ manual: true }), true);
  assert.strictEqual(superseded.cancelled, true, 'manual root playback must cancel the old transaction');
  assert.strictEqual(
    sandbox.settleSourceFallbackTerminal(0, 2, 'stale', { sourceFallbackRecovery: superseded }),
    false
  );
  assert.notStrictEqual(sandbox.audio.src, '', 'a cancelled late transaction must not clear the new root media');
}

function testStaticRecoveryWiring() {
  assert(/beginSourceFallbackPlaybackInvocation\(opts\)/.test(startText));
  assert(/completeSourceFallbackRecovery\(sourceFallbackRecoveryFromOptions\(opts\)\)/.test(startText));
  assert(/catchRecovery \? sourceFallbackRecoveryFailureOptions\(opts\)/.test(startText));
  assert(/setupRecovery \? sourceFallbackRecoveryFailureOptions\(opts\)/.test(startText));
  assert(/freshUrlAttemptCount\) \|\| 0\) >= 1/.test(controlsText));
  assert(/opts\.manual && !opts\.trackSwitch && !opts\.resumeRecovery[\s\S]{0,260}resetPlaybackFreshUrlRecoveryBudget/.test(controlsText));
  assert(/function waitForAudioPlaybackProgress/.test(controlsText));
  assert(/var AUDIO_PLAY_REQUEST_TIMEOUT_MS = 22000/.test(controlsText), 'renderer play-request budget must exceed the proxy upstream budget');
  assert(/var AUDIO_TRACK_SWITCH_CLOCK_TIMEOUT_MS = 6500/.test(controlsText), 'fresh track switches must fail over promptly after play resolves');
  assert(/var AUDIO_TRACK_SWITCH_RESUME_CLOCK_TIMEOUT_MS = 12000/.test(controlsText), 'mid-track resume gets a separate wider clock budget');
  assert(/var AUDIO_NETWORK_STARVATION_GRACE_MS = 9000/.test(controlsText), 'active network loading gets a separate recovery grace period');
  assert(/function audioPlaybackStartState/.test(controlsText), 'clock-stall logs must include non-sensitive media state');
  assert(/function audioPlaybackHasTransientNetworkFailure/.test(controlsText));
  assert(/function settleRecoverableNetworkPlaybackStall/.test(controlsText));
  assert(/function rebuildTrackSwitchMediaAfterClockStall/.test(controlsText), 'a stalled element must be rebuilt before retrying the same URL');
  assert(/audioErrorHasCode\(originalErr, 'AUDIO_CLOCK_STALLED'\)[\s\S]{0,180}rebuildTrackSwitchMediaAfterClockStall/.test(controlsText));
  const completeStartBlock = controlsText.slice(
    controlsText.indexOf('async function completeAudioPlayStart'),
    controlsText.indexOf('function canResumePausedAudioFast')
  );
  assert(/opts\.trackSwitch[\s\S]{0,320}waitForAudioPlaybackProgress/.test(completeStartBlock), 'natural track switches must wait for the media clock before showing playback');
  assert(/AUDIO_CLOCK_STALLED/.test(controlsText));
  assert(/AUDIO_NETWORK_STALLED/.test(controlsText));
  assert(/playbackMediaHasRecoverableNetworkStall\(playbackMedia, token\)/.test(startText));
  assert(/SMART_TRANSITION_PLAY_REQUEST_TIMEOUT_MS = 2500/.test(smartTransitionText));
  assert(/SMART_TRANSITION_CLOCK_TIMEOUT_MS = 2500/.test(smartTransitionText));
  assert(/var remotePlayback\s*=/.test(beatPrefetchText));
  assert(/if \(remotePlayback\)[\s\S]{0,180}hideBeatChip\(\)/.test(beatPrefetchText), 'online playback must stop after cache miss instead of downloading the whole track');
  assert(!/bufferedLead/.test(beatPrefetchText), 'online beat analysis must not retry forever on a shallow buffer');
  assert(/waitForSmartTransitionPlaybackProgress\([\s\S]{0,320}SMART_TRANSITION_CLOCK_TIMEOUT_MS/.test(smartTransitionText));
  assert(/function playbackStartEventHasClock/.test(switchCoreText));
  assert(/startEventPendingClock[\s\S]{0,260}!startEventPendingClock/.test(switchCoreText), 'play events at 0:00 must not mark the player as running');
  assert(/sourceFallbackRecovery:\s*recovery/.test(controlsText));
  assert(/if \(recovered === true\) return true/.test(controlsText));
  const attemptSource = extractFunction(controlsText, 'attemptAudioPlay');
  const networkTerminalPos = attemptSource.indexOf("audioErrorHasCode(err, 'AUDIO_NETWORK_STALLED')");
  const staleRetryGuardPos = attemptSource.lastIndexOf('if (!playbackAttemptStillCurrent(expectedMedia, expectedToken)) return false;', networkTerminalPos);
  const fallbackLogPos = attemptSource.indexOf("console.warn('Audio play blocked:");
  assert(staleRetryGuardPos >= 0 && staleRetryGuardPos < networkTerminalPos && networkTerminalPos < fallbackLogPos, 'stale track-switch retries must stop before network or fresh-url recovery');
  assert(/clearPlaybackResumeWatchdogs\(\)/.test(fallbackText));
  assert(/playbackResumeRecovery\.serial =/.test(fallbackText));
  assert(/audio\.__mineradioTrackSwitchToken = token/.test(startText));
  assert(/audioEl !== audio/.test(progressText));
  assert(/__mineradioTrackSwitchToken\) !== Number\(trackSwitchToken\)/.test(progressText));
  assert(/playbackMediaMatchesCurrentQueueItem\(audioEl\)/.test(progressText));
  assert(/ownerQueueItemKey:\s*String\(audioEl\.__mineradioQueueItemKey/.test(progressText));
  assert(/function playbackStallRecoveryOwnerStillCurrent/.test(controlsText));
  assert((controlsText.match(/playbackStallRecoveryOwnerStillCurrent\(/g) || []).length >= 4);
  assert(/recoverySerial !== playbackResumeRecovery\.serial/.test(controlsText));
  assert(/clearPlaybackResumeWatchdogs\(\);\s*playbackResumeRecovery\.serial =/.test(controlsText));
  assert(/\['play', 'playing', 'pause'[\s\S]{0,500}audioEl !== audio/.test(progressText));
  assert(/\['error', 'stalled'\][\s\S]{0,700}schedulePlaybackStallRecovery/.test(progressText));
  assert((startText.match(/else setTimeout\(nextTrack, 0\)/g) || []).length >= 2, 'normal ended playback must still advance');
  const nextTrackBlock = controlsText.slice(
    controlsText.indexOf('function nextTrack'),
    controlsText.indexOf('function prevTrack')
  );
  assert(/playQueueAt\(currentIdx, opts\)/.test(nextTrackBlock));
  assert(!/sourceFallbackRecovery/.test(nextTrackBlock), 'natural ended next starts a fresh playback root');
}

async function run() {
  await testFiniteQueueRecovery();
  await testDuplicateSongProviderDeduplication();
  await testLateAsyncCannotReviveTerminal();
  await testDeadlineAndManualSupersession();
  testPendingResumeSurvivesGraphRecovery();
  testNetworkStarvationRetainsSourceAndResumePosition();
  testStaticRecoveryWiring();
  console.log('OK playback-source-fallback-transaction');
}

run().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
