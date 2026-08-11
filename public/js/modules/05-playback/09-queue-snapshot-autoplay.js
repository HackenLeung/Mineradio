// ============================================================
function queueItemKey(song) {
  if (!song) return '';
  if (song.provider === 'qq' || song.source === 'qq' || song.type === 'qq') return 'qq:' + (song.mid || song.songmid || song.id || (song.name + '|' + song.artist));
  if (song.provider === 'kugou' || song.source === 'kugou' || song.type === 'kugou' || song.hash || song.audioHash) return 'kugou:' + (song.hash || song.fileHash || song.audioHash || song.id || (song.name + '|' + song.artist));
  if (song.cloudSong || song.cloudSource === 'netease-cloud') return 'netease-cloud:' + (song.cloudId || song.id || (song.name + '|' + song.artist));
  if (song.type === 'podcast' && song.programId) return 'podcast:' + song.programId;
  if (song.localKey) return 'local:' + song.localKey;
  if (song.id != null && song.id !== '') return 'song:' + song.id;
  return String(song.name || '') + '|' + String(song.artist || '');
}
// 快照只保存可寻址的轻量字段。内嵌封面是 base64 data URL、内嵌歌词最多 512 KB，
// 一旦写进队列快照，每次 tick 都要同步序列化几十上百 MB，会直接卡死主线程。
// 这些内容在文件夹重扫时会由 syncResolvedLocalSongReferences 重新挂回来。
var PLAYBACK_SNAPSHOT_URL_MAX = 2048;
var PLAYBACK_SNAPSHOT_IDENTITY_KEYS = [
  'provider', 'source', 'type', 'cloudSong', 'cloudSource', 'cloudId', 'id', 'mid', 'songmid', 'mediaMid', 'media_mid', 'qqId',
  'hash', 'fileHash', 'audioHash', 'albumId', 'album_id', 'albumMid', 'albummid', 'albumAudioId', 'album_audio_id', 'mixSongId', 'hqHash', 'sqHash', 'resHash',
  'name', 'title', 'artist', 'duration', 'durationMs', 'dt',
  'programId', 'radioId', 'radioName', 'localKey', 'localPath'
];
var PLAYBACK_SNAPSHOT_EXTRA_KEYS = [
  'album', 'fee', 'playable', 'playbackMode', 'recommendationSource',
  'localFolderPath', 'localFolderName'
];
var PLAYBACK_SNAPSHOT_URL_KEYS = ['cover', 'sidecarCover'];
// data URL 一律丢弃：体积不可控，且能从本地文件重新读取。
function playbackSnapshotSafeUrl(value) {
  var raw = typeof value === 'string' ? value : '';
  if (!raw || /^data:/i.test(raw)) return '';
  return raw.length > PLAYBACK_SNAPSHOT_URL_MAX ? '' : raw;
}
function playbackSnapshotSafeMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return null;
  var safe = {};
  Object.keys(metadata).forEach(function (key) {
    var value = metadata[key];
    if (value == null || value === '') return;
    if (typeof value === 'string') {
      var trimmed = playbackSnapshotSafeUrl(value);
      if (trimmed) safe[key] = trimmed;
      return;
    }
    if (typeof value === 'number' || typeof value === 'boolean') safe[key] = value;
  });
  return Object.keys(safe).length ? safe : null;
}
function playbackRestoreSongSnapshot(song, minimal) {
  song = song || {};
  var snap = {};
  var keys = minimal
    ? PLAYBACK_SNAPSHOT_IDENTITY_KEYS
    : PLAYBACK_SNAPSHOT_IDENTITY_KEYS.concat(PLAYBACK_SNAPSHOT_EXTRA_KEYS);
  keys.forEach(function (key) {
    if (song[key] != null && song[key] !== '') snap[key] = song[key];
  });
  PLAYBACK_SNAPSHOT_URL_KEYS.forEach(function (key) {
    var safe = playbackSnapshotSafeUrl(song[key]);
    if (safe) snap[key] = safe;
  });
  if (!minimal) {
    if (Array.isArray(song.artists)) snap.artists = song.artists.slice(0, 6);
    var safeMetadata = playbackSnapshotSafeMetadata(song.onlineMetadata);
    if (safeMetadata) snap.onlineMetadata = safeMetadata;
  }
  if (song.type === 'local' || song.localKey) snap.localMissing = true;
  return snap;
}
function readLastPlaybackSnapshot() {
  try {
    var raw = localStorage.getItem(LAST_PLAYBACK_STORE_KEY);
    if (raw) {
      var data = JSON.parse(raw);
      if (data && data.version === 1 && data.current) {
        data.currentTime = 0;
        return data;
      }
    }

    // main 旧版把完整队列保存在 playback-session-v1。直接从同一个
    // localStorage profile 读取它，不复制、合并或移动任何 Electron 数据。
    var legacyRaw = localStorage.getItem('mineradio-playback-session-v1');
    if (!legacyRaw) return null;
    var legacy = JSON.parse(legacyRaw);
    var legacyQueue = legacy && Array.isArray(legacy.queue) ? legacy.queue : [];
    if (!legacyQueue.length) return null;
    var legacyIndex = Math.max(0, Math.min(legacyQueue.length - 1, Number(legacy.currentIdx) || 0));
    var legacyCurrent = legacyQueue[legacyIndex];
    if (!legacyCurrent) return null;
    return {
      version: 1,
      savedAt: Number(legacy.savedAt) || Date.now(),
      reason: 'main-playback-session-v1',
      currentIdx: legacyIndex,
      currentTime: 0,
      duration: playbackDurationFromSong(legacyCurrent),
      playing: false,
      playMode: legacy.playMode || 'loop',
      current: legacyCurrent,
      queue: legacyQueue,
    };
  } catch (e) {
    return null;
  }
}
function saveLastPlaybackSnapshot(force, reason) {
  var now = Date.now();
  if (!force && now - lastPlaybackSnapshotSavedAt < 2500) return;
  var song = currentCoverSong();
  if (!song) return;
  if (!audio && restoredLastPlaybackSnapshot && restoredLastPlaybackSnapshot.current && queueItemKey(song) === queueItemKey(restoredLastPlaybackSnapshot.current)) return;
  // 无论成功还是失败都推进节流时间戳，避免配额写入失败后紧密重试。
  lastPlaybackSnapshotSavedAt = now;
  var durationSec = getPlaybackDurationSeconds();
  var sourceQueue = Array.isArray(playQueue) ? playQueue : [];
  function payloadForQueue(queue, minimal) { return {
    version: 1,
    savedAt: now,
    reason: reason || '',
    currentIdx: currentIdx,
    currentTime: 0,
    duration: Math.max(0, Number(durationSec) || playbackDurationFromSong(song) || 0),
    playing: !!(audio && !audio.paused && !audio.ended),
    playMode: playMode || 'loop',
    current: playbackRestoreSongSnapshot(song),
    queue: queue
  }; }
  // 任何成功写入的快照都必须保留完整队列。普通字段超出配额时只缩减
  // 单曲字段，不缩短队列；两次都失败则保留上一次完整快照。
  var attempts = [
    { minimal: false },
    { minimal: true }
  ];
  for (var i = 0; i < attempts.length; i++) {
    try {
      var packed = sourceQueue.map(function (item) {
        return playbackRestoreSongSnapshot(item, attempts[i].minimal);
      }).filter(function (item) { return item && (item.id || item.mid || item.localKey || item.name); });
      var payload = payloadForQueue(packed, attempts[i].minimal);
      localStorage.setItem(LAST_PLAYBACK_STORE_KEY, JSON.stringify(payload));
      return;
    } catch (error) {
      if (i === attempts.length - 1) console.warn('[PlaybackSnapshotSave]', error);
    }
  }
}
function applyRestoredPlaybackProgressUi(snapshot) {
  snapshot = snapshot || {};
  var durationSec = Number(snapshot.duration) || playbackDurationFromSong(snapshot.current) || 0;
  setProgressVisual(0);
  var timeDisplay = document.getElementById('time-display');
  if (timeDisplay) timeDisplay.textContent = '0:00 / ' + (durationSec > 0 ? formatProgramTime(durationSec) : '0:00');
}
function hydrateLastPlaybackSnapshotQueue(snapshot) {
  snapshot = snapshot || {};
  if (!snapshot.current) return null;
  var current = hydrateCustomCover(Object.assign({}, snapshot.current));
  var queue = Array.isArray(snapshot.queue) ? snapshot.queue.map(function (song) {
    return hydrateCustomCover(Object.assign({}, song));
  }).filter(function (song) {
    return song && (song.id || song.mid || song.localKey || song.localPath || song.name);
  }) : [];
  if (!queue.length) queue = [current];
  var idx = Math.max(0, Math.min(queue.length - 1, Number(snapshot.currentIdx) || 0));
  if (!queue[idx] || queueItemKey(queue[idx]) !== queueItemKey(current)) {
    var found = -1;
    for (var i = 0; i < queue.length; i++) {
      if (queueItemKey(queue[i]) === queueItemKey(current)) { found = i; break; }
    }
    if (found >= 0) idx = found;
    else { queue.unshift(current); idx = 0; }
  }
  return { current: current, queue: queue, index: idx };
}
function restoreLastPlaybackSnapshot() {
  if (restoredLastPlaybackSnapshot) return false;
  var snapshot = readLastPlaybackSnapshot();
  if (!snapshot || !snapshot.current) return false;
  var restoredQueue = hydrateLastPlaybackSnapshotQueue(snapshot);
  if (!restoredQueue) return false;
  var current = restoredQueue.current;
  var isLocal = current.type === 'local' || !!current.localKey || current.localMissing;
  restoredLastPlaybackSnapshot = snapshot;
  startupRestoreHomePending = !startupAutoplayPreference;
  playQueue = restoredQueue.queue;
  currentIdx = restoredQueue.index;
  currentLocalSong = isLocal ? playQueue[currentIdx] : null;
  if (typeof applyRestoredPlayMode === 'function') applyRestoredPlayMode(snapshot.playMode);
  else if (snapshot.playMode) playMode = snapshot.playMode;
  var shownSong = currentCoverSong() || current;
  if (shownSong) {
    updateControlTrackInfo(shownSong);
    var titleEl = document.getElementById('thumb-title');
    var artistEl = document.getElementById('thumb-artist');
    if (titleEl) titleEl.textContent = shownSong.name || shownSong.title || '上一首';
    if (artistEl) artistEl.textContent = isLocal ? ((shownSong.artist || '本地文件') + ' · 正在恢复文件夹') : (shownSong.artist || songSourceLabel(shownSong));
    var thumbWrap = document.getElementById('thumb-wrap');
    if (thumbWrap) thumbWrap.classList.add('visible');
    var restoredCover = !isLocal && typeof songCoverSrc === 'function'
      ? songCoverSrc(shownSong, 400)
      : (!isLocal ? shownSong.cover : '');
    if (restoredCover) {
      setTimeout(function () {
        if (!audio && currentIdx >= 0 && playQueue[currentIdx] && queueItemKey(playQueue[currentIdx]) === queueItemKey(shownSong)) {
          loadCoverFromUrl(songCoverSrc(shownSong, 400), { deferHeavy: true, delay: 120, timeout: 700 });
        }
      }, 180);
    }
  }
  applyRestoredPlaybackProgressUi(snapshot);
  showRestoredPlaybackControls('restore');
  return true;
}
function canStartupAutoplayRestoredSnapshot() {
  if (!startupAutoplayPreference || startupAutoplayAttempted) return false;
  if (!restoredLastPlaybackSnapshot) return false;
  if (currentLocalSong && (!Array.isArray(playQueue) || !playQueue.length)) return false;
  return !!(Array.isArray(playQueue) && currentIdx >= 0 && playQueue[currentIdx]);
}
function isStartupAutoplayPlaying() {
  return !!(audio && audio.src && !audio.paused && !audio.ended);
}
function clearStartupAutoplayRetryTimer() {
  if (startupAutoplayRetryTimer) {
    clearTimeout(startupAutoplayRetryTimer);
    startupAutoplayRetryTimer = null;
  }
}
function restoreHomeAfterStartupAutoplayFallback() {
  startupRestoreHomePending = true;
  forcePlaybackControlsInteractive();
  showRestoredPlaybackControls('restore');
  updateEmptyHomeVisibility({ forceLoad: true });
}
function handleStartupAutoplayUnavailable(reason) {
  startupAutoplayJobId += 1;
  startupAutoplayAttemptCount = 0;
  startupAutoplayHomeFallbackTried = false;
  if ((reason === 'local-missing' || reason === 'queue-empty') && tryStartupAutoplayHomeFallback(startupAutoplayJobId)) return;
  restoreHomeAfterStartupAutoplayFallback();
}
function startupAutoplayUnavailableReason() {
  if (!startupAutoplayPreference || startupAutoplayAttempted) return '';
  if (!restoredLastPlaybackSnapshot) return '';
  if (currentLocalSong && (!Array.isArray(playQueue) || !playQueue.length)) return 'local-missing';
  if (!(Array.isArray(playQueue) && currentIdx >= 0 && playQueue[currentIdx])) return 'queue-empty';
  return '';
}
function startupAutoplayRetryDelay(attempt) {
  var delays = [80, 260, 620, 1100, 1800, 2800, 4200, 6200, 8800, 12000, 16000, 22000];
  return delays[Math.min(delays.length - 1, Math.max(0, attempt))];
}
function startupAutoplayNextPlayableIndex() {
  if (!Array.isArray(playQueue) || !playQueue.length) return -1;
  if (currentIdx < 0 || currentIdx >= playQueue.length) return 0;
  if (isQueueItemRecentlyPlaybackFailed(currentIdx) && playQueue.length > 1) {
    var nextIdx = nextUnblockedQueueIndex(currentIdx);
    if (nextIdx >= 0) return nextIdx;
  }
  return currentIdx;
}
function scheduleStartupAutoplayRetry(jobId, reason, delay) {
  clearStartupAutoplayRetryTimer();
  if (!startupAutoplayPreference || jobId !== startupAutoplayJobId) return false;
  if (isStartupAutoplayPlaying()) return true;
  startupAutoplayRetryTimer = setTimeout(function () {
    startupAutoplayRetryTimer = null;
    runStartupAutoplayAttempt(jobId, reason || 'retry');
  }, delay == null ? startupAutoplayRetryDelay(startupAutoplayAttemptCount) : delay);
  return true;
}
function tryStartupAutoplayHomeFallback(jobId) {
  if (startupAutoplayHomeFallbackTried) return false;
  if (!hasAnyPlatformLogin()) return false;
  startupAutoplayHomeFallbackTried = true;
  Promise.resolve().then(async function () {
    try {
      await waitForHomeDiscoverIdle(1800);
      if (!homeDiscoverState.loaded || (!homeDiscoverState.songs.length && !homeDiscoverState.loading)) {
        await loadHomeDiscover(true);
      }
      if (jobId !== startupAutoplayJobId || !startupAutoplayPreference || isStartupAutoplayPlaying()) return;
      if (!homeDiscoverState.songs.length) {
        restoreHomeAfterStartupAutoplayFallback();
        return;
      }
      playQueue = homeDiscoverState.songs.map(cloneSong);
      currentIdx = 0;
      currentLocalSong = null;
      startupRestoreHomePending = false;
      startupAutoplayAttemptCount = 0;
      safeRenderQueuePanel('startup-autoplay-home-fallback', { scrollCurrent: miniQueueOpen });
      safeShelfRebuild('startup-autoplay-home-fallback', true);
      forcePlaybackControlsInteractive();
      await playQueueAt(0, { manual: false, startupAutoplay: true });
      setTimeout(function () {
        if (jobId !== startupAutoplayJobId || !startupAutoplayPreference) return;
        if (isStartupAutoplayPlaying()) finishStartupAutoplayJob(true);
        else scheduleStartupAutoplayRetry(jobId, 'home-fallback-retry', 420);
      }, 360);
    } catch (e) {
      console.warn('[StartupAutoplayHomeFallback]', e);
      if (jobId === startupAutoplayJobId && startupAutoplayPreference && !isStartupAutoplayPlaying()) {
        restoreHomeAfterStartupAutoplayFallback();
      }
    }
  });
  return true;
}
function finishStartupAutoplayJob(success) {
  clearStartupAutoplayRetryTimer();
  if (success) {
    startupRestoreHomePending = false;
    forcePlaybackControlsInteractive();
    return;
  }
  if (tryStartupAutoplayHomeFallback(startupAutoplayJobId)) return;
  restoreHomeAfterStartupAutoplayFallback();
}
function runStartupAutoplayAttempt(jobId, reason) {
  if (!startupAutoplayPreference || jobId !== startupAutoplayJobId) return false;
  if (!restoredLastPlaybackSnapshot) return false;
  if (isStartupAutoplayPlaying()) {
    finishStartupAutoplayJob(true);
    return true;
  }
  var idx = startupAutoplayNextPlayableIndex();
  if (idx < 0) {
    finishStartupAutoplayJob(false);
    return false;
  }
  var retryLoadedAudio = !!(audio && audio.src && currentIdx === idx && startupAutoplayAttemptCount > 0 && !isQueueItemRecentlyPlaybackFailed(idx));
  startupAutoplayAttemptCount += 1;
  currentIdx = idx;
  showRestoredPlaybackControls('startup-autoplay');
  Promise.resolve(retryLoadedAudio ? playAudio({ silent: true, startupAutoplay: true }) : playQueueAt(idx, { manual: false, startupAutoplay: true }))
    .catch(function (e) { console.warn('[StartupAutoplay]', reason || 'startup', e); })
    .finally(function () {
      if (jobId !== startupAutoplayJobId || !startupAutoplayPreference) return;
      setTimeout(function () {
        if (jobId !== startupAutoplayJobId || !startupAutoplayPreference) return;
        if (isStartupAutoplayPlaying()) {
          finishStartupAutoplayJob(true);
          return;
        }
        if (startupAutoplayAttemptCount >= 12) {
          finishStartupAutoplayJob(false);
          return;
        }
        scheduleStartupAutoplayRetry(jobId, 'retry-after-' + reason);
      }, 260);
    });
  return true;
}
function isStartupHomeReadyForAutoplay() {
  if (startupHomeRevealReady) return true;
  return !(document.body && document.body.classList && document.body.classList.contains('splash-active'));
}
function queueStartupAutoplayAfterHomeReveal(reason) {
  if (!startupAutoplayPreference) return false;
  if (isStartupHomeReadyForAutoplay()) return scheduleStartupAutoplayFromSnapshot(reason || 'startup');
  startupAutoplayHomeQueuedReason = reason || 'startup';
  return true;
}
function flushStartupAutoplayAfterHomeReveal(reason, delay) {
  if (!startupAutoplayHomeQueuedReason || !startupAutoplayPreference) return false;
  if (!isStartupHomeReadyForAutoplay()) return false;
  var queuedReason = startupAutoplayHomeQueuedReason;
  startupAutoplayHomeQueuedReason = '';
  setTimeout(function () {
    if (!startupAutoplayPreference || startupAutoplayAttempted) return;
    scheduleStartupAutoplayFromSnapshot(queuedReason || reason || 'home-revealed');
  }, delay == null ? 120 : Math.max(0, Number(delay) || 0));
  return true;
}
function markStartupHomeReadyForAutoplay(reason, delay) {
  startupHomeRevealReady = true;
  flushStartupAutoplayAfterHomeReveal(reason || 'home-revealed', delay);
}
function scheduleStartupAutoplayFromSnapshot(reason) {
  if (!isStartupHomeReadyForAutoplay()) {
    startupAutoplayHomeQueuedReason = reason || 'startup';
    return true;
  }
  if (!canStartupAutoplayRestoredSnapshot()) {
    var unavailableReason = startupAutoplayUnavailableReason();
    if (unavailableReason) {
      startupAutoplayAttempted = true;
      handleStartupAutoplayUnavailable(unavailableReason);
    }
    return false;
  }
  clearStartupAutoplayRetryTimer();
  startupAutoplayJobId += 1;
  startupAutoplayAttemptCount = 0;
  startupAutoplayHomeFallbackTried = false;
  startupAutoplayAttempted = true;
  showRestoredPlaybackControls('startup-autoplay');
  scheduleStartupAutoplayRetry(
    startupAutoplayJobId,
    reason || 'startup',
    reason === 'login-status' ? 360 : (reason === 'setting-toggle' ? 40 : 900)
  );
  return true;
}
