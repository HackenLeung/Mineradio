var SMART_TRANSITION_STORE_KEY = 'mineradio-smart-transition-v2';
var SMART_TRANSITION_LEAD_STORE_KEY = 'mineradio-smart-transition-lead-v1';
var SMART_TRANSITION_LEAD_OPTIONS = [15, 30, 60];
var smartTransitionLeadSec = 30;
var smartCrossfadePrepareTimer = 0;
var smartCrossfadeExecuting = false;
var smartCrossfadePreparedAudio = null;
var smartTransitionMediaFadeSerial = 0;
var smartTransitionMediaFadeRaf = 0;
var smartTransitionMediaFadeTimer = 0;
var smartTransitionPairFadeResolve = null;
var smartTransitionGeneration = 0;
var smartTransitionDelayWaiters = [];
var smartTransitionActiveTransitionContext = null;
var smartTransitionAudioDescriptorCache = {};
var smartTransitionStyle = 'mirror';
var smartTransitionPending = null;
var smartTransitionVisualTimer = 0;
var smartCoverTransition = null;
var smartCoverTransitionSerial = 0;
var SMART_CROSSFADE_NORMAL_START_SETTLE_MS = 4200;
var SMART_CROSSFADE_HANDOFF_SETTLE_MS = 5200;
var SMART_TRANSITION_MAX_VOCAL_ENTRY_AT_SEC = 45;

function normalizeSmartTransitionStyle(value) {
  value = String(value || '');
  return /^(mirror|spectrum|blocks|wipe|random|off)$/.test(value) ? value : 'mirror';
}

function readSmartTransitionPreference() {
  try { return normalizeSmartTransitionStyle(localStorage.getItem(SMART_TRANSITION_STORE_KEY) || 'mirror'); } catch (_) { return 'mirror'; }
}

function isSmartTransitionEnabled() {
  return normalizeSmartTransitionStyle(smartTransitionStyle) !== 'off';
}

function smartTransitionRunStyle() {
  var style = normalizeSmartTransitionStyle(smartTransitionStyle);
  if (style !== 'random') return style;
  var choices = ['mirror', 'spectrum', 'blocks', 'wipe'];
  return choices[Math.floor(Math.random() * choices.length)] || 'mirror';
}

function smartTransitionStyleMode(value) {
  value = normalizeSmartTransitionStyle(value);
  if (value === 'off') return -1;
  if (value === 'blocks') return 1;
  if (value === 'spectrum') return 5;
  if (value === 'mirror') return 6;
  return 0;
}

function updateSmartTransitionStyleControls(status) {
  document.querySelectorAll('#smart-transition-style-seg [data-smart-transition-style]').forEach(function (button) {
    button.classList.toggle('active', button.getAttribute('data-smart-transition-style') === smartTransitionStyle);
  });
  var segment = document.getElementById('smart-transition-style-seg');
  if (segment) segment.classList.toggle('smart-transition-ready', status === 'ready');
}

function normalizeSmartTransitionLeadSec(value) {
  value = Math.round(Number(value) || 0);
  return SMART_TRANSITION_LEAD_OPTIONS.indexOf(value) >= 0 ? value : 30;
}

function readSmartTransitionLeadPreference() {
  try { return normalizeSmartTransitionLeadSec(localStorage.getItem(SMART_TRANSITION_LEAD_STORE_KEY)); } catch (_) { return 30; }
}

function updateSmartTransitionLeadControls() {
  document.querySelectorAll('#smart-transition-lead-seg [data-smart-transition-lead]').forEach(function (button) {
    button.classList.toggle('active', Number(button.getAttribute('data-smart-transition-lead')) === smartTransitionLeadSec);
  });
}

function setSmartTransitionLeadSec(value, silent) {
  smartTransitionLeadSec = normalizeSmartTransitionLeadSec(value);
  try { localStorage.setItem(SMART_TRANSITION_LEAD_STORE_KEY, String(smartTransitionLeadSec)); } catch (_) { }
  updateSmartTransitionLeadControls();
  // 重排当前曲的过渡计划，让新提前量立即生效（若智能过渡开启且未在执行中）。
  if (isSmartTransitionEnabled() && !smartCrossfadeExecuting && audio && !audio.paused) {
    smartTransitionPending = null;
    stopSmartTransitionPreparedAudio();
    scheduleSmartCrossfadePrepare(trackSwitchToken, currentIdx, 260);
  }
  if (!silent) showToast('提前过渡 ' + smartTransitionLeadSec + ' 秒');
}

function hideSmartTransitionVisual() {
  if (smartTransitionVisualTimer) clearTimeout(smartTransitionVisualTimer);
  smartTransitionVisualTimer = 0;
  var visual = document.getElementById('smart-transition-visual');
  var chip = document.getElementById('smart-transition-chip');
  if (visual) visual.classList.remove('active');
  if (chip) {
    chip.classList.remove('show');
    chip.setAttribute('aria-hidden', 'true');
  }
}

function showSmartTransitionVisual(durationMs) {
  if (!isSmartTransitionEnabled() || document.hidden) return '';
  hideSmartTransitionVisual();
  var style = smartTransitionRunStyle();
  var visual = document.getElementById('smart-transition-visual');
  var chip = document.getElementById('smart-transition-chip');
  if (visual) {
    visual.setAttribute('data-style', style);
    visual.style.setProperty('--smart-transition-ms', Math.max(900, Number(durationMs) || 7200) + 'ms');
    void visual.offsetWidth;
    visual.classList.add('active');
  }
  if (chip) {
    chip.classList.add('show');
    chip.setAttribute('aria-hidden', 'false');
  }
  smartTransitionVisualTimer = setTimeout(hideSmartTransitionVisual, Math.max(1400, Number(durationMs) || 7200) + 900);
  return style;
}

function resetSmartCoverTransition() {
  smartCoverTransition = null;
  if (uniforms && uniforms.uSmartCoverT) uniforms.uSmartCoverT.value = 0;
}

function smartTransitionCoverSource(song) {
  song = typeof hydrateCustomCover === 'function' ? hydrateCustomCover(song || {}) : (song || {});
  if ((song.type === 'local' || song.source === 'local' || song.localKey) && typeof localLibraryCover === 'function') {
    return localLibraryCover(song) || song.cover || '';
  }
  return typeof songCoverSrc === 'function' ? (songCoverSrc(song, 512) || song.cover || '') : (song.cover || '');
}

function setSmartCoverTextureFromImage(img) {
  if (!img || !smartCoverTransition) return false;
  try {
    var size = Math.min(512, coverTextureSizeForResolution(fx.coverResolution));
    var cv = document.createElement('canvas');
    cv.width = cv.height = size;
    var ctx = cv.getContext('2d');
    var iw = img.naturalWidth || img.width;
    var ih = img.naturalHeight || img.height;
    var side = Math.min(iw, ih);
    ctx.drawImage(img, (iw - side) / 2, (ih - side) / 2, side, side, 0, 0, size, size);
    smartCoverTex.image = cv;
    smartCoverTex.needsUpdate = true;
    smartCoverTransition.coverCanvas = cv;
    smartCoverTransition.edgeCanvas = buildEdgeAndDepth(cv);
    return true;
  } catch (_) {
    return false;
  }
}

