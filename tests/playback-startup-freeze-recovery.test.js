'use strict';

// 锁住起播冻结的恢复时序。实测 15 条日志的形态完全一致：
// currentTime=0、readyState=4、networkState=1(IDLE)、缓冲几十秒、ctx running。
// 旧守卫 `readyState >= 2 && networkState !== NETWORK_NO_SOURCE` 对这个形态恒成立，
// 把 1600ms 那档整档 return 掉，只剩 3600ms 兜底 —— 每次起播冻结白等 2 秒。
// 收窄成「只挡还在下载的 NETWORK_LOADING」后，1600ms 档必须武装；
// 同时真正在缓冲的情况（LOADING / 数据不足）仍然要被挡住，不能误伤。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const controlsText = fs.readFileSync(path.join(root, 'public/js/modules/05-playback/14-player-controls.js'), 'utf8');

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

// 起播冻结的实测形态（stall.jsonl 里 15 条的共同特征）
function startupFrozenMedia(overrides) {
  return Object.assign({
    currentTime: 0,
    duration: 231.34,
    paused: false,
    ended: false,
    seeking: false,
    error: null,
    readyState: 4,
    networkState: 1,
    NETWORK_LOADING: 2,
    NETWORK_NO_SOURCE: 3,
    src: 'http://127.0.0.1:3000/api/audio?id=1',
    currentSrc: 'http://127.0.0.1:3000/api/audio?id=1',
    buffered: { length: 1, start: () => 0, end: () => 30.77 },
    __mineradioQueueItemKey: 'song-1',
    __mineradioTrackSwitchToken: 7,
  }, overrides || {});
}

function createSandbox(media) {
  const timers = [];
  const calls = { recover: [], settle: [], cleared: 0 };
  const sandbox = {
    console: { warn() { }, error() { } },
    Number,
    Math,
    isFinite,
    Promise,
    setTimeout(fn, delay) { timers.push({ fn, delay }); return timers.length; },
    clearTimeout() { },
    audio: media,
    trackSwitchToken: 7,
    playQueue: [{ name: '测试歌曲' }],
    currentIdx: 0,
    playbackResumeRecovery: { serial: 0, timerIds: [], pending: false },
    PLAYBACK_RESUME_STALL_DELAYS: [1600, 3600],
    AUDIO_NETWORK_STARVATION_GRACE_MS: 9000,
    trackSwitchStallRecoveryAllowed: () => true,
    canRefreshCurrentPlaybackUrlForResume: () => true,
    clearPlaybackResumeWatchdogs: () => { calls.cleared += 1; },
    playbackMediaMatchesCurrentQueueItem: () => true,
    waitForAudioPlaybackProgress: async () => false,
    settleRecoverableNetworkPlaybackStall: (...args) => { calls.settle.push(args); },
    ensurePlaybackAudioGraph: async () => true,
    ensureAudiblePlaybackGain: () => true,
    recoverCurrentTrackPlaybackFromFreshUrl: async (reason, opts) => {
      calls.recover.push({ reason, opts });
      return true;
    },
  };
  const source = [
    namedFunctionSource(controlsText, 'isSameAudioPlaybackTarget'),
    namedFunctionSource(controlsText, 'audioBufferedLeadSeconds'),
    namedFunctionSource(controlsText, 'audioPlaybackWaitingForNetwork'),
    namedFunctionSource(controlsText, 'audioPlaybackHasTransientNetworkFailure'),
    namedFunctionSource(controlsText, 'playbackStallRecoveryOwnerStillCurrent'),
    namedFunctionSource(controlsText, 'schedulePlaybackStallRecovery'),
  ].join('\n');
  vm.runInNewContext(source, sandbox, { filename: 'stall-recovery.js' });
  return { sandbox, timers, calls };
}

async function fireTimer(ctx, delay) {
  const timer = ctx.timers.find((t) => t.delay === delay);
  assert.ok(timer, `应武装 ${delay}ms 定时器`);
  await timer.fn();
}

