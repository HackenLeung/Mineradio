var CUEFIELD_AUTOMIX_STORE_KEY = 'mineradio-cuefield-automix-v1';
var SMART_TRANSITION_STORE_KEY = 'mineradio-smart-transition-v2';
var cuefieldAutoMixEnabled = false;
var cuefieldAutoMix = null;
var cuefieldAutoMixPrepareTimer = 0;
var cuefieldAutoMixExecuting = false;
var cuefieldAutoMixPreparedAudio = null;
var cuefieldMediaFadeSerial = 0;
var cuefieldMediaFadeRaf = 0;
var cuefieldMediaFadeTimer = 0;
var cuefieldPairFadeResolve = null;
var cuefieldTransitionGeneration = 0;
var cuefieldDelayWaiters = [];
var cuefieldActiveTransitionContext = null;
var cuefieldAudioDescriptorCache = {};
var cuefieldFeedbackState = { context: null, timer: 0, submitted: false };
var smartTransitionStyle = 'mirror';
var smartTransitionPending = null;
var smartTransitionVisualTimer = 0;
var CUEFIELD_AUTOMIX_NORMAL_START_SETTLE_MS = 4200;
var CUEFIELD_AUTOMIX_HANDOFF_SETTLE_MS = 5200;

function readCuefieldAutoMixPreference() {
  try { return localStorage.getItem(CUEFIELD_AUTOMIX_STORE_KEY) === '1'; } catch (_) { return false; }
}

function saveCuefieldAutoMixPreference() {
  try { localStorage.setItem(CUEFIELD_AUTOMIX_STORE_KEY, cuefieldAutoMixEnabled ? '1' : '0'); } catch (_) { }
}

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

function updateSmartTransitionStyleControls(status) {
  document.querySelectorAll('#smart-transition-style-seg [data-smart-transition-style]').forEach(function (button) {
    button.classList.toggle('active', button.getAttribute('data-smart-transition-style') === smartTransitionStyle);
  });
  var segment = document.getElementById('smart-transition-style-seg');
  if (segment) segment.classList.toggle('smart-transition-ready', status === 'ready');
}

function hideSmartTransitionVisual() {
  if (smartTransitionVisualTimer) clearTimeout(smartTransitionVisualTimer);
  smartTransitionVisualTimer = 0;
  var visual = document.getElementById('smart-transition-visual');
  var chip = document.getElementById('smart-transition-chip');
  if (visual) visual.classList.remove('active');
  if (chip) chip.classList.remove('show');
}

function showSmartTransitionVisual(durationMs) {
  if (!isSmartTransitionEnabled() || document.hidden) return;
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
  if (chip) chip.classList.add('show');
  smartTransitionVisualTimer = setTimeout(hideSmartTransitionVisual, Math.max(1400, Number(durationMs) || 7200) + 900);
}

function setSmartTransitionStyle(style, silent) {
  smartTransitionStyle = normalizeSmartTransitionStyle(style);
  try { localStorage.setItem(SMART_TRANSITION_STORE_KEY, smartTransitionStyle); } catch (_) { }
  if (!isSmartTransitionEnabled()) {
    var pending = smartTransitionPending;
    smartTransitionPending = null;
    if (!cuefieldAutoMixExecuting && pending && pending.preparedAudio) stopCuefieldPreparedAudio(pending.preparedAudio);
    hideSmartTransitionVisual();
  } else if (audio && !audio.paused && currentIdx >= 0) {
    scheduleCuefieldAutoMixPrepare(trackSwitchToken, currentIdx, 260);
  }
  updateSmartTransitionStyleControls();
  if (!silent) showToast(isSmartTransitionEnabled() ? '智能过渡已开启' : '智能过渡已关闭');
}

function cuefieldSongKey(song) {
  return typeof beatMapSongKey === 'function' ? String(beatMapSongKey(song) || '') : '';
}

function cuefieldAutoMixNextIndex(index) {
  if (!Array.isArray(playQueue) || playQueue.length < 2 || playMode === 'single') return -1;
  index = isFinite(Number(index)) ? Math.round(Number(index)) : currentIdx;
  return (index + 1 + playQueue.length) % playQueue.length;
}

function cuefieldAutoMixStatusText(status) {
  return {
    disabled: '已关闭',
    waiting: '等待播放',
    preparing: '正在分析下一首',
    'waiting-beatmap': '正在准备节拍图',
    'missing-audio': '下一首暂不可用',
    fallback: '本组歌曲暂不适合混音',
    ready: '过渡已准备',
    handoff: '正在自动过渡',
    error: '准备失败'
  }[status] || status || '待命';
}

function updateCuefieldAutoMixUi(status) {
  var button = document.getElementById('cuefield-automix-btn');
  if (!button) return;
  var snapshot = cuefieldAutoMix && cuefieldAutoMix.snapshot ? cuefieldAutoMix.snapshot() : null;
  var ready = !!(snapshot && snapshot.pending);
  button.classList.toggle('cuefield-automix-on', !!cuefieldAutoMixEnabled);
  button.classList.toggle('cuefield-automix-ready', !!cuefieldAutoMixEnabled && ready);
  button.setAttribute('aria-pressed', cuefieldAutoMixEnabled ? 'true' : 'false');
  button.title = cuefieldAutoMixEnabled
    ? ('Cuefield AutoMix · ' + (ready ? '过渡已准备' : cuefieldAutoMixStatusText(status || (snapshot && snapshot.lastStatus))))
    : 'Cuefield AutoMix（实验功能，默认关闭）';
}