function loadSmartCoverTexture(song, serial) {
  var src = smartTransitionCoverSource(song);
  if (!src) return;
  var loadSrc = typeof isInlineCoverSrc === 'function' && isInlineCoverSrc(src)
    ? src
    : (/^https?:\/\//i.test(src) && typeof coverProxySrc === 'function' ? coverProxySrc(src) : src);
  if (!loadSrc) return;
  var img = new Image();
  img.crossOrigin = 'anonymous';
  img.decoding = 'async';
  img.onload = function () {
    if (!smartCoverTransition || smartCoverTransition.serial !== serial) return;
    if (setSmartCoverTextureFromImage(img)) smartCoverTransition.ready = true;
  };
  img.src = loadSrc;
}

function startSmartCoverTransition(song, durationMs, runStyle) {
  var style = normalizeSmartTransitionStyle(runStyle || smartTransitionRunStyle());
  if (style === 'off' || document.hidden || !uniforms || !uniforms.uSmartCoverT) {
    resetSmartCoverTransition();
    return false;
  }
  var serial = ++smartCoverTransitionSerial;
  smartCoverTransition = {
    serial: serial,
    startedAt: performance.now(),
    durationMs: Math.max(1200, Number(durationMs) || 7200),
    ready: false,
    coverCanvas: null,
    edgeCanvas: null,
    mode: smartTransitionStyleMode(style)
  };
  uniforms.uSmartCoverT.value = 0;
  uniforms.uSmartCoverMode.value = smartCoverTransition.mode;
  loadSmartCoverTexture(song, serial);
  uniforms.uBurstAmt.value = Math.max(uniforms.uBurstAmt.value || 0, 0.36);
  return true;
}

function tickSmartCoverTransition(now) {
  if (!smartCoverTransition || !uniforms || !uniforms.uSmartCoverT) return;
  var t = clamp01((now - smartCoverTransition.startedAt) / Math.max(1, smartCoverTransition.durationMs));
  uniforms.uSmartCoverT.value = smartCoverTransition.ready ? visualEase(t) : 0;
  if (t >= 1 && !smartCrossfadeExecuting) resetSmartCoverTransition();
}

function commitSmartCoverTextureForHandoff(song) {
  if (!smartCoverTransition || !smartCoverTransition.ready || !smartCoverTransition.coverCanvas) return false;
  try {
    var committedCover = smartCoverTransition.coverCanvas;
    coverTex.image = committedCover;
    coverTex.needsUpdate = true;
    uniforms.uHasCover.value = 1;
    coverPickerCanvas = committedCover;
    if (smartCoverTransition.edgeCanvas) {
      coverEdgeTex.image = smartCoverTransition.edgeCanvas;
      coverEdgeTex.needsUpdate = true;
      setCoverDepthState(1, 0.55, 1);
      if (typeof refreshFloatColorsFromCover === 'function') refreshFloatColorsFromCover(committedCover);
      if (typeof refreshBackCoverColorsFromCanvas === 'function') refreshBackCoverColorsFromCanvas(committedCover);
      if (typeof updateLyricPaletteFromCover === 'function') updateLyricPaletteFromCover(committedCover);
    }
    var src = smartTransitionCoverSource(song);
    if (src) {
      var thumb = document.getElementById('thumb-cover');
      if (thumb) thumb.src = src;
      if (typeof setControlCoverSrc === 'function') setControlCoverSrc(src);
      if (typeof setAlbumBackground === 'function') setAlbumBackground(src);
      currentCoverSource = { kind: typeof isInlineCoverSrc === 'function' && isInlineCoverSrc(src) ? 'data' : 'url', src: src };
      if (shelfManager) shelfManager.onCoverChange(src);
    }
    return true;
  } catch (_) {
    return false;
  }
}

function setSmartTransitionStyle(style, silent) {
  smartTransitionStyle = normalizeSmartTransitionStyle(style);
  try { localStorage.setItem(SMART_TRANSITION_STORE_KEY, smartTransitionStyle); } catch (_) { }
  if (!isSmartTransitionEnabled()) {
    var pending = smartTransitionPending;
    smartTransitionPending = null;
    if (!smartCrossfadeExecuting && pending && pending.preparedAudio) stopSmartTransitionPreparedAudio(pending.preparedAudio);
    hideSmartTransitionVisual();
    resetSmartCoverTransition();
  } else if (audio && !audio.paused && currentIdx >= 0) {
    scheduleSmartCrossfadePrepare(trackSwitchToken, currentIdx, 260);
  }
  updateSmartTransitionStyleControls();
  if (!silent) showToast(isSmartTransitionEnabled() ? '智能过渡已开启' : '智能过渡已关闭');
}

function smartTransitionSongKey(song) {
  return typeof beatMapSongKey === 'function' ? String(beatMapSongKey(song) || '') : '';
}

function smartCrossfadeNextIndex(index) {
  if (!Array.isArray(playQueue) || playQueue.length < 2 || playMode === 'single') return -1;
  index = isFinite(Number(index)) ? Math.round(Number(index)) : currentIdx;
  return (index + 1 + playQueue.length) % playQueue.length;
}

function smartCrossfadeAudioDescriptor(song) {
  var key = smartTransitionSongKey(song);
  var cached = key && smartTransitionAudioDescriptorCache[key];
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached);
  if (song && (song.type === 'local' || song.source === 'local' || song.localUrl)) {
    var hasStableLocalUrl = !!song.localUrl && song.localMissing !== true;
    var localUrlReady = hasStableLocalUrl
      ? Promise.resolve(true)
      : Promise.resolve(typeof ensureFreshLocalPlaybackUrl === 'function' ? ensureFreshLocalPlaybackUrl(song) : !!song.localUrl);
    return localUrlReady.then(function () {
      if (!song.localUrl) return null;
      var localDescriptor = {
        proxyUrl: song.localUrl,
        playbackData: { url: song.localUrl, source: 'local', local: true },
        local: true,
        expiresAt: Date.now() + 4 * 60 * 1000
      };
      if (key) smartTransitionAudioDescriptorCache[key] = localDescriptor;
      return localDescriptor;
    });
  }
  return Promise.resolve(typeof fetchBeatPrefetchAudioUrl === 'function' ? fetchBeatPrefetchAudioUrl(song) : null).then(function (proxyUrl) {
    if (!proxyUrl) return null;
    var descriptor = {
      proxyUrl: proxyUrl,
      playbackData: { url: proxyUrl, source: songProviderKey(song), level: '' },
      expiresAt: Date.now() + 4 * 60 * 1000
    };
    if (key) smartTransitionAudioDescriptorCache[key] = descriptor;
    return descriptor;
  });
}

function clearSmartCrossfadeTimer() {
  if (smartCrossfadePrepareTimer) clearTimeout(smartCrossfadePrepareTimer);
  smartCrossfadePrepareTimer = 0;
}

function clearSmartTransitionTimelineTimers() {
  while (smartTransitionDelayWaiters.length) {
    var waiter = smartTransitionDelayWaiters.pop();
    clearTimeout(waiter.timer);
    waiter.resolve(false);
  }
  cancelSmartTransitionMediaFade();
}

