'use strict';

// 冻结检测器只负责「发现稳态播放中途时钟停住并上报一次」。它不执行恢复，
// 所以这里断言的是：该报的报、不该报的不报、同一次冻结不重复报。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const progressSeek = fs.readFileSync(path.join(root, 'public/js/modules/06-lyrics/04-progress-seek.js'), 'utf8');

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
    const character = text[index];
    if (lineComment) {
      if (character === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === '*' && text[index + 1] === '/') { blockComment = false; index += 1; }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'" || character === '`') { quote = character; continue; }
    if (character === '/' && text[index + 1] === '/') { lineComment = true; index += 1; continue; }
    if (character === '/' && text[index + 1] === '*') { blockComment = true; index += 1; continue; }
    if (character === '{') depth += 1;
    if (character === '}' && --depth === 0) return text.slice(declaration.index, index + 1);
  }
  throw new Error(`unterminated ${name}()`);
}

function fakeMedia(overrides) {
  return Object.assign({
    currentTime: 30,
    duration: 200,
    paused: false,
    ended: false,
    seeking: false,
    readyState: 4,
    networkState: 2,
    src: 'http://127.0.0.1:3000/api/audio?id=1',
    currentSrc: 'http://127.0.0.1:3000/api/audio?id=1',
    buffered: { length: 1, end: () => 90 },
    __mineradioQueueItemKey: 'song-1',
  }, overrides || {});
}

function createSandbox(options) {
  options = options || {};
  const posts = [];
  const media = options.media || fakeMedia();
  const sandbox = {
    audio: media,
    playQueue: [{ name: '测试歌曲' }],
    currentIdx: 0,
    audioCtx: { state: 'running' },
    console: { warn() {} },
    performance: { now: () => sandbox.__now },
    __now: 10000,
    __posts: posts,
    isFinite,
    Number,
    String,
    Math,
    JSON,
    playbackTransitionHasAudibleNextDeck: () => options.audibleNextDeck === true,
    playbackMediaMatchesCurrentQueueItem: () => options.queueMatches !== false,
    fetch(url, init) {
      posts.push({ url, body: JSON.parse(init.body) });
      return Promise.resolve({ ok: true });
    },
  };
  const source = [
    'var PLAYBACK_FREEZE_TICKS_REQUIRED = 5;',
    'var PLAYBACK_FREEZE_MIN_ADVANCE = 0.02;',
    'var PLAYBACK_FREEZE_PENDING_STALE_MS = 10000;',
    'var playbackFreezeWatch = { lastTime: -1, stuckTicks: 0, reportedAt: 0, reportedTime: -1,'
      + ' pending: false, awaitingResume: false, frozenAt: 0, frozenTime: -1 };',
    namedFunctionSource(progressSeek, 'resetPlaybackFreezeWatch'),
    namedFunctionSource(progressSeek, 'playbackFreezeBufferedEnd'),
    namedFunctionSource(progressSeek, 'reportPlaybackFreeze'),
    namedFunctionSource(progressSeek, 'reportPlaybackFreezeResume'),
    namedFunctionSource(progressSeek, 'tickPlaybackFreezeWatch'),
  ].join('\n');
  vm.runInNewContext(source, sandbox, { filename: 'freeze-watch.js' });
  return { sandbox, media, posts };
}

// 200ms 一跳，连续 6 跳覆盖「首跳只记基准 + 5 跳判定」。
function tick(ctx, times) {
  for (let i = 0; i < times; i += 1) {
    ctx.sandbox.__now += 200;
    ctx.sandbox.tickPlaybackFreezeWatch(ctx.sandbox.audio);
  }
}

// 上报链是 fetch().catch().then()，要跨多个微任务跳才会把 pending 复位。
// setImmediate 排在微任务队列排空之后，一次就够。
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

// 时钟恢复推进时会补发 clock-resumed，所以断言冻结条数必须按 reason 过滤，
// 不能数 posts 总量。
function frozen(ctx) {
  return ctx.posts.filter((p) => p.body.reason === 'clock-frozen');
}
function resumed(ctx) {
  return ctx.posts.filter((p) => p.body.reason === 'clock-resumed');
}

test('时钟连续 1 秒不推进时上报一次', async () => {
  const ctx = createSandbox();
  tick(ctx, 6);
  await flush();
  assert.equal(ctx.posts.length, 1, '应上报一条');
  assert.equal(ctx.posts[0].url, '/api/diag/stall-log');
  const body = ctx.posts[0].body;
  assert.equal(body.reason, 'clock-frozen');
  assert.equal(body.currentTime, 30);
  assert.equal(body.readyState, 4);
  assert.equal(body.networkState, 2);
  assert.equal(body.bufferedEnd, 90);
  assert.equal(body.audioCtxState, 'running');
  assert.equal(body.songKey, 'song-1');
  assert.equal(body.title, '测试歌曲');
  assert.equal(body.smartTransition, false);
});

test('不足 1 秒不上报', () => {
  const ctx = createSandbox();
  tick(ctx, 4);
  assert.equal(ctx.posts.length, 0, '4 跳（<1s）不应上报');
});

test('时钟正常推进不上报', () => {
  const ctx = createSandbox();
  for (let i = 0; i < 20; i += 1) {
    ctx.sandbox.audio.currentTime += 0.2;
    ctx.sandbox.__now += 200;
    ctx.sandbox.tickPlaybackFreezeWatch(ctx.sandbox.audio);
  }
  assert.equal(ctx.posts.length, 0, '正常播放不应上报');
});

test('同一次冻结只上报一条', async () => {
  const ctx = createSandbox();
  tick(ctx, 6);
  await flush();
  assert.equal(ctx.posts.length, 1);
  tick(ctx, 40);
  await flush();
  assert.equal(ctx.posts.length, 1, '位置没变就不应重复上报');
});

test('恢复推进后再次冻结会上报新的一条', async () => {
  const ctx = createSandbox();
  tick(ctx, 6);
  await flush();
  assert.equal(frozen(ctx).length, 1);
  for (let i = 0; i < 5; i += 1) {
    ctx.sandbox.audio.currentTime += 0.2;
    ctx.sandbox.__now += 200;
    ctx.sandbox.tickPlaybackFreezeWatch(ctx.sandbox.audio);
  }
  tick(ctx, 6);
  await flush();
  const freezes = frozen(ctx);
  assert.equal(freezes.length, 2, '新位置上的冻结应上报');
  assert.notEqual(freezes[1].body.currentTime, freezes[0].body.currentTime);
});

test('暂停、seek、结束状态不上报', () => {
  for (const overrides of [{ paused: true }, { seeking: true }, { ended: true }]) {
    const ctx = createSandbox({ media: fakeMedia(overrides) });
    tick(ctx, 20);
    assert.equal(ctx.posts.length, 0, `${JSON.stringify(overrides)} 不应上报`);
  }
});

test('智能过渡期间不上报（B deck 可能才是出声的）', () => {
  const ctx = createSandbox({ audibleNextDeck: true });
  tick(ctx, 20);
  assert.equal(ctx.posts.length, 0, '过渡期间 A deck 停住是正常的');
});

test('媒体已不属于当前队列项时不上报', () => {
  const ctx = createSandbox({ queueMatches: false });
  tick(ctx, 20);
  assert.equal(ctx.posts.length, 0, '归属不匹配不应上报');
});

test('waiting 时间戳换算成距今毫秒', async () => {
  const ctx = createSandbox();
  ctx.sandbox.audio.__mineradioLastWaitingAt = ctx.sandbox.__now - 500;
  tick(ctx, 6);
  await flush();
  assert.equal(ctx.posts.length, 1);
  // 6 跳共推进 1200ms，加上事件本身早 500ms。
  assert.equal(ctx.posts[0].body.lastWaitingAgoMs, 1700);
});

test('从未触发 waiting 时该字段为 null', async () => {
  const ctx = createSandbox();
  tick(ctx, 6);
  await flush();
  assert.equal(ctx.posts[0].body.lastWaitingAgoMs, null);
});

test('上报失败不抛异常且不卡住后续上报', async () => {
  const ctx = createSandbox();
  ctx.sandbox.fetch = function () { return Promise.reject(new Error('offline')); };
  assert.doesNotThrow(() => tick(ctx, 6));
  await flush();
  assert.equal(ctx.sandbox.playbackFreezeWatch.pending, false, '失败后 pending 必须复位');
});

test('buffered 为空时 bufferedEnd 落 null 而不是抛错', async () => {
  const ctx = createSandbox({ media: fakeMedia({ buffered: { length: 0, end: () => { throw new Error('empty'); } } }) });
  tick(ctx, 6);
  await flush();
  assert.equal(ctx.posts.length, 1);
  assert.equal(ctx.posts[0].body.bufferedEnd, null);
});

test('上报永久挂起时超过陈旧阈值可恢复上报', async () => {
  const ctx = createSandbox();
  // 永不 settle 的上报：模拟请求 hang 死。
  ctx.sandbox.fetch = function () { return new Promise(function () {}); };
  tick(ctx, 6);
  await flush();
  assert.equal(ctx.sandbox.playbackFreezeWatch.pending, true, '挂起中 pending 应为 true');

  // 换回可用的上报通道，并让时间走过陈旧阈值。
  const posts = [];
  ctx.sandbox.fetch = function (url, init) {
    posts.push({ url, body: JSON.parse(init.body) });
    return Promise.resolve({ ok: true });
  };
  ctx.sandbox.audio.currentTime += 5;
  ctx.sandbox.__now += 11000;
  tick(ctx, 6);
  await flush();
  // 位置推进会先补一条 clock-resumed，再报新的 clock-frozen —— 只数后者。
  const frozenPosts = posts.filter((p) => p.body.reason === 'clock-frozen');
  assert.equal(frozenPosts.length, 1, '越过陈旧阈值后必须能重新上报，否则诊断会永久静默');
  assert.equal(ctx.sandbox.playbackFreezeWatch.pending, false);
});

test('时钟恢复推进时补发 clock-resumed 并带冻结时长', async () => {
  const ctx = createSandbox();
  tick(ctx, 6);
  await flush();
  assert.equal(frozen(ctx).length, 1);
  assert.equal(resumed(ctx).length, 0, '还没恢复不该有 resumed');

  // 冻结持续 10 跳（2000ms）后时钟恢复推进
  tick(ctx, 10);
  ctx.sandbox.audio.currentTime += 0.3;
  ctx.sandbox.__now += 200;
  ctx.sandbox.tickPlaybackFreezeWatch(ctx.sandbox.audio);
  await flush();

  const resumes = resumed(ctx);
  assert.equal(resumes.length, 1, '恢复推进应补发一条 clock-resumed');
  const body = resumes[0].body;
  // 冻结点在第 6 跳（上报时刻），恢复在其后 11 跳 = 2200ms
  assert.equal(body.frozenForMs, 2200, 'frozenForMs 应为上报到恢复的间隔');
  assert.equal(body.resumedFromSameTime, true, '位置从冻结点继续应标 same-time');
  assert.equal(body.currentTime, 30.3);

  // 恢复后不重复发
  for (let i = 0; i < 5; i += 1) {
    ctx.sandbox.audio.currentTime += 0.2;
    ctx.sandbox.__now += 200;
    ctx.sandbox.tickPlaybackFreezeWatch(ctx.sandbox.audio);
  }
  await flush();
  assert.equal(resumed(ctx).length, 1, '正常播放期间不该再发 resumed');
});

test('恢复时位置跳变要标 position-jumped', async () => {
  const ctx = createSandbox();
  tick(ctx, 6);
  await flush();
  // 恢复链换 URL 后从头开始播：位置从 30 跳回 0.8
  ctx.sandbox.audio.currentTime = 0.8;
  ctx.sandbox.__now += 200;
  ctx.sandbox.tickPlaybackFreezeWatch(ctx.sandbox.audio);
  await flush();
  const resumes = resumed(ctx);
  assert.equal(resumes.length, 1);
  assert.equal(resumes[0].body.resumedFromSameTime, false, '位置跳变不该标 same-time');
});

test('切歌打断冻结观测时不补发 resumed', async () => {
  const ctx = createSandbox();
  tick(ctx, 6);
  await flush();
  assert.equal(frozen(ctx).length, 1);
  // 归属校验失败（切歌）会走 resetPlaybackFreezeWatch，不该错报成「恢复」
  ctx.sandbox.playbackMediaMatchesCurrentQueueItem = () => false;
  ctx.sandbox.__now += 200;
  ctx.sandbox.tickPlaybackFreezeWatch(ctx.sandbox.audio);
  await flush();
  assert.equal(resumed(ctx).length, 0, '切歌不算恢复，不该发 clock-resumed');
});

test('waiting 监听只记时间戳，不调恢复调度', () => {
  const bindSource = namedFunctionSource(progressSeek, 'bindPlaybackProgressEvents');
  const waitingHandler = /addEventListener\('waiting'[\s\S]{0,200}?\}\);/.exec(bindSource);
  assert.ok(waitingHandler, '应绑定 waiting 事件');
  assert.match(waitingHandler[0], /__mineradioLastWaitingAt = performance\.now\(\)/, 'waiting 应记时间戳');
  assert.ok(
    !/schedulePlaybackStallRecovery/.test(waitingHandler[0]),
    'waiting 不能直接调 schedulePlaybackStallRecovery：它进来就清定时器，会把已武装的恢复无限推后',
  );
});