function cuefieldAutoMixAudioDescriptor(song) {
  var key = cuefieldSongKey(song);
  var cached = key && cuefieldAudioDescriptorCache[key];
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached);
  if (song && (song.type === 'local' || song.source === 'local' || song.localUrl)) {
    return Promise.resolve(typeof ensureFreshLocalPlaybackUrl === 'function' ? ensureFreshLocalPlaybackUrl(song) : !!song.localUrl).then(function () {
      if (!song.localUrl) return null;
      var localDescriptor = {
        proxyUrl: song.localUrl,
        playbackData: { url: song.localUrl, source: 'local', local: true },
        expiresAt: Date.now() + 4 * 60 * 1000
      };
      if (key) cuefieldAudioDescriptorCache[key] = localDescriptor;
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
    if (key) cuefieldAudioDescriptorCache[key] = descriptor;
    return descriptor;
  });
}

function cuefieldLinesToLrc(lines) {
  return (Array.isArray(lines) ? lines : []).slice(0, 800).map(function (line) {
    if (!line || line.fallback || !isFinite(Number(line.t != null ? line.t : line.time))) return '';
    var seconds = Math.max(0, Number(line.t != null ? line.t : line.time) || 0);
    var minutes = Math.floor(seconds / 60);
    var remain = seconds - minutes * 60;
    var stamp = String(minutes).padStart(2, '0') + ':' + remain.toFixed(3).padStart(6, '0');
    var text = String(line.text || '').replace(/[\r\n]+/g, ' ').trim();
    return text ? ('[' + stamp + ']' + text) : '';
  }).filter(Boolean).join('\n');
}

async function cuefieldLyricTextForSong(song, current) {
  if (!song) return '';
  if (current) {
    var liveLines = originalLyricsState && originalLyricsState.lines && originalLyricsState.lines.length
      ? originalLyricsState.lines
      : lyricsLines;
    var liveLrc = cuefieldLinesToLrc(liveLines);
    if (liveLrc) return liveLrc;
  }
  if (typeof readPersistentLyricCache !== 'function') return '';
  try {
    var payload = await readPersistentLyricCache(song);
    if (!payload && typeof lyricEndpointForSong === 'function') {
      payload = await apiJson(lyricEndpointForSong(song), { timeoutMs: 4200 });
      if (payload && typeof writePersistentLyricCache === 'function') writePersistentLyricCache(song, payload);
    }
    if (!payload) return '';
    if (String(payload.lyric || '').trim()) return String(payload.lyric).trim();
    if (typeof parseLyricResponseToOriginalState === 'function') {
      var state = parseLyricResponseToOriginalState(song, payload);
      return cuefieldLinesToLrc(state && state.lines);
    }
  } catch (_) { }
  return '';
}

async function ensureCuefieldAutoMixBeatMap(song, key, context) {
  if (!song || !key) return false;
  if (beatMapCache[key]) return true;
  if (context && context.currentIndex === currentIdx && currentBeatMap && key === cuefieldSongKey(playQueue[currentIdx])) {
    beatMapCache[key] = currentBeatMap;
    if (typeof writeBeatDiskCache === 'function') {
      try { await writeBeatDiskCache(key, currentBeatMap, song, 'cuefield'); } catch (_) { }
    }
    return true;
  }
  var diskMap = typeof readBeatDiskCache === 'function' ? await readBeatDiskCache(key) : null;
  if (diskMap) return true;
  function contextStillCurrent() {
    return !context || (context.token === trackSwitchToken && context.currentIndex === currentIdx);
  }
  if (!contextStillCurrent() || !cuefieldAutoMixEnabled || !isBeatPrefetchCandidate(song) || beatMapBusy || cuefieldAutoMixVisualTransitionBusy()) return false;
  var analysisToken = beatMapToken;
  var descriptor = await cuefieldAutoMixAudioDescriptor(song);
  if (!contextStillCurrent() || analysisToken !== beatMapToken || beatMapBusy || cuefieldAutoMixVisualTransitionBusy()) return !!beatMapCache[key];
  if (!descriptor || !descriptor.proxyUrl || beatMapCache[key]) return !!beatMapCache[key];
  var map = await analyzeAudioBeats(descriptor.proxyUrl, null, analysisToken, {
    background: true,
    prefetch: true,
    cuefieldAutoMix: true,
    song: song
  });
  if (!map || !contextStillCurrent() || analysisToken !== beatMapToken) return false;
  beatMapCache[key] = map;
  if (typeof writeBeatDiskCache === 'function') await writeBeatDiskCache(key, map, song, 'cuefield');
  return true;
}

function initCuefieldAutoMix() {
  if (cuefieldAutoMix || !window.CuefieldAutoMix || typeof window.CuefieldAutoMix.createCuefieldAutoMix !== 'function') return cuefieldAutoMix;
  cuefieldAutoMix = window.CuefieldAutoMix.createCuefieldAutoMix({
    allowWeak: false,
    allowSafetyFallback: false,
    minMixConfidence: 0.64,
    getKey: cuefieldSongKey,
    ensureBeatMap: ensureCuefieldAutoMixBeatMap,
    planTransition: async function (fromKey, toKey, context) {
      var fromSong = context && context.currentSong;
      var toSong = context && context.nextSong;
      var lyricPair = await Promise.all([
        cuefieldLyricTextForSong(fromSong, true),
        cuefieldLyricTextForSong(toSong, false)
      ]);
      return apiJson('/api/cuefield/transition', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fromKey: fromKey,
          toKey: toKey,
          fromLrc: lyricPair[0] || '',
          toLrc: lyricPair[1] || '',
          exitBias: 'late',
          maxEntryTime: 32
        })
      });
    },
    prepareAudioUrl: cuefieldAutoMixAudioDescriptor
  });
  cuefieldAutoMix.setEnabled(cuefieldAutoMixEnabled);
  return cuefieldAutoMix;
}

