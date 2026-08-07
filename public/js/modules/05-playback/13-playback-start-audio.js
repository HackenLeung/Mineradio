function playbackSameAlbumCover(prevSong, nextSong) {
  if (!prevSong || !nextSong) return false;
  var prevProvider = normalizePlaybackProvider(songProviderKey(prevSong));
  var nextProvider = normalizePlaybackProvider(songProviderKey(nextSong));
  if (prevProvider !== nextProvider) return false;
  var prevAlbum = prevSong.albumId || prevSong.album_id || prevSong.albumMid || prevSong.albummid || '';
  var nextAlbum = nextSong.albumId || nextSong.album_id || nextSong.albumMid || nextSong.albummid || '';
  if (!prevAlbum || String(prevAlbum) !== String(nextAlbum)) return false;
  var prevCover = String(prevSong.customCover || prevSong.cover || prevSong.picUrl || prevSong.albumCover || prevSong.coverUrl || '').trim();
  var nextCover = String(nextSong.customCover || nextSong.cover || nextSong.picUrl || nextSong.albumCover || nextSong.coverUrl || '').trim();
  return !!(prevCover && prevCover === nextCover);
}

var SMART_TRANSITION_HANDOFF_GAIN_SETTLE_MS = 180;

function qqPlaybackEvidenceQuery(song) {
  song = song || {};
  var vipRequired = !!(song.vipRequired || song.needVip || song.need_vip || song.onlyVipPlayable || song.only_vip_playable);
  if (!vipRequired && typeof songRequiresVip === 'function') {
    try { vipRequired = songRequiresVip(song); } catch (e) { vipRequired = false; }
  }
  return '&vipRequired=' + encodeURIComponent(vipRequired ? '1' : '') +
    '&needVip=' + encodeURIComponent(song.needVip || song.need_vip ? '1' : '') +
    '&onlyVipPlayable=' + encodeURIComponent(song.onlyVipPlayable || song.only_vip_playable ? '1' : '') +
    '&privilege=' + encodeURIComponent(song.privilege || song.Privilege || song.mediaPrivilege || song.media_privilege || '') +
    '&fee=' + encodeURIComponent(song.fee || song.Fee || '');
}

function neteasePlaybackMatchQuery(song, opts) {
  song = song || {};
  opts = opts || {};
  var excludeIds = Array.isArray(opts.excludeIds)
    ? opts.excludeIds.join(',')
    : String(opts.excludeIds || '');
  var artistId = song.artistId || song.artist_id || '';
  if (!artistId && Array.isArray(song.artists) && song.artists[0]) artistId = song.artists[0].id || '';
  if (!artistId && Array.isArray(song.ar) && song.ar[0]) artistId = song.ar[0].id || '';
  var artistRecords = Array.isArray(song.artists) && song.artists.length ? song.artists : (Array.isArray(song.ar) ? song.ar : []);
  var artistIds = artistRecords.map(function (artist) { return artist && artist.id || ''; }).filter(Boolean);
  var artistNames = artistRecords.map(function (artist) { return artist && artist.name || ''; }).filter(Boolean);
  if (!artistIds.length && artistId) artistIds = [artistId];
  if (!artistNames.length && (song.artist || song.artistName)) artistNames = [song.artist || song.artistName];
  var albumName = song.album || song.albumName || '';
  if (albumName && typeof albumName === 'object') albumName = albumName.name || '';
  return '&name=' + encodeURIComponent(song.name || song.title || '') +
    '&artist=' + encodeURIComponent(song.artist || song.artistName || '') +
    '&artistId=' + encodeURIComponent(artistId) +
    '&artistIds=' + encodeURIComponent(artistIds.join(',')) +
    '&artistNames=' + encodeURIComponent(artistNames.join('\u001f')) +
    '&album=' + encodeURIComponent(albumName) +
    '&duration=' + encodeURIComponent(song.durationMs || song.dt || song.duration || 0) +
    '&excludeIds=' + encodeURIComponent(excludeIds) +
    '&skipDirect=' + (opts.skipDirect ? '1' : '');
}

function clearNeteaseSourceMatchMetadata(song) {
  if (!song) return song;
  song.neteaseSourceMatched = false;
  song.resolvedNeteaseId = '';
  song.neteaseSourceMatchKind = '';
  song.neteaseSourceMatchScore = 0;
  song.neteaseSourceMatchAlbum = '';
  song.neteaseSourceMatchNotified = false;
  return song;
}

function applyNeteaseSourceMatchMetadata(song, data) {
  if (!song || !data || !data.sourceMatch) return song;
  song.neteaseSourceMatched = true;
  song.resolvedNeteaseId = data.resolvedNeteaseId || data.resolvedSongId || song.resolvedNeteaseId || '';
  song.neteaseSourceMatchKind = data.matchKind || 'netease_same_track_metadata';
  song.neteaseSourceMatchScore = Number(data.matchScore || 0) || 0;
  song.neteaseSourceMatchAlbum = data.matchedSong && data.matchedSong.album || '';
  song.playbackSource = data.source || 'netease-same-track';
  return song;
}

function neteaseSourceMatchTriedIds(data) {
  var tried = Array.isArray(data && data.sourceMatchTriedIds) ? data.sourceMatchTriedIds.slice() : [];
  var resolved = data && (data.resolvedNeteaseId || data.resolvedSongId);
  if (resolved && tried.map(String).indexOf(String(resolved)) < 0) tried.push(String(resolved));
  return tried.filter(Boolean).slice(0, 4);
}