function cancelSmartTransitionMediaFade() {
  smartTransitionMediaFadeSerial++;
  if (smartTransitionMediaFadeRaf) cancelAnimationFrame(smartTransitionMediaFadeRaf);
  if (smartTransitionMediaFadeTimer) clearInterval(smartTransitionMediaFadeTimer);
  smartTransitionMediaFadeRaf = 0;
  smartTransitionMediaFadeTimer = 0;
  if (smartTransitionPairFadeResolve) {
    var resolve = smartTransitionPairFadeResolve;
    smartTransitionPairFadeResolve = null;
    resolve(false);
  }
}

function claimSmartTransitionPreparedAudioForPlayback(media) {
  if (!media) return false;
  cancelSmartTransitionMediaFade();
  if (media.__mineradioPreparedAudioGraph) media.__mineradioPreparedAudioGraph.adopted = true;
  if (media === smartCrossfadePreparedAudio) smartCrossfadePreparedAudio = null;
  return true;
}

function disposeSmartTransitionPreparedAudioGraph(media) {
  var graph = media && media.__mineradioPreparedAudioGraph;
  if (!graph || graph.adopted) return;
  [graph.source, graph.analyser, graph.beatAnalyser, graph.gainNode].forEach(function (node) {
    try { if (node) node.disconnect(); } catch (_) { }
  });
  try { delete media.__mineradioPreparedAudioGraph; } catch (_) { }
}

function stopSmartTransitionPreparedAudio(media) {
  media = media || smartCrossfadePreparedAudio;
  if (!media) return;
  // Once the preloaded B deck has become Mineradio's active deck it no longer
  // belongs to SmartTransition. A later C-deck preparation must never pause or unload it.
  if (typeof audio !== 'undefined' && media === audio) {
    claimSmartTransitionPreparedAudioForPlayback(media);
    return;
  }
  disposeSmartTransitionPreparedAudioGraph(media);
  try { media.pause(); } catch (_) { }
  try { media.removeAttribute('src'); media.load(); } catch (_) { }
  if (media === smartCrossfadePreparedAudio) smartCrossfadePreparedAudio = null;
}

function resetSmartCrossfade(reason, options) {
  options = options || {};
  var activeContext = smartTransitionActiveTransitionContext;
  var shouldRestoreOutgoing = !!(
    activeContext
    && reason !== 'manual-pause'
    && reason !== 'manual-seek'
    && reason !== 'track-switch'
    && reason !== 'smart-transition-handoff'
    && activeContext.outgoingToken === trackSwitchToken
    && activeContext.outgoingIndex === currentIdx
    && activeContext.outgoingMedia === audio
    && audio
    && !audio.paused
    && !audio.ended
  );
  smartTransitionGeneration++;
  clearSmartCrossfadeTimer();
  clearSmartTransitionTimelineTimers();
  smartTransitionPending = null;
  if (!options.preserveExecution) smartCrossfadeExecuting = false;
  if (!options.preservePreparedAudio) stopSmartTransitionPreparedAudio();
  if (shouldRestoreOutgoing && typeof rampAudioOutputGain === 'function') rampAudioOutputGain(targetVolume, 120);
  if (!options.preserveExecution) smartTransitionActiveTransitionContext = null;
  if (!options.preserveExecution) hideSmartTransitionVisual();
  updateSmartTransitionStyleControls();
}

function smartCrossfadePostSwitchDelay(isSmartTransitionHandoff) {
  return isSmartTransitionHandoff ? SMART_CROSSFADE_HANDOFF_SETTLE_MS : SMART_CROSSFADE_NORMAL_START_SETTLE_MS;
}

function smartCrossfadeVisualTransitionBusy() {
  if (typeof isRenderInteractionActive === 'function' && isRenderInteractionActive()) return true;
  if (typeof colorMixTween !== 'undefined' && colorMixTween) return true;
  if (typeof coverDepthTween !== 'undefined' && coverDepthTween) return true;
  if (typeof loadingTween !== 'undefined' && loadingTween) return true;
  return false;
}

function transitionPendingEnabled(pending) {
  return !!(pending && pending.mode === 'smart-transition' && isSmartTransitionEnabled());
}

function smartTransitionLyricLooksLikeCredit(text) {
  text = String(text || '').trim();
  if (!text) return true;
  return /^(?:作词|作曲|编曲|制作人|制作|监制|录音|混音|母带|吉他|贝斯|鼓|弦乐|和声|人声|演唱|词|曲|composer|lyricist|lyrics?|arranger|producer|mix(?:ed)?|master(?:ed)?)(?:\s*[:：]|\s+)/i.test(text);
}

function smartTransitionIncomingVocalCue(lines, fadeSec) {
  // The incoming deck should meet the listener one fade before its first real
  // lyric, rather than replaying a long instrumental intro from 0:00.
  lines = Array.isArray(lines) ? lines : [];
  var leadSec = Math.max(0, Number(fadeSec) || 0);
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i] || {};
    var at = Number(line.t);
    if (!isFinite(at) || at < 0 || line.fallback || (typeof isNoLyricText === 'function' && isNoLyricText(line.text))) continue;
    if (smartTransitionLyricLooksLikeCredit(line.text)) continue;
    // A first vocal this late is more likely a long-intro/remix cue. Jumping
    // tens of seconds is worse than keeping the full arrangement from 0:00.
    if (at > SMART_TRANSITION_MAX_VOCAL_ENTRY_AT_SEC) return { known: false, vocalAt: 0, entryTime: 0 };
    return {
      known: true,
      vocalAt: at,
      // Begin B exactly one crossfade earlier, so its first lyric arrives
      // as the incoming fade completes (not several seconds after it).
      entryTime: Math.max(0, at - leadSec)
    };
  }
  return { known: false, vocalAt: 0, entryTime: 0 };
}

function smartTransitionIncomingVocalCueFromResponse(song, response, fadeSec) {
  if (typeof parseLyricResponseToOriginalState !== 'function') return { known: false, vocalAt: 0, entryTime: 0 };
  try {
    var merged = typeof mergeInlineLyricResponseForSong === 'function'
      ? mergeInlineLyricResponseForSong(song, response || {})
      : (response || {});
    var state = parseLyricResponseToOriginalState(song, merged);
    return smartTransitionIncomingVocalCue(state && state.lines, fadeSec);
  } catch (_) {
    return { known: false, vocalAt: 0, entryTime: 0 };
  }
}

async function smartTransitionIncomingEntryTime(song, fadeSec) {
  // Inline lyrics and the disk cache avoid an extra request in the common
  // case.  A cache miss is still worth resolving while A is playing: it lets
  // the B deck seek directly to the first vocal lead-in before it preloads.
  var cue = smartTransitionIncomingVocalCueFromResponse(song, {}, fadeSec);
  if (cue.known) return cue;
  try {
    if (typeof readPersistentLyricCache === 'function') {
      var cached = await readPersistentLyricCache(song);
      cue = smartTransitionIncomingVocalCueFromResponse(song, cached, fadeSec);
      if (cue.known) return cue;
    }
    if (typeof apiJson !== 'function' || typeof lyricEndpointForSong !== 'function') return cue;
    var response = await apiJson(lyricEndpointForSong(song), { timeoutMs: 5000 });
    var merged = typeof mergeInlineLyricResponseForSong === 'function'
      ? mergeInlineLyricResponseForSong(song, response || {})
      : (response || {});
    cue = smartTransitionIncomingVocalCueFromResponse(song, merged, fadeSec);
    if (typeof writePersistentLyricCache === 'function') writePersistentLyricCache(song, merged);
  } catch (_) { }
  return cue;
}

