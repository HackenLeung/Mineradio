'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const snapshot = read('public/js/modules/05-playback/09-queue-snapshot-autoplay.js');
const playbackStart = read('public/js/modules/05-playback/13-playback-start-audio.js');
const progressSeek = read('public/js/modules/06-lyrics/04-progress-seek.js');
const homeActions = read('public/js/modules/05-playback/05-home-actions.js');
const playerControls = read('public/js/modules/05-playback/14-player-controls.js');
const dashboard = read('public/js/modules/05-playback/03a-home-dashboard.js');
const providerFallback = read('public/js/modules/05-playback/11-provider-fallback.js');

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

function makeSandbox(checkpointRaw, restoredSong, duration) {
  const values = new Map();
  if (checkpointRaw != null) values.set('mineradio-last-playback-progress-v1', checkpointRaw);
  const localStorage = {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
  const sandbox = {
    localStorage,
    PLAYBACK_PROGRESS_STORE_KEY: 'mineradio-last-playback-progress-v1',
    PLAYBACK_SNAPSHOT_RESUME_MIN_SECONDS: 3,
    queueItemKey: song => String(song && song.id || ''),
    mvTheaterActiveMedia: () => null,
    audio: null,
    JSON,
    Math,
    Number,
    Date,
    Array,
    values,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${namedFunctionSource(snapshot, 'readPlaybackProgressCheckpoint')}
${namedFunctionSource(snapshot, 'playbackSnapshotResumeSeconds')}
this.readPlaybackProgressCheckpoint = readPlaybackProgressCheckpoint;
this.playbackSnapshotResumeSeconds = playbackSnapshotResumeSeconds;`, sandbox);
  sandbox.restoredSong = restoredSong;
  sandbox.duration = duration;
  return sandbox;
}

test('restored progress prefers the fresher checkpoint for the same song', () => {
  const sandbox = makeSandbox(JSON.stringify({
    version: 1,
    key: '2',
    currentTime: 143,
    duration: 240,
    savedAt: Date.now(),
  }));
  // 完整快照是 40 秒前写的，checkpoint 更近，应该用 checkpoint。
  const resume = sandbox.playbackSnapshotResumeSeconds({
    currentTime: 101,
    duration: 240,
    savedAt: Date.now() - 40000,
    current: { id: '2' },
  });
  assert.equal(resume, 143);
});

test('a checkpoint older than the whole snapshot never rolls the saved position back', () => {
  const sandbox = makeSandbox(JSON.stringify({
    version: 1,
    key: '2',
    currentTime: 101,
    duration: 240,
    savedAt: Date.now() - 60000,
  }));
  // beforeunload 刚写过完整快照，checkpoint 还是 60 秒前的旧值，不能被它覆盖。
  const resume = sandbox.playbackSnapshotResumeSeconds({
    currentTime: 152,
    duration: 240,
    savedAt: Date.now() - 1000,
    current: { id: '2' },
  });
  assert.equal(resume, 152);
});

test('checkpoint from another song never leaks into the restored track', () => {
  const sandbox = makeSandbox(JSON.stringify({
    version: 1,
    key: '9',
    currentTime: 143,
    duration: 240,
    savedAt: Date.now(),
  }));
  const resume = sandbox.playbackSnapshotResumeSeconds({
    currentTime: 62,
    duration: 240,
    current: { id: '2' },
  });
  assert.equal(resume, 62);
});

test('positions below the minimum or at the very end do not restart mid-track', () => {
  const fresh = makeSandbox(null);
  assert.equal(fresh.playbackSnapshotResumeSeconds({ currentTime: 1.4, duration: 240, current: { id: '2' } }), 0);
  assert.equal(fresh.playbackSnapshotResumeSeconds({ currentTime: 240, duration: 240, current: { id: '2' } }), 0);
  assert.equal(fresh.playbackSnapshotResumeSeconds({ currentTime: 239.8, duration: 240, current: { id: '2' } }), 0);
  assert.equal(fresh.playbackSnapshotResumeSeconds({ currentTime: 0, duration: 0, current: { id: '2' } }), 0);
  assert.equal(fresh.playbackSnapshotResumeSeconds({}), 0);
});

test('playback start applies the saved position only to the restored track', () => {
  assert.match(playbackStart, /playbackSnapshotPendingResumeForSong\(song\)/);
  assert.match(playbackStart, /notePlaybackSnapshotResumeConsumed\(\)/);
  assert.match(playbackStart, /scheduleAudioResumePosition\(audio, requestedResumeAt, token\)/);
  // 手动切歌、循环重播、音质切换、音源回退都不能继承旧进度。
  const resumeBlock = playbackStart.slice(
    playbackStart.indexOf('var requestedResumeAt = Math.max(0, Number(opts.resumeAt) || 0);'),
    playbackStart.indexOf('var isRemotePlaybackSong'),
  );
  for (const excluded of ['opts.autoRepeat', 'opts.qualitySwitch', 'opts.fallbackDepth', 'opts.resumeRecovery']) {
    assert.match(resumeBlock, new RegExp(excluded.replace('.', '\\.')));
  }
  // 只有恢复路径显式打开，普通点播不会跳到中间。
  assert.match(resumeBlock, /var restoringLastPlayback = !!\(opts\.resumeFromSnapshot \|\| opts\.startupAutoplay\)/);
  assert.match(homeActions, /resumeFromSnapshot: true/);
  assert.match(playerControls, /resumeFromSnapshot: !!playbackSnapshotPendingResumeForSong/);
  // 起播别的歌时待用进度要作废。
  assert.match(playbackStart, /pendingPlaybackResumeAt = 0|notePlaybackSnapshotResumeConsumed\(\)/);
  // 成功起播后才清空待用值，同一首重试仍能接上位置。
  assert.match(playbackStart, /restoredResumeAt > 0 && typeof notePlaybackSnapshotResumeConsumed === 'function'/);
  // 用户主动点了这首歌：按点击意图从头播，旧进度作废。
  assert.match(playbackStart, /else if \(!restoringLastPlayback\)/);
  // 本地歌那条分支没有 session-begin，必须单独清。
  assert.match(playbackStart, /localStarted === true && restoredResumeAt > 0/);
});

test('progress checkpoint reads the audio clock only, never the MV video clock', () => {
  const save = namedFunctionSource(snapshot, 'schedulePlaybackProgressSnapshotSave');
  assert.match(save, /PLAYBACK_SNAPSHOT_PROGRESS_SAVE_INTERVAL_MS/);
  assert.match(save, /playbackMediaMatchesCurrentQueueItem/);
  assert.match(save, /playbackSnapshotAudioSeconds\(\)/);
  const audioClock = namedFunctionSource(snapshot, 'playbackSnapshotAudioSeconds');
  assert.doesNotMatch(audioClock, /getPlaybackCurrentSeconds/);
  assert.match(audioClock, /__mineradioPendingResumeSeconds/);
  assert.match(progressSeek, /schedulePlaybackProgressSnapshotSave\(\)/);
  assert.match(progressSeek, /notePlaybackProgressSeeked\(\)/);
  assert.match(progressSeek, /name === 'playing' \|\| name === 'pause' \|\| name === 'ended'/);
});

test('both restore paths reset the pending resume and clearing the queue wipes the checkpoint', () => {
  assert.match(snapshot, /pendingPlaybackResumeAt = playbackSnapshotResumeSeconds\(snapshot\)/);
  assert.match(homeActions, /pendingPlaybackResumeAt = typeof playbackSnapshotResumeSeconds === 'function'/);
  assert.match(playerControls, /clearPlaybackProgressCheckpoint\(\)/);
  assert.match(playerControls, /pendingPlaybackResumeAt = 0/);
  assert.match(dashboard, /playbackSnapshotResumeSeconds\(recentSnapshot\)/);
  assert.match(dashboard, /继续/);
});

test('the periodic progress tick keeps the restored position until audio owns a clock', () => {
  const fill = { style: {} };
  const thumb = { style: {} };
  const timeDisplay = { textContent: '' };
  function render(audioState, pending) {
    const sandbox = {
      audio: audioState,
      pendingPlaybackResumeAt: pending,
      currentCoverSong: () => ({ duration: 200 }),
      document: {
        getElementById(id) {
          if (id === 'progress-fill') return fill;
          if (id === 'progress-thumb') return thumb;
          if (id === 'time-display') return timeDisplay;
          return null;
        },
      },
      isProgressDragPreviewActive: () => false,
      clampRange: (value, min, max) => Math.max(min, Math.min(max, value)),
      formatProgramTime: seconds => String(Math.floor(Number(seconds) || 0)),
      playbackDurationFromSong: song => Number(song && song.duration) || 0,
      isFinite,
      Number,
      Math,
    };
    vm.createContext(sandbox);
    vm.runInContext([
      namedFunctionSource(progressSeek, 'playbackClockMedia'),
      namedFunctionSource(progressSeek, 'getPlaybackDurationSeconds'),
      namedFunctionSource(progressSeek, 'getPlaybackCurrentSeconds'),
      namedFunctionSource(progressSeek, 'pendingRestoredProgressSeconds'),
      namedFunctionSource(progressSeek, 'setProgressVisual'),
      namedFunctionSource(progressSeek, 'updatePlaybackProgressUi'),
      'this.updatePlaybackProgressUi = updatePlaybackProgressUi;',
    ].join('\n'), sandbox);
    sandbox.updatePlaybackProgressUi();
    return { percent: fill.style.width, text: timeDisplay.textContent };
  }

  // 恢复后 audio 还没建起来：底栏必须显示上次的进度而不是 0:00。
  assert.deepEqual(render(null, 143), { percent: '71.5%', text: '143 / 200' });
  // 起播时 seek 还没落地，currentTime 仍是 0，同样不能抹回起点。
  assert.deepEqual(render({ src: 'qa://restored', currentTime: 0, duration: 200, __mineradioPendingResumeSeconds: 143 }, 143), { percent: '71.5%', text: '143 / 200' });
  // 音频时钟接管后按真实位置走。
  assert.deepEqual(render({ src: 'qa://restored', currentTime: 150, duration: 200 }, 0), { percent: '75%', text: '150 / 200' });
});

test('skipping a failed queue item never inherits the failed track resume position', () => {
  const skip = namedFunctionSource(providerFallback, 'skipFailedQueueItem');
  assert.match(skip, /delete nextPlaybackOpts\.resumeAt/);
  assert.ok(
    skip.indexOf('delete nextPlaybackOpts.resumeAt') < skip.indexOf('playQueueAt(nextIdx, nextPlaybackOpts)'),
    'resumeAt must be dropped before the next track starts',
  );
});