function clearCuefieldAutoMixTimer() {
  if (cuefieldAutoMixPrepareTimer) clearTimeout(cuefieldAutoMixPrepareTimer);
  cuefieldAutoMixPrepareTimer = 0;
}

function clearCuefieldTimelineTimers() {
  while (cuefieldDelayWaiters.length) {
    var waiter = cuefieldDelayWaiters.pop();
    clearTimeout(waiter.timer);
    waiter.resolve(false);
  }
  cancelCuefieldMediaFade();
}

function cancelCuefieldMediaFade() {
  cuefieldMediaFadeSerial++;
  if (cuefieldMediaFadeRaf) cancelAnimationFrame(cuefieldMediaFadeRaf);
  if (cuefieldMediaFadeTimer) clearInterval(cuefieldMediaFadeTimer);
  cuefieldMediaFadeRaf = 0;
  cuefieldMediaFadeTimer = 0;
  if (cuefieldPairFadeResolve) {
    var resolve = cuefieldPairFadeResolve;
    cuefieldPairFadeResolve = null;
    resolve(false);
  }
}

function claimCuefieldPreparedAudioForPlayback(media) {
  if (!media) return false;
  cancelCuefieldMediaFade();
  if (media.__mineradioPreparedAudioGraph) media.__mineradioPreparedAudioGraph.adopted = true;
  if (media === cuefieldAutoMixPreparedAudio) cuefieldAutoMixPreparedAudio = null;
  return true;
}

function disposeCuefieldPreparedAudioGraph(media) {
  var graph = media && media.__mineradioPreparedAudioGraph;
  if (!graph || graph.adopted) return;
  [graph.source, graph.analyser, graph.beatAnalyser, graph.gainNode].forEach(function (node) {
    try { if (node) node.disconnect(); } catch (_) { }
  });
  try { delete media.__mineradioPreparedAudioGraph; } catch (_) { }
}

function stopCuefieldPreparedAudio(media) {
  media = media || cuefieldAutoMixPreparedAudio;
  if (!media) return;
  // Once the preloaded B deck has become Mineradio's active deck it no longer
  // belongs to Cuefield. A later C-deck preparation must never pause or unload it.
  if (typeof audio !== 'undefined' && media === audio) {
    claimCuefieldPreparedAudioForPlayback(media);
    return;
  }
  disposeCuefieldPreparedAudioGraph(media);
  try { media.pause(); } catch (_) { }
  try { media.removeAttribute('src'); media.load(); } catch (_) { }
  if (media === cuefieldAutoMixPreparedAudio) cuefieldAutoMixPreparedAudio = null;
}

function resetCuefieldAutoMix(reason, options) {
  options = options || {};
  var activeContext = cuefieldActiveTransitionContext;
  var shouldRestoreOutgoing = !!(
    activeContext
    && reason !== 'manual-pause'
    && reason !== 'manual-seek'
    && reason !== 'track-switch'
    && reason !== 'cuefield-handoff'
    && activeContext.outgoingToken === trackSwitchToken
    && activeContext.outgoingIndex === currentIdx
    && activeContext.outgoingMedia === audio
    && audio
    && !audio.paused
    && !audio.ended
  );
  cuefieldTransitionGeneration++;
  clearCuefieldAutoMixTimer();
  clearCuefieldTimelineTimers();
  smartTransitionPending = null;
  if (!options.preserveExecution) cuefieldAutoMixExecuting = false;
  if (!options.preservePreparedAudio) stopCuefieldPreparedAudio();
  if (shouldRestoreOutgoing && typeof rampAudioOutputGain === 'function') rampAudioOutputGain(targetVolume, 120);
  if (!options.preserveExecution) cuefieldActiveTransitionContext = null;
  if (cuefieldAutoMix) cuefieldAutoMix.reset(reason || 'reset');
  if (!options.preserveExecution) hideSmartTransitionVisual();
  updateSmartTransitionStyleControls();
  updateCuefieldAutoMixUi(reason || 'idle');
}

function cuefieldAutoMixPostSwitchDelay(isCuefieldHandoff) {
  return isCuefieldHandoff ? CUEFIELD_AUTOMIX_HANDOFF_SETTLE_MS : CUEFIELD_AUTOMIX_NORMAL_START_SETTLE_MS;
}

function cuefieldAutoMixVisualTransitionBusy() {
  if (typeof isRenderInteractionActive === 'function' && isRenderInteractionActive()) return true;
  if (typeof colorMixTween !== 'undefined' && colorMixTween) return true;
  if (typeof coverDepthTween !== 'undefined' && coverDepthTween) return true;
  if (typeof loadingTween !== 'undefined' && loadingTween) return true;
  return false;
}

function cuefieldAutoMixBlockedByAlbumGapless(index) {
  return typeof albumGaplessQueueCanAdvance === 'function' && albumGaplessQueueCanAdvance(index);
}