function scheduleSmartCrossfadePrepare(token, index, delay, attempt) {
  clearSmartCrossfadeTimer();
  var smartEnabled = isSmartTransitionEnabled();
  if (!smartEnabled || !audio || audio.paused || !playQueue || playQueue.length < 2) return false;
  var currentIndex = isFinite(Number(index)) ? Math.round(Number(index)) : currentIdx;
  var nextIndex = smartCrossfadeNextIndex(currentIndex);
  if (nextIndex < 0 || nextIndex === currentIndex) return false;
  smartCrossfadePrepareTimer = setTimeout(function () {
    smartCrossfadePrepareTimer = 0;
    runSmartCrossfadePrepare(token, currentIndex, nextIndex, attempt || 0);
  }, Math.max(260, Number(delay) || 1200));
  return true;
}

async function runSmartCrossfadePrepare(token, currentIndex, nextIndex, attempt) {
  var smartEnabled = isSmartTransitionEnabled();
  if (!smartEnabled || token !== trackSwitchToken || currentIndex !== currentIdx) return;
  if (smartCrossfadeVisualTransitionBusy()) {
    scheduleSmartCrossfadePrepare(token, currentIndex, 900, attempt || 0);
    return;
  }
  await prepareSmartTransitionFallback(token, currentIndex);
}

async function prepareSmartTransitionFallback(token, currentIndex) {
  if (!isSmartTransitionEnabled() || token !== trackSwitchToken || currentIndex !== currentIdx || smartCrossfadeExecuting) return false;
  var nextIndex = typeof pickNextQueueIndex === 'function' ? pickNextQueueIndex(currentIndex) : smartCrossfadeNextIndex(currentIndex);
  if (nextIndex < 0 || nextIndex === currentIndex) return false;
  var currentSong = playQueue[currentIndex];
  var nextSong = playQueue[nextIndex];
  if (!currentSong || !nextSong) return false;
  var initialDuration = Number(audio && audio.duration) || (typeof getPlaybackDurationSeconds === 'function' ? Number(getPlaybackDurationSeconds()) : 0);
  if (!isFinite(initialDuration) || initialDuration <= 12) return false;
  // Resolve lyrics and the next source together, then recompute A's timing.
  // These awaits can take several seconds on a slow provider.
  var initialFadeSec = Math.min(7.6, Math.max(4.2, initialDuration * 0.045));
  var prepared = await Promise.all([
    smartCrossfadeAudioDescriptor(nextSong),
    smartTransitionIncomingEntryTime(nextSong, initialFadeSec)
  ]);
  var descriptor = prepared[0];
  var incomingCue = prepared[1] || { known: false, entryTime: 0 };
  if (!descriptor || !descriptor.proxyUrl || token !== trackSwitchToken || currentIndex !== currentIdx) return false;
  var duration = Number(audio && audio.duration) || (typeof getPlaybackDurationSeconds === 'function' ? Number(getPlaybackDurationSeconds()) : 0);
  var nowSec = Number(audio && audio.currentTime) || 0;
  if (!isFinite(duration) || duration <= 12 || duration - nowSec <= 1.5) return false;
  // 淡变触发点/时长：保持原动态算法（结束前 4.5% 钳 4.2~7.6s），不随提前量改变。
  var fadeLeadSec = Math.min(7.6, Math.max(4.2, duration * 0.045));
  var triggerAt = Math.max(nowSec, duration - fadeLeadSec);
  var fadeMs = Math.max(1200, Math.round((duration - triggerAt - 0.12) * 1000));
  var fadeSec = fadeMs / 1000;
  if (incomingCue.known) incomingCue.entryTime = Math.max(0, Number(incomingCue.vocalAt) - fadeSec);
  // 提前量（15/30/60s）：从"结束前 leadSec"开始进入人声监听窗口，
  // 检测到人声已结束（尾奏/纯伴奏）就提前触发淡变；检测不到则按 triggerAt 照旧。
  var monitorLeadSec = normalizeSmartTransitionLeadSec(smartTransitionLeadSec);
  var monitorFrom = Math.max(Number(audio.currentTime) || 0, duration - monitorLeadSec);
  // 窗口太短或歌曲太短就没必要提前判断了。
  var vocalMonitorEnabled = monitorFrom < triggerAt - 1.5 && duration > monitorLeadSec + 12;
  smartTransitionPending = {
    mode: 'smart-transition',
    token: token,
    currentIndex: currentIndex,
    nextIndex: nextIndex,
    fromKey: smartTransitionSongKey(currentSong),
    toKey: smartTransitionSongKey(nextSong),
    audioUrl: descriptor,
    executionMode: 'simple-crossfade',
    mixType: 'crossfade',
    fadeSec: fadeSec,
    fadeStartA: triggerAt,
    bFadeStart: Math.max(0, Number(incomingCue.entryTime) || 0),
    entryTime: Math.max(0, Number(incomingCue.entryTime) || 0),
    incomingVocalAt: Math.max(0, Number(incomingCue.vocalAt) || 0),
    exitTime: duration,
    triggerAt: triggerAt,
    vocalMonitor: vocalMonitorEnabled ? {
      from: monitorFrom,
      until: triggerAt,
      baseline: 0,
      baselineSamples: 0,
      belowSince: 0,
      lastSampleAt: 0
    } : null,
    timeline: [
      { t: -fadeMs / 1000, deck: 'B', op: 'play', at: Math.max(0, Number(incomingCue.entryTime) || 0), volume: 0 },
      { t: -fadeMs / 1000, deck: 'AB', op: 'crossfade', duration: fadeMs },
      { t: -0.12, deck: 'B', op: 'handoff' }
    ],
    createdAt: Date.now()
  };
  prepareSmartTransitionPendingAudio(smartTransitionPending);
  updateSmartTransitionStyleControls('ready');
  return true;
}

function smartTransitionPendingDescriptor(pending) {
  var source = pending && pending.audioUrl;
  if (!source) return null;
  return typeof source === 'string' ? { proxyUrl: source, playbackData: { url: source } } : source;
}

function smartTransitionTimelineExecution(pending) {
  var descriptor = smartTransitionPendingDescriptor(pending);
  if (!pending || !descriptor) return null;
  return {
    bStart: Math.max(0, Number(pending.entryTime) || 0),
    fadeDurationMs: Math.max(360, Number(pending.fadeSec) * 1000 || 1400),
    fadeStartDelayMs: 0
  };
}

function smartTransitionSetMediaTime(media, seconds) {
  if (!media) return;
  function setTime() {
    try { media.currentTime = Math.max(0, Number(seconds) || 0); } catch (_) { }
  }
  if (media.readyState >= 1) setTime();
  else media.addEventListener('loadedmetadata', setTime, { once: true });
}