async function retryNeteaseSourceMatchPlayback(song, data, idx, token, opts, requestedQuality) {
  if (!song || !data || !data.sourceMatch) return null;
  opts = opts || {};
  var sourceRecovery = typeof sourceFallbackRecoveryFromOptions === 'function'
    ? sourceFallbackRecoveryFromOptions(opts)
    : null;
  if (sourceRecovery && !sourceFallbackRecoveryCanContinue(sourceRecovery)) return null;
  var retryDepth = Math.max(0, Number(opts.neteaseSourceMatchRetryDepth) || 0);
  var triedIds = neteaseSourceMatchTriedIds(data);
  if (retryDepth >= 3 || triedIds.length >= 4) return null;
  var nextData = null;
  try {
    var nextDataPromise = apiJson(
      '/api/song/url?id=' + encodeURIComponent(song.id || '') +
      neteasePlaybackMatchQuery(song, { excludeIds: triedIds, skipDirect: true }) +
      '&quality=' + encodeURIComponent(requestedQuality),
      { timeoutMs: 10000 }
    );
    nextData = sourceRecovery
      ? await awaitSourceFallbackBudget(nextDataPromise, sourceRecovery)
      : await nextDataPromise;
  } catch (err) {
    console.warn('[NeteaseSourceMatch] next candidate lookup failed:', err);
    return token === trackSwitchToken ? null : false;
  }
  if (token !== trackSwitchToken) return false;
  if (sourceRecovery && (nextData === sourceFallbackBudgetTimeoutResult || !sourceFallbackRecoveryCanContinue(sourceRecovery))) return null;
  if (!nextData || !nextData.url || !nextData.sourceMatch) return null;
  var retryOpts = Object.assign({}, opts, {
    smartTransitionHandoff: false,
    smartTransitionMixed: false,
    preloadedAudio: null,
    preloadedData: null,
    preloadedProxyAudioUrl: '',
    preResolvedPlaybackData: nextData,
    neteaseSourceMatchRetryDepth: retryDepth + 1,
    qualityOverride: requestedQuality,
    suppressPlayFailureNotice: true,
  });
  var retryPromise = playQueueAt(idx, retryOpts);
  var retryToken = trackSwitchToken;
  var retryStarted = await retryPromise;
  if (retryToken !== trackSwitchToken) return false;
  return retryStarted === true;
}

async function playLocalQueueSong(song, idx, token, firstVisualPlay, opts, resumeAt) {
  opts = opts || {};
  var transitionHandoff = !!(opts.smartTransitionHandoff && opts.preloadedAudio);
  var transitionPreviousAudio = transitionHandoff ? audio : null;
  if (song && typeof ensureFreshLocalPlaybackUrl === 'function'
    && (!song.localUrl || (!song.customCover && !song.sidecarCover && !song.embeddedCover && !song.embeddedMediaParsed))) {
    await ensureFreshLocalPlaybackUrl(song);
  }
  if (!song || !song.localUrl) {
    showToast('本地文件已失效，请重新导入后继续');
    forcePlaybackControlsInteractive();
    return false;
  }
  currentLocalSong = song;
  playQueue[idx] = song;
  var localCover = typeof localLibraryCover === 'function' ? localLibraryCover(song) : (song.customCover || song.sidecarCover || song.embeddedCover || song.cover || '');
  if (localCover && !opts.coverCommitted) loadCoverFromUrl(localCover, { trackToken: token, deferHeavy: false, delay: 0, timeout: 500, seamlessTrackSwitch: !firstVisualPlay });
  updateCustomCoverButton();
  document.getElementById('trial-banner').classList.remove('show');
  if (transitionHandoff) {
    if (transitionPreviousAudio) transitionPreviousAudio.onended = null;
    audio = opts.preloadedAudio;
    if (typeof claimSmartTransitionPreparedAudioForPlayback === 'function') claimSmartTransitionPreparedAudioForPlayback(audio);
  } else if (!audio) { audio = new Audio(); audio.crossOrigin = 'anonymous'; }
  else {
    audioFadeSerial++;
    clearAudioFadeTimers();
    audio.pause();
  }
  var transitionAdoptedGain = transitionHandoff ? clampRange(Number(audio.volume) || 0, 0, 1) : 0;
  resetPlaybackAudioGraphForSourceSwitch('local-track-switch');
  audio.autoplay = true;
  audio.preload = 'auto';
  bindPlaybackProgressEvents(audio);
  if (transitionHandoff) setAudioOutputGainImmediate(transitionAdoptedGain);
  else applyVolumeToAudio();
  await applyAudioOutputDevice(audio);
  if (!transitionHandoff) audio.src = song.localUrl;
  audio.__mineradioQueueItemKey = queueItemKey(song);
  audio.__mineradioTrackSwitchToken = token;
  updatePlaybackProgressUi();
  lyricSunEnergy = 0; lyricSunTarget = 0; lyricSunHold = 0; lyricSunAvg = 0; lyricSunPeak = 0.55;
  audio.onended = function () {
    if (token !== trackSwitchToken) return;
    if (this && this.__mineradioSmartTransitionEndedRecoveryToken === token) return;
    if (typeof smartCrossfadeExecuting !== 'undefined' && smartCrossfadeExecuting) {
      if (typeof noteSmartCrossfadeOutgoingEnded === 'function') noteSmartCrossfadeOutgoingEnded(this, token, currentIdx);
      if (typeof recoverSmartCrossfadeEndedOutgoing === 'function' && smartTransitionActiveTransitionContext) {
        recoverSmartCrossfadeEndedOutgoing(smartTransitionPending, smartTransitionActiveTransitionContext, 'outgoing-ended');
      }
      return;
    }
    finalizeListenSession(true);
    if (playMode === 'single') setTimeout(function () { playQueueAt(currentIdx, { autoRepeat: true, suppressPlayFailureNotice: true }); }, 0);
    else setTimeout(nextTrack, 0);
  };
  audio.onloadedmetadata = function () {
    if (token !== trackSwitchToken || !currentLocalSong || currentLocalSong.localKey !== song.localKey) return;
    var duration = audio && isFinite(audio.duration) ? audio.duration : 0;
    currentLocalSong.duration = duration;
    if (playQueue[idx]) playQueue[idx].duration = duration;
    if (lyricSourceMode === 'custom') applyCustomLyricState(currentLocalSong, true);
    if (typeof resolveLocalOnlineMetadata === 'function') {
      resolveLocalOnlineMetadata(currentLocalSong, token).then(function () {
        if (token !== trackSwitchToken) return;
        var resolvedCover = typeof localLibraryCover === 'function' ? localLibraryCover(currentLocalSong) : currentLocalSong.cover;
        if (resolvedCover) loadCoverFromUrl(resolvedCover, { trackToken: token, deferHeavy: false, delay: 0, timeout: 500, seamlessTrackSwitch: true });
        fetchLyric(currentLocalSong, token);
      }).catch(function () { });
    }
    // 瘦身后的本地歌封面字段为空，需等本地库扫完按 localKey/localPath 现取。
    // 启动快照自动恢复常在扫库完成前播放，这里延迟补一次，避免封面永远空白。
    [900, 2600].forEach(function (delayMs) {
      setTimeout(function () {
        if (token !== trackSwitchToken || !currentLocalSong || currentLocalSong.localKey !== song.localKey) return;
        var retryCover = typeof localLibraryCover === 'function' ? localLibraryCover(currentLocalSong) : '';
        if (retryCover) loadCoverFromUrl(retryCover, { trackToken: token, deferHeavy: false, delay: 0, timeout: 500, seamlessTrackSwitch: true });
      }, delayMs);
    });
    safeRenderQueuePanel('local-metadata', { scrollCurrent: miniQueueOpen });
  };
  scheduleAudioResumePosition(audio, opts.resumeAt != null ? opts.resumeAt : resumeAt, token);
  if (!transitionHandoff) audio.load();
  currentBeatMap = null;
  beatMapNextIdx = 0;
  resetAudioVisualState();
  resetBeatCameraSync(0);
  cancelBeatAnalysisTimer();
  cancelDjBeatAnalysisTimer();
  beatMapToken++;
  djBeatMapToken++;
  resetDjBeatMapState();
  setDjModeActive(false);
  var playbackStarted = await playAudio({
    manual: !!opts.manual,
    silent: !!opts.startupAutoplay || !opts.manual,
    startupAutoplay: !!opts.startupAutoplay,
    trackSwitch: true,
    resumeRecovery: !!opts.resumeRecovery,
    preserveGain: transitionHandoff
  });
  if (!playbackStarted) {
    forcePlaybackControlsInteractive();
    if (opts.startupAutoplay) {
      return false;
    }
    if (!opts.suppressPlayFailureNotice) {
      if (opts.manual) showToast('播放启动失败，请重新选择本地音乐');
      else showSourceFallbackNotice('本地音乐已载入', '点击播放器中间的播放按钮继续播放。');
    }
    return false;
  }
  forcePlaybackControlsInteractive();
  beginListenSession(song, null);
  if (transitionHandoff && transitionPreviousAudio && transitionPreviousAudio !== audio) {
    setTimeout(function () {
      try {
        transitionPreviousAudio.pause();
        transitionPreviousAudio.removeAttribute('src');
        transitionPreviousAudio.load();
      } catch (_) { }
    }, 160);
  }
  if (typeof cancelPendingTrackFallbackLyrics === 'function') cancelPendingTrackFallbackLyrics();
  fetchLyric(song, token);
  safeRenderQueuePanel('play-local-queue', { scrollCurrent: miniQueueOpen });
  scheduleShelfRebuild('play-local-queue', true);
  setTimeout(function () {
    if (token === trackSwitchToken && currentLocalSong && currentLocalSong.localKey === song.localKey) {
      prepareLocalBeatAnalysis(currentLocalSong, song.localUrl);
    }
  }, firstVisualPlay ? 680 : 520);
  return true;
}