function transitionPendingEnabled(pending) {
  return !!(pending && (pending.mode === 'smart-transition' ? isSmartTransitionEnabled() : cuefieldAutoMixEnabled));
}

function toggleCuefieldAutoMix() {
  cuefieldAutoMixEnabled = !cuefieldAutoMixEnabled;
  saveCuefieldAutoMixPreference();
  var runtime = initCuefieldAutoMix();
  if (runtime) runtime.setEnabled(cuefieldAutoMixEnabled);
  if (!cuefieldAutoMixEnabled) resetCuefieldAutoMix('disabled');
  updateCuefieldAutoMixUi(cuefieldAutoMixEnabled ? 'waiting' : 'disabled');
  showToast(cuefieldAutoMixEnabled ? 'Cuefield AutoMix 已开启：只在当前队列自动过渡' : 'Cuefield AutoMix 已关闭');
  if (cuefieldAutoMixEnabled) scheduleCuefieldAutoMixPrepare(trackSwitchToken, currentIdx, 720);
}

function scheduleCuefieldAutoMixPrepare(token, index, delay, attempt) {
  clearCuefieldAutoMixTimer();
  if ((!cuefieldAutoMixEnabled && !isSmartTransitionEnabled()) || !audio || audio.paused || !playQueue || playQueue.length < 2) return false;
  var runtime = cuefieldAutoMixEnabled ? initCuefieldAutoMix() : null;
  if (cuefieldAutoMixEnabled && !runtime && !isSmartTransitionEnabled()) return false;
  var currentIndex = isFinite(Number(index)) ? Math.round(Number(index)) : currentIdx;
  if (cuefieldAutoMixBlockedByAlbumGapless(currentIndex)) return false;
  var nextIndex = cuefieldAutoMixNextIndex(currentIndex);
  if (nextIndex < 0 || nextIndex === currentIndex) return false;
  updateCuefieldAutoMixUi('preparing');
  cuefieldAutoMixPrepareTimer = setTimeout(function () {
    cuefieldAutoMixPrepareTimer = 0;
    runCuefieldAutoMixPrepare(token, currentIndex, nextIndex, attempt || 0);
  }, Math.max(260, Number(delay) || 1200));
  return true;
}

async function runCuefieldAutoMixPrepare(token, currentIndex, nextIndex, attempt) {
  if ((!cuefieldAutoMixEnabled && !isSmartTransitionEnabled()) || token !== trackSwitchToken || currentIndex !== currentIdx) return;
  if (cuefieldAutoMixBlockedByAlbumGapless(currentIndex)) return;
  if (cuefieldAutoMixVisualTransitionBusy()) {
    scheduleCuefieldAutoMixPrepare(token, currentIndex, 900, attempt || 0);
    return;
  }
  var currentSong = playQueue[currentIndex];
  var nextSong = playQueue[nextIndex];
  if (!currentSong || !nextSong) return;
  if (!cuefieldAutoMixEnabled || !cuefieldAutoMix) {
    await prepareSmartTransitionFallback(token, currentIndex);
    return;
  }
  updateCuefieldAutoMixUi('preparing');
  var result = await cuefieldAutoMix.prepare({
    token: token,
    currentIndex: currentIndex,
    nextIndex: nextIndex,
    currentSong: currentSong,
    nextSong: nextSong,
    leadSec: 4,
    introBedLeadSec: 12
  });
  if (
    token !== trackSwitchToken
    || currentIndex !== currentIdx
    || !audio
    || audio.paused
    || cuefieldSongKey(playQueue[currentIndex]) !== cuefieldSongKey(currentSong)
    || cuefieldSongKey(playQueue[nextIndex]) !== cuefieldSongKey(nextSong)
  ) return;
  updateCuefieldAutoMixUi(result && result.status);
  if (result && result.status === 'ready' && result.pending) {
    prepareCuefieldPendingAudio(result.pending);
    showToast('Cuefield 已准备下一首过渡');
    return;
  }
  if (result && (result.status === 'waiting-beatmap' || result.status === 'missing-audio' || result.status === 'busy') && attempt < 3) {
    scheduleCuefieldAutoMixPrepare(token, currentIndex, 2600, attempt + 1);
    return;
  }
  if (isSmartTransitionEnabled()) await prepareSmartTransitionFallback(token, currentIndex);
}