function smartTransitionCreatePreparedAudioGraph(media) {
  if (!media || media.__mineradioPreparedAudioGraph) return media && media.__mineradioPreparedAudioGraph || null;
  var graph = null;
  try {
    if ((!audioCtx || audioCtx.state === 'closed') && typeof initAudio === 'function') initAudio();
    if (!audioCtx || audioCtx.state === 'closed' || !audioCtx.createMediaElementSource) return null;
    graph = { context: audioCtx, source: null, analyser: null, beatAnalyser: null, gainNode: null, adopted: false };
    graph.source = audioCtx.createMediaElementSource(media);
    // A media element cannot be safely returned to direct-output mode after a
    // MediaElementSource has been created for it. Mark it immediately so a
    // later graph-construction failure can discard this element completely.
    media.__mineradioMediaSourceBound = true;
    graph.analyser = audioCtx.createAnalyser();
    graph.beatAnalyser = audioCtx.createAnalyser();
    graph.gainNode = audioCtx.createGain();
    graph.analyser.fftSize = typeof FFT_SIZE !== 'undefined' ? FFT_SIZE : 2048;
    graph.analyser.smoothingTimeConstant = 0.58;
    graph.beatAnalyser.fftSize = typeof BEAT_FFT_SIZE !== 'undefined' ? BEAT_FFT_SIZE : 1024;
    graph.beatAnalyser.smoothingTimeConstant = 0.10;
    graph.gainNode.gain.value = 0;
    graph.source.connect(graph.analyser);
    graph.source.connect(graph.beatAnalyser);
    graph.analyser.connect(graph.gainNode);
    graph.gainNode.connect(audioCtx.destination);
    media.__mineradioPreparedAudioGraph = graph;
    return graph;
  } catch (error) {
    if (graph) {
      [graph.source, graph.analyser, graph.beatAnalyser, graph.gainNode].forEach(function (node) {
        try { if (node) node.disconnect(); } catch (_) { }
      });
    }
    if (media && media.__mineradioMediaSourceBound) media.__mineradioPreparedGraphFailed = true;
    try { delete media.__mineradioPreparedAudioGraph; } catch (_) { }
    console.warn('[SmartCrossfade] prepared audio graph fallback:', error && error.message || error);
    return null;
  }
}

function smartTransitionWriteIncomingGain(media, value) {
  value = Math.max(0, Math.min(1, Number(value) || 0));
  var graph = media && media.__mineradioPreparedAudioGraph;
  if (graph && graph.gainNode) {
    try { graph.gainNode.gain.value = value; } catch (_) { }
    try { media.volume = 1; media.muted = false; } catch (_) { }
    return value;
  }
  try { media.volume = value; media.muted = false; } catch (_) { }
  return value;
}

function prepareSmartTransitionPendingAudio(pending) {
  var descriptor = smartTransitionPendingDescriptor(pending);
  if (!descriptor || !descriptor.proxyUrl) return null;
  if (pending.preparedAudio && pending.preparedAudio.src) return pending.preparedAudio;
  stopSmartTransitionPreparedAudio();
  var execution = smartTransitionTimelineExecution(pending);
  var media = new Audio();
  media.crossOrigin = 'anonymous';
  media.preload = 'auto';
  media.volume = 1;
  media.muted = false;
  var directLocalDeck = !!(descriptor.local || (descriptor.playbackData && descriptor.playbackData.local));
  if (!directLocalDeck) smartTransitionCreatePreparedAudioGraph(media);
  if (!directLocalDeck && media.__mineradioPreparedGraphFailed) {
    try { media.pause(); media.removeAttribute('src'); media.load(); } catch (_) { }
    // The first element is permanently tied to a failed WebAudio source.
    // Recreate a clean element for the direct-volume fallback instead of
    // risking a silent B deck.
    media = new Audio();
    media.crossOrigin = 'anonymous';
    media.preload = 'auto';
    media.volume = 1;
    media.muted = false;
  }
  if (directLocalDeck) media.__mineradioSmartTransitionDirectVolume = true;
  smartTransitionWriteIncomingGain(media, 0);
  media.src = descriptor.proxyUrl;
  smartTransitionSetMediaTime(media, execution && execution.bStart);
  try { media.load(); } catch (_) { }
  pending.preparedAudio = media;
  pending.timelineExecution = execution;
  smartCrossfadePreparedAudio = media;
  return media;
}

function smartTransitionDelay(delayMs, generation) {
  return new Promise(function (resolve) {
    var waiter = {
      timer: 0,
      resolve: function (ok) {
        var index = smartTransitionDelayWaiters.indexOf(waiter);
        if (index >= 0) smartTransitionDelayWaiters.splice(index, 1);
        resolve(!!ok);
      }
    };
    waiter.timer = setTimeout(function () {
      waiter.resolve(generation === smartTransitionGeneration);
    }, Math.max(0, Number(delayMs) || 0));
    smartTransitionDelayWaiters.push(waiter);
  });
}

function smartTransitionTransitionStillCurrent(pending, context) {
  if (!pending || !context || !transitionPendingEnabled(pending)) return false;
  if (context.generation !== smartTransitionGeneration) return false;
  if (pending.token !== trackSwitchToken || pending.currentIndex !== currentIdx) return false;
  if (!context.outgoingMedia || audio !== context.outgoingMedia) return false;
  if (context.outgoingMedia.paused && !context.outgoingMedia.ended) return false;
  if (pending.fromKey && smartTransitionSongKey(playQueue[pending.currentIndex]) !== pending.fromKey) return false;
  if (pending.toKey && smartTransitionSongKey(playQueue[pending.nextIndex]) !== pending.toKey) return false;
  return true;
}

