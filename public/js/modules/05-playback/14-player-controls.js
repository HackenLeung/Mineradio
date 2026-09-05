function waitForAudioReadyToPlay(media, timeoutMs) {
  if (!media) return Promise.resolve(false);
  if (media.readyState >= 2) return Promise.resolve(true);
  return new Promise(function (resolve) {
    var done = false;
    var timer = null;
    function cleanup() {
      if (timer) clearTimeout(timer);
      media.removeEventListener('canplay', onReady);
      media.removeEventListener('loadeddata', onReady);
      media.removeEventListener('error', onError);
    }
    function finish(ok) {
      if (done) return;
      done = true;
      cleanup();
      resolve(!!ok);
    }
    function onReady() { finish(true); }
    function onError() { finish(false); }
    media.addEventListener('canplay', onReady, { once: true });
    media.addEventListener('loadeddata', onReady, { once: true });
    media.addEventListener('error', onError, { once: true });
    timer = setTimeout(function () { finish(media.readyState >= 2); }, timeoutMs || 1000);
  });
}

function isSameAudioPlaybackTarget(media, src) {
  return !!(audio && media && audio === media && (audio.currentSrc || audio.src || '') === src);
}

function clearPlaybackResumeWatchdogs() {
  if (!playbackResumeRecovery || !Array.isArray(playbackResumeRecovery.timerIds)) return;
  playbackResumeRecovery.timerIds.forEach(function (timerId) { clearTimeout(timerId); });
  playbackResumeRecovery.timerIds = [];
}

function clearPlaybackResumePauseMarker() {
  if (!playbackResumeRecovery) return;
  playbackResumeRecovery.pausedAt = 0;
  playbackResumeRecovery.pausedSongKey = '';
  playbackResumeRecovery.pausedSrc = '';
  playbackResumeRecovery.pausedPosition = 0;
}

function updatePlaybackResumePauseMarker(reason) {
  if (!playbackResumeRecovery) return;
  if (reason === 'pause' || reason === 'manual-pause') {
    var song = playQueue && currentIdx >= 0 && currentIdx < playQueue.length ? playQueue[currentIdx] : null;
    var src = audio && (audio.currentSrc || audio.src || '') || '';
    if (!song || !src || !audio || audio.ended) {
      clearPlaybackResumePauseMarker();
      return;
    }
    playbackResumeRecovery.pausedAt = Date.now();
    playbackResumeRecovery.pausedSongKey = typeof queueItemKey === 'function' ? queueItemKey(song) : '';
    playbackResumeRecovery.pausedSrc = src;
    playbackResumeRecovery.pausedPosition = isFinite(audio.currentTime) ? Math.max(0, audio.currentTime) : 0;
    return;
  }
  if (reason === 'play' || reason === 'playing' || reason === 'ended' || reason === 'emptied' || reason === 'abort' || reason === 'error' || reason === 'track-switch') {
    clearPlaybackResumePauseMarker();
  }
}

function currentResumeSeconds(fallback) {
  if (audio && isFinite(audio.currentTime) && audio.currentTime > 0) return audio.currentTime;
  if (typeof getPlaybackCurrentSeconds === 'function') {
    var current = getPlaybackCurrentSeconds();
    if (isFinite(current) && current > 0) return current;
  }
  return Math.max(0, Number(fallback) || 0);
}

// 本地歌的起播卡死不该按在线歌的节奏等：文件已经在本机、缓冲往往几十上百秒，
// 6500ms 那档纯粹是白等（实测 stall.jsonl 里本地 MP3 缓冲 139s 仍冻 5762ms）。
// 判定同时看队列项和 media.src —— 队列项在恢复/换歌竞态里可能还没对上，
// 而 `/api/local-media` 这个来源是服务端注册过的本地文件，足以单独定性。
function playbackSongIsLocalFile(song) {
  return !!(song && (song.type === 'local' || song.source === 'local' || song.localUrl || song.localKey));
}
function playbackMediaIsLocalFile(media) {
  if (playbackSongIsLocalFile(playQueue && currentIdx >= 0 && currentIdx < playQueue.length ? playQueue[currentIdx] : null)) return true;
  var src = String(media && (media.currentSrc || media.src) || '');
  return src.indexOf('/api/local-media') >= 0;
}
function playbackTrackSwitchClockTimeoutMs(media, startTime) {
  if (Number(startTime) >= 0.35) return AUDIO_TRACK_SWITCH_RESUME_CLOCK_TIMEOUT_MS;
  if (playbackMediaIsLocalFile(media)) return AUDIO_LOCAL_TRACK_SWITCH_CLOCK_TIMEOUT_MS;
  return AUDIO_TRACK_SWITCH_CLOCK_TIMEOUT_MS;
}

function canRefreshCurrentPlaybackUrlForResume(song) {
  if (!song || song.type === 'local' || song.source === 'local' || song.localUrl) return false;
  var provider = normalizePlaybackProvider(songProviderKey(song));
  return provider === 'netease' || provider === 'qq' || provider === 'kugou';
}

function playbackResumeProvider(song) {
  return song ? normalizePlaybackProvider(songProviderKey(song)) : '';
}

function playbackResumeLongPauseThresholdMs(song) {
  var provider = playbackResumeProvider(song);
  var providerMs = PLAYBACK_RESUME_LONG_PAUSE_PROVIDER_MS && PLAYBACK_RESUME_LONG_PAUSE_PROVIDER_MS[provider];
  return Math.max(30000, Number(providerMs || PLAYBACK_RESUME_LONG_PAUSE_MS || 0) || (8 * 60 * 1000));
}

function playbackResumePausedLongEnough(song) {
  if (!playbackResumeRecovery || !playbackResumeRecovery.pausedAt) return false;
  if (!song || !canRefreshCurrentPlaybackUrlForResume(song)) return false;
  var markerKey = playbackResumeRecovery.pausedSongKey || '';
  var currentKey = typeof queueItemKey === 'function' ? queueItemKey(song) : '';
  if (markerKey && currentKey && markerKey !== currentKey) return false;
  var markerSrc = playbackResumeRecovery.pausedSrc || '';
  var currentSrc = audio && (audio.currentSrc || audio.src || '') || '';
  if (markerSrc && currentSrc && markerSrc !== currentSrc) return false;
  return Date.now() - playbackResumeRecovery.pausedAt >= playbackResumeLongPauseThresholdMs(song);
}