async function prepareSmartTransitionFallback(token, currentIndex) {
  if (!isSmartTransitionEnabled() || token !== trackSwitchToken || currentIndex !== currentIdx || cuefieldAutoMixExecuting) return false;
  if (cuefieldAutoMixBlockedByAlbumGapless(currentIndex)) return false;
  var nextIndex = typeof pickNextQueueIndex === 'function' ? pickNextQueueIndex(currentIndex) : cuefieldAutoMixNextIndex(currentIndex);
  if (nextIndex < 0 || nextIndex === currentIndex) return false;
  var currentSong = playQueue[currentIndex];
  var nextSong = playQueue[nextIndex];
  if (!currentSong || !nextSong) return false;
  var descriptor = await cuefieldAutoMixAudioDescriptor(nextSong);
  if (!descriptor || !descriptor.proxyUrl || token !== trackSwitchToken || currentIndex !== currentIdx) return false;
  var duration = Number(audio && audio.duration) || (typeof getPlaybackDurationSeconds === 'function' ? Number(getPlaybackDurationSeconds()) : 0);
  if (!isFinite(duration) || duration <= 12) return false;
  var leadSec = Math.min(7.6, Math.max(4.2, duration * 0.045));
  var triggerAt = Math.max(Number(audio.currentTime) || 0, duration - leadSec);
  var fadeMs = Math.max(1200, Math.round((duration - triggerAt - 0.12) * 1000));
  smartTransitionPending = {
    mode: 'smart-transition',
    token: token,
    currentIndex: currentIndex,
    nextIndex: nextIndex,
    fromKey: cuefieldSongKey(currentSong),
    toKey: cuefieldSongKey(nextSong),
    audioUrl: descriptor,
    executionMode: 'simple-crossfade',
    mixType: 'crossfade',
    fadeSec: fadeMs / 1000,
    fadeStartA: triggerAt,
    bFadeStart: 0,
    entryTime: 0,
    exitTime: duration,
    triggerAt: triggerAt,
    timeline: [
      { t: -fadeMs / 1000, deck: 'B', op: 'play', at: 0, volume: 0 },
      { t: -fadeMs / 1000, deck: 'AB', op: 'crossfade', duration: fadeMs },
      { t: -0.12, deck: 'B', op: 'handoff' }
    ],
    createdAt: Date.now()
  };
  prepareCuefieldPendingAudio(smartTransitionPending);
  updateSmartTransitionStyleControls('ready');
  return true;
}

function cuefieldPendingDescriptor(pending) {
  var source = pending && pending.audioUrl;
  if (!source) return null;
  return typeof source === 'string' ? { proxyUrl: source, playbackData: { url: source } } : source;
}

function cuefieldTimelineExecution(pending) {
  var descriptor = cuefieldPendingDescriptor(pending);
  if (!pending || !descriptor) return null;
  if (window.CuefieldTimelineExecutor && typeof window.CuefieldTimelineExecutor.buildCuefieldTimelineExecution === 'function') {
    return window.CuefieldTimelineExecutor.buildCuefieldTimelineExecution({
      timeline: pending.timeline,
      entryTime: pending.entryTime,
      executionMode: pending.executionMode,
      targetVolume: targetVolume
    });
  }
  return { leadSec: 4, bStart: Math.max(0, Number(pending.entryTime) || 0), handoffDelayMs: 2600, actions: [] };
}

function cuefieldSetMediaTime(media, seconds) {
  if (!media) return;
  function setTime() {
    try { media.currentTime = Math.max(0, Number(seconds) || 0); } catch (_) { }
  }
  if (media.readyState >= 1) setTime();
  else media.addEventListener('loadedmetadata', setTime, { once: true });
}

function cuefieldCreatePreparedAudioGraph(media) {
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
    console.warn('[CuefieldAutoMix] prepared audio graph fallback:', error && error.message || error);
    return null;
  }
}