function smartTransitionRunEqualPowerCrossfade(pending, nextMedia, durationMs, context) {
  cancelSmartTransitionMediaFade();
  var serial = smartTransitionMediaFadeSerial;
  var initialTarget = Math.max(0.0001, Number(targetVolume) || 0);
  var outgoingRatio = Math.max(0, Math.min(1, (typeof currentAudioOutputGain === 'function' ? currentAudioOutputGain() : initialTarget) / initialTarget));
  var fadeStartA = isFinite(Number(pending && pending.fadeStartA))
    ? Number(pending.fadeStartA)
    : Number(context.outgoingMedia && context.outgoingMedia.currentTime) || 0;
  var headroomDepth = pending && pending.mixType === 'beatmix' ? 0.16 : 0.10;
  var fadeWatchdogAt = Date.now() + durationMs + 1800;
  durationMs = Math.max(1, Number(durationMs) || 1);
  return new Promise(function (resolve) {
    var settled = false;
    smartTransitionPairFadeResolve = resolve;
    function finish(ok) {
      if (settled) return;
      settled = true;
      if (smartTransitionPairFadeResolve === resolve) smartTransitionPairFadeResolve = null;
      if (smartTransitionMediaFadeRaf) cancelAnimationFrame(smartTransitionMediaFadeRaf);
      if (smartTransitionMediaFadeTimer) clearInterval(smartTransitionMediaFadeTimer);
      smartTransitionMediaFadeRaf = 0;
      smartTransitionMediaFadeTimer = 0;
      resolve(!!ok);
    }
    function applyStep() {
      if (settled) return;
      if (serial !== smartTransitionMediaFadeSerial || !smartTransitionTransitionStillCurrent(pending, context)) {
        finish(false);
        return;
      }
      if (Date.now() >= fadeWatchdogAt) {
        finish(false);
        return;
      }
      var mediaNow = Number(context.outgoingMedia && context.outgoingMedia.currentTime);
      var t = Math.max(0, Math.min(1, ((isFinite(mediaNow) ? mediaNow : fadeStartA) - fadeStartA) / (durationMs / 1000)));
      if (context.outgoingMedia && (context.outgoingMedia.ended || (isFinite(context.outgoingMedia.duration) && context.outgoingMedia.duration - mediaNow <= 0.025))) t = 1;
      var eased = t * t * (3 - 2 * t);
      var theta = eased * Math.PI * 0.5;
      var liveTarget = Math.max(0, Math.min(1, Number(targetVolume) || 0));
      var overlapHeadroom = 1 - Math.sin(Math.PI * eased) * headroomDepth;
      var outgoing = liveTarget * outgoingRatio * Math.cos(theta) * overlapHeadroom;
      var incoming = liveTarget * Math.sin(theta) * overlapHeadroom;
      if (typeof writeAudioOutputGain === 'function') writeAudioOutputGain(outgoing);
      smartTransitionWriteIncomingGain(nextMedia, incoming);
      if (t >= 1) {
        if (typeof writeAudioOutputGain === 'function') writeAudioOutputGain(0);
        smartTransitionWriteIncomingGain(nextMedia, liveTarget);
        finish(true);
      }
    }
    function tick() {
      applyStep();
      if (!settled) smartTransitionMediaFadeRaf = requestAnimationFrame(tick);
    }
    smartTransitionMediaFadeTimer = setInterval(function () {
      applyStep();
    }, 40);
    smartTransitionMediaFadeRaf = requestAnimationFrame(tick);
  });
}

async function smartTransitionWaitForMediaTime(media, targetTime, pending, context) {
  targetTime = Math.max(0, Number(targetTime) || 0);
  var watchdogAt = Date.now() + 7000;
  while (media && Number(media.currentTime) + 0.012 < targetTime) {
    if (!smartTransitionTransitionStillCurrent(pending, context) || Date.now() >= watchdogAt) return false;
    if (!await smartTransitionDelay(24, context.generation)) return false;
  }
  return smartTransitionTransitionStillCurrent(pending, context);
}

async function runSmartTransitionTimeline(pending, nextMedia, context) {
  var execution = pending.timelineExecution || smartTransitionTimelineExecution(pending);
  if (!execution) return false;
  pending.timelineExecution = execution;
  clearSmartTransitionTimelineTimers();
  var fadeMs = Math.max(360, Number(execution.fadeDurationMs) || Number(pending.fadeSec) * 1000 || 1400);
  var fadeStartA = isFinite(Number(pending.fadeStartA))
    ? Number(pending.fadeStartA)
    : Math.max(0, Number(pending.triggerAt) + Math.max(0, Number(execution.fadeStartDelayMs) || 0) / 1000);
  pending.fadeStartA = fadeStartA;
  pending.executionFallback = nextMedia.__mineradioPreparedAudioGraph ? 'shared-context-gain' : 'direct-volume-fallback';
  if (!await smartTransitionWaitForMediaTime(context.outgoingMedia, fadeStartA, pending, context)) return false;
  if (!smartTransitionTransitionStillCurrent(pending, context)) return false;
  if (nextMedia.readyState < 2) return false;
  var bFadeStart = isFinite(Number(pending.bFadeStart)) ? Math.max(0, Number(pending.bFadeStart)) : Math.max(0, Number(execution.bStart) || 0);
  if (Math.abs((Number(nextMedia.currentTime) || 0) - bFadeStart) > 0.04) smartTransitionSetMediaTime(nextMedia, bFadeStart);
  var completed = await smartTransitionRunEqualPowerCrossfade(pending, nextMedia, fadeMs, context);
  if (!completed || !smartTransitionTransitionStillCurrent(pending, context)) return false;
  return smartTransitionTransitionStillCurrent(pending, context);
}

// 提前人声判断：读主循环已填好的 frequencyData（复用全局 analyser，无额外解码）。
// 人声频段 420-2600Hz 与主循环 voc 一致；用总能量做参照，避免把安静前奏误判成结束。
function smartTransitionVocalEndedNow(monitor, nowSec) {
  if (!monitor || typeof beatBandRms !== 'function') return false;
  if (!analyser || !frequencyData || !frequencyData.length) return false;
  var sampleRate = (audioCtx && audioCtx.sampleRate) || 44100;
  var fftSize = (analyser && analyser.fftSize) || frequencyData.length * 2;
  var vocal = beatBandRms(frequencyData, sampleRate, fftSize, 420, 2600);
  var total = beatBandRms(frequencyData, sampleRate, fftSize, 60, 8000);
  // 窗口前 ~2.5s 先建人声基线（这段时间通常还在唱）。
  if (monitor.baselineSamples < 6) {
    monitor.baseline += vocal;
    monitor.baselineSamples += 1;
    monitor.belowSince = 0;
    return false;
  }
  var baseline = monitor.baseline / monitor.baselineSamples;
  // 基线太低说明这段本来就没人声（纯乐器/间奏），不做提前判断，交给原触发点。
  if (baseline < 0.035) return false;
  // 骤降：人声掉到基线 35% 以下，且不是整体都安静（伴奏还在 → 才是"人声结束了"）。
  var vocalDropped = vocal < baseline * 0.35;
  var accompanimentAlive = total > Math.max(0.030, baseline * 0.55);
  if (vocalDropped && accompanimentAlive) {
    if (!monitor.belowSince) monitor.belowSince = nowSec;
    // 持续 ~1.5s，避开句间气口/长音误判。
    return (nowSec - monitor.belowSince) >= 1.5;
  }
  monitor.belowSince = 0;
  return false;
}

function tickSmartCrossfade() {
  if (smartCrossfadeExecuting || !audio) return;
  if (!smartTransitionPending) return;
  var pending = smartTransitionPending;
  if (!transitionPendingEnabled(pending) || pending.token !== trackSwitchToken || pending.currentIndex !== currentIdx) return;
  var nowSec = Number(audio.currentTime) || 0;
  var due = nowSec >= Number(pending.triggerAt);
  // 提前判断：进入监听窗口后，人声已结束就提前到当前点淡变（淡变时长不变）。
  if (!due && pending.vocalMonitor && nowSec >= Number(pending.vocalMonitor.from)) {
    if (smartTransitionVocalEndedNow(pending.vocalMonitor, nowSec)) {
      // 淡变需要 fadeSec 时长，太晚触发会超过结尾；保证还剩足够淡变时间。
      var fadeSec = Math.max(0.36, Number(pending.fadeSec) || 1.4);
      var duration = Number(audio.duration) || Number(pending.exitTime) || 0;
      if (duration - nowSec >= fadeSec + 0.12) {
        pending.triggerAt = nowSec;
        pending.fadeStartA = nowSec;
        due = true;
      }
    }
  }
  if (due) {
    // Never mute/end A while B has not buffered enough to start.  Let A end
    // naturally and use the ordinary next-track path instead of leaving an
    // apparently selected but silent incoming song on screen.
    var preparedMedia = pending.preparedAudio;
    if (!preparedMedia || Number(preparedMedia.readyState) < 2) {
      smartTransitionPending = null;
      stopSmartTransitionPreparedAudio(preparedMedia);
      updateSmartTransitionStyleControls();
      return;
    }
    smartTransitionPending = null;
    executeSmartCrossfade(pending);
  }
}

