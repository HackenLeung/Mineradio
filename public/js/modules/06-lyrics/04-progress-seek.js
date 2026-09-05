var progressDragState = {
  active: false,
  lastParticleAt: 0,
  previewTime: 0,
  previewDuration: 0,
  resumeAfterSeek: false,
  media: null,
  mediaSrc: '',
  commitSerial: 0,
  previewHoldUntil: 0,
  previewHoldSerial: 0,
  previewClockBase: 0,
  previewClockStartedAt: 0,
  previewClockRunning: false,
  previewClockShouldRun: false,
  previewAudioSettled: false,
  previewReleaseAt: 0,
  previewReleaseDelay: 96,
  previewSettleTarget: 0,
  previewSettleStartedAt: 0,
  previewSettleMedia: null,
  previewSettleMediaSrc: '',
  resumePlaySerial: 0,
  barRect: null,
  pendingPointer: null,
  pointerPreviewRaf: 0
};
var progressLyricPreviewRaf = 0;
function progressSeekPreviewVisualReady() {
  if (!lyricsLines || !lyricsLines.length || (fx && fx.particleLyrics === false)) return true;
  if (typeof stageLyricProgressSeekVisualReady !== 'function') return true;
  return stageLyricProgressSeekVisualReady(getProgressPreviewClockSeconds());
}
function clearProgressPreviewHold(serial) {
  if (serial && progressDragState.previewHoldSerial && serial !== progressDragState.previewHoldSerial) return false;
  progressDragState.previewHoldUntil = 0;
  progressDragState.previewHoldSerial = 0;
  progressDragState.previewClockRunning = false;
  progressDragState.previewClockShouldRun = false;
  progressDragState.previewAudioSettled = false;
  progressDragState.previewReleaseAt = 0;
  progressDragState.previewSettleTarget = 0;
  progressDragState.previewSettleStartedAt = 0;
  progressDragState.previewSettleMedia = null;
  progressDragState.previewSettleMediaSrc = '';
  return true;
}
function isProgressDragPreviewActive() {
  if (!progressDragState || progressDragState.previewDuration <= 0) return false;
  if (progressDragState.active) return true;
  var now = performance.now();
  if (progressDragState.previewHoldSerial) {
    if (progressDragState.previewAudioSettled && progressSeekPreviewVisualReady()) {
      if (!progressDragState.previewReleaseAt) {
        progressDragState.previewReleaseAt = now + Math.max(34, Number(progressDragState.previewReleaseDelay) || 96);
      }
      if (now < progressDragState.previewReleaseAt) return true;
      clearProgressPreviewHold(progressDragState.previewHoldSerial);
      return false;
    }
    progressDragState.previewReleaseAt = 0;
    if (progressDragState.previewHoldUntil > now) return true;
    var settleAge = now - (Number(progressDragState.previewSettleStartedAt) || now);
    var settleMedia = progressDragState.previewSettleMedia;
    if (settleAge < 5200 && settleMedia && progressSeekMediaStillCurrent(settleMedia, progressDragState.previewSettleMediaSrc)) {
      progressDragState.previewHoldUntil = now + 420;
      return true;
    }
    clearProgressPreviewHold(progressDragState.previewHoldSerial);
    return false;
  }
  progressDragState.previewClockRunning = false;
  return false;
}
function getProgressPreviewClockSeconds() {
  var t = Number(progressDragState.previewTime) || 0;
  if (!progressDragState.active && progressDragState.previewClockRunning && progressDragState.previewHoldUntil > performance.now()) {
    var elapsed = Math.max(0, (performance.now() - (Number(progressDragState.previewClockStartedAt) || performance.now())) / 1000);
    t = (Number(progressDragState.previewClockBase) || 0) + elapsed;
    if (progressDragState.previewDuration > 0) t = Math.min(t, progressDragState.previewDuration);
    progressDragState.previewTime = t;
  }
  return t;
}
function getProgressDragPreviewSeconds() {
  return isProgressDragPreviewActive() ? getProgressPreviewClockSeconds() : null;
}
function beginProgressPreviewHold(serial, holdMs, runClock, media, mediaSrc, targetTime) {
  progressDragState.previewHoldSerial = serial || progressDragState.previewHoldSerial || 0;
  progressDragState.previewClockRunning = false;
  progressDragState.previewClockShouldRun = !!runClock;
  progressDragState.previewAudioSettled = false;
  progressDragState.previewReleaseAt = 0;
  progressDragState.previewReleaseDelay = 96;
  progressDragState.previewSettleTarget = Math.max(0, Number(targetTime) || Number(progressDragState.previewTime) || 0);
  progressDragState.previewSettleStartedAt = performance.now();
  progressDragState.previewSettleMedia = media || null;
  progressDragState.previewSettleMediaSrc = mediaSrc || '';
  progressDragState.previewClockBase = Number(progressDragState.previewTime) || 0;
  progressDragState.previewClockStartedAt = performance.now();
  progressDragState.previewHoldUntil = performance.now() + Math.max(1200, Number(holdMs) || 2800);
  scheduleProgressLyricPreviewTick();
}
function finishProgressPreviewHold(serial, settleMs) {
  if (serial && progressDragState.previewHoldSerial && serial !== progressDragState.previewHoldSerial) return;
  var settleMedia = progressDragState.previewSettleMedia;
  var mediaSeconds = settleMedia && isFinite(Number(settleMedia.currentTime)) ? Math.max(0, Number(settleMedia.currentTime)) : null;
  if (mediaSeconds != null) progressDragState.previewTime = mediaSeconds;
  progressDragState.previewAudioSettled = true;
  progressDragState.previewReleaseDelay = Math.max(34, Number(settleMs) || 96);
  if (progressDragState.previewClockShouldRun) {
    progressDragState.previewClockRunning = true;
    progressDragState.previewClockBase = Number(progressDragState.previewTime) || 0;
    progressDragState.previewClockStartedAt = performance.now();
  }
  scheduleProgressLyricPreviewTick();
}
function scheduleProgressLyricPreviewTick() {
  if (typeof markRenderInteraction === 'function') markRenderInteraction('progress-drag', 420);
  if (typeof wakeMainLoopFromBackground === 'function') wakeMainLoopFromBackground();
  if (progressLyricPreviewRaf) return;
  var raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : function (fn) { return setTimeout(fn, 16); };
  progressLyricPreviewRaf = raf(function () {
    progressLyricPreviewRaf = 0;
    if (!isProgressDragPreviewActive()) return;
    // The main rAF loop is the sole lyric tick owner.  Calling it here as well
    // made a seek preview update the same track twice in one display frame.
    if (typeof wakeMainLoopFromBackground === 'function') wakeMainLoopFromBackground();
    if (isProgressDragPreviewActive()) scheduleProgressLyricPreviewTick();
  });
}
function normalizePlaybackDurationSeconds(value) {
  var raw = Number(value);
  if (!isFinite(raw) || raw <= 0) return 0;
  return raw > 1000 ? raw / 1000 : raw;
}
function playbackDurationFromSong(song) {
  if (!song) return 0;
  return normalizePlaybackDurationSeconds(song.duration || song.durationMs || song.dt || 0);
}
// MV 剧场开着时，底栏那条进度/时间要读视频的时钟 —— MV 有片头，时长和音频版
// 本来就不是一回事，读 audio 会显示一条和画面无关的进度。
function playbackClockMedia() {
  var mv = typeof mvTheaterActiveMedia === 'function' ? mvTheaterActiveMedia() : null;
  return mv || audio;
}
function getPlaybackDurationSeconds() {
  var media = playbackClockMedia();
  if (media && isFinite(media.duration) && media.duration > 0) return media.duration;
  if (media !== audio) return 0;
  return playbackDurationFromSong(currentCoverSong());
}
function getPlaybackCurrentSeconds() {
  var media = playbackClockMedia();
  return media && isFinite(media.currentTime) && media.currentTime > 0 ? media.currentTime : 0;
}
function setProgressVisual(percent) {
  percent = clampRange(percent || 0, 0, 100);
  var fill = document.getElementById('progress-fill');
  var thumb = document.getElementById('progress-thumb');
  if (fill) fill.style.width = percent + '%';
  if (thumb) thumb.style.left = percent + '%';
}
function updatePlaybackProgressUi() {
  if (isProgressDragPreviewActive() && progressDragState.previewDuration > 0) {
    renderProgressPreview(getProgressPreviewClockSeconds(), progressDragState.previewDuration);
    return;
  }
  var durationSec = getPlaybackDurationSeconds();
  var currentSec = getPlaybackCurrentSeconds();
  if (durationSec > 0 && currentSec > durationSec) currentSec = durationSec;
  setProgressVisual(durationSec > 0 ? (currentSec / durationSec * 100) : 0);
  var timeDisplay = document.getElementById('time-display');
  if (timeDisplay) timeDisplay.textContent = formatProgramTime(currentSec) + ' / ' + (durationSec > 0 ? formatProgramTime(durationSec) : '0:00');
}