test('起播冻结（rs=4/ns=IDLE/缓冲充足）1600ms 档必须武装恢复', async () => {
  const ctx = createSandbox(startupFrozenMedia());
  ctx.sandbox.schedulePlaybackStallRecovery('clock-frozen', {});
  assert.equal(ctx.timers.length, 2, '应武装两档定时器');

  await fireTimer(ctx, 1600);
  assert.equal(ctx.calls.recover.length, 1,
    '实测形态 rs=4/ns=1/t=0 必须在 1600ms 档触发恢复，不能等 3600ms 兜底');
  assert.equal(ctx.calls.recover[0].reason, 'clock-frozen');
});

test('真在缓冲（NETWORK_LOADING + 数据不足）1600ms 档仍要被挡住', async () => {
  const ctx = createSandbox(startupFrozenMedia({
    readyState: 2,
    networkState: 2,
    buffered: { length: 1, start: () => 0, end: () => 0.2 },
  }));
  ctx.sandbox.schedulePlaybackStallRecovery('clock-frozen', {});
  await fireTimer(ctx, 1600);
  assert.equal(ctx.calls.recover.length, 0, '网络饥饿是正常缓冲，1600ms 不该打扰');
  assert.equal(ctx.calls.settle.length, 0);
});

test('还在下载但数据已够（NETWORK_LOADING + rs=4）1600ms 档也要被挡住', async () => {
  // 这是收窄后仍要保留的挡位：时钟可能马上就走，下载中不打扰。
  const ctx = createSandbox(startupFrozenMedia({
    readyState: 4,
    networkState: 2,
    buffered: { length: 1, start: () => 0, end: () => 30 },
  }));
  ctx.sandbox.schedulePlaybackStallRecovery('clock-frozen', {});
  await fireTimer(ctx, 1600);
  assert.equal(ctx.calls.recover.length, 0, 'NETWORK_LOADING 期间 1600ms 不该动手');
});

test('3600ms 兜底档不受 LOADING 挡位影响', async () => {
  const ctx = createSandbox(startupFrozenMedia({
    readyState: 4,
    networkState: 2,
    buffered: { length: 1, start: () => 0, end: () => 30 },
  }));
  ctx.sandbox.schedulePlaybackStallRecovery('clock-frozen', {});
  await fireTimer(ctx, 3600);
  assert.equal(ctx.calls.recover.length, 1, '3600ms 档是最后兜底，必须动手');
});

test('时钟已推进时两档都不动手', async () => {
  const media = startupFrozenMedia();
  const ctx = createSandbox(media);
  ctx.sandbox.schedulePlaybackStallRecovery('clock-frozen', {});
  media.currentTime = 2.5;
  await fireTimer(ctx, 1600);
  await fireTimer(ctx, 3600);
  assert.equal(ctx.calls.recover.length, 0, '已恢复推进就不该再动播放链');
});

test('归属换人后定时器落空', async () => {
  const media = startupFrozenMedia();
  const ctx = createSandbox(media);
  ctx.sandbox.schedulePlaybackStallRecovery('clock-frozen', {});
  ctx.sandbox.trackSwitchToken = 8; // 切歌
  await fireTimer(ctx, 1600);
  assert.equal(ctx.calls.recover.length, 0, '切歌后旧定时器不该碰新歌');
});

test('守卫源码不再使用 NETWORK_NO_SOURCE 一刀切', () => {
  const source = namedFunctionSource(controlsText, 'schedulePlaybackStallRecovery');
  assert.ok(
    !/delayMs < 3000[\s\S]{0,120}NETWORK_NO_SOURCE/.test(source),
    '快档守卫不能再写成 networkState !== NETWORK_NO_SOURCE：它对起播冻结恒成立，等于整档禁用',
  );
  assert.ok(
    /delayMs < 3000[\s\S]{0,260}NETWORK_LOADING/.test(source),
    '快档守卫应只挡 NETWORK_LOADING（还在下载）',
  );
});