function cuefieldWriteIncomingGain(media, value) {
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

function prepareCuefieldPendingAudio(pending) {
  var descriptor = cuefieldPendingDescriptor(pending);
  if (!descriptor || !descriptor.proxyUrl) return null;
  if (pending.preparedAudio && pending.preparedAudio.src) return pending.preparedAudio;
  stopCuefieldPreparedAudio();
  var execution = cuefieldTimelineExecution(pending);
  var media = new Audio();
  media.crossOrigin = 'anonymous';
  media.preload = 'auto';
  media.volume = 1;
  media.muted = false;
  cuefieldCreatePreparedAudioGraph(media);
  if (media.__mineradioPreparedGraphFailed) {
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
  cuefieldWriteIncomingGain(media, 0);
  media.src = descriptor.proxyUrl;
  cuefieldSetMediaTime(media, execution && execution.bStart);
  try { media.load(); } catch (_) { }
  pending.preparedAudio = media;
  pending.timelineExecution = execution;
  cuefieldAutoMixPreparedAudio = media;
  return media;
}

function cuefieldDelay(delayMs, generation) {
  return new Promise(function (resolve) {
    var waiter = {
      timer: 0,
      resolve: function (ok) {
        var index = cuefieldDelayWaiters.indexOf(waiter);
        if (index >= 0) cuefieldDelayWaiters.splice(index, 1);
        resolve(!!ok);
      }
    };
    waiter.timer = setTimeout(function () {
      waiter.resolve(generation === cuefieldTransitionGeneration);
    }, Math.max(0, Number(delayMs) || 0));
    cuefieldDelayWaiters.push(waiter);
  });
}

function cuefieldTransitionStillCurrent(pending, context) {
  if (!pending || !context || !transitionPendingEnabled(pending)) return false;
  if (context.generation !== cuefieldTransitionGeneration) return false;
  if (pending.token !== trackSwitchToken || pending.currentIndex !== currentIdx) return false;
  if (!context.outgoingMedia || audio !== context.outgoingMedia) return false;
  if (context.outgoingMedia.paused && !context.outgoingMedia.ended) return false;
  if (pending.fromKey && cuefieldSongKey(playQueue[pending.currentIndex]) !== pending.fromKey) return false;
  if (pending.toKey && cuefieldSongKey(playQueue[pending.nextIndex]) !== pending.toKey) return false;
  return true;
}

function cuefieldRunEqualPowerCrossfade(pending, nextMedia, durationMs, context) {
  cancelCuefieldMediaFade();
  var serial = cuefieldMediaFadeSerial;
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
    cuefieldPairFadeResolve = resolve;
    function finish(ok) {
      if (settled) return;
      settled = true;
      if (cuefieldPairFadeResolve === resolve) cuefieldPairFadeResolve = null;
      if (cuefieldMediaFadeRaf) cancelAnimationFrame(cuefieldMediaFadeRaf);
      if (cuefieldMediaFadeTimer) clearInterval(cuefieldMediaFadeTimer);
      cuefieldMediaFadeRaf = 0;
      cuefieldMediaFadeTimer = 0;
      resolve(!!ok);
    }
    function applyStep() {
      if (settled) return;
      if (serial !== cuefieldMediaFadeSerial || !cuefieldTransitionStillCurrent(pending, context)) {
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
      cuefieldWriteIncomingGain(nextMedia, incoming);
      if (t >= 1) {
        if (typeof writeAudioOutputGain === 'function') writeAudioOutputGain(0);
        cuefieldWriteIncomingGain(nextMedia, liveTarget);
        finish(true);
      }
    }
    function tick() {
      applyStep();
      if (!settled) cuefieldMediaFadeRaf = requestAnimationFrame(tick);
    }
    cuefieldMediaFadeTimer = setInterval(function () {
      applyStep();
    }, 40);
    cuefieldMediaFadeRaf = requestAnimationFrame(tick);
  });
}

async function cuefieldWaitForMediaTime(media, targetTime, pending, context) {
  targetTime = Math.max(0, Number(targetTime) || 0);
  var watchdogAt = Date.now() + 7000;
  while (media && Number(media.currentTime) + 0.012 < targetTime) {
    if (!cuefieldTransitionStillCurrent(pending, context) || Date.now() >= watchdogAt) return false;
    if (!await cuefieldDelay(24, context.generation)) return false;
  }
  return cuefieldTransitionStillCurrent(pending, context);
}

async function runCuefieldTimeline(pending, nextMedia, context) {
  var execution = pending.timelineExecution || cuefieldTimelineExecution(pending);
  if (!execution) return false;
  pending.timelineExecution = execution;
  clearCuefieldTimelineTimers();
  var fadeMs = Math.max(360, Number(execution.fadeDurationMs) || Number(pending.fadeSec) * 1000 || 1400);
  var fadeStartA = isFinite(Number(pending.fadeStartA))
    ? Number(pending.fadeStartA)
    : Math.max(0, Number(pending.triggerAt) + Math.max(0, Number(execution.fadeStartDelayMs) || 0) / 1000);
  pending.fadeStartA = fadeStartA;
  pending.executionFallback = nextMedia.__mineradioPreparedAudioGraph ? 'shared-context-gain' : 'direct-volume-fallback';
  if (!await cuefieldWaitForMediaTime(context.outgoingMedia, fadeStartA, pending, context)) return false;
  if (!cuefieldTransitionStillCurrent(pending, context)) return false;
  if (nextMedia.readyState < 2) return false;
  var bFadeStart = isFinite(Number(pending.bFadeStart)) ? Math.max(0, Number(pending.bFadeStart)) : Math.max(0, Number(execution.bStart) || 0);
  if (Math.abs((Number(nextMedia.currentTime) || 0) - bFadeStart) > 0.04) cuefieldSetMediaTime(nextMedia, bFadeStart);
  var completed = await cuefieldRunEqualPowerCrossfade(pending, nextMedia, fadeMs, context);
  if (!completed || !cuefieldTransitionStillCurrent(pending, context)) return false;
  return cuefieldTransitionStillCurrent(pending, context);
}

function cuefieldFeedbackContext(pending) {
  var from = playQueue[pending.currentIndex] || {};
  var to = playQueue[pending.nextIndex] || {};
  var chosen = pending.plan && pending.plan.chosen || {};
  var evaluation = chosen.evaluation || {};
  return {
    pair: {
      fromKey: pending.fromKey,
      toKey: pending.toKey,
      fromTitle: from.name || from.title || '',
      fromArtist: from.artist || '',
      toTitle: to.name || to.title || '',
      toArtist: to.artist || ''
    },
    transition: {
      recipe: chosen.recipe || '',
      transitionRecipe: chosen.transitionRecipe || pending.executionMode || '',
      executionMode: pending.executionMode || '',
      tier: evaluation.tier || '',
      score: chosen.score,
      evalScore: evaluation.score,
      risks: evaluation.risks || [],
      exitTime: pending.exitTime,
      entryTime: pending.entryTime
    }
  };
}

function showCuefieldFeedback(context) {
  if (!context) return;
  cuefieldFeedbackState.context = context;
  cuefieldFeedbackState.submitted = false;
  var root = document.getElementById('cuefield-feedback');
  var meta = document.getElementById('cuefield-feedback-meta');
  if (meta) meta.textContent = (context.pair.fromTitle || '当前歌曲') + ' → ' + (context.pair.toTitle || '下一首');
  if (root) root.classList.add('show');
  if (cuefieldFeedbackState.timer) clearTimeout(cuefieldFeedbackState.timer);
  cuefieldFeedbackState.timer = setTimeout(function () { if (root) root.classList.remove('show'); }, 30000);
}

function submitCuefieldFeedback(rating) {
  rating = Number(rating);
  if (rating < 1 || rating > 3 || !cuefieldFeedbackState.context || cuefieldFeedbackState.submitted) return;
  cuefieldFeedbackState.submitted = true;
  apiJson('/api/cuefield/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ rating: rating }, cuefieldFeedbackState.context))
  }).then(function () {
    var root = document.getElementById('cuefield-feedback');
    if (root) root.classList.remove('show');
    showToast('Cuefield 评分已保存');
  }).catch(function () {
    cuefieldFeedbackState.submitted = false;
    showToast('Cuefield 评分保存失败');
  });
}