function playbackTransitionHasAudibleNextDeck() {
  var smartTransitionMedia = typeof smartCrossfadePreparedAudio !== 'undefined' ? smartCrossfadePreparedAudio : null;
  if (
    typeof smartCrossfadeExecuting !== 'undefined'
    && smartCrossfadeExecuting
    && smartTransitionMedia
    && smartTransitionMedia !== audio
    && !smartTransitionMedia.paused
    && !smartTransitionMedia.ended
    && Number(smartTransitionMedia.volume) > 0.001
  ) return true;
  return false;
}

function bindPlaybackProgressEvents(audioEl) {
  if (!audioEl || audioEl._mineradioProgressBound) return;
  audioEl._mineradioProgressBound = true;
  if (typeof bindMediaSessionToAudio === 'function') bindMediaSessionToAudio(audioEl);
  ['loadedmetadata', 'durationchange', 'timeupdate', 'seeked', 'play', 'pause', 'emptied'].forEach(function (name) {
    audioEl.addEventListener(name, updatePlaybackProgressUi);
  });
  audioEl.addEventListener('timeupdate', function () {
    if (typeof tickSmartCrossfade === 'function') tickSmartCrossfade();
  });
  ['play', 'playing', 'pause', 'ended', 'emptied', 'abort', 'error'].forEach(function (name) {
    audioEl.addEventListener(name, function () {
      if (audioEl !== audio) return;
      if (Number(audioEl.__mineradioTrackSwitchToken) !== Number(trackSwitchToken)) return;
      if (
        name !== 'emptied'
        && typeof playbackMediaMatchesCurrentQueueItem === 'function'
        && !playbackMediaMatchesCurrentQueueItem(audioEl)
      ) return;
      if (name === 'ended' && audioEl === audio && playbackTransitionHasAudibleNextDeck()) return;
      syncPlaybackStateFromAudioEvent(name);
      if (name === 'playing' || name === 'ended') saveLastPlaybackSnapshot(true, name);
    });
  });
  ['error', 'stalled'].forEach(function (name) {
    audioEl.addEventListener(name, function () {
      if (audioEl !== audio) return;
      if (Number(audioEl.__mineradioTrackSwitchToken) !== Number(trackSwitchToken)) return;
      if (typeof playbackMediaMatchesCurrentQueueItem === 'function' && !playbackMediaMatchesCurrentQueueItem(audioEl)) return;
      if (typeof schedulePlaybackStallRecovery === 'function') {
        schedulePlaybackStallRecovery(name, {
          silent: name !== 'error',
          ownerMedia: audioEl,
          ownerToken: trackSwitchToken,
          ownerQueueItemKey: String(audioEl.__mineradioQueueItemKey || '')
        });
      }
    });
  });
  // `waiting` 只记时间戳，不参与恢复调度：它在正常起播、seek、切歌时都会触发，
  // 而 schedulePlaybackStallRecovery 进来就 clearPlaybackResumeWatchdogs()，
  // 直接接上去会让 waiting 反复重置定时器、把已武装的恢复无限推后。
  // 这个时间戳供冻结检测器区分「网络饥饿」和「时钟冻结」。
  audioEl.addEventListener('waiting', function () {
    if (audioEl !== audio) return;
    audioEl.__mineradioLastWaitingAt = performance.now();
  });
}
function emitProgressDragParticles(x, y) {
  var now = performance.now();
  if (now - progressDragState.lastParticleAt < 46) return;
  progressDragState.lastParticleAt = now;
  for (var i = 0; i < 3; i++) {
    var dot = document.createElement('span');
    dot.className = 'progress-drag-particle';
    var dx = (Math.random() - 0.5) * 34;
    var dy = -10 - Math.random() * 28;
    dot.style.setProperty('--px', x + 'px');
    dot.style.setProperty('--py', y + 'px');
    dot.style.setProperty('--dx', dx + 'px');
    dot.style.setProperty('--dy', dy + 'px');
    document.body.appendChild(dot);
    setTimeout((function (el) { return function () { if (el && el.parentNode) el.parentNode.removeChild(el); }; })(dot), 700);
  }
}
function renderProgressPreview(currentSec, durationSec) {
  currentSec = Math.max(0, Number(currentSec) || 0);
  durationSec = Math.max(0, Number(durationSec) || 0);
  if (durationSec > 0 && currentSec > durationSec) currentSec = durationSec;
  setProgressVisual(durationSec > 0 ? (currentSec / durationSec * 100) : 0);
  var timeDisplay = document.getElementById('time-display');
  if (timeDisplay) timeDisplay.textContent = formatProgramTime(currentSec) + ' / ' + (durationSec > 0 ? formatProgramTime(durationSec) : '0:00');
}
function progressPointerPreviewFromEvent(e) {
  var durationSec = getPlaybackDurationSeconds();
  if (!audio || !durationSec) return null;
  var bar = document.getElementById('progress-bar');
  if (!bar) return null;
  var rect = progressDragState.active && progressDragState.barRect
    ? progressDragState.barRect
    : bar.getBoundingClientRect();
  var width = Math.max(1, rect.width || 1);
  var ratio = clampRange((e.clientX - rect.left) / width, 0, 1);
  return { ratio: ratio, time: ratio * durationSec, duration: durationSec, rect: rect };
}
function queueProgressPointerPreview(e, emitParticles) {
  if (!e) return;
  progressDragState.pendingPointer = { clientX: Number(e.clientX) || 0, clientY: Number(e.clientY) || 0, emitParticles: !!emitParticles };
  if (progressDragState.pointerPreviewRaf) return;
  progressDragState.pointerPreviewRaf = requestAnimationFrame(function () {
    progressDragState.pointerPreviewRaf = 0;
    var pending = progressDragState.pendingPointer;
    progressDragState.pendingPointer = null;
    if (pending && progressDragState.active) previewProgressPointer(pending, pending.emitParticles);
  });
}
function flushProgressPointerPreview(e) {
  if (progressDragState.pointerPreviewRaf) {
    cancelAnimationFrame(progressDragState.pointerPreviewRaf);
    progressDragState.pointerPreviewRaf = 0;
  }
  var pending = progressDragState.pendingPointer;
  progressDragState.pendingPointer = null;
  if (e && isFinite(Number(e.clientX))) previewProgressPointer(e, false);
  else if (pending) previewProgressPointer(pending, false);
}
function previewProgressPointer(e, emitParticles) {
  var preview = progressPointerPreviewFromEvent(e);
  if (!preview) return false;
  progressDragState.previewTime = preview.time;
  progressDragState.previewDuration = preview.duration;
  progressDragState.previewClockRunning = false;
  renderProgressPreview(preview.time, preview.duration);
  // Beat-map cursors are committed once on pointer release.  Rewinding and
  // rescanning long beat arrays for every raw pointermove steals rAF time from
  // the continuous lyric track without changing audible playback.
  scheduleProgressLyricPreviewTick();
  if (emitParticles) emitProgressDragParticles(e.clientX, preview.rect.top + preview.rect.height / 2);
  return true;
}
function progressSeekTargetReached(media, targetTime, serial) {
  if (!media || serial !== progressDragState.commitSerial) return false;
  if (!progressSeekMediaStillCurrent(media, progressDragState.previewSettleMediaSrc)) return false;
  if (media.seeking || media.readyState < 2 || !isFinite(Number(media.currentTime))) return false;
  var current = Math.max(0, Number(media.currentTime) || 0);
  var target = Math.max(0, Number(targetTime) || 0);
  return current >= Math.max(0, target - 0.45) && current <= target + 1.5;
}
function waitForProgressSeekReady(media, targetTime, serial, timeoutMs) {
  if (!media) return Promise.resolve(false);
  if (progressSeekTargetReached(media, targetTime, serial)) return Promise.resolve(true);
  return new Promise(function (resolve) {
    var done = false;
    var timer = null;
    function cleanup() {
      if (timer) clearTimeout(timer);
      media.removeEventListener('seeked', onReady);
      media.removeEventListener('timeupdate', onReady);
      media.removeEventListener('canplay', onReady);
      media.removeEventListener('loadeddata', onReady);
      media.removeEventListener('playing', onReady);
      media.removeEventListener('error', onError);
    }
    function finish(ok) {
      if (done) return;
      done = true;
      cleanup();
      resolve(!!ok);
    }
    function onReady() {
      if (progressSeekTargetReached(media, targetTime, serial)) finish(true);
    }
    function onError() { finish(false); }
    media.addEventListener('seeked', onReady, { once: true });
    media.addEventListener('timeupdate', onReady);
    media.addEventListener('canplay', onReady);
    media.addEventListener('loadeddata', onReady);
    media.addEventListener('playing', onReady);
    media.addEventListener('error', onError, { once: true });
    timer = setTimeout(function () { finish(progressSeekTargetReached(media, targetTime, serial)); }, timeoutMs || 1800);
  });
}
function progressSeekMediaStillCurrent(media, mediaSrc) {
  return !!(media && audio === media && (media.currentSrc || media.src || '') === mediaSrc);
}
function restoreProgressSeekAudio(media, mediaSrc, resumeAfterSeek, serial) {
  if (serial !== progressDragState.commitSerial) return;
  if (!progressSeekMediaStillCurrent(media, mediaSrc)) {
    clearProgressPreviewHold(serial);
    return;
  }
  if (!resumeAfterSeek) {
    progressDragState.resumePlaySerial = 0;
    finishProgressPreviewHold(serial, 96);
    try { if (media && !media.paused) media.pause(); } catch (pauseErr) { }
    if (typeof restorePlaybackGain === 'function') restorePlaybackGain();
    return;
  }
  if (progressDragState.resumePlaySerial !== serial || (media && media.paused)) {
    primeProgressSeekPlayback(media, mediaSrc, serial);
  }
  finishProgressPreviewHold(serial, 96);
}
function primeProgressSeekPlayback(media, mediaSrc, serial) {
  if (serial !== progressDragState.commitSerial) return false;
  if (!progressSeekMediaStillCurrent(media, mediaSrc)) return false;
  progressDragState.resumePlaySerial = serial;
  if (typeof attemptAudioPlay === 'function') {
    attemptAudioPlay({ manual: true, silent: true });
    return true;
  }
  try {
    var playResult = media.play();
    if (playResult && playResult.then) {
      playResult.then(function () {
        if (serial !== progressDragState.commitSerial || !progressSeekMediaStillCurrent(media, mediaSrc)) return;
        if (typeof restorePlaybackGain === 'function') restorePlaybackGain();
      }).catch(function () {
        if (serial !== progressDragState.commitSerial || !progressSeekMediaStillCurrent(media, mediaSrc)) return;
        if (typeof restorePlaybackGain === 'function') restorePlaybackGain();
      });
    }
    return true;
  } catch (e) {
    finishProgressPreviewHold(serial, 48);
    if (progressSeekMediaStillCurrent(media, mediaSrc) && typeof restorePlaybackGain === 'function') restorePlaybackGain();
    return false;
  }
}
function commitProgressSeek(targetTime, resumeAfterSeek) {
  var media = progressDragState.media || audio;
  if (!media) return;
  var durationSec = progressDragState.previewDuration || getPlaybackDurationSeconds();
  if (!durationSec) return;
  targetTime = clampRange(Number(targetTime) || 0, 0, durationSec);
  var mediaSrc = progressDragState.mediaSrc || (media.currentSrc || media.src || '');
  var serial = ++progressDragState.commitSerial;
  if (!progressSeekMediaStillCurrent(media, mediaSrc)) {
    clearProgressPreviewHold();
    progressDragState.resumePlaySerial = 0;
    return false;
  }
  progressDragState.previewTime = targetTime;
  progressDragState.previewDuration = durationSec;
  beginProgressPreviewHold(serial, 2800, !!resumeAfterSeek, media, mediaSrc, targetTime);
  if (typeof setAudioOutputGainImmediate === 'function') setAudioOutputGainImmediate(0);
  try {
    media.currentTime = targetTime;
  } catch (err) {
    console.warn('[ProgressSeek] commit failed:', err && (err.message || err));
    progressDragState.previewClockRunning = false;
    finishProgressPreviewHold(serial, 48);
    restoreProgressSeekAudio(media, mediaSrc, false, serial);
    return;
  }
  if (resumeAfterSeek) primeProgressSeekPlayback(media, mediaSrc, serial);
  renderProgressPreview(targetTime, durationSec);
  syncBeatMapPlaybackCursor(targetTime, true);
  waitForProgressSeekReady(media, targetTime, serial, 1800).then(function (ready) {
    if (serial !== progressDragState.commitSerial || !progressSeekMediaStillCurrent(media, mediaSrc)) return false;
    if (ready) return true;
    try { media.currentTime = targetTime; } catch (retryErr) { }
    return waitForProgressSeekReady(media, targetTime, serial, 1200);
  }).then(function (ready) {
    if (serial !== progressDragState.commitSerial || !progressSeekMediaStillCurrent(media, mediaSrc)) return;
    if (!ready) console.warn('[ProgressSeek] target did not settle before fallback handoff');
    restoreProgressSeekAudio(media, mediaSrc, !!resumeAfterSeek && !!ready, serial);
  });
}
var progressBar = document.getElementById('progress-bar');
progressBar.addEventListener('pointerdown', function (e) {
  // MV 模式交给 17-mv-theater.js 里那条轻量拖拽：这里整条链绑死 audio
  // （progressSeekMediaStillCurrent 里 audio === media），还要压 gainNode、
  // 复位智能过渡，对 <video> 一样都不适用。
  // 判定用 mvTheaterOwnsPlayback() 而不是 mvTheaterActiveMedia()：后者要求视频
  // 已有 src，取址那段时间里它是 null，拖拽会落回这条链，去 seek 并起播刚被剧场
  // 暂停的音频。剧场开着就一律不接，视频够不够就绪由 MV 那条自己判断。
  if (typeof mvTheaterOwnsPlayback === 'function' && mvTheaterOwnsPlayback()) return;
  if (!audio || !getPlaybackDurationSeconds()) return;
  if (typeof resetSmartCrossfade === 'function') resetSmartCrossfade('manual-seek');
  progressDragState.active = true;
  progressDragState.media = audio;
  progressDragState.mediaSrc = audio.currentSrc || audio.src || '';
  progressDragState.resumeAfterSeek = !!(audio && !audio.paused && !audio.ended && playing);
  progressDragState.previewTime = getPlaybackCurrentSeconds();
  progressDragState.previewDuration = getPlaybackDurationSeconds();
  progressDragState.barRect = progressBar.getBoundingClientRect();
  progressBar.classList.add('is-dragging');
  if (progressDragState.resumeAfterSeek) {
    if (typeof setAudioOutputGainImmediate === 'function') setAudioOutputGainImmediate(0);
    try { audio.pause(); } catch (pauseErr) { }
  }
  try { progressBar.setPointerCapture(e.pointerId); } catch (err) { }
  previewProgressPointer(e, true);
  scheduleProgressLyricPreviewTick();
});
progressBar.addEventListener('pointermove', function (e) {
  if (!progressDragState.active) return;
  queueProgressPointerPreview(e, true);
});
function endProgressDrag(e, commit) {
  if (!progressDragState.active) return;
  flushProgressPointerPreview(e);
  var targetTime = progressDragState.previewTime;
  var resumeAfterSeek = progressDragState.resumeAfterSeek;
  var dragMedia = progressDragState.media;
  var dragMediaSrc = progressDragState.mediaSrc;
  progressDragState.active = false;
  progressDragState.barRect = null;
  progressBar.classList.remove('is-dragging');
  try { if (e && e.pointerId != null) progressBar.releasePointerCapture(e.pointerId); } catch (err) { }
  if (commit !== false) commitProgressSeek(targetTime, resumeAfterSeek);
  else {
    clearProgressPreviewHold();
    progressDragState.resumePlaySerial = 0;
    if (progressSeekMediaStillCurrent(dragMedia, dragMediaSrc) && typeof restorePlaybackGain === 'function') restorePlaybackGain();
  }
  progressDragState.media = null;
  progressDragState.mediaSrc = '';
  progressDragState.resumeAfterSeek = false;
  if (commit !== false && typeof scheduleSmartCrossfadePrepare === 'function') {
    scheduleSmartCrossfadePrepare(trackSwitchToken, currentIdx, 900);
  }
}
progressBar.addEventListener('pointerup', function (e) { endProgressDrag(e, true); });
progressBar.addEventListener('pointercancel', function (e) { endProgressDrag(e, false); });
progressBar.addEventListener('lostpointercapture', function (e) { endProgressDrag(e, true); });
// ============================================================
//  媒体时钟冻结检测（只观测并上报，不执行恢复）
// ============================================================
// 现有恢复已覆盖起播、手动恢复和 error/stalled 事件三个入口。剩下的缺口是
// 「稳态播放中途冻结、且浏览器不发任何事件」——起播 watchdog 早已到期。
// 这里先只落一条日志到本机 /api/diag/stall-log，用真实字段判断该恢复到哪一层，
// 再决定是否值得加第三层 watchdog（多层 watchdog 互相重入本身就是 bug 来源）。
var PLAYBACK_FREEZE_TICKS_REQUIRED = 5;   // 5 × 200ms = 1s 无推进
var PLAYBACK_FREEZE_MIN_ADVANCE = 0.02;
var PLAYBACK_FREEZE_PENDING_STALE_MS = 10000;
var playbackFreezeWatch = {
  lastTime: -1, stuckTicks: 0, reportedAt: 0, reportedTime: -1, pending: false,
  // 只记「检测到冻结」判断不出恢复有没有生效、花了多久，也就无法定位是哪一层救回来的。
  // 冻结未平息时保留这两个字段，时钟重新推进时补一条 clock-resumed。
  awaitingResume: false, frozenAt: 0, frozenTime: -1,
};
function resetPlaybackFreezeWatch() {
  playbackFreezeWatch.lastTime = -1;
  playbackFreezeWatch.stuckTicks = 0;
  playbackFreezeWatch.reportedTime = -1;
  playbackFreezeWatch.awaitingResume = false;
  playbackFreezeWatch.frozenAt = 0;
  playbackFreezeWatch.frozenTime = -1;
}
function playbackFreezeBufferedEnd(media) {
  try {
    if (!media.buffered || !media.buffered.length) return null;
    return media.buffered.end(media.buffered.length - 1);
  } catch (err) { return null; }
}
function reportPlaybackFreeze(media) {
  // 上报若卡在飞行中（请求 hang 住、.then 永不执行），不能让 pending 永久锁死，
  // 否则整个诊断会静默失效 —— 这个机制要连跑几天，静默失效等于没做。
  if (playbackFreezeWatch.pending) {
    if (performance.now() - playbackFreezeWatch.reportedAt < PLAYBACK_FREEZE_PENDING_STALE_MS) return;
    playbackFreezeWatch.pending = false;
  }
  var current = isFinite(media.currentTime) ? media.currentTime : 0;
  // 同一次冻结只报一条：位置没变过就不重复上报，等 currentTime 恢复推进后才允许下一条。
  if (playbackFreezeWatch.reportedTime >= 0 && Math.abs(current - playbackFreezeWatch.reportedTime) < PLAYBACK_FREEZE_MIN_ADVANCE) return;
  playbackFreezeWatch.pending = true;
  playbackFreezeWatch.reportedAt = performance.now();
  playbackFreezeWatch.reportedTime = current;
  playbackFreezeWatch.awaitingResume = true;
  playbackFreezeWatch.frozenAt = performance.now();
  playbackFreezeWatch.frozenTime = current;
  var song = (typeof playQueue !== 'undefined' && playQueue) ? playQueue[currentIdx] : null;
  var lastWaitingAt = Number(media.__mineradioLastWaitingAt) || 0;
  var payload = {
    reason: 'clock-frozen',
    currentTime: current,
    duration: isFinite(media.duration) ? media.duration : null,
    readyState: media.readyState,
    networkState: media.networkState,
    paused: !!media.paused,
    seeking: !!media.seeking,
    bufferedEnd: playbackFreezeBufferedEnd(media),
    audioCtxState: (typeof audioCtx !== 'undefined' && audioCtx) ? String(audioCtx.state || '') : 'none',
    lastWaitingAgoMs: lastWaitingAt ? (performance.now() - lastWaitingAt) : null,
    smartTransition: typeof playbackTransitionHasAudibleNextDeck === 'function' ? playbackTransitionHasAudibleNextDeck() : false,
    songKey: String(media.__mineradioQueueItemKey || ''),
    title: song ? String(song.name || song.title || '') : '',
    src: String(media.currentSrc || media.src || '')
  };
  console.warn('[PlaybackFreeze]', payload);
  fetch('/api/diag/stall-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).catch(function () { /* 诊断上报失败不影响播放 */ })
    .then(function () { playbackFreezeWatch.pending = false; });
}
// 冻结平息时补记一条。frozenForMs 是真正要看的数字：它直接反映恢复链
// 有没有生效、以及改动有没有把卡顿时长压下来。
function reportPlaybackFreezeResume(media, current) {
  var frozenAt = Number(playbackFreezeWatch.frozenAt) || 0;
  var frozenTime = Number(playbackFreezeWatch.frozenTime);
  playbackFreezeWatch.awaitingResume = false;
  playbackFreezeWatch.frozenAt = 0;
  playbackFreezeWatch.frozenTime = -1;
  if (!frozenAt) return;
  var payload = {
    reason: 'clock-resumed',
    currentTime: current,
    duration: isFinite(media.duration) ? media.duration : null,
    readyState: media.readyState,
    networkState: media.networkState,
    bufferedEnd: playbackFreezeBufferedEnd(media),
    audioCtxState: (typeof audioCtx !== 'undefined' && audioCtx) ? String(audioCtx.state || '') : 'none',
    // 检测本身要 1 秒,所以实际卡顿时长约为 frozenForMs + 1000。
    frozenForMs: Math.round(performance.now() - frozenAt),
    // 位置有没有跳变:恢复链换了 URL 或做了 seek 会让位置不等于冻结点。
    resumedFromSameTime: isFinite(frozenTime) && Math.abs(current - frozenTime) < 0.5,
    songKey: String(media.__mineradioQueueItemKey || ''),
    src: String(media.currentSrc || media.src || '')
  };
  console.warn('[PlaybackFreeze] resumed after', payload.frozenForMs, 'ms');
  fetch('/api/diag/stall-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).catch(function () { /* 诊断上报失败不影响播放 */ });
}

function tickPlaybackFreezeWatch(media) {
  if (!media || media !== audio || !media.src) { resetPlaybackFreezeWatch(); return; }
  if (media.paused || media.ended || media.seeking) { resetPlaybackFreezeWatch(); return; }
  // 过渡期间 B deck 可能才是出声的那个，A deck 停住是正常的。
  if (typeof playbackTransitionHasAudibleNextDeck === 'function' && playbackTransitionHasAudibleNextDeck()) { resetPlaybackFreezeWatch(); return; }
  if (typeof playbackMediaMatchesCurrentQueueItem === 'function' && !playbackMediaMatchesCurrentQueueItem(media)) { resetPlaybackFreezeWatch(); return; }
  var current = isFinite(media.currentTime) ? media.currentTime : 0;
  if (playbackFreezeWatch.lastTime < 0) { playbackFreezeWatch.lastTime = current; return; }
  // 用绝对值:恢复链换 URL 后时钟会从 0 附近重新走,这个「倒跳」也是时钟在动。
  // 只认前进方向会把倒跳当成还在冻结,在新位置再报一条假冻结。
  // 主动 seek 不会走到这里 —— seeking 状态在上面已经 reset 掉了。
  if (Math.abs(current - playbackFreezeWatch.lastTime) >= PLAYBACK_FREEZE_MIN_ADVANCE) {
    // 刚从一次已上报的冻结里恢复：补一条,记录卡了多久。
    // 没有这条就判断不出是哪一层救回来的,也看不出修改有没有缩短卡顿时长。
    if (playbackFreezeWatch.awaitingResume) {
      reportPlaybackFreezeResume(media, current);
    }
    playbackFreezeWatch.lastTime = current;
    playbackFreezeWatch.stuckTicks = 0;
    playbackFreezeWatch.reportedTime = -1;
    return;
  }
  playbackFreezeWatch.lastTime = current;
  playbackFreezeWatch.stuckTicks++;
  if (playbackFreezeWatch.stuckTicks < PLAYBACK_FREEZE_TICKS_REQUIRED) return;
  reportPlaybackFreeze(media);
}
setInterval(function () {
  if (!audio) {
    resetPlaybackFreezeWatch();
    updatePlaybackProgressUi();
    return;
  }
  if (progressDragState.active) {
    resetPlaybackFreezeWatch();
    updatePlaybackProgressUi();
    return;
  }
  tickPlaybackFreezeWatch(audio);
  updateListenStatsTick(false);
  updatePlaybackProgressUi();
  if (audio.currentTime) updateLyricsHighlight();
}, 200);

// ============================================================
//  文件拖放