function trackSwitchStallRecoveryAllowed(song, opts) {
  opts = opts || {};
  if (!opts.trackSwitch || opts.resumeRecovery) return true;
  return canRefreshCurrentPlaybackUrlForResume(song);
}


function playbackFreshUrlRecoverySongKey(song) {
  if (typeof queueItemKey === 'function') return queueItemKey(song);
  return song ? [songProviderKey(song), song.id || song.mid || song.hash || ''].join(':') : '';
}

function resetPlaybackFreshUrlRecoveryBudget(song) {
  if (!playbackResumeRecovery) return;
  playbackResumeRecovery.freshUrlSongKey = playbackFreshUrlRecoverySongKey(song);
  playbackResumeRecovery.freshUrlAttemptCount = 0;
}

function playbackStallRecoveryTransaction(song, opts) {
  opts = opts || {};
  var recovery = typeof sourceFallbackRecoveryFromOptions === 'function'
    ? sourceFallbackRecoveryFromOptions(opts)
    : null;
  var recoverySongKey = typeof sourceFallbackRecoveryContentKey === 'function'
    ? sourceFallbackRecoveryContentKey(song)
    : '';
  if (
    !recovery
    && typeof sourceFallbackRecoveryIdentityActive === 'function'
    && sourceFallbackRecoveryIdentityActive(activeSourceFallbackRecovery)
    && (!recoverySongKey || activeSourceFallbackRecovery.visitedSongKeys[recoverySongKey])
  ) {
    recovery = activeSourceFallbackRecovery;
  }
  if (!recovery && typeof ensureSourceFallbackRecovery === 'function') {
    recovery = ensureSourceFallbackRecovery({}, song, currentIdx, trackSwitchToken);
  }
  return recovery;
}

async function recoverCurrentTrackPlaybackFromFreshUrl(reason, opts) {
  opts = opts || {};
  if (!playQueue.length || currentIdx < 0 || currentIdx >= playQueue.length) return false;
  var song = playQueue[currentIdx];
  if (!canRefreshCurrentPlaybackUrlForResume(song)) return false;
  var songKey = playbackFreshUrlRecoverySongKey(song);
  if (playbackResumeRecovery.freshUrlSongKey !== songKey) resetPlaybackFreshUrlRecoveryBudget(song);
  var now = performance.now();
  if (playbackResumeRecovery.pending || now - (playbackResumeRecovery.lastAttemptAt || 0) < 1200) return false;
  var recovery = playbackStallRecoveryTransaction(song, opts);
  if (!recovery) return false;
  if ((Number(playbackResumeRecovery.freshUrlAttemptCount) || 0) >= 1) {
    return settleSourceFallbackTerminal(
      currentIdx,
      trackSwitchToken,
      '当前歌曲重新取链后仍无法播放，已停止自动重试。',
      { silent: !!opts.silent, sourceFallbackRecovery: recovery }
    );
  }
  playbackResumeRecovery.freshUrlAttemptCount = (Number(playbackResumeRecovery.freshUrlAttemptCount) || 0) + 1;
  playbackResumeRecovery.pending = true;
  playbackResumeRecovery.lastAttemptAt = now;
  playbackResumeRecovery.lastReason = reason || 'resume-recovery';
  playbackResumeRecovery.serial++;
  clearPlaybackResumeWatchdogs();
  var resumeAt = currentResumeSeconds(opts.resumeAt);
  try {
    if (!opts.silent && typeof showSourceFallbackNotice === 'function') {
      showSourceFallbackNotice('播放恢复保护', '旧播放链接可能已失效，正在重新取链并回到原进度。');
    }
    var recovered = await playQueueAt(currentIdx, {
      manual: true,
      resumeAt: resumeAt,
      preserveHomeState: true,
      suppressPlayFailureNotice: true,
      resumeRecovery: true,
      sourceFallbackRecovery: recovery
    });
    if (recovered === true) return true;
    if (sourceFallbackRecoveryIdentityActive(recovery)) {
      return settleSourceFallbackTerminal(
        currentIdx,
        trackSwitchToken,
        '当前歌曲重新取链后仍无法播放，已停止自动重试。',
        { silent: !!opts.silent, sourceFallbackRecovery: recovery }
      );
    }
    return false;
  } catch (recoveryErr) {
    console.warn('[PlaybackResumeRecovery]', reason, recoveryErr);
    if (sourceFallbackRecoveryIdentityActive(recovery)) {
      settleSourceFallbackTerminal(
        currentIdx,
        trackSwitchToken,
        '当前歌曲恢复失败，已停止自动重试。',
        { silent: !!opts.silent, sourceFallbackRecovery: recovery }
      );
    }
    return false;
  } finally {
    playbackResumeRecovery.pending = false;
    forcePlaybackControlsInteractive();
  }
}

function playbackStallRecoveryOwnerStillCurrent(media, src, token, recoverySerial, queueKey) {
  if (!isSameAudioPlaybackTarget(media, src)) return false;
  if (token !== trackSwitchToken || recoverySerial !== playbackResumeRecovery.serial) return false;
  if (media.paused || media.ended || media.seeking) return false;
  if (queueKey && String(media.__mineradioQueueItemKey || '') !== queueKey) return false;
  if (typeof playbackMediaMatchesCurrentQueueItem === 'function' && !playbackMediaMatchesCurrentQueueItem(media)) return false;
  return true;
}