async function playQueueAt(idx, opts) {
  opts = opts || {};
  if (typeof beginSourceFallbackPlaybackInvocation === 'function' && !beginSourceFallbackPlaybackInvocation(opts)) return false;
  if (idx < 0 || idx >= playQueue.length) return false;
  if (typeof ensurePlaylistQueueHydratedAhead === 'function') ensurePlaylistQueueHydratedAhead(idx);
  var transitionHandoff = !!(opts.smartTransitionHandoff && opts.preloadedAudio && opts.preloadedData);
  var transitionMixed = !!(transitionHandoff && opts.smartTransitionMixed !== false);
  var transitionPreviousAudio = transitionHandoff ? audio : null;
  var transitionAdoptedGain = 0;
  var playbackMedia = null;
  var previousSongForTransition = currentIdx >= 0 && currentIdx < playQueue.length ? playQueue[currentIdx] : null;
  if (
    playMode === 'shuffle'
    && !opts.skipShuffleOrder
    && !opts.autoRepeat
    && !opts.qualitySwitch
    && !opts.resumeRecovery
    && !opts.fallbackDepth
    && typeof reorderQueueForShufflePlaybackOrder === 'function'
  ) {
    idx = reorderQueueForShufflePlaybackOrder(idx, { reason: 'shuffle-play-queue-at', renderPanel: false, rebuildShelf: false, persistSnapshot: false });
  }
  var qualitySwitch = !!opts.qualitySwitch;
  startupRestoreHomePending = false;
  markRenderInteraction(qualitySwitch ? 'quality-switch' : 'track-switch', qualitySwitch ? 520 : 1500);
  var playPhase = 'start';
  function markPlayPhase(name) { playPhase = name; }
  try {
    markPlayPhase('session-finalize');
    safePlaybackStep('session-finalize', function () { finalizeListenSession(false); });
    homeForcedOpen = false;
    if (!opts.preserveHomeState) homeSuppressed = false;
    currentIdx = idx;
    trackSwitchToken++;
    markPlayPhase('cancel-previous-track');
    cancelBeatAnalysisTimer();
    cancelBeatPrefetchTimer();
    if (typeof resetSmartCrossfade === 'function') {
      resetSmartCrossfade(opts.smartTransitionHandoff ? 'smart-transition-handoff' : 'track-switch', {
        preservePreparedAudio: !!opts.smartTransitionHandoff,
        preserveExecution: !!opts.smartTransitionHandoff
      });
    }
    if (localBeatAnalysis.active) cancelLocalBeatAnalysis();
    closeGsapModal(document.getElementById('local-beat-modal'));
    beatMapToken++;
    var token = trackSwitchToken;
    function playbackInvocationStillCurrent(media) {
      return !!(media && token === trackSwitchToken && currentIdx === idx && audio === media);
    }
    function disposeStalePlaybackInvocationMedia(media) {
      if (!media || media === audio) return;
      try {
        media.pause();
        media.removeAttribute('src');
        media.load();
      } catch (e) { }
    }
    var firstVisualPlay = !firstPlayDone;
    markPlayPhase('track-setup');
    var song = safePlaybackStep('hydrate-song', function () { return hydrateCustomCover(playQueue[idx]); }) || playQueue[idx];
    playQueue[idx] = song;
    var sameAlbumCoverSwitch = playbackSameAlbumCover(previousSongForTransition, song);
    var earlyLyricFetchStarted = false;
    function startTrackLyricFetch() {
      if (earlyLyricFetchStarted) return false;
      if (!song || song.type === 'podcast' || song.type === 'local' || song.source === 'local' || song.localUrl) return false;
      if (typeof fetchLyric !== 'function') return false;
      earlyLyricFetchStarted = true;
      setTimeout(function () {
        if (token === trackSwitchToken) fetchLyric(song, token);
      }, 0);
      return true;
    }
    var requestedResumeAt = Math.max(0, Number(opts.resumeAt) || 0);
    var isRemotePlaybackSong = !(song && (song.type === 'local' || song.source === 'local' || song.localUrl));
    // A remote mid-track recovery starts with a thin range buffer around the requested position.
    // Keep whole-track analysis, next-track beat prefetch, and B-deck preload
    // out of that window so they cannot starve the resumed stream.
    var onlineBackgroundAudioDeferUntil = isRemotePlaybackSong && !transitionHandoff && requestedResumeAt >= 0.35
      ? Date.now() + 45000
      : 0;
    function onlineBackgroundAudioDelay(baseDelayMs) {
      return Math.max(Math.max(0, Number(baseDelayMs) || 0), onlineBackgroundAudioDeferUntil - Date.now());
    }
    function onlineSmartTransitionPrepareDelay(baseDelayMs) {
      var delayedMs = onlineBackgroundAudioDelay(baseDelayMs);
      if (!onlineBackgroundAudioDeferUntil || !audio) return delayedMs;
      var durationSec = Number(audio.duration) || 0;
      var positionSec = Number(audio.currentTime) || requestedResumeAt;
      if (!isFinite(durationSec) || durationSec <= positionSec) return delayedMs;
      var fadeLeadSec = Math.min(7.6, Math.max(4.2, durationSec * 0.045));
      // Keep about ten seconds to resolve lyrics/source and buffer B before
      // the fade trigger. A near-end recovery therefore prepares promptly,
      // while an ordinary mid-track recovery still gets its quiet 45s window.
      var latestUsefulMs = Math.max(600, (durationSec - positionSec - fadeLeadSec - 10) * 1000);
      return Math.min(delayedMs, latestUsefulMs);
    }
    var playbackContext = opts.context || (song && song.radioContext) || null;
    activeRadioContext = playbackContext || null;
    safeRenderQueuePanel('play-queue-at-switch', { scrollCurrent: miniQueueOpen });
    safePlaybackStep('shelf-preview-suppress', suppressShelfPreviewForPlaybackSwitch);
    if (!transitionHandoff) pauseCurrentAudioForTrackSwitch();
    else {
      playToggleBusy = false;
      forcePlaybackControlsInteractive();
    }
    var bmKey = safePlaybackStep('beatmap-key', function () { return beatMapSongKey(song); }) || '';
    var podcastDjMode = !!safePlaybackStep('podcast-mode', function () { return isPodcastSong(song); });
    safePlaybackStep('dj-mode', function () { setDjModeActive(podcastDjMode, song); });
    safePlaybackStep('visual-switch', switchPlaybackVisualToEmily);
    currentLocalSong = null;
    safePlaybackStep('cover-button', updateCustomCoverButton);
    safePlaybackStep('like-buttons', function () { updateLikeButtons(song); });
    safePlaybackStep('comment-button', function () { if (typeof updateCommentButtonForSong === 'function') updateCommentButtonForSong(song); });
    safePlaybackStep('like-status', function () { syncLikeStatusForSong(song); });
    safePlaybackStep('cinema-track-profile', function () { if (!qualitySwitch) resetCinemaTrackProfile(song); });
    safePlaybackStep('empty-home', function () { if (!opts.preserveHomeState) updateEmptyHomeVisibility(); });
    safePlaybackStep('track-ui', function () {
      document.getElementById('hint').classList.add('hidden');
      document.getElementById('thumb-title').textContent = song.name;
      document.getElementById('thumb-artist').textContent = song.artist;
      updateControlTrackInfo(song);
      document.getElementById('thumb-wrap').classList.add('visible');
    });
    markPlayPhase('lyric-prep');
    safePlaybackStep('lyric-prep', function () {
      if (qualitySwitch) {
        if (typeof cancelPendingTrackFallbackLyrics === 'function') cancelPendingTrackFallbackLyrics();
        if (typeof markStageLyricsPlaybackResume === 'function') markStageLyricsPlaybackResume('quality-switch-preserve-lyrics');
        applyPreferredLyricsForCurrent(true);
      } else {
        if (typeof resetLyricsForTrackSwitch === 'function') resetLyricsForTrackSwitch(song, token);
        else {
          var initialLyricLines = withLyricFallback([]);
          setOriginalLyricsState(initialLyricLines, false, 'fallback');
          applyPreferredLyricsForCurrent(true);
        }
        startTrackLyricFetch();
        if (typeof scheduleTrackSwitchFallbackLyrics === 'function') scheduleTrackSwitchFallbackLyrics(song, token, 1500);
      }
    });

    markPlayPhase('cover-load');
    safePlaybackStep('cover-load', function () {
      if (qualitySwitch || opts.coverCommitted) return;
      var customCover = getCustomCoverForSong(song);
      var coverOpts = {
        trackToken: token,
        deferHeavy: true,
        delay: firstVisualPlay ? 320 : (sameAlbumCoverSwitch ? 80 : 520),
        timeout: firstVisualPlay ? 1300 : 1700,
        seamlessTrackSwitch: !firstVisualPlay,
        noCoverTransition: sameAlbumCoverSwitch,
        colorMixDuration: sameAlbumCoverSwitch ? 1 : undefined
      };
      if (customCover) applyCoverDataUrl(customCover, coverOpts);
      else loadCoverFromUrl(song.cover ? coverUrlWithSize(song.cover, 400) : '', coverOpts);
    });
    safePlaybackStep('trial-banner-reset', function () { document.getElementById('trial-banner').classList.remove('show'); });
    if (song.type === 'local' || song.source === 'local' || song.localUrl) {
      markPlayPhase('local-audio');
      var localStarted = await playLocalQueueSong(song, idx, token, firstVisualPlay, opts, requestedResumeAt);
      if (localStarted === true && typeof completeSourceFallbackRecovery === 'function') {
        completeSourceFallbackRecovery(sourceFallbackRecoveryFromOptions(opts));
      }
      return localStarted === true;
    }
    safePlaybackStep('show-loading', function () { showLoading({ trackSwitch: true, seamlessCover: true }); });
    if (!qualitySwitch) lyricSunEnergy = 0; lyricSunTarget = 0; lyricSunHold = 0; lyricSunAvg = 0; lyricSunPeak = 0.55;

    // 首次播放: 粒子从暗处浮出 (Apple 风格)
    if (firstVisualPlay) {
      safePlaybackStep('first-visual-alpha', function () {
        firstPlayDone = true;
        tweenParticleAlpha(uniforms.uAlpha.value || 0, 1.0, 220);
      });
    }

    try {
      markPlayPhase('source-url');
      var playbackProvider = normalizePlaybackProvider(songProviderKey(song));
      var isQQPlayback = playbackProvider === 'qq';
      var isKugouPlayback = playbackProvider === 'kugou';


      var requestedQuality = normalizePlaybackQualityForProvider(opts.qualityOverride || getProviderPlaybackQuality(playbackProvider), playbackProvider);
      if (playbackProvider === 'netease' && requestedQuality === 'jymaster' && !hasProviderSvip('netease', loginStatus)) requestedQuality = 'hires';
      var runtimeQualityCap = playbackQualityCapValue(song, playbackProvider);
      if (playbackQualityAboveCap(requestedQuality, playbackProvider, runtimeQualityCap)) {
        requestedQuality = runtimeQualityCap;
      }
      var qualityParam = '&quality=' + encodeURIComponent(requestedQuality);
      var data;
      if (transitionHandoff) {
        data = opts.preloadedData;
      } else if (opts.preResolvedPlaybackData && opts.preResolvedPlaybackData.url) {
        data = opts.preResolvedPlaybackData;
      } else if (isQQPlayback) {
        data = await apiJson('/api/qq/song/url?mid=' + encodeURIComponent(song.mid || song.songmid || song.id || '') + '&mediaMid=' + encodeURIComponent(song.mediaMid || song.media_mid || '') + qqPlaybackEvidenceQuery(song) + qualityParam, { timeoutMs: 15000 });
      } else if (isKugouPlayback) {
        data = await apiJson('/api/kugou/song/url?hash=' + encodeURIComponent(song.hash || song.fileHash || song.audioHash || song.id || '') +
          '&albumId=' + encodeURIComponent(song.albumId || song.album_id || '') +
          '&albumAudioId=' + encodeURIComponent(song.albumAudioId || song.album_audio_id || song.mixSongId || '') +
          '&mixSongId=' + encodeURIComponent(song.mixSongId || '') +
          '&hqHash=' + encodeURIComponent(song.hqHash || song.hq_hash || '') +
          '&sqHash=' + encodeURIComponent(song.sqHash || song.sq_hash || '') +
          '&resHash=' + encodeURIComponent(song.resHash || song.res_hash || '') +
          '&vipRequired=' + encodeURIComponent(song.vipRequired || song.needVip || song.onlyVipPlayable || song.only_vip_playable ? '1' : '') +
          '&privilege=' + encodeURIComponent(song.privilege || song.Privilege || song.mediaPrivilege || song.media_privilege || '') +
          '&fee=' + encodeURIComponent(song.fee || song.Fee || '') +
          qualityParam, { timeoutMs: 9000 });
      } else {
        data = await apiJson('/api/song/url?id=' + encodeURIComponent(song.id || '') + neteasePlaybackMatchQuery(song) + qualityParam, { timeoutMs: 14000 });
      }
      if (token !== trackSwitchToken) return;
      if (
        typeof sourceFallbackRecoveryFromOptions === 'function'
        && sourceFallbackRecoveryFromOptions(opts)
        && !sourceFallbackRecoveryCanContinue(sourceFallbackRecoveryFromOptions(opts))
      ) {
        return settleExpiredSourceFallbackPlayback(idx, token, opts);
      }
      if (data) {
        song.resolvedPlaybackProvider = playbackProvider;
        song.playbackLevel = data.level || song.playbackLevel || '';
        if (!data.sourceMatch) song.playbackSource = data.source || data.provider || song.playbackSource || '';
        if (playbackProvider === 'netease' && !data.sourceMatch) clearNeteaseSourceMatchMetadata(song);
        song.trial = !!(song.trial || data.trial);
        song.vipRequired = !!(
          song.vipRequired ||
          data.trial ||
          data.needVip ||
          data.need_vip ||
          data.vipRequired ||
          data.onlyVipPlayable ||
          data.only_vip_playable ||
          (data.restriction && /vip_required|paid_required|trial_only|need_vip|only_vip/i.test(String(data.restriction.category || data.restriction.reason || data.restriction.message || ''))) ||
          /vip_required|paid_required|trial_only|need_vip|only_vip/i.test(String(data.category || data.reason || data.error || data.message || '')) ||
          (typeof songRequiresVip === 'function' && songRequiresVip(Object.assign({}, song, data)))
        );
        if (typeof updateControlTrackInfo === 'function') updateControlTrackInfo(song);
        if (isKugouPlayback && typeof applyKugouPlaybackStatusEvidence === 'function') applyKugouPlaybackStatusEvidence(data);
        if (isQQPlayback && typeof applyQQPlaybackStatusEvidence === 'function') applyQQPlaybackStatusEvidence(data, song);
      }
      var retryPlaybackOpts = Object.assign({}, opts);
      if (opts.resumeAt != null) retryPlaybackOpts.resumeAt = requestedResumeAt;
      if (!data || !data.url) {
        var fallbackResult = await tryAutoPlaybackFallback(song, data, idx, token, retryPlaybackOpts);
        if (fallbackResult !== null) return fallbackResult === true;
        if (opts.startupAutoplay) {
          markQueueItemPlaybackFailed(idx);
          return false;
        }
        handlePlaybackUnavailable(song, data);
        return false;
      }
      var resolvedQualityText = playbackResolvedQualityText(data, playbackProvider);
      var qualityDowngraded = !!(data && data.level && playbackQualityWasDowngraded(requestedQuality, data.level, playbackProvider));
      if (qualityDowngraded) markPlaybackQualityRuntimeCap(song, playbackProvider, data.level, 'resolved-lower');
      if (!opts.startupAutoplay && !isQQPlayback && qualityDowngraded) {
        showSourceFallbackNotice((isKugouPlayback ? '小狗' : '小云') + '音质自动降级', '请求 ' + playbackQualityLabel(requestedQuality, playbackProvider) + '，实际播放 ' + resolvedQualityText + '。');
      } else if (!opts.startupAutoplay && opts.qualitySwitch) {
        showSourceFallbackNotice('音质已切换', '实际播放: ' + resolvedQualityText + '。');
      }
      if (data.trial) {
        var txt;
        if (data.loggedIn && data.vipLevel === 'svip') txt = '此歌曲需要单曲、专辑购买或更高权限';
        else if (data.loggedIn && data.vipLevel === 'vip') txt = '此歌曲需要 SVIP 或购买 · 当前仅播放试听片段';
        else if (data.loggedIn) txt = '此歌曲需 VIP · 当前仅播放试听片段';
        else txt = '当前未登录 · 仅播放试听片段';
        document.getElementById('trial-text').textContent = txt;
        var trialLoginBtn = document.getElementById('trial-login-btn');
        if (trialLoginBtn) {
          trialLoginBtn.style.display = data.loggedIn ? 'none' : '';
          trialLoginBtn.onclick = function () { openProviderLogin(playbackProvider); };
        }
        document.getElementById('trial-banner').classList.add('show');
      }
      markPlayPhase('audio-element');
      var proxyAudioUrl = opts.preloadedProxyAudioUrl || '/api/audio?url=' + encodeURIComponent(data.url);
      if (transitionHandoff) {
        audioFadeSerial++;
        clearAudioFadeTimers();
        if (transitionPreviousAudio) transitionPreviousAudio.onended = null;
        audio = opts.preloadedAudio;
        if (typeof claimSmartTransitionPreparedAudioForPlayback === 'function') {
          claimSmartTransitionPreparedAudioForPlayback(audio);
        }
        var preparedGraphGain = audio.__mineradioPreparedAudioGraph && audio.__mineradioPreparedAudioGraph.gainNode
          ? Number(audio.__mineradioPreparedAudioGraph.gainNode.gain.value)
          : NaN;
        transitionAdoptedGain = transitionMixed
          ? clampRange(isFinite(preparedGraphGain) ? preparedGraphGain : (Number(audio.volume) || 0), 0, 1)
          : audioSilentFloor();
        audio.crossOrigin = 'anonymous';
        audio.autoplay = true;
        audio.preload = 'auto';
        if (!audio.src) audio.src = proxyAudioUrl;
        if (!transitionMixed) audio.volume = 0;
        else audio.muted = false;
      } else if (!audio) {
        audio = new Audio();
        audio.crossOrigin = 'anonymous';
      } else {
        audioFadeSerial++;
        clearAudioFadeTimers();
        audio.pause();
      }
      resetPlaybackAudioGraphForSourceSwitch(transitionHandoff ? 'smart-transition-handoff' : 'track-switch');
      audio.autoplay = true;
      audio.preload = 'auto';
      // resetPlaybackAudioGraphForSourceSwitch may deliberately replace a
      // capture-backed element before a new src is assigned. Capture the
      // expected media only after that lifetime reset so playAudio never holds
      // a stale, already-paused element reference.
      playbackMedia = audio;
      bindPlaybackProgressEvents(audio);
      if (transitionHandoff) setAudioOutputGainImmediate(transitionMixed ? transitionAdoptedGain : audioSilentFloor());
      else applyVolumeToAudio();
      await applyAudioOutputDevice(playbackMedia);
      if (!playbackInvocationStillCurrent(playbackMedia)) {
        disposeStalePlaybackInvocationMedia(playbackMedia);
        return false;
      }
      if (
        typeof sourceFallbackRecoveryFromOptions === 'function'
        && sourceFallbackRecoveryFromOptions(opts)
        && !sourceFallbackRecoveryCanContinue(sourceFallbackRecoveryFromOptions(opts))
      ) {
        return settleExpiredSourceFallbackPlayback(idx, token, opts);
      }
      if (!transitionHandoff) audio.src = proxyAudioUrl;
      audio.__mineradioQueueItemKey = queueItemKey(song);
      audio.__mineradioTrackSwitchToken = token;
      if (typeof clearRecoverableNetworkPlaybackStall === 'function') clearRecoverableNetworkPlaybackStall(audio);
      updatePlaybackProgressUi();
      audio.onended = function () {
        if (token !== trackSwitchToken) return;
        if (this && this.__mineradioSmartTransitionEndedRecoveryToken === token) return;
        if (typeof smartCrossfadeExecuting !== 'undefined' && smartCrossfadeExecuting) {
          if (typeof noteSmartCrossfadeOutgoingEnded === 'function') noteSmartCrossfadeOutgoingEnded(this, token, currentIdx);
          if (typeof recoverSmartCrossfadeEndedOutgoing === 'function' && smartTransitionActiveTransitionContext) {
            recoverSmartCrossfadeEndedOutgoing(smartTransitionPending, smartTransitionActiveTransitionContext, 'outgoing-ended');
          }
          return;
        }
        finalizeListenSession(true);
        if (playMode === 'single') setTimeout(function () { playQueueAt(currentIdx, { autoRepeat: true, suppressPlayFailureNotice: true }); }, 0);
        else setTimeout(nextTrack, 0);
      };
      scheduleAudioResumePosition(audio, requestedResumeAt, token);
      if (!transitionHandoff) audio.load();
      markPlayPhase(qualitySwitch ? 'visual-prep-skip' : 'visual-prep');
      if (qualitySwitch) {
        if (typeof markStageLyricsPlaybackResume === 'function') markStageLyricsPlaybackResume('quality-switch-audio-ready');
      } else try {
        // 重置 beatmap 状态
        currentBeatMap = null;
        beatMapNextIdx = 0;
        resetAudioVisualState({ preserveEnvelope: transitionMixed });
        resetBeatCameraSync(audio && isFinite(audio.currentTime) ? audio.currentTime : 0, { preserveMomentum: transitionMixed });
        cancelBeatAnalysisTimer();
        beatMapToken++;
        var bmTok = beatMapToken;
        if (podcastDjMode) {
          // 播客走独立 DJ 离线锁拍系统, 不写入普通歌曲 beatMap.
          djBeatMapToken++;
          cancelDjBeatAnalysisTimer();
          resetDjBeatMapState();
          currentBeatMap = null;
          beatMapNextIdx = 0;
          var djTok = djBeatMapToken;
          var djKey = djSongKey(song);
          if (djBeatMapCache[djKey]) {
            currentDjBeatMap = djBeatMapCache[djKey];
            applyPodcastDjProfileFromMap(currentDjBeatMap);
            syncPodcastDjMapCursor(audio ? audio.currentTime : 0, true);
            hideBeatChip();
            notifyDesktopLyricsBeatMapReady();
            console.log('podcast DJ beatmap 缓存命中:', currentDjBeatMap.cameraBeats.length, '个主拍');
          } else {
            showBeatChip('DJ 离线锁拍准备中…');
            var djDurationSec = Math.max(0, Number(song.duration) || 0);
            if (djDurationSec > 10000) djDurationSec /= 1000;
            schedulePodcastDjAnalysis(djKey, data.url, djTok, djDurationSec);
          }
          maybeAnnounceDjMode();
        } else if (bmKey && beatMapCache[bmKey]) {
          // 如果缓存有, 直接用
          currentBeatMap = beatMapCache[bmKey];
          applyCinemaProfileFromBeatMap(currentBeatMap);
          syncBeatMapPlaybackCursor(audio ? audio.currentTime : 0, transitionMixed);
          notifyDesktopLyricsBeatMapReady();
          console.log('beatmap 缓存命中:', currentBeatMap.kicks.length, '个鼓点');
          scheduleQueueBeatPrefetch(idx, onlineBackgroundAudioDelay(2600));
        } else {
          var diskBeatMap = bmKey ? await readBeatDiskCache(bmKey) : null;
          if (!playbackInvocationStillCurrent(playbackMedia)) {
            disposeStalePlaybackInvocationMedia(playbackMedia);
            return false;
          }
          if (diskBeatMap) {
            currentBeatMap = diskBeatMap;
            applyCinemaProfileFromBeatMap(currentBeatMap);
            syncBeatMapPlaybackCursor(audio ? audio.currentTime : 0, transitionMixed);
            notifyDesktopLyricsBeatMapReady();
            console.log('beatmap D盘缓存命中:', currentBeatMap.kicks.length, '个鼓点');
            scheduleQueueBeatPrefetch(idx, onlineBackgroundAudioDelay(2600));
          } else {
            // 后台延迟分析, 避免新歌刚开始播放时抢占解码和渲染资源
            scheduleBeatAnalysis(bmKey || song.id, proxyAudioUrl, bmTok, song);
          }
        }
      } catch (visualErr) {
        console.warn('[PlaybackVisualPrep]', song && song.name, visualErr);
        currentBeatMap = null;
        beatMapNextIdx = 0;
        safePlaybackStep('visual-prep-hide-chip', hideBeatChip);
      }
      markPlayPhase('audio-start');
      if (!playbackInvocationStillCurrent(playbackMedia)) return false;
      var playbackStarted = await playAudio({ manual: !!opts.manual, silent: isQQPlayback || !!opts.startupAutoplay || !opts.manual, startupAutoplay: !!opts.startupAutoplay, trackSwitch: true, resumeRecovery: !!opts.resumeRecovery, preserveGain: transitionMixed, expectedMedia: playbackMedia, expectedToken: token });
      // A confirmed frozen media clock may require a clean Audio element. The
      // retry keeps the same token/key, so adopt only that deliberate rebuild;
      // any other replacement is still a stale invocation and must be ignored.
      // This must also run when the start failed: otherwise the swapped-in
      // element makes the invocation look stale and the whole failure chain
      // below (source match retry, provider fallback, skip) is skipped.
      if (
        audio
        && audio !== playbackMedia
        && Number(audio.__mineradioTrackSwitchToken) === Number(token)
        && String(audio.__mineradioQueueItemKey || '') === String(queueItemKey(song) || '')
      ) playbackMedia = audio;
      if (!playbackInvocationStillCurrent(playbackMedia)) return false;
      if (
        typeof sourceFallbackRecoveryFromOptions === 'function'
        && sourceFallbackRecoveryFromOptions(opts)
        && !sourceFallbackRecoveryCanContinue(sourceFallbackRecoveryFromOptions(opts))
      ) {
        return settleExpiredSourceFallbackPlayback(idx, token, opts);
      }
      if (!playbackStarted) {
        if (
          typeof playbackMediaHasRecoverableNetworkStall === 'function'
          && playbackMediaHasRecoverableNetworkStall(playbackMedia, token)
        ) {
          // This is a transient proxy/CDN starvation, not proof that the song
          // or provider is unavailable. Keep the source and pending seek for a
          // manual retry instead of scanning the queue and clearing ownership.
          forcePlaybackControlsInteractive();
          return false;
        }
        if (playbackProvider === 'netease' && data && data.sourceMatch) {
          var sameSourceRetry = await retryNeteaseSourceMatchPlayback(song, data, idx, token, retryPlaybackOpts, requestedQuality);
          if (sameSourceRetry !== null) return sameSourceRetry === true;
          var matchedPlaybackFallback = await tryAutoPlaybackFallback(song, Object.assign({}, data, { url: null, reason: 'media_start_failed' }), idx, token, retryPlaybackOpts);
          if (matchedPlaybackFallback !== null) return matchedPlaybackFallback === true;
        }
        if (isQQPlayback) {
          var qqRetryStarted = await retryQQPlaybackWithCompatibleQuality(song, idx, token, retryPlaybackOpts, data, requestedQuality);
          if (token !== trackSwitchToken) return qqRetryStarted === true;
          if (qqRetryStarted) return true;
        }
        var mediaFailureRecovery = typeof sourceFallbackRecoveryFromOptions === 'function'
          ? sourceFallbackRecoveryFromOptions(retryPlaybackOpts)
          : null;
        if (!opts.manual && (!opts.startupAutoplay || mediaFailureRecovery)) {
          var mediaFailureFallback = await tryAutoPlaybackFallback(
            song,
            Object.assign({}, data || {}, { url: null, reason: 'media_start_failed' }),
            idx,
            token,
            retryPlaybackOpts
          );
          if (mediaFailureFallback !== null) return mediaFailureFallback === true;
          if (mediaFailureRecovery) {
            return await skipFailedQueueItem(
              idx,
              token,
              '当前歌曲无法启动播放，正在尝试队列里的下一首。',
              sourceFallbackRecoveryFailureOptions(retryPlaybackOpts)
            );
          }
        }
        forcePlaybackControlsInteractive();
        if (opts.startupAutoplay && !mediaFailureRecovery) {
          return false;
        }
        if (!opts.suppressPlayFailureNotice) {
          if (opts.manual) {
            showToast('播放启动失败，请重新选择歌曲');
          } else {
            showSourceFallbackNotice('歌曲已载入', '点击播放器中间的播放按钮继续播放。');
          }
        }
        return false;
      }
      forcePlaybackControlsInteractive();
      if (playbackProvider === 'netease' && data && data.sourceMatch) {
        applyNeteaseSourceMatchMetadata(song, data);
        if (typeof updateControlTrackInfo === 'function') updateControlTrackInfo(song);
      }
      if (!opts.startupAutoplay && !opts.qualitySwitch && data && data.sourceMatch && !song.neteaseSourceMatchNotified && typeof showSourceFallbackNotice === 'function') {
        song.neteaseSourceMatchNotified = true;
        showSourceFallbackNotice('小云已匹配可播音源', '已在小云内切换到同一首歌的可播版本；歌词、封面、专辑和队列仍保持原曲。');
      }
      if (transitionHandoff && transitionMixed && typeof rampAudioOutputGain === 'function') {
        rampAudioOutputGain(targetVolume, SMART_TRANSITION_HANDOFF_GAIN_SETTLE_MS);
      }
      if (transitionHandoff && transitionPreviousAudio && transitionPreviousAudio !== audio) {
        setTimeout(function () {
          try {
            transitionPreviousAudio.pause();
            transitionPreviousAudio.removeAttribute('src');
            transitionPreviousAudio.load();
          } catch (e) { }
        }, 220);
      }
      markPlayPhase('session-begin');
      safePlaybackStep('listen-session-begin', function () { beginListenSession(song, playbackContext); });
      markPlayPhase('lyrics-fetch');
      if (song.type === 'podcast') {
        if (typeof cancelPendingTrackFallbackLyrics === 'function') cancelPendingTrackFallbackLyrics();
        safePlaybackStep('podcast-lyrics', function () {
          var podcastLyricLines = withLyricFallback([]);
          setOriginalLyricsState(podcastLyricLines, false, 'fallback');
          applyPreferredLyricsForCurrent(true);
        });
      } else if (!qualitySwitch) {
        if (!earlyLyricFetchStarted) fetchLyric(song, token);
      } else {
        if (typeof cancelPendingTrackFallbackLyrics === 'function') cancelPendingTrackFallbackLyrics();
        if (typeof markStageLyricsPlaybackResume === 'function') markStageLyricsPlaybackResume('quality-switch-lyrics-kept');
      }
      if (!qualitySwitch) {
        safeRenderQueuePanel('play-queue-at');
        scheduleShelfRebuild('play-queue-at', true);
        if (typeof scheduleQueueLyricPrefetch === 'function') scheduleQueueLyricPrefetch(idx, 2400);
      }
      if (!qualitySwitch && typeof scheduleSmartCrossfadePrepare === 'function') {
        var smartTransitionPrepareDelay = typeof smartCrossfadePostSwitchDelay === 'function'
          ? smartCrossfadePostSwitchDelay(!!opts.smartTransitionHandoff)
          : 4200;
        smartTransitionPrepareDelay = onlineSmartTransitionPrepareDelay(smartTransitionPrepareDelay);
        scheduleSmartCrossfadePrepare(token, idx, smartTransitionPrepareDelay);
      }
      safePlaybackStep('shelf-preview-suppress-end', suppressShelfPreviewForPlaybackSwitch);
      if (typeof completeSourceFallbackRecovery === 'function') {
        completeSourceFallbackRecovery(sourceFallbackRecoveryFromOptions(opts));
      }
      return true;
    } catch (err) {
      console.error('Play failed:', { phase: playPhase, error: err }, err);
      hideLoading();
      forcePlaybackControlsInteractive();
      var catchRecovery = typeof sourceFallbackRecoveryFromOptions === 'function'
        ? sourceFallbackRecoveryFromOptions(opts)
        : null;
      if (opts.startupAutoplay && !catchRecovery) {
        return false;
      }
      if (catchRecovery && opts.fallbackDepth > 0) return false;
      if (!isPlaybackRecursionError(err) && token === trackSwitchToken && !opts.manual && (catchRecovery || playQueue.length > 1)) {
        return await skipFailedQueueItem(
          idx,
          token,
          '当前歌曲加载失败，正在尝试队列里的下一首。',
          catchRecovery ? sourceFallbackRecoveryFailureOptions(opts) : { playbackOpts: opts }
        );
      }
      if (opts.suppressPlayFailureNotice) return false;
      var failText = playbackFailureToastText(err);
      showToast(failText);
      if (typeof showSourceFallbackNotice === 'function') showSourceFallbackNotice('播放失败', failText);
      return false;
    }
  } catch (setupErr) {
    console.error('Play setup failed:', { phase: playPhase, error: setupErr }, setupErr);
    hideLoading();
    forcePlaybackControlsInteractive();
    var setupRecovery = typeof sourceFallbackRecoveryFromOptions === 'function'
      ? sourceFallbackRecoveryFromOptions(opts)
      : null;
    if (opts.startupAutoplay && !setupRecovery) {
      return false;
    }
    if (setupRecovery && opts.fallbackDepth > 0) return false;
      if (!isPlaybackRecursionError(setupErr) && typeof token !== 'undefined' && token === trackSwitchToken && !opts.manual && (setupRecovery || playQueue.length > 1)) {
        return await skipFailedQueueItem(
          idx,
          token,
          '当前歌曲切换失败，正在尝试队列里的下一首。',
          setupRecovery ? sourceFallbackRecoveryFailureOptions(opts) : { playbackOpts: opts }
        );
    }
    if (opts.suppressPlayFailureNotice) return false;
    var setupFailText = playbackFailureToastText(setupErr);
    showToast(setupFailText);
    if (typeof showSourceFallbackNotice === 'function') showSourceFallbackNotice('播放失败', setupFailText);
    return false;
  }
}
