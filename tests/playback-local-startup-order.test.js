'use strict';

// 本地歌起播冻结的两条约束。
//
// 实测（MineradioCache/diagnostics/stall.jsonl:443-444）：本地 MP3
// `/api/local-media`、readyState=4、networkState=1(IDLE)、缓冲 139.88s，
// 时钟仍卡在 0 秒，frozenForMs=5762、resumedFromSameTime=true。
// 本地文件不可能缺数据，恢复链对本地歌也整条禁用
// （canRefreshCurrentPlaybackUrlForResume 直接 false），所以 5.6s 全是
// AUDIO_TRACK_SWITCH_CLOCK_TIMEOUT_MS(6500) 硬等 + 重试重建的耗时。
//
// 1) play() 之后不能再切输出设备/重建图：setSinkId 落在解码启动窗口里，
//    Chromium 会偶发把媒体时钟钉在 0。已经能正常起播的重试路径
//    (retryTrackSwitchAudioPlayOnce) 就是「先设备、先建图、再 play」。
// 2) 本地歌起播的时钟等待要短：文件在本机，1600ms 不走钟就该重建，
//    没有理由按在线歌的 6500ms 等。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const controlsPath = 'public/js/modules/05-playback/14-player-controls.js';
const controlsText = fs.readFileSync(path.join(root, controlsPath), 'utf8');

function namedFunctionSource(text, name) {
  const declaration = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(text);
  assert.ok(declaration, `expected ${name}()`);
  const bodyStart = text.indexOf('{', declaration.index + declaration[0].length);
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = bodyStart; index < text.length; index += 1) {
    const ch = text[index];
    if (lineComment) { if (ch === '\n') lineComment = false; continue; }
    if (blockComment) { if (ch === '*' && text[index + 1] === '/') { blockComment = false; index += 1; } continue; }
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '/' && text[index + 1] === '/') { lineComment = true; index += 1; continue; }
    if (ch === '/' && text[index + 1] === '*') { blockComment = true; index += 1; continue; }
    if (ch === '{') depth += 1;
    if (ch === '}' && --depth === 0) return text.slice(declaration.index, index + 1);
  }
  throw new Error(`unterminated ${name}()`);
}

// stall.jsonl:443 的本地歌形态
function localFrozenMedia(overrides) {
  return Object.assign({
    currentTime: 0,
    duration: 244.24,
    paused: false,
    ended: false,
    seeking: false,
    error: null,
    readyState: 4,
    networkState: 1,
    NETWORK_LOADING: 2,
    NETWORK_NO_SOURCE: 3,
    src: 'http://127.0.0.1:3000/api/local-media?id=bJz4_5ROTfwtwsXz0XtmUm2H',
    currentSrc: 'http://127.0.0.1:3000/api/local-media?id=bJz4_5ROTfwtwsXz0XtmUm2H',
    buffered: { length: 1, start: () => 0, end: () => 139.88 },
    __mineradioQueueItemKey: 'local-1',
    __mineradioTrackSwitchToken: 7,
    play() { this.__played = true; return Promise.resolve(); },
  }, overrides || {});
}

function remoteFrozenMedia(overrides) {
  return localFrozenMedia(Object.assign({
    src: 'http://127.0.0.1:3000/api/audio?url=http%3A%2F%2Fm701.music.126.net%2Fx',
    currentSrc: 'http://127.0.0.1:3000/api/audio?url=http%3A%2F%2Fm701.music.126.net%2Fx',
    __mineradioQueueItemKey: 'song-1',
  }, overrides || {}));
}

// attemptAudioPlay 的 manual/trackSwitch 分支只需要这些协作者。
// 每个副作用都记进 order，用顺序断言取代对实现细节的猜测。
function createPlaySandbox(media, song) {
  const order = [];
  const sandbox = {
    console: { warn() { }, error() { } },
    Number, Math, isFinite, Promise, String,
    setTimeout(fn) { return 0; },
    clearTimeout() { },
    audio: media,
    trackSwitchToken: 7,
    playQueue: [song],
    currentIdx: 0,
    playing: false,
    AUDIO_PLAY_REQUEST_TIMEOUT_MS: 22000,
    AUDIO_NETWORK_STARVATION_GRACE_MS: 9000,
    AUDIO_MANUAL_RESUME_CLOCK_TIMEOUT_MS: 4200,
    applyAudioOutputDevice: async () => { order.push('setSinkId'); return true; },
    ensurePlaybackAudioGraph: async (reason) => { order.push('graph:' + reason); return true; },
    awaitMediaPlayWithTimeout: async () => { order.push('awaitPlay'); return undefined; },
    audioGraphHealthy: () => true,
    initAudio: () => true,
    playbackMediaMatchesCurrentQueueItem: () => true,
    playbackMediaHasRecoverableNetworkStall: () => false,
    resetPlaybackFreshUrlRecoveryBudget: () => { },
    playbackResumePausedLongEnough: () => false,
    resumePausedAudioFast: async () => null,
    currentResumeSeconds: () => 0,
    playbackResumeRecovery: { pausedPosition: 0 },
    waitForAudioPlaybackProgress: async () => { order.push('waitClock'); return true; },
    completeAudioPlayStart: async () => { order.push('complete'); return true; },
    audioPlaybackHasTransientNetworkFailure: () => false,
    audioErrorHasCode: () => false,
    settleRecoverableNetworkPlaybackStall: () => { },
    recoverCurrentTrackPlaybackFromFreshUrl: async () => { order.push('freshUrl'); return false; },
    restorePlaybackGain: () => { },
    setPlayIcon: () => { },
    hideLoading: () => { },
    forcePlaybackControlsInteractive: () => { },
    showToast: () => { },
    retryTrackSwitchAudioPlayOnce: async () => { order.push('retry'); return true; },
    createAudioClockStalledError: () => new Error('AUDIO_CLOCK_STALLED'),
    createAudioNetworkStalledError: () => new Error('AUDIO_NETWORK_STALLED'),
    scheduleAudioResumePosition: () => { },
    waitForAudioResumePosition: async () => true,
  };
  const source = [
    namedFunctionSource(controlsText, 'playbackAttemptStillCurrent'),
    namedFunctionSource(controlsText, 'attemptAudioPlay'),
  ].join('\n');
  vm.runInNewContext(source, sandbox, { filename: 'attempt-audio-play.js' });
  return { sandbox, order };
}