function schedulePlaybackStallRecovery(reason, opts) {
  opts = opts || {};
  var media = opts.ownerMedia || audio;
  if (!media || media !== audio || !media.src) return;
  if (opts.ownerToken != null && Number(opts.ownerToken) !== Number(trackSwitchToken)) return;
  var queueKey = String(opts.ownerQueueItemKey || media.__mineradioQueueItemKey || '');
  if (queueKey && String(media.__mineradioQueueItemKey || '') !== queueKey) return;
  if (typeof playbackMediaMatchesCurrentQueueItem === 'function' && !playbackMediaMatchesCurrentQueueItem(media)) return;
  var song = playQueue[currentIdx];
  if (!trackSwitchStallRecoveryAllowed(song, opts)) return;
  if (!canRefreshCurrentPlaybackUrlForResume(song)) return;
  clearPlaybackResumeWatchdogs();
  playbackResumeRecovery.serial = (Number(playbackResumeRecovery.serial) || 0) + 1;
  var src = media.currentSrc || media.src || '';
  var token = trackSwitchToken;
  var startTime = isFinite(media.currentTime) ? media.currentTime : 0;
  var recoverySerial = playbackResumeRecovery.serial;
  PLAYBACK_RESUME_STALL_DELAYS.forEach(function (delayMs) {
    var timerId = setTimeout(async function () {
      if (!playbackStallRecoveryOwnerStillCurrent(media, src, token, recoverySerial, queueKey)) return;
      var current = isFinite(media.currentTime) ? media.currentTime : 0;
      var minAdvance = delayMs > 2000 ? 0.28 : 0.08;
      if (current >= startTime + minAdvance) return;
      if (delayMs < 3000 && audioPlaybackWaitingForNetwork(media)) return;
      // 「数据够就别打扰」这条不能一刀切：起播冻结的实测形态是
      // readyState=4 + networkState=1(IDLE) + 缓冲几十秒 + currentTime 恒为 0，
      // 此条件恒成立，1600ms 那档被整档 return 掉，只剩 3600ms 兜底 —— 白等 2 秒。
      // 真正在缓冲的情况由上一行的 audioPlaybackWaitingForNetwork 负责（它只在
      // networkState=2 LOADING 时为真），所以这里只需排除仍在取数据的状态。
      if (
        delayMs < 3000
        && media.readyState >= 2
        && Number(media.networkState) === Number(media.NETWORK_LOADING || 2)
      ) return;
      if (audioPlaybackHasTransientNetworkFailure(media)) {
        if (audioPlaybackWaitingForNetwork(media)) {
          var networkRecovered = await waitForAudioPlaybackProgress(
            media,
            token,
            current,
            AUDIO_NETWORK_STARVATION_GRACE_MS,
            0.08
          );
          if (networkRecovered) return;
        }
        if (!playbackStallRecoveryOwnerStillCurrent(media, src, token, recoverySerial, queueKey)) return;
        settleRecoverableNetworkPlaybackStall(media, token, Math.max(current, startTime), opts.silent);
        return;
      }
      try {
        await ensurePlaybackAudioGraph('resume-stall-before-refresh');
        ensureAudiblePlaybackGain('resume-stall-before-refresh');
      } catch (graphErr) {
        console.warn('[PlaybackResumeRecovery] graph precheck failed:', graphErr);
      }
      if (!playbackStallRecoveryOwnerStillCurrent(media, src, token, recoverySerial, queueKey)) return;
      current = isFinite(media.currentTime) ? media.currentTime : 0;
      if (current >= startTime + minAdvance) return;
      var recovered = await recoverCurrentTrackPlaybackFromFreshUrl(reason || 'resume-stalled', {
        resumeAt: current || startTime,
        silent: opts.silent
      });
      if (!playbackStallRecoveryOwnerStillCurrent(media, src, token, recoverySerial, queueKey)) return;
    }, delayMs);
    playbackResumeRecovery.timerIds.push(timerId);
  });
}