function noteSmartCrossfadeOutgoingEnded(media, token, index) {
  if (!media) return false;
  media.__mineradioSmartTransitionEndedDeferredToken = Number(token);
  media.__mineradioSmartTransitionEndedDeferredIndex = Number(index);
  return true;
}

function recoverSmartCrossfadeEndedOutgoing(pending, context, reason) {
  var outgoing = context && context.outgoingMedia;
  var token = Number(context && context.outgoingToken);
  var index = Number(context && context.outgoingIndex);
  if (
    !outgoing
    || !outgoing.ended
    || !isFinite(token)
    || !isFinite(index)
    || trackSwitchToken !== token
    || currentIdx !== index
    || audio !== outgoing
  ) return false;
  if (outgoing.__mineradioSmartTransitionEndedRecoveryToken === token) return true;
  outgoing.__mineradioSmartTransitionEndedRecoveryToken = token;
  smartCrossfadeExecuting = false;
  if (smartTransitionActiveTransitionContext === context) smartTransitionActiveTransitionContext = null;
  if (typeof finalizeListenSession === 'function') finalizeListenSession(true);
  updateSmartTransitionStyleControls();
  setTimeout(function () {
    if (trackSwitchToken !== token || currentIdx !== index || audio !== outgoing) return;
    if (playMode === 'single') {
      playQueueAt(index, { autoRepeat: true, suppressPlayFailureNotice: true });
    } else if (typeof nextTrack === 'function') {
      nextTrack(false);
    } else if (pending && isFinite(Number(pending.nextIndex))) {
      playQueueAt(Number(pending.nextIndex), { skipShuffleOrder: true, suppressPlayFailureNotice: true, preserveHomeState: true });
    }
  }, 0);
  return true;
}