function tickCuefieldAutoMix() {
  if (cuefieldAutoMixExecuting || !audio) return;
  if (cuefieldAutoMixEnabled && cuefieldAutoMix && cuefieldAutoMix.shouldTrigger({ token: trackSwitchToken, currentIndex: currentIdx, currentTime: audio.currentTime || 0 })) {
    var cuefieldPending = cuefieldAutoMix.consumePending();
    if (cuefieldPending) {
      smartTransitionPending = null;
      executeCuefieldAutoMix(cuefieldPending);
      return;
    }
  }
  if (
    smartTransitionPending
    && transitionPendingEnabled(smartTransitionPending)
    && smartTransitionPending.token === trackSwitchToken
    && smartTransitionPending.currentIndex === currentIdx
    && Number(audio.currentTime) >= Number(smartTransitionPending.triggerAt)
  ) {
    var pending = smartTransitionPending;
    smartTransitionPending = null;
    executeCuefieldAutoMix(pending);
  }
}

function noteCuefieldAutoMixOutgoingEnded(media, token, index) {
  if (!media) return false;
  media.__mineradioCuefieldEndedDeferredToken = Number(token);
  media.__mineradioCuefieldEndedDeferredIndex = Number(index);
  return true;
}

function recoverCuefieldAutoMixEndedOutgoing(pending, context, reason) {
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
  if (outgoing.__mineradioCuefieldEndedRecoveryToken === token) return true;
  outgoing.__mineradioCuefieldEndedRecoveryToken = token;
  cuefieldAutoMixExecuting = false;
  if (cuefieldActiveTransitionContext === context) cuefieldActiveTransitionContext = null;
  if (typeof finalizeListenSession === 'function') finalizeListenSession(true);
  if (pending && pending.mode === 'smart-transition') updateSmartTransitionStyleControls();
  else updateCuefieldAutoMixUi(reason || 'fallback');
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

function cuefieldPromiseWithTimeout(promise, timeoutMs, code) {
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

function waitForCuefieldPlaybackProgress(pending, media, context, startTime, timeoutMs) {
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
      if (!cuefieldTransitionStillCurrent(pending, context) || media.error || media.ended || (event && /^(error|ended|abort)$/.test(event.type))) return finish(false);
      if (!media.paused && isFinite(Number(media.currentTime)) && Number(media.currentTime) >= startTime + 0.05) finish(true);
    }
    ['timeupdate', 'playing', 'error', 'ended', 'abort'].forEach(function (name) { media.addEventListener(name, check); });
    poll = setInterval(check, 80);
    timer = setTimeout(function () { finish(false); }, Math.max(500, Number(timeoutMs) || 1600));
    check();
  });
}