function playbackAttemptStillCurrent(media, token) {
  return !!(media && audio === media && token === trackSwitchToken);
}
// `play()` may wait for the proxy to open a remote stream, but once it resolves
// a normal track switch must advance promptly. Explicit mid-track recovery or
// source switching gets the wider clock budget; fresh 0:00 switches fail over quickly.
var AUDIO_PLAY_REQUEST_TIMEOUT_MS = 22000;
var AUDIO_LOCAL_TRACK_SWITCH_CLOCK_TIMEOUT_MS = 1600;
var AUDIO_TRACK_SWITCH_CLOCK_TIMEOUT_MS = 6500;
var AUDIO_TRACK_SWITCH_RESUME_CLOCK_TIMEOUT_MS = 12000;
var AUDIO_MANUAL_RESUME_CLOCK_TIMEOUT_MS = 4200;
var AUDIO_NETWORK_STARVATION_GRACE_MS = 9000;
function awaitMediaPlayWithTimeout(media, playPromise, token, timeoutMs) {
  timeoutMs = Math.max(1000, Number(timeoutMs) || AUDIO_PLAY_REQUEST_TIMEOUT_MS);
  return new Promise(function (resolve, reject) {
    var settled = false;
    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      if (playbackAttemptStillCurrent(media, token)) {
        try { media.pause(); } catch (e) { }
      }
      var timeoutError = new Error('AUDIO_PLAY_TIMEOUT: media.play() did not start within ' + timeoutMs + 'ms');
      timeoutError.code = 'AUDIO_PLAY_TIMEOUT';
      reject(timeoutError);
    }, timeoutMs);
    Promise.resolve(playPromise).then(function (value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }, function (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}
function waitForAudioPlaybackProgress(media, token, startTime, timeoutMs, minAdvance) {
  timeoutMs = Math.max(400, Number(timeoutMs) || 1200);
  minAdvance = Math.max(0.02, Number(minAdvance) || 0.04);
  startTime = Math.max(0, Number(startTime) || 0);
  return new Promise(function (resolve) {
    var settled = false;
    var timer = 0;
    var poll = 0;
    function cleanup() {
      if (timer) clearTimeout(timer);
      if (poll) clearInterval(poll);
      ['timeupdate', 'playing', 'error', 'ended', 'abort'].forEach(function (name) {
        media.removeEventListener(name, check);
      });
    }
    function finish(ok) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(!!ok);
    }
    function check(event) {
      if (
        !playbackAttemptStillCurrent(media, token)
        || media.error
        || media.ended
        || media.paused
        || (event && /^(error|ended|abort)$/.test(event.type))
      ) return finish(false);
      var current = isFinite(Number(media.currentTime)) ? Number(media.currentTime) : 0;
      if (current >= startTime + minAdvance) finish(true);
    }
    ['timeupdate', 'playing', 'error', 'ended', 'abort'].forEach(function (name) {
      media.addEventListener(name, check);
    });
    poll = setInterval(check, 80);
    timer = setTimeout(function () { finish(false); }, timeoutMs);
    check();
  });
}
function playbackMediaMatchesCurrentQueueItem(media) {
  if (!media || !media.src || currentIdx < 0 || currentIdx >= playQueue.length) return false;
  var song = playQueue[currentIdx];
  var expectedKey = typeof queueItemKey === 'function' ? queueItemKey(song) : '';
  var mediaKey = String(media.__mineradioQueueItemKey || '');
  return !!(expectedKey && mediaKey && expectedKey === mediaKey);
}
function audioPlaybackStartState(media) {
  if (!media) return 'media=missing';
  var mediaError = media.error;
  return [
    'time=' + (isFinite(Number(media.currentTime)) ? Number(media.currentTime).toFixed(3) : 'NaN'),
    'readyState=' + Number(media.readyState || 0),
    'networkState=' + Number(media.networkState || 0),
    'paused=' + !!media.paused,
    'ended=' + !!media.ended,
    'error=' + (mediaError ? Number(mediaError.code || 0) : 0)
  ].join(' ');
}
function audioBufferedLeadSeconds(media) {
  if (!media || !media.buffered || !Number.isFinite(Number(media.currentTime))) return 0;
  var current = Math.max(0, Number(media.currentTime));
  try {
    for (var index = 0; index < media.buffered.length; index++) {
      var start = Number(media.buffered.start(index));
      var end = Number(media.buffered.end(index));
      if (current >= start - 0.12 && current <= end + 0.12) return Math.max(0, end - current);
    }
  } catch (e) { }
  return 0;
}
function audioPlaybackWaitingForNetwork(media) {
  if (!media || media.ended || media.error) return false;
  var networkLoading = Number(media.networkState || 0) === Number(media.NETWORK_LOADING || 2);
  if (!networkLoading) return false;
  var readyState = Number(media.readyState || 0);
  return readyState < 3 || audioBufferedLeadSeconds(media) < 0.45;
}
function audioPlaybackHasTransientNetworkFailure(media) {
  if (audioPlaybackWaitingForNetwork(media)) return true;
  if (!media || media.ended || Number(media.readyState || 0) >= 2) return false;
  var src = String(media.currentSrc || media.src || '');
  var mediaErrorCode = Number(media.error && media.error.code || 0);
  return src.indexOf('/api/audio?url=') >= 0 && (mediaErrorCode === 2 || mediaErrorCode === 4);
}
function createAudioNetworkStalledError(media, phase) {
  var error = new Error('AUDIO_NETWORK_STALLED' + (phase ? ' (' + phase + ')' : '') + ': ' + audioPlaybackStartState(media));
  error.code = 'AUDIO_NETWORK_STALLED';
  error.mediaState = audioPlaybackStartState(media);
  return error;
}
function clearRecoverableNetworkPlaybackStall(media) {
  if (!media) return;
  media.__mineradioRecoverableNetworkStallToken = 0;
  media.__mineradioRecoverableNetworkStallAt = 0;
}
function playbackMediaHasRecoverableNetworkStall(media, token) {
  return !!(
    media
    && Number(media.__mineradioRecoverableNetworkStallToken) === Number(token)
    && media.src
  );
}
function settleRecoverableNetworkPlaybackStall(media, token, resumeAt, silent) {
  if (!media || media !== audio || token !== trackSwitchToken || !media.src) return false;
  var position = Math.max(0, Number(resumeAt) || (isFinite(Number(media.currentTime)) ? Number(media.currentTime) : 0));
  media.__mineradioRecoverableNetworkStallToken = token;
  media.__mineradioRecoverableNetworkStallAt = Date.now();
  media.__mineradioPendingResumeSeconds = position;
  media.__mineradioPendingResumeToken = token;
  if (typeof clearPlaybackResumeWatchdogs === 'function') clearPlaybackResumeWatchdogs();
  if (playbackResumeRecovery) playbackResumeRecovery.serial = (Number(playbackResumeRecovery.serial) || 0) + 1;
  try { media.pause(); } catch (e) { }
  if (playbackResumeRecovery) {
    var song = playQueue && currentIdx >= 0 && currentIdx < playQueue.length ? playQueue[currentIdx] : null;
    playbackResumeRecovery.pausedAt = Date.now();
    playbackResumeRecovery.pausedSongKey = typeof queueItemKey === 'function' ? queueItemKey(song) : '';
    playbackResumeRecovery.pausedSrc = media.currentSrc || media.src || '';
    playbackResumeRecovery.pausedPosition = position;
  }
  restorePlaybackGain();
  playing = false;
  setPlayIcon(false);
  hideLoading();
  forcePlaybackControlsInteractive();
  if (typeof syncPlaybackStateFromAudioEvent === 'function') syncPlaybackStateFromAudioEvent('network-stalled');
  var now = Date.now();
  if (!playbackResumeRecovery || now - (playbackResumeRecovery.lastNetworkStallNoticeAt || 0) >= 8000) {
    if (playbackResumeRecovery) playbackResumeRecovery.lastNetworkStallNoticeAt = now;
    if (typeof showSourceFallbackNotice === 'function') {
      showSourceFallbackNotice('网络缓冲暂时中断', '已保留当前歌曲和进度，点击播放按钮会继续重试。');
    } else if (!silent && typeof showToast === 'function') {
      showToast('网络缓冲暂时中断，点击播放继续重试');
    }
  }
  return true;
}
function createAudioClockStalledError(media, phase) {
  var error = new Error('AUDIO_CLOCK_STALLED' + (phase ? ' (' + phase + ')' : '') + ': ' + audioPlaybackStartState(media));
  error.code = 'AUDIO_CLOCK_STALLED';
  error.mediaState = audioPlaybackStartState(media);
  return error;
}

async function completeAudioPlayStart(opts, reason, expectedMedia, expectedToken) {
  opts = opts || {};
  if (!playbackAttemptStillCurrent(expectedMedia, expectedToken)) return false;
  if (opts.trackSwitch) {
    var trackStartTime = isFinite(Number(expectedMedia.currentTime)) ? Number(expectedMedia.currentTime) : 0;
    var trackClockTimeoutMs = playbackTrackSwitchClockTimeoutMs(expectedMedia, trackStartTime);
    var trackStarted = await waitForAudioPlaybackProgress(expectedMedia, expectedToken, trackStartTime, trackClockTimeoutMs, 0.04);
    if (!trackStarted && audioPlaybackWaitingForNetwork(expectedMedia)) {
      trackStarted = await waitForAudioPlaybackProgress(expectedMedia, expectedToken, trackStartTime, AUDIO_NETWORK_STARVATION_GRACE_MS, 0.04);
    }
    if (!trackStarted) {
      var trackStartStall = audioPlaybackHasTransientNetworkFailure(expectedMedia)
        ? createAudioNetworkStalledError(expectedMedia, 'track-switch')
        : createAudioClockStalledError(expectedMedia, 'track-switch');
      try { expectedMedia.pause(); } catch (e) { }
      throw trackStartStall;
    }
  }
  await ensurePlaybackAudioGraph(reason || 'playback-started');
  if (!playbackAttemptStillCurrent(expectedMedia, expectedToken)) return false;
  clearRecoverableNetworkPlaybackStall(expectedMedia);
  switchPlaybackVisualToEmily();
  playing = true; setPlayIcon(true);
  if (typeof markStageLyricsPlaybackResume === 'function') markStageLyricsPlaybackResume(reason || 'playback-started');
  if (opts.trackSwitch) primeCinemaAfterTrackStart(reason || 'track-switch');
  if (opts.trackSwitch && !opts.resumeRecovery && typeof resetPlaybackFreshUrlRecoveryBudget === 'function') {
    var startedSong = playQueue && currentIdx >= 0 && currentIdx < playQueue.length ? playQueue[currentIdx] : null;
    resetPlaybackFreshUrlRecoveryBudget(startedSong);
  }
  schedulePlaybackAnalyserRecovery(reason || 'playback-started');
  if (!opts.preserveGain) restorePlaybackGain();
  schedulePlaybackStallRecovery(reason || 'playback-started', opts);
  forcePlaybackControlsInteractive();
  hideLoading();
  return true;
}

function canResumePausedAudioFast(opts) {
  opts = opts || {};
  return !!(
    opts.manual &&
    !opts.trackSwitch &&
    !opts.resumeRecovery &&
    audio &&
    audio.src &&
    playbackMediaMatchesCurrentQueueItem(audio) &&
    audio.paused &&
    !audio.ended
  );
}

function schedulePausedAudioResumeMaintenance(media, src, token, reason, opts) {
  opts = opts || {};
  setTimeout(async function () {
    if (!isSameAudioPlaybackTarget(media, src) || token !== trackSwitchToken || media.paused || media.ended) return;
    try {
      await applyAudioOutputDevice(media);
      await ensurePlaybackAudioGraph((reason || 'manual-resume-fast') + '-deferred-graph');
      ensureAudiblePlaybackGain((reason || 'manual-resume-fast') + '-deferred-gain');
    } catch (err) {
      console.warn('[PlaybackResumeFast] deferred maintenance failed:', err);
    }
    if (!isSameAudioPlaybackTarget(media, src) || token !== trackSwitchToken || media.paused || media.ended) return;
    schedulePlaybackAnalyserRecovery(reason || 'manual-resume-fast');
    schedulePlaybackStallRecovery(reason || 'manual-resume-fast', opts);
  }, 48);
}

async function resumePausedAudioFast(opts) {
  opts = opts || {};
  if (!canResumePausedAudioFast(opts)) return null;
  var media = audio;
  var src = media.currentSrc || media.src || '';
  var token = trackSwitchToken;
  var startTime = isFinite(media.currentTime) ? Number(media.currentTime) : 0;
  try {
    restorePlaybackGain();
    await awaitMediaPlayWithTimeout(media, media.play(), token);
    if (!isSameAudioPlaybackTarget(media, src) || token !== trackSwitchToken) return false;
    if (!await waitForAudioPlaybackProgress(media, token, startTime, AUDIO_MANUAL_RESUME_CLOCK_TIMEOUT_MS, 0.04)) {
      try { media.pause(); } catch (e) { }
      return false;
    }
    clearRecoverableNetworkPlaybackStall(media);
    switchPlaybackVisualToEmily();
    playing = true; setPlayIcon(true);
    if (typeof markStageLyricsPlaybackResume === 'function') {
      setTimeout(function () {
        if (isSameAudioPlaybackTarget(media, src) && token === trackSwitchToken && !media.paused && !media.ended) {
          markStageLyricsPlaybackResume('manual-resume-fast');
        }
      }, 0);
    }
    forcePlaybackControlsInteractive();
    hideLoading();
    schedulePausedAudioResumeMaintenance(media, src, token, 'manual-resume-fast', { manual: true, silent: true, fastResume: true });
    return true;
  } catch (err) {
    console.warn('[PlaybackResumeFast]', err && (err.message || err));
    return null;
  }
}

function audioErrorHasCode(error, code) {
  if (!error) return false;
  if (error.code === code) return true;
  return String(error.message || '').indexOf(code) === 0;
}

function releaseReplacedPlaybackMedia(media) {
  if (!media || media === audio) return;
  // A replaced element keeps its src, so its buffer and its open connection to
  // the local audio proxy stay alive until GC. Chromium caps same-host
  // connections, so leaking one per stalled switch would feed the very stall
  // this rebuild exists to recover from.
  try {
    media.pause();
    media.removeAttribute('src');
    media.load();
  } catch (e) { }
}

function rebuildTrackSwitchMediaAfterClockStall(media, token) {
  if (!media || media !== audio || !media.src || typeof replaceAudioElementForGraphRecovery !== 'function') return null;
  var queueKey = String(media.__mineradioQueueItemKey || '');
  try {
    replaceAudioElementForGraphRecovery('track-switch-clock-stalled', { preservePlayback: true });
  } catch (rebuildErr) {
    console.warn('[Playback] media rebuild after stalled clock failed:', rebuildErr && (rebuildErr.message || rebuildErr));
  }
  var rebuilt = audio;
  if (!rebuilt || rebuilt === media) return null;
  // The swap lands before any of the rebuild's own setup can throw, so stamp
  // the identity markers on whatever survived the call. Without them a partial
  // rebuild leaves an unrecognisable element behind and every caller downstream
  // reads the attempt as stale, giving up without restoring gain or the UI.
  rebuilt.__mineradioQueueItemKey = queueKey;
  rebuilt.__mineradioTrackSwitchToken = token;
  if (!rebuilt.src) return null;
  releaseReplacedPlaybackMedia(media);
  try { rebuilt.load(); } catch (e) { }
  return rebuilt;
}

async function retryTrackSwitchAudioPlayOnce(opts, originalErr, expectedMedia, expectedToken) {
  var retryAudio = audioErrorHasCode(originalErr, 'AUDIO_CLOCK_STALLED')
    ? (rebuildTrackSwitchMediaAfterClockStall(expectedMedia, expectedToken) || expectedMedia)
    : expectedMedia;
  var retrySrc = retryAudio && (retryAudio.currentSrc || retryAudio.src || '');
  if (!retryAudio || !retrySrc) throw originalErr;
  await waitForAudioReadyToPlay(retryAudio, opts.manual ? 1400 : 2600);
  if (!playbackAttemptStillCurrent(retryAudio, expectedToken) || !isSameAudioPlaybackTarget(retryAudio, retrySrc)) return null;
  if (retryAudio.readyState === 0 || retryAudio.networkState === retryAudio.NETWORK_EMPTY) {
    try { retryAudio.load(); } catch (e) { }
  }
  if (!audioGraphHealthy()) initAudio();
  await applyAudioOutputDevice(retryAudio);
  if (!playbackAttemptStillCurrent(retryAudio, expectedToken)) return null;
  await ensurePlaybackAudioGraph('track-switch-retry-before-play');
  if (!playbackAttemptStillCurrent(retryAudio, expectedToken)) return null;
  var retryPlay = retryAudio.play();
  await ensurePlaybackAudioGraph('track-switch-retry-after-play-request');
  await awaitMediaPlayWithTimeout(retryAudio, retryPlay, expectedToken);
  if (!playbackAttemptStillCurrent(retryAudio, expectedToken)) return null;
  return await completeAudioPlayStart(opts, 'track-switch-retry-started', retryAudio, expectedToken);
}

async function attemptAudioPlay(opts) {
  opts = opts || {};
  var expectedMedia = opts.expectedMedia || audio;
  var expectedToken = opts.expectedToken == null ? trackSwitchToken : Number(opts.expectedToken);
  try {
    if (!playbackAttemptStillCurrent(expectedMedia, expectedToken)) return false;
    var currentSongForResume = playQueue && currentIdx >= 0 && currentIdx < playQueue.length ? playQueue[currentIdx] : null;
    if (opts.manual && playbackMediaHasRecoverableNetworkStall(expectedMedia, expectedToken)) {
      var recoverableResumeAt = Math.max(
        Number(expectedMedia.__mineradioPendingResumeSeconds) || 0,
        currentResumeSeconds(playbackResumeRecovery && playbackResumeRecovery.pausedPosition),
      );
      try { expectedMedia.load(); } catch (e) { }
      if (recoverableResumeAt >= 0.35 && typeof scheduleAudioResumePosition === 'function') {
        scheduleAudioResumePosition(expectedMedia, recoverableResumeAt, expectedToken);
        var resumeSettled = await waitForAudioResumePosition(expectedMedia, recoverableResumeAt, expectedToken, 1800);
        if (!resumeSettled) throw createAudioNetworkStalledError(expectedMedia, 'manual-resume-seek');
      }
    }
    if (opts.manual && !opts.trackSwitch && !opts.resumeRecovery) {
      // A manual click is an explicit new recovery attempt. Do not let a
      // previous automatic refresh permanently consume this song's retry.
      resetPlaybackFreshUrlRecoveryBudget(currentSongForResume);
    }
    if (opts.manual && !opts.trackSwitch && !opts.resumeRecovery && audio && audio.src && audio.paused && !audio.ended && playbackResumePausedLongEnough(currentSongForResume)) {
      var staleResumeAt = currentResumeSeconds(playbackResumeRecovery && playbackResumeRecovery.pausedPosition);
      var refreshedResume = await recoverCurrentTrackPlaybackFromFreshUrl('long-pause-stale-source', {
        resumeAt: staleResumeAt,
        silent: opts.silent !== false
      });
      if (refreshedResume) return true;
    }
    if (!playbackAttemptStillCurrent(expectedMedia, expectedToken)) return false;
    var fastResume = await resumePausedAudioFast(opts);
    if (fastResume === true) return true;
    if (fastResume === false) {
      throw audioPlaybackHasTransientNetworkFailure(expectedMedia)
        ? createAudioNetworkStalledError(expectedMedia, 'manual-resume')
        : createAudioClockStalledError(expectedMedia, 'manual-resume');
    }
    if (!playbackAttemptStillCurrent(expectedMedia, expectedToken)) return false;
    if (opts.manual || opts.trackSwitch) {
      var directStartTime = isFinite(Number(expectedMedia.currentTime)) ? Number(expectedMedia.currentTime) : 0;
      // 输出设备和 WebAudio 图必须在 play() 之前稳定下来。尤其本地歌上，
      // play() 后再次 setSinkId 会让 Chromium 偶发把媒体时钟卡在 0 秒。
      await applyAudioOutputDevice(expectedMedia);
      if (!playbackAttemptStillCurrent(expectedMedia, expectedToken)) return false;
      await ensurePlaybackAudioGraph(opts.manual ? 'manual-before-play' : 'track-switch-before-play');
      if (!playbackAttemptStillCurrent(expectedMedia, expectedToken)) return false;
      var directPlay = expectedMedia.play();
      await awaitMediaPlayWithTimeout(expectedMedia, directPlay, expectedToken);
      if (opts.manual && !opts.trackSwitch && !await waitForAudioPlaybackProgress(expectedMedia, expectedToken, directStartTime, AUDIO_MANUAL_RESUME_CLOCK_TIMEOUT_MS, 0.04)) {
        throw audioPlaybackHasTransientNetworkFailure(expectedMedia)
          ? createAudioNetworkStalledError(expectedMedia, 'manual-start')
          : createAudioClockStalledError(expectedMedia, 'manual-start');
      }
    } else {
      await applyAudioOutputDevice(expectedMedia);
      if (!playbackAttemptStillCurrent(expectedMedia, expectedToken)) return false;
      await ensurePlaybackAudioGraph(opts.startupAutoplay ? 'startup-before-play' : 'auto-before-play');
      if (!playbackAttemptStillCurrent(expectedMedia, expectedToken)) return false;
      var autoPlay = expectedMedia.play();
      await ensurePlaybackAudioGraph(opts.startupAutoplay ? 'startup-after-play-request' : 'auto-after-play-request');
      await awaitMediaPlayWithTimeout(expectedMedia, autoPlay, expectedToken);
    }
    if (!playbackAttemptStillCurrent(expectedMedia, expectedToken)) return false;
    return await completeAudioPlayStart(opts, 'playback-started', expectedMedia, expectedToken);
  } catch (err) {
    if (!playbackAttemptStillCurrent(expectedMedia, expectedToken)) return false;
    if (opts.trackSwitch && expectedMedia && expectedMedia.src) {
      var stalledQueueItemKey = String(expectedMedia.__mineradioQueueItemKey || '');
      try {
        var recovered = await retryTrackSwitchAudioPlayOnce(opts, err, expectedMedia, expectedToken);
        if (recovered) return true;
      } catch (retryErr) {
        err = retryErr;
      }
      // The stalled-clock retry may deliberately rebuild the media element.
      // Follow that swap, otherwise the identity check below reads the retry
      // as a stale attempt and silently skips the fresh-url recovery, the gain
      // restore and hideLoading, leaving the player frozen on a loading state.
      if (
        audio
        && audio !== expectedMedia
        && Number(audio.__mineradioTrackSwitchToken) === Number(expectedToken)
        && String(audio.__mineradioQueueItemKey || '') === stalledQueueItemKey
      ) expectedMedia = audio;
    }
    if (!playbackAttemptStillCurrent(expectedMedia, expectedToken)) return false;
    if (audioErrorHasCode(err, 'AUDIO_NETWORK_STALLED')) {
      settleRecoverableNetworkPlaybackStall(
        expectedMedia,
        expectedToken,
        currentResumeSeconds(expectedMedia && expectedMedia.__mineradioPendingResumeSeconds),
        opts.silent,
      );
      return false;
    }
    console.warn('Audio play blocked:', err && (err.message || err));
    if (!opts.resumeRecovery) {
      var recoveryReason = opts.trackSwitch ? 'track-switch-play-rejected' : 'play-rejected';
      var resumed = await recoverCurrentTrackPlaybackFromFreshUrl(recoveryReason, {
        originalError: err,
        silent: opts.silent
      });
      if (resumed) return true;
    }
    if (!playbackAttemptStillCurrent(expectedMedia, expectedToken)) return false;
    restorePlaybackGain();
    playing = false; setPlayIcon(false);
    hideLoading();
    forcePlaybackControlsInteractive();
    if (!opts.silent && !opts.trackSwitch) showToast(opts.manual ? '播放启动失败, 请重新选择歌曲' : '播放被系统拦截, 请点击播放按钮');
    return false;
  }
}
async function playAudio(opts) {
  opts = opts || {};
  return attemptAudioPlay({ manual: !!opts.manual, silent: !!opts.silent || !!opts.startupAutoplay || !!opts.trackSwitch, startupAutoplay: !!opts.startupAutoplay, preserveGain: !!opts.preserveGain, trackSwitch: !!opts.trackSwitch, resumeRecovery: !!opts.resumeRecovery, expectedMedia: opts.expectedMedia || audio, expectedToken: opts.expectedToken == null ? trackSwitchToken : opts.expectedToken });
}
async function togglePlay() {
  if (playToggleBusy) return;
  // MV 剧场开着时底栏播放键作用于视频。放在 playToggleBusy 之前：MV 分支不碰
  // 音频链，没有需要串行化的异步起播。
  if (typeof toggleMvPlayback === 'function' && toggleMvPlayback()) {
    forcePlaybackControlsInteractive();
    return;
  }
  playToggleBusy = true;
  try {
    forcePlaybackControlsInteractive();
    if ((!audio || !audio.src) && playQueue.length && currentIdx >= 0) {
      await playQueueAt(currentIdx, { manual: true });
      return;
    }
    if (audio && audio.src && playQueue.length && currentIdx >= 0 && !playbackMediaMatchesCurrentQueueItem(audio)) {
      await playQueueAt(currentIdx, { manual: true, suppressPlayFailureNotice: true });
      return;
    }
    if ((!audio || !audio.src) && currentLocalSong && (currentLocalSong.localMissing || !currentLocalSong.localUrl)) {
      showToast('上次播放的是本地文件，请重新导入后继续');
      return;
    }
    if (!audio) return;
    if (audio.paused || audio.ended) {
      await attemptAudioPlay({ manual: true });
    } else {
      if (typeof smartCrossfadeExecuting !== 'undefined' && smartCrossfadeExecuting && typeof resetSmartCrossfade === 'function') {
        resetSmartCrossfade('manual-pause');
      }
      try { audio.pause(); } catch (pauseErr) { console.warn('[TogglePlayPause]', pauseErr); }
      playing = false;
      setPlayIcon(false);
      hideLoading();
      safePlaybackStep('listen-stats-pause', function () { updateListenStatsTick(true); });
      forcePlaybackControlsInteractive();
      safePlaybackStep('sync-pause-state', function () { syncPlaybackStateFromAudioEvent('manual-pause'); });
      safePlaybackStep('pause-controls-hide', function () { scheduleControlsHide(520); });
    }
  } catch (err) {
    console.warn('[TogglePlay]', err);
    playing = !!(audio && !audio.paused);
    setPlayIcon(playing);
    hideLoading();
    forcePlaybackControlsInteractive();
    if (!audio || !audio.src) showToast('播放控制失败');
  } finally {
    playToggleBusy = false;
  }
}
function setPlayIcon(p) {
  document.getElementById('play-icon').innerHTML = p
    ? '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>'
    : '<path d="M8 5v14l11-7z"/>';
}
function shuffleArrayInPlace(items) {
  for (var i = items.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var tmp = items[i];
    items[i] = items[j];
    items[j] = tmp;
  }
  return items;
}
function reorderQueueForShufflePlaybackOrder(startIdx, opts) {
  opts = opts || {};
  if (!playQueue.length) return -1;
  startIdx = Math.round(Number(startIdx));
  if (!isFinite(startIdx) || startIdx < 0 || startIdx >= playQueue.length) {
    startIdx = currentIdx >= 0 && currentIdx < playQueue.length ? currentIdx : 0;
  }
  if (playQueue.length > 1) {
    var currentSong = playQueue[startIdx];
    var upcoming = [];
    for (var i = 0; i < playQueue.length; i++) {
      if (i !== startIdx) upcoming.push(playQueue[i]);
    }
    shuffleArrayInPlace(upcoming);
    playQueue.length = 0;
    playQueue.push(currentSong);
    for (var j = 0; j < upcoming.length; j++) playQueue.push(upcoming[j]);
  }
  currentIdx = 0;
  if (opts.renderPanel !== false) safeRenderQueuePanel(opts.reason || 'shuffle-playback-order', { animate: false, scrollCurrent: false, deferWhenHidden: false });
  if (opts.rebuildShelf !== false) safeShelfRebuild(opts.reason || 'shuffle-playback-order', true);
  if (opts.persistSnapshot !== false && typeof saveLastPlaybackSnapshot === 'function') saveLastPlaybackSnapshot(true, opts.reason || 'shuffle-playback-order');
  return currentIdx;
}
function nextTrack(userInitiated) {
  if (!playQueue.length) return;
  playToggleBusy = false;
  forcePlaybackControlsInteractive();
  if (currentIdx >= playQueue.length - 1 && queueHydrationState && queueHydrationState.queueRef === playQueue && (queueHydrationState.active || queueHydrationState.loading) && !queueHydrationState.error) {
    var previousTail = currentIdx;
    Promise.resolve(hydratePlaylistQueueNextPage('queue-tail')).then(function () {
      if (playQueue.length <= previousTail + 1 && queueHydrationState && queueHydrationState.error) {
        showToast('后续歌曲载入失败，当前歌曲保持不变');
        return false;
      }
      currentIdx = playQueue.length > previousTail + 1 ? previousTail + 1 : 0;
      var tailOpts = userInitiated ? { manual: true, suppressPlayFailureNotice: true } : { suppressPlayFailureNotice: true };
      if (playMode === 'shuffle') tailOpts.skipShuffleOrder = true;
      return playQueueAt(currentIdx, tailOpts);
    }).finally(forcePlaybackControlsInteractive);
    return;
  }
  if (playMode === 'shuffle') currentIdx = currentIdx < 0 ? 0 : (currentIdx + 1) % playQueue.length;
  else currentIdx = (currentIdx + 1) % playQueue.length;
  var opts = userInitiated ? { manual: true, suppressPlayFailureNotice: true } : { suppressPlayFailureNotice: true };
  if (playMode === 'shuffle') opts.skipShuffleOrder = true;
  Promise.resolve(playQueueAt(currentIdx, opts)).finally(forcePlaybackControlsInteractive);
}
function prevTrack(userInitiated) {
  if (!playQueue.length) return;
  playToggleBusy = false;
  forcePlaybackControlsInteractive();
  currentIdx = (currentIdx - 1 + playQueue.length) % playQueue.length;
  var opts = userInitiated ? { manual: true, suppressPlayFailureNotice: true } : { suppressPlayFailureNotice: true };
  if (playMode === 'shuffle') opts.skipShuffleOrder = true;
  Promise.resolve(playQueueAt(currentIdx, opts)).finally(forcePlaybackControlsInteractive);
}
function shuffleQueue() {
  reorderQueueForShufflePlaybackOrder(currentIdx, { reason: 'shuffle-queue' });
  showToast('队列已随机');
}
function clearQueue() {
  if (typeof cancelPlaylistQueueHydration === 'function') cancelPlaylistQueueHydration('clear-queue');
  playQueue = []; currentIdx = -1;
  currentLocalSong = null;
  startupRestoreHomePending = false;
  restoredLastPlaybackSnapshot = null;
  try { localStorage.removeItem(LAST_PLAYBACK_STORE_KEY); } catch (e) { }
  safeRenderQueuePanel('clear-queue');
  safeShelfRebuild('clear-queue');
  updateCustomCoverButton();
  updateCustomLyricControls();
  if (typeof syncMediaSessionState === 'function') syncMediaSessionState();
  updateEmptyHomeVisibility({ forceLoad: false });
}
function removeFromQueue(idx) {
  if (idx < 0 || idx >= playQueue.length) return;
  playQueue.splice(idx, 1);
  if (currentIdx >= playQueue.length) currentIdx = playQueue.length - 1;
  safeRenderQueuePanel('remove-queue-item');
  safeShelfRebuild('remove-queue-item');
  updateCustomCoverButton();
  updateCustomLyricControls();
  updateEmptyHomeVisibility({ forceLoad: false });
}
function playModeLabel(mode) {
  return { loop: '顺序循环', shuffle: '随机播放', single: '单曲循环' }[mode] || '顺序循环';
}

function normalizePlayMode(mode) {
  mode = String(mode || '');
  return mode === 'shuffle' || mode === 'single' ? mode : 'loop';
}

// 快照恢复只赋值不刷新按钮时，模块加载时那一次 updatePlayModeButton 停在初始的 loop 上，
// 于是图标显示顺序循环、实际却按恢复出来的模式走。恢复路径一律走这里。
// 队列快照本身就是当时的乱序结果，恢复后不再重排。
function applyRestoredPlayMode(mode) {
  if (!mode) return;
  playMode = normalizePlayMode(mode);
  updatePlayModeButton(false);
}

function playModeIconMarkup(mode) {
  if (mode === 'shuffle') {
    return '<path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="M15 15l6 6"/><path d="M4 4l5 5"/>';
  }
  if (mode === 'single') {
    return '<path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/><path d="M12 9v6"/><path d="M10.5 10.5 12 9l1.5 1.5"/>';
  }
  return '<path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>';
}

function updatePlayModeButton(animate) {
  var label = playModeLabel(playMode);
  var chip = document.getElementById('play-mode-chip');
  var btn = document.getElementById('play-mode-btn');
  var icon = document.getElementById('play-mode-icon');
  if (chip) chip.textContent = label;
  if (btn) {
    btn.dataset.mode = playMode;
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.classList.toggle('active', playMode !== 'loop');
  }
  if (icon) icon.innerHTML = playModeIconMarkup(playMode);
  if (!animate || !btn) return;
  if (window.gsap) {
    window.gsap.killTweensOf(btn);
    if (icon) window.gsap.killTweensOf(icon);
    window.gsap.timeline({ defaults: { overwrite: true } })
      .fromTo(btn, { scale: 0.86, rotate: -8 }, { scale: 1.12, rotate: 4, duration: 0.16, ease: 'power2.out' })
      .to(btn, { scale: 1, rotate: 0, duration: 0.34, ease: 'back.out(2.1)' });
    window.gsap.fromTo(btn,
      { boxShadow: '0 0 0 0 rgba(255,63,85,.36)' },
      { boxShadow: '0 0 0 14px rgba(255,63,85,0)', duration: 0.58, ease: 'sine.out', overwrite: false, onComplete: function () { window.gsap.set(btn, { clearProps: 'boxShadow' }); } }
    );
    if (icon) window.gsap.fromTo(icon, { y: 4, autoAlpha: 0.32, rotate: -22, scale: 0.74 }, { y: 0, autoAlpha: 1, rotate: 0, scale: 1, duration: 0.42, ease: 'expo.out', overwrite: true });
  } else {
    btn.classList.remove('mode-switching');
    void btn.offsetWidth;
    btn.classList.add('mode-switching');
    setTimeout(function () { btn.classList.remove('mode-switching'); }, 460);
  }
}

function cyclePlayMode() {
  var modes = ['loop', 'shuffle', 'single'];
  var idx = modes.indexOf(playMode);
  var prevMode = playMode;
  playMode = modes[(idx + 1) % modes.length];
  if (playMode === 'shuffle' && prevMode !== 'shuffle') {
    reorderQueueForShufflePlaybackOrder(currentIdx, { reason: 'play-mode-shuffle' });
  }
  updatePlayModeButton(true);
  saveLastPlaybackSnapshot(true, 'play-mode');
  showToast('播放模式: ' + playModeLabel(playMode));
}
updatePlayModeButton(false);