test('换歌起播必须先设备、先建图，再 play()', async () => {
  const media = localFrozenMedia();
  const ctx = createPlaySandbox(media, { type: 'local', localUrl: 'file:///x.mp3' });
  const started = await ctx.sandbox.attemptAudioPlay({ trackSwitch: true, silent: true });
  assert.equal(started, true);

  const sink = ctx.order.indexOf('setSinkId');
  const graph = ctx.order.findIndex((step) => step.startsWith('graph:'));
  const play = ctx.order.indexOf('awaitPlay');
  assert.ok(sink >= 0 && graph >= 0 && play >= 0, `三步都要发生，实际：${ctx.order.join(' > ')}`);
  assert.ok(sink < play, `setSinkId 必须在 play 之前，实际：${ctx.order.join(' > ')}`);
  assert.ok(graph < play, `建图必须在 play 之前，实际：${ctx.order.join(' > ')}`);
});

test('play() 之后不得再切输出设备', async () => {
  const media = localFrozenMedia();
  const ctx = createPlaySandbox(media, { type: 'local', localUrl: 'file:///x.mp3' });
  await ctx.sandbox.attemptAudioPlay({ trackSwitch: true, silent: true });
  const play = ctx.order.indexOf('awaitPlay');
  const lateSink = ctx.order.indexOf('setSinkId', play);
  assert.equal(lateSink, -1,
    `setSinkId 落在解码启动窗口会把 Chromium 的媒体时钟钉在 0，实际：${ctx.order.join(' > ')}`);
});

test('手动起播同样先设备、先建图', async () => {
  const media = localFrozenMedia({ currentTime: 0, paused: true });
  const ctx = createPlaySandbox(media, { type: 'local', localUrl: 'file:///x.mp3' });
  await ctx.sandbox.attemptAudioPlay({ manual: true });
  const sink = ctx.order.indexOf('setSinkId');
  const play = ctx.order.indexOf('awaitPlay');
  assert.ok(sink >= 0 && sink < play, `手动路径也要先设设备，实际：${ctx.order.join(' > ')}`);
});

// ---- 本地歌起播的时钟等待时长 ----

function createTimeoutSandbox(media, song) {
  const sandbox = {
    Number, Math, isFinite, String,
    audio: media,
    playQueue: [song],
    currentIdx: 0,
    AUDIO_LOCAL_TRACK_SWITCH_CLOCK_TIMEOUT_MS: 1600,
    AUDIO_TRACK_SWITCH_CLOCK_TIMEOUT_MS: 6500,
    AUDIO_TRACK_SWITCH_RESUME_CLOCK_TIMEOUT_MS: 12000,
  };
  const source = [
    namedFunctionSource(controlsText, 'playbackSongIsLocalFile'),
    namedFunctionSource(controlsText, 'playbackMediaIsLocalFile'),
    namedFunctionSource(controlsText, 'playbackTrackSwitchClockTimeoutMs'),
  ].join('\n');
  vm.runInNewContext(source, sandbox, { filename: 'local-clock-timeout.js' });
  return sandbox;
}

test('本地歌起播用短等待（1600ms），不按在线歌的 6500ms 白等', () => {
  const sandbox = createTimeoutSandbox(localFrozenMedia(), { type: 'local', localUrl: 'file:///x.mp3' });
  assert.equal(sandbox.playbackTrackSwitchClockTimeoutMs(sandbox.audio, 0), 1600);
});

test('队列项还没对上时，/api/local-media 这个来源足以定性为本地歌', () => {
  // 换歌/快照恢复竞态里 playQueue[currentIdx] 可能还是上一首或空对象。
  const sandbox = createTimeoutSandbox(localFrozenMedia(), null);
  assert.equal(sandbox.playbackTrackSwitchClockTimeoutMs(sandbox.audio, 0), 1600);
});

test('在线歌不受影响，仍是 6500ms', () => {
  const sandbox = createTimeoutSandbox(remoteFrozenMedia(), { id: 1, name: '在线歌' });
  assert.equal(sandbox.playbackTrackSwitchClockTimeoutMs(sandbox.audio, 0), 6500,
    '慢网络需要这段宽限，不能被本地歌的短档误伤');
});

test('中途恢复（起点 >= 0.35s）仍走 12000ms，本地歌也一样', () => {
  const local = createTimeoutSandbox(localFrozenMedia({ currentTime: 42 }), { type: 'local', localUrl: 'file:///x.mp3' });
  assert.equal(local.playbackTrackSwitchClockTimeoutMs(local.audio, 42), 12000,
    'seek/恢复到中段是另一回事，短档只针对 0 秒起播');
});

test('源码里 trackSwitch 等待必须走统一的时长判定', () => {
  const source = namedFunctionSource(controlsText, 'completeAudioPlayStart');
  assert.ok(
    /playbackTrackSwitchClockTimeoutMs\s*\(/.test(source),
    '起播等待时长要由 playbackTrackSwitchClockTimeoutMs 决定，否则本地歌又会退回 6500ms 硬等',
  );
});