async function executeCuefieldAutoMix(pending) {
  if (!pending || !transitionPendingEnabled(pending) || cuefieldAutoMixExecuting || pending.token !== trackSwitchToken || pending.currentIndex !== currentIdx) return;
  var isSmartTransition = pending.mode === 'smart-transition';
  if (cuefieldAutoMixBlockedByAlbumGapless(pending.currentIndex)) {
    stopCuefieldPreparedAudio(pending.preparedAudio);
    if (cuefieldAutoMix) cuefieldAutoMix.reset('album-gapless-priority');
    updateCuefieldAutoMixUi('waiting');
    return;
  }
  if (pending.fromKey && cuefieldSongKey(playQueue[pending.currentIndex]) !== pending.fromKey) return;
  if (pending.toKey && cuefieldSongKey(playQueue[pending.nextIndex]) !== pending.toKey) return;
  var transitionContext = {
    generation: ++cuefieldTransitionGeneration,
    outgoingMedia: audio,
    outgoingToken: trackSwitchToken,
    outgoingIndex: currentIdx
  };
  cuefieldAutoMixExecuting = true;
  if (isSmartTransition) {
    updateSmartTransitionStyleControls('handoff');
    showSmartTransitionVisual(Number(pending.fadeSec) * 1000);
  } else updateCuefieldAutoMixUi('handoff');
  var nextMedia = prepareCuefieldPendingAudio(pending);
  if (!nextMedia) {
    cuefieldAutoMixExecuting = false;
    if (isSmartTransition) updateSmartTransitionStyleControls();
    else updateCuefieldAutoMixUi('missing-audio');
    recoverCuefieldAutoMixEndedOutgoing(pending, transitionContext, 'missing-audio');
    return;
  }
  cuefieldActiveTransitionContext = transitionContext;
  try {
    cuefieldSetMediaTime(nextMedia, pending.timelineExecution && pending.timelineExecution.bStart);
    cuefieldWriteIncomingGain(nextMedia, 0);
    if (typeof applyAudioOutputDevice === 'function') await applyAudioOutputDevice(nextMedia);
    if (!cuefieldTransitionStillCurrent(pending, transitionContext)) {
      cuefieldAutoMixExecuting = false;
      stopCuefieldPreparedAudio(nextMedia);
      if (cuefieldActiveTransitionContext === transitionContext) cuefieldActiveTransitionContext = null;
      recoverCuefieldAutoMixEndedOutgoing(pending, transitionContext, 'fallback');
      return;
    }
    var nextMediaStartTime = Number(nextMedia.currentTime) || 0;
    await cuefieldPromiseWithTimeout(nextMedia.play(), 3600, isSmartTransition ? 'SMART_TRANSITION_PLAY_TIMEOUT' : 'CUEFIELD_PLAY_TIMEOUT');
    var progressed = await waitForCuefieldPlaybackProgress(pending, nextMedia, transitionContext, nextMediaStartTime, 1600);
    if (!progressed) throw new Error(isSmartTransition ? 'SMART_TRANSITION_CLOCK_STALLED' : 'CUEFIELD_CLOCK_STALLED');
  } catch (_) {
    cuefieldAutoMixExecuting = false;
    stopCuefieldPreparedAudio(nextMedia);
    if (cuefieldActiveTransitionContext === transitionContext) cuefieldActiveTransitionContext = null;
    if (isSmartTransition) updateSmartTransitionStyleControls();
    else updateCuefieldAutoMixUi('error');
    recoverCuefieldAutoMixEndedOutgoing(pending, transitionContext, 'error');
    showToast(isSmartTransition ? '智能过渡失败，已恢复普通切歌' : 'Cuefield AutoMix：下一首预载失败');
    return;
  }
  var feedback = isSmartTransition ? null : cuefieldFeedbackContext(pending);
  var handoffReady = await runCuefieldTimeline(pending, nextMedia, transitionContext);
  if (!handoffReady || !cuefieldTransitionStillCurrent(pending, transitionContext)) {
    cuefieldAutoMixExecuting = false;
    stopCuefieldPreparedAudio(nextMedia);
    if (
      transitionContext.generation === cuefieldTransitionGeneration
      && transitionContext.outgoingToken === trackSwitchToken
      && transitionContext.outgoingIndex === currentIdx
      && transitionContext.outgoingMedia === audio
      && audio
      && !audio.paused
      && !audio.ended
      && typeof rampAudioOutputGain === 'function'
    ) rampAudioOutputGain(targetVolume, 120);
    if (cuefieldActiveTransitionContext === transitionContext) cuefieldActiveTransitionContext = null;
    recoverCuefieldAutoMixEndedOutgoing(pending, transitionContext, 'fallback');
    return;
  }
  var descriptor = cuefieldPendingDescriptor(pending);
  var handoffSucceeded = false;
  async function runCuefieldNormalFallback() {
    var expectedFailedToken = transitionContext.outgoingToken + 1;
    if (
      trackSwitchToken !== expectedFailedToken
      || currentIdx !== pending.nextIndex
      || (audio !== nextMedia && audio !== transitionContext.outgoingMedia)
    ) return false;
    var fallbackOwnerMedia = audio;
    if (fallbackOwnerMedia === nextMedia) {
      try {
        nextMedia.pause();
        nextMedia.removeAttribute('src');
        nextMedia.load();
      } catch (_) { }
      if (transitionContext.outgoingMedia && transitionContext.outgoingMedia !== fallbackOwnerMedia) {
        try {
          transitionContext.outgoingMedia.pause();
          transitionContext.outgoingMedia.removeAttribute('src');
          transitionContext.outgoingMedia.load();
        } catch (_) { }
      }
    } else {
      stopCuefieldPreparedAudio(nextMedia);
    }
    var fallbackResult = await playQueueAt(pending.nextIndex, {
      preserveHomeState: true,
      skipShuffleOrder: true,
      suppressPlayFailureNotice: true
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
      albumGaplessHandoff: true,
      albumGaplessMixed: true,
      preloadedAudio: nextMedia,
      preloadedData: descriptor && descriptor.playbackData || { url: descriptor && descriptor.proxyUrl || '' },
      preloadedProxyAudioUrl: descriptor && descriptor.proxyUrl || '',
      cuefieldAutoMix: true,
      smartTransition: isSmartTransition,
      fade: false
    });
    handoffSucceeded = !!(handoffResult === true && audio === nextMedia && currentIdx === pending.nextIndex && nextMedia.src && !nextMedia.paused && !nextMedia.ended);
    if (!handoffSucceeded) handoffSucceeded = await runCuefieldNormalFallback();
    if (handoffSucceeded && feedback) showCuefieldFeedback(feedback);
  } catch (err) {
    console.warn('[CuefieldAutoMix] handoff failed:', err);
    try { handoffSucceeded = await runCuefieldNormalFallback(); } catch (_) { }
  } finally {
    if (!handoffSucceeded && audio !== nextMedia) stopCuefieldPreparedAudio(nextMedia);
    cuefieldAutoMixExecuting = false;
    if (cuefieldActiveTransitionContext === transitionContext) cuefieldActiveTransitionContext = null;
    if (isSmartTransition) updateSmartTransitionStyleControls();
    else updateCuefieldAutoMixUi(handoffSucceeded ? 'ready' : 'error');
    if (!handoffSucceeded) recoverCuefieldAutoMixEndedOutgoing(pending, transitionContext, 'error');
  }
}

cuefieldAutoMixEnabled = readCuefieldAutoMixPreference();
smartTransitionStyle = readSmartTransitionPreference();
initCuefieldAutoMix();
updateCuefieldAutoMixUi(cuefieldAutoMixEnabled ? 'waiting' : 'disabled');
updateSmartTransitionStyleControls();