function smartTransitionPromiseWithTimeout(promise, timeoutMs, code) {
  return new Promise(function (resolve, reject) {
    var settled = false;
    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      reject(new Error(code || 'MEDIA_PLAY_TIMEOUT'));
    }, Math.max(400, Number(timeoutMs) || 3600));
    Promise.resolve(promise).then(function (value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }, function (error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

// B is already required to have buffered before the fade trigger, so its play
// and clock checks stay short. A slow/stale prepared deck is abandoned while
// A still owns playback, rather than locking the transition for tens of seconds.
var SMART_TRANSITION_PLAY_REQUEST_TIMEOUT_MS = 2500;
var SMART_TRANSITION_CLOCK_TIMEOUT_MS = 2500;
var SMART_TRANSITION_ADOPTED_CLOCK_TIMEOUT_MS = 6500;

function waitForSmartTransitionPlaybackProgress(pending, media, context, startTime, timeoutMs) {
  return new Promise(function (resolve) {
    var settled = false;
    var timer = 0;
    var poll = 0;
    function cleanup() {
      if (timer) clearTimeout(timer);
      if (poll) clearInterval(poll);
      ['timeupdate', 'playing', 'error', 'ended', 'abort'].forEach(function (name) { media.removeEventListener(name, check); });
    }
    function finish(ok) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(!!ok);
    }
    function check(event) {
      if (!smartTransitionTransitionStillCurrent(pending, context) || media.error || media.ended || (event && /^(error|ended|abort)$/.test(event.type))) return finish(false);
      if (!media.paused && isFinite(Number(media.currentTime)) && Number(media.currentTime) >= startTime + 0.05) finish(true);
    }
    ['timeupdate', 'playing', 'error', 'ended', 'abort'].forEach(function (name) { media.addEventListener(name, check); });
    poll = setInterval(check, 80);
    timer = setTimeout(function () { finish(false); }, Math.max(500, Number(timeoutMs) || SMART_TRANSITION_CLOCK_TIMEOUT_MS));
    check();
  });
}

function waitForAdoptedSmartTransitionPlaybackProgress(media, expectedToken, expectedIndex, startTime, timeoutMs) {
  return new Promise(function (resolve) {
    var settled = false;
    var timer = 0;
    var poll = 0;
    function cleanup() {
      if (timer) clearTimeout(timer);
      if (poll) clearInterval(poll);
      ['timeupdate', 'playing', 'error', 'ended', 'abort'].forEach(function (name) { media.removeEventListener(name, check); });
    }
    function finish(ok) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(!!ok);
    }
    function check(event) {
      if (
        audio !== media
        || trackSwitchToken !== expectedToken
        || currentIdx !== expectedIndex
        || media.error
        || media.ended
        || media.paused
        || (event && /^(error|ended|abort)$/.test(event.type))
      ) return finish(false);
      if (isFinite(Number(media.currentTime)) && Number(media.currentTime) >= startTime + 0.08) finish(true);
    }
    ['timeupdate', 'playing', 'error', 'ended', 'abort'].forEach(function (name) { media.addEventListener(name, check); });
    poll = setInterval(check, 80);
    timer = setTimeout(function () { finish(false); }, Math.max(650, Number(timeoutMs) || SMART_TRANSITION_CLOCK_TIMEOUT_MS));
    check();
  });
}

async function executeSmartCrossfade(pending) {
  if (!pending || !transitionPendingEnabled(pending) || smartCrossfadeExecuting || pending.token !== trackSwitchToken || pending.currentIndex !== currentIdx) return;
  var isSmartTransition = pending.mode === 'smart-transition';
  if (pending.fromKey && smartTransitionSongKey(playQueue[pending.currentIndex]) !== pending.fromKey) return;
  if (pending.toKey && smartTransitionSongKey(playQueue[pending.nextIndex]) !== pending.toKey) return;
  var transitionContext = {
    generation: ++smartTransitionGeneration,
    outgoingMedia: audio,
    outgoingToken: trackSwitchToken,
    outgoingIndex: currentIdx
  };
  smartCrossfadeExecuting = true;
  if (isSmartTransition) {
    updateSmartTransitionStyleControls('handoff');
    var activeRunStyle = showSmartTransitionVisual(Number(pending.fadeSec) * 1000);
    startSmartCoverTransition(playQueue[pending.nextIndex], Number(pending.fadeSec) * 1000, activeRunStyle);
  }
  var nextMedia = prepareSmartTransitionPendingAudio(pending);
  if (!nextMedia || Number(nextMedia.readyState) < 2) {
    smartCrossfadeExecuting = false;
    if (isSmartTransition) resetSmartCoverTransition();
    stopSmartTransitionPreparedAudio(nextMedia);
    if (isSmartTransition) updateSmartTransitionStyleControls();
    recoverSmartCrossfadeEndedOutgoing(pending, transitionContext, 'missing-audio');
    return;
  }
  smartTransitionActiveTransitionContext = transitionContext;
  try {
    smartTransitionSetMediaTime(nextMedia, pending.timelineExecution && pending.timelineExecution.bStart);
    smartTransitionWriteIncomingGain(nextMedia, 0);
    if (typeof applyAudioOutputDevice === 'function') await applyAudioOutputDevice(nextMedia);
    if (!smartTransitionTransitionStillCurrent(pending, transitionContext)) {
      smartCrossfadeExecuting = false;
      if (isSmartTransition) resetSmartCoverTransition();
      stopSmartTransitionPreparedAudio(nextMedia);
      if (smartTransitionActiveTransitionContext === transitionContext) smartTransitionActiveTransitionContext = null;
      recoverSmartCrossfadeEndedOutgoing(pending, transitionContext, 'fallback');
      return;
    }
    var nextMediaStartTime = Number(nextMedia.currentTime) || 0;
    await smartTransitionPromiseWithTimeout(nextMedia.play(), SMART_TRANSITION_PLAY_REQUEST_TIMEOUT_MS, 'SMART_TRANSITION_PLAY_TIMEOUT');
    var progressed = await waitForSmartTransitionPlaybackProgress(pending, nextMedia, transitionContext, nextMediaStartTime, SMART_TRANSITION_CLOCK_TIMEOUT_MS);
    if (!progressed) throw new Error('SMART_TRANSITION_CLOCK_STALLED');
  } catch (_) {
    smartCrossfadeExecuting = false;
    if (isSmartTransition) resetSmartCoverTransition();
    stopSmartTransitionPreparedAudio(nextMedia);
    if (smartTransitionActiveTransitionContext === transitionContext) smartTransitionActiveTransitionContext = null;
    if (isSmartTransition) updateSmartTransitionStyleControls();
    recoverSmartCrossfadeEndedOutgoing(pending, transitionContext, 'error');
    showToast('智能过渡失败，已恢复普通切歌');
    return;
  }
  var handoffReady = await runSmartTransitionTimeline(pending, nextMedia, transitionContext);
  if (!handoffReady || !smartTransitionTransitionStillCurrent(pending, transitionContext)) {
    smartCrossfadeExecuting = false;
    if (isSmartTransition) resetSmartCoverTransition();
    stopSmartTransitionPreparedAudio(nextMedia);
    if (
      transitionContext.generation === smartTransitionGeneration
      && transitionContext.outgoingToken === trackSwitchToken
      && transitionContext.outgoingIndex === currentIdx
      && transitionContext.outgoingMedia === audio
      && audio
      && !audio.paused
      && !audio.ended
      && typeof rampAudioOutputGain === 'function'
    ) rampAudioOutputGain(targetVolume, 120);
    if (smartTransitionActiveTransitionContext === transitionContext) smartTransitionActiveTransitionContext = null;
    recoverSmartCrossfadeEndedOutgoing(pending, transitionContext, 'fallback');
    return;
  }
  var descriptor = smartTransitionPendingDescriptor(pending);
  var coverCommitted = isSmartTransition ? commitSmartCoverTextureForHandoff(playQueue[pending.nextIndex]) : false;
  var handoffSucceeded = false;
  async function runSmartTransitionNormalFallback() {
    var expectedFailedToken = transitionContext.outgoingToken + 1;
    if (
      trackSwitchToken !== expectedFailedToken
      || currentIdx !== pending.nextIndex
      || (audio !== nextMedia && audio !== transitionContext.outgoingMedia)
    ) return false;
    var fallbackOwnerMedia = audio;
    if (fallbackOwnerMedia === nextMedia) {
      if (typeof replaceAudioElementForGraphRecovery === 'function') {
        replaceAudioElementForGraphRecovery('smart-transition-handoff-fallback', { preservePlayback: false });
      } else {
        try {
          nextMedia.pause();
          nextMedia.removeAttribute('src');
          nextMedia.load();
        } catch (_) { }
      }
      if (transitionContext.outgoingMedia && transitionContext.outgoingMedia !== fallbackOwnerMedia) {
        try {
          transitionContext.outgoingMedia.pause();
          transitionContext.outgoingMedia.removeAttribute('src');
          transitionContext.outgoingMedia.load();
        } catch (_) { }
      }
    } else {
      stopSmartTransitionPreparedAudio(nextMedia);
    }
    var fallbackResult = await playQueueAt(pending.nextIndex, {
      preserveHomeState: true,
      skipShuffleOrder: true,
      suppressPlayFailureNotice: true,
      coverCommitted: coverCommitted
    });
    return !!(
      fallbackResult === true
      && currentIdx === pending.nextIndex
      && audio
      && audio.src
      && !audio.paused
      && !audio.ended
    );
  }
  try {
    var handoffResult = await playQueueAt(pending.nextIndex, {
      preserveHomeState: true,
      smartTransitionMixed: true,
      preloadedAudio: nextMedia,
      preloadedData: descriptor && descriptor.playbackData || { url: descriptor && descriptor.proxyUrl || '' },
      preloadedProxyAudioUrl: descriptor && descriptor.proxyUrl || '',
      smartTransitionHandoff: true,
      smartTransition: isSmartTransition,
      coverCommitted: coverCommitted
    });
    handoffSucceeded = !!(handoffResult === true && audio === nextMedia && currentIdx === pending.nextIndex && nextMedia.src && !nextMedia.paused && !nextMedia.ended);
    if (handoffSucceeded) {
      var adoptedToken = trackSwitchToken;
      var adoptedStartTime = Number(nextMedia.currentTime) || 0;
    var adoptedProgressed = await waitForAdoptedSmartTransitionPlaybackProgress(nextMedia, adoptedToken, pending.nextIndex, adoptedStartTime, SMART_TRANSITION_ADOPTED_CLOCK_TIMEOUT_MS);
      if (!adoptedProgressed) {
        console.warn('[SmartCrossfade] adopted media clock stalled; falling back to a fresh player');
        handoffSucceeded = await runSmartTransitionNormalFallback();
      }
    }
    if (!handoffSucceeded) handoffSucceeded = await runSmartTransitionNormalFallback();
  } catch (err) {
    console.warn('[SmartCrossfade] handoff failed:', err);
    try { handoffSucceeded = await runSmartTransitionNormalFallback(); } catch (_) { }
  } finally {
    if (!handoffSucceeded && audio !== nextMedia) stopSmartTransitionPreparedAudio(nextMedia);
    smartCrossfadeExecuting = false;
    if (smartTransitionActiveTransitionContext === transitionContext) smartTransitionActiveTransitionContext = null;
    if (isSmartTransition) updateSmartTransitionStyleControls();
    if (isSmartTransition) resetSmartCoverTransition();
    if (!handoffSucceeded) recoverSmartCrossfadeEndedOutgoing(pending, transitionContext, 'error');
  }
}

smartTransitionStyle = readSmartTransitionPreference();
smartTransitionLeadSec = readSmartTransitionLeadPreference();
updateSmartTransitionStyleControls();
updateSmartTransitionLeadControls();
