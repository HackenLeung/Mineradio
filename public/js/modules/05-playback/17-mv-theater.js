// ============================================================
//  MV 剧场
// ============================================================
// MV 只有小云有：kugou-api.js / qq-vip-api.js 里没有任何 MV 接口，所以
// songCanPlayMv() 对小Q / 小狗恒为 false，底栏那颗按钮会置灰。
//
// 音频策略：MV 用自带音轨，进剧场时暂停 audio、退出时按原状态恢复。
// 刻意不把 <video> 接进 audioCtx —— 08-audio-graph-controls.js 那套
// MediaElementSource 有「一个元素一生只能绑一次」的生命周期约束和整条恢复链，
// 为了让频谱动一动去碰它，风险远大于收益。代价是 EQ / 频谱 / 音调对 MV 无效，
// 音调那一行在 MV 模式下会置灰（见 mv-theater.css）。
var MV_RESOLUTION_LABELS = { 240: '240P', 480: '480P', 720: '720P', 1080: '1080P' };
var MV_CHROME_IDLE_MS = 2500;
var mvTheaterState = {
  active: false,
  mvid: '',
  songKey: '',
  requestToken: 0,
  resolution: 1080,
  resolutions: [],
  url: '',
  error: '',
  // 退出时要还原的音频状态。
  resumeAudio: false,
  chromeTimer: 0,
  detail: null,
};

function mvTheaterElement(id) { return document.getElementById(id); }
function mvVideoElement() { return mvTheaterElement('mv-video'); }

// 小云的 song.mv / mvid，0 表示没有 MV。
function mvIdForSong(song) {
  if (!song) return '';
  if (typeof songProviderKey === 'function' && songProviderKey(song) !== 'netease') return '';
  var raw = song.mv != null ? song.mv : (song.mvid != null ? song.mvid : 0);
  var id = parseInt(raw, 10);
  return isFinite(id) && id > 0 ? String(id) : '';
}

function songCanPlayMv(song) { return !!mvIdForSong(song); }

// 剧场开着且视频真的有源 —— 只用于「读数」：进度、时长、时间显示、遥控上报。
// 加载中还没有 src，那时进度条不该切过去。
function mvTheaterActiveMedia() {
  if (!mvTheaterState.active) return null;
  var video = mvVideoElement();
  if (!video || !(video.currentSrc || video.src)) return null;
  return video;
}

// 「意图」门槛：谁该接住播放键 / 空格 / 媒体键 / 进度拖拽。只看剧场开没开，
// 不看视频就绪 —— 开场时音频已经被暂停了，输入必须立刻被接管。用
// mvTheaterActiveMedia() 当这个门槛是错的：取址那 15s 里它是 null，输入会落回
// 音频分支，把刚暂停的歌恢复，等视频就绪 autoplay 后两路声音一起响。取址失败时
// 更糟 —— 视频永远不就绪，暗场背后会一直能放歌。
function mvTheaterOwnsPlayback() {
  return !!mvTheaterState.active;
}

function mvResolutionLabel(r) {
  return MV_RESOLUTION_LABELS[Number(r)] || (String(r || '') + 'P');
}

function setMvStatus(kind, text, retry) {
  var theater = mvTheaterElement('mv-theater');
  var label = mvTheaterElement('mv-status-text');
  var retryBtn = mvTheaterElement('mv-status-retry');
  if (!theater) return;
  theater.classList.toggle('is-loading', kind === 'loading');
  theater.classList.toggle('is-error', kind === 'error');
  if (label) label.textContent = text || '';
  if (retryBtn) retryBtn.hidden = !retry;
}

function syncMvButton(song) {
  var btn = mvTheaterElement('mv-btn');
  if (!btn) return;
  song = song || (typeof currentCoverSong === 'function' ? currentCoverSong() : null);
  var canPlay = songCanPlayMv(song);
  btn.disabled = !canPlay && !mvTheaterState.active;
  btn.classList.toggle('is-on', mvTheaterState.active);
  btn.setAttribute('aria-pressed', mvTheaterState.active ? 'true' : 'false');
  var title = mvTheaterState.active
    ? '退出 MV'
    : (canPlay ? '看 MV' : (song && typeof songProviderKey === 'function' && songProviderKey(song) !== 'netease'
      ? 'MV 只有小云音源支持'
      : '这首歌没有 MV'));
  btn.title = title;
  btn.setAttribute('aria-label', title);
}

// 鼠标不动就把卡上文字淡掉：看 MV 时画面上不该常驻标题和按钮。
function bumpMvChromeIdle() {
  var theater = mvTheaterElement('mv-theater');
  if (!theater) return;
  theater.classList.remove('chrome-idle');
  if (mvTheaterState.chromeTimer) clearTimeout(mvTheaterState.chromeTimer);
  mvTheaterState.chromeTimer = setTimeout(function () {
    mvTheaterState.chromeTimer = 0;
    if (!mvTheaterState.active) return;
    var quality = mvTheaterElement('mv-quality');
    // 画质菜单开着时不要淡掉，否则菜单会连着标题一起消失。
    if (quality && quality.classList.contains('open')) return;
    var el = mvTheaterElement('mv-theater');
    if (el) el.classList.add('chrome-idle');
  }, MV_CHROME_IDLE_MS);
}

function renderMvQualityList() {
  var wrap = mvTheaterElement('mv-quality');
  var btn = mvTheaterElement('mv-quality-btn');
  var list = mvTheaterElement('mv-quality-list');
  if (!wrap || !btn || !list) return;
  var options = mvTheaterState.resolutions.length ? mvTheaterState.resolutions : [mvTheaterState.resolution];
  btn.textContent = mvResolutionLabel(mvTheaterState.resolution);
  // 只有一档时没什么可选，直接禁用，别给一个点开只有一行的菜单。
  btn.disabled = options.length < 2;
  list.innerHTML = options.slice().reverse().map(function (r) {
    var active = Number(r) === Number(mvTheaterState.resolution);
    return '<button type="button" role="menuitem" class="mv-quality-option' + (active ? ' is-active' : '')
      + '" data-mv-resolution="' + r + '">' + mvResolutionLabel(r) + (active ? '<span aria-hidden="true">✓</span>' : '')
      + '</button>';
  }).join('');
}

function closeMvQualityMenu() {
  var wrap = mvTheaterElement('mv-quality');
  var btn = mvTheaterElement('mv-quality-btn');
  if (wrap) wrap.classList.remove('open');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

function toggleMvQualityMenu(event) {
  if (event) event.stopPropagation();
  var wrap = mvTheaterElement('mv-quality');
  var btn = mvTheaterElement('mv-quality-btn');
  if (!wrap || !btn || btn.disabled) return;
  var open = !wrap.classList.contains('open');
  wrap.classList.toggle('open', open);
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  bumpMvChromeIdle();
}

function renderMvMeta() {
  var titleEl = mvTheaterElement('mv-title');
  var subEl = mvTheaterElement('mv-sub');
  var detail = mvTheaterState.detail || {};
  var song = typeof currentCoverSong === 'function' ? currentCoverSong() : null;
  if (titleEl) titleEl.textContent = detail.name || (song && song.name) || 'MV';
  if (subEl) {
    var parts = [];
    var artist = detail.artist || (song && song.artist) || '';
    if (artist) parts.push(artist);
    if (detail.publishTime) parts.push(String(detail.publishTime).slice(0, 10));
    parts.push('小云 MV');
    subEl.textContent = parts.join(' · ');
  }
}

// 拉 URL 并挂到 <video>。resumeAt 用于切画质时接回原位置。
function loadMvSource(resumeAt, autoplay) {
  var video = mvVideoElement();
  if (!video || !mvTheaterState.mvid) return Promise.resolve(false);
  var token = ++mvTheaterState.requestToken;
  setMvStatus('loading', '正在载入 MV…', false);
  var url = '/api/mv/url?id=' + encodeURIComponent(mvTheaterState.mvid) + '&r=' + mvTheaterState.resolution;
  return apiJson(url, { timeoutMs: 15000 }).then(function (data) {
    if (token !== mvTheaterState.requestToken || !mvTheaterState.active) return false;
    if (!data || data.error || !data.proxyUrl) {
      mvTheaterState.error = (data && data.error) || 'MV 地址获取失败';
      setMvStatus('error', mvTheaterState.error, true);
      return false;
    }
    mvTheaterState.url = data.proxyUrl;
    mvTheaterState.error = '';
    // 上游可能降档给别的清晰度，按实际生效的回填 chip，别显示一个没生效的档位。
    if (data.resolution) mvTheaterState.resolution = Number(data.resolution) || mvTheaterState.resolution;
    renderMvQualityList();
    video.src = data.proxyUrl;
    applyMvVideoOutput();
    var seekTo = Number(resumeAt) || 0;
    if (seekTo > 0.4) {
      var seekOnce = function () {
        video.removeEventListener('loadedmetadata', seekOnce);
        try { video.currentTime = seekTo; } catch (e) { }
      };
      video.addEventListener('loadedmetadata', seekOnce);
    }
    if (autoplay !== false) {
      var playResult = video.play();
      if (playResult && playResult.catch) {
        playResult.catch(function (err) {
          if (token !== mvTheaterState.requestToken) return;
          console.warn('[MvTheater] play rejected:', err && (err.message || err));
        });
      }
    }
    return true;
  }).catch(function (err) {
    if (token !== mvTheaterState.requestToken) return false;
    mvTheaterState.error = 'MV 载入失败';
    setMvStatus('error', 'MV 载入失败', true);
    console.warn('[MvTheater]', err && (err.message || err));
    return false;
  });
}

function loadMvDetail() {
  var mvid = mvTheaterState.mvid;
  if (!mvid) return;
  // 用 mvid 而不是 requestToken 做时效判定：详情只跟「哪支 MV」有关，和换清晰度
  // 无关。之前用 token 是错的 —— 开场先调 loadMvDetail() 再调 loadMvSource()，
  // 后者会 ++requestToken，等详情回来时 token 必然已经过期，标题和清晰度列表
  // 永远不会渲染上去。
  apiJson('/api/mv/detail?id=' + encodeURIComponent(mvid), { timeoutMs: 12000 }).then(function (data) {
    if (mvid !== mvTheaterState.mvid || !mvTheaterState.active) return;
    var mv = data && data.mv;
    if (!mv) return;
    mvTheaterState.detail = mv;
    if (Array.isArray(mv.resolutions) && mv.resolutions.length) {
      mvTheaterState.resolutions = mv.resolutions.slice();
    }
    renderMvMeta();
    renderMvQualityList();
  }).catch(function () { /* 详情失败不影响播放，标题退回歌曲名 */ });
}

// 音量 / 倍速跟随全局设置。gainNode 那条链只服务 audio，视频只能写元素属性。
function applyMvVideoOutput() {
  var video = mvVideoElement();
  if (!video) return;
  video.muted = false;
  if (typeof targetVolume !== 'undefined') video.volume = Math.max(0, Math.min(1, Number(targetVolume) || 0));
  if (typeof playbackTuning !== 'undefined' && playbackTuning) {
    try { video.preservesPitch = true; } catch (e) { }
    try { video.playbackRate = Number(playbackTuning.speed) || 1; } catch (e) { }
  }
  // 只写 sinkId，不走 applyAudioOutputDevice()：那个函数会顺手
  // bindAudioOutputMirrorEvents(video)，把视频的 play/pause/seeking 接到多设备
  // 镜像同步上，而镜像镜的是 audio 的 src —— 视频事件去驱动它只会打乱镜像。
  if (typeof audioOutputDeviceId !== 'undefined' && audioOutputDeviceId && typeof video.setSinkId === 'function') {
    try { video.setSinkId(audioOutputDeviceId).catch(function () { }); } catch (e) { }
  }
}

function switchMvResolution(resolution) {
  var next = parseInt(resolution, 10);
  if (!isFinite(next) || next === Number(mvTheaterState.resolution)) { closeMvQualityMenu(); return; }
  var video = mvVideoElement();
  var resumeAt = video && isFinite(video.currentTime) ? video.currentTime : 0;
  var wasPlaying = !!(video && !video.paused && !video.ended);
  mvTheaterState.resolution = next;
  closeMvQualityMenu();
  renderMvQualityList();
  loadMvSource(resumeAt, wasPlaying);
  showToast('MV 画质 ' + mvResolutionLabel(next));
}

async function openMvTheater(song) {
  song = song || (typeof currentCoverSong === 'function' ? currentCoverSong() : null);
  var mvid = mvIdForSong(song);
  if (!mvid) {
    showToast(song && typeof songProviderKey === 'function' && songProviderKey(song) !== 'netease'
      ? 'MV 只有小云音源支持'
      : '这首歌没有 MV');
    return false;
  }
  var theater = mvTheaterElement('mv-theater');
  var video = mvVideoElement();
  if (!theater || !video) return false;
  if (mvTheaterState.active && mvTheaterState.mvid === mvid) return true;

  // 沉浸模式会隐掉底栏，而 MV 的播放控制全靠底栏，两者不能并存。
  if (typeof immersiveMode !== 'undefined' && immersiveMode && typeof setImmersiveMode === 'function') {
    setImmersiveMode(false);
  }
  mvTheaterState.active = true;
  mvTheaterState.mvid = mvid;
  mvTheaterState.songKey = typeof queueItemKey === 'function' ? queueItemKey(song) : '';
  mvTheaterState.detail = null;
  mvTheaterState.resolutions = [];
  mvTheaterState.resolution = 1080;
  mvTheaterState.error = '';
  mvTheaterState.url = '';

  // MV 用自带音轨，先把歌停掉，退出时按这个标记恢复。
  mvTheaterState.resumeAudio = !!(typeof audio !== 'undefined' && audio && !audio.paused && !audio.ended);
  if (typeof audio !== 'undefined' && audio) {
    if (typeof resetSmartCrossfade === 'function') resetSmartCrossfade('mv-theater-open');
    try { audio.pause(); } catch (e) { }
  }

  document.body.classList.add('mv-theater-active');
  theater.setAttribute('aria-hidden', 'false');
  theater.classList.add('is-open');
  renderMvMeta();
  renderMvQualityList();
  syncMvButton(song);
  bumpMvChromeIdle();
  loadMvDetail();
  await loadMvSource(0, true);
  return true;
}

function closeMvTheater(opts) {
  opts = opts || {};
  if (!mvTheaterState.active) return false;
  var theater = mvTheaterElement('mv-theater');
  var video = mvVideoElement();
  mvTheaterState.requestToken++;
  mvTheaterState.active = false;
  closeMvQualityMenu();
  if (mvTheaterState.chromeTimer) { clearTimeout(mvTheaterState.chromeTimer); mvTheaterState.chromeTimer = 0; }
  // 挂着的单击判定不清掉，会在剧场关掉之后才触发一次 toggle。
  if (mvClickTimer) { clearTimeout(mvClickTimer); mvClickTimer = 0; }
  if (video) {
    try { video.pause(); } catch (e) { }
    // 清空 src 并 load() 才能真正断开下载，只 pause 会继续吃带宽。
    try { video.removeAttribute('src'); video.load(); } catch (e) { }
  }
  if (theater) {
    theater.classList.remove('is-open', 'is-loading', 'is-error', 'chrome-idle', 'is-fullscreen');
    theater.setAttribute('aria-hidden', 'true');
  }
  document.body.classList.remove('mv-theater-active');
  setMvStatus('', '', false);
  syncMvButton();

  var shouldResume = mvTheaterState.resumeAudio && opts.resumeAudio !== false;
  mvTheaterState.resumeAudio = false;
  if (shouldResume && typeof audio !== 'undefined' && audio && audio.src) {
    if (typeof attemptAudioPlay === 'function') attemptAudioPlay({ manual: true, silent: true });
    else { try { audio.play(); } catch (e) { } }
  } else if (typeof syncPlaybackStateFromAudioEvent === 'function') {
    // 不恢复播放时得把播放图标按音频的真实状态刷一遍：视频那两个
    // play/pause 监听在 active 置 false 后就提前 return 了，图标会卡在 MV
    // 留下的「正在播放」上，而其实什么都没在响。
    syncPlaybackStateFromAudioEvent('mv-theater-close');
  }
  if (typeof updatePlaybackProgressUi === 'function') updatePlaybackProgressUi();
  if (typeof forcePlaybackControlsInteractive === 'function') forcePlaybackControlsInteractive();
  return true;
}

function toggleMvTheater() {
  if (mvTheaterState.active) { closeMvTheater(); return; }
  openMvTheater();
}

// 底栏播放键在 MV 模式下作用于视频。返回 true 表示这次 toggle 已经被吃掉，
// 调用方不要再走音频那条。
function toggleMvPlayback() {
  if (!mvTheaterOwnsPlayback()) return false;
  var video = mvTheaterActiveMedia();
  // 载入中 / 错误态：没有可播的视频，但也绝不能放行给音频。状态浮层已经在显示
  // 「正在载入 MV…」或错误加重试，这里静默吃掉就行。
  if (!video) return true;
  if (video.paused || video.ended) {
    var result = video.play();
    if (result && result.catch) result.catch(function () { });
  } else {
    try { video.pause(); } catch (e) { }
  }
  return true;
}

// 进度条拖拽的 MV 分支。刻意不复用 commitProgressSeek：那条链绑死 audio
// （progressSeekMediaStillCurrent 里 audio === media），还带 gainNode 压音和
// 智能过渡复位。视频只需要写 currentTime。
var mvSeekState = { active: false, rect: null, wasPlaying: false };
var mvClickTimer = 0;
var mvSuppressClickUntil = 0;
function mvSeekRatioFromEvent(e) {
  var rect = mvSeekState.rect;
  if (!rect || !rect.width) return 0;
  return clampRange((e.clientX - rect.left) / rect.width, 0, 1);
}
function mvSeekPreview(e) {
  var video = mvTheaterActiveMedia();
  if (!video || !isFinite(video.duration) || video.duration <= 0) return;
  var target = mvSeekRatioFromEvent(e) * video.duration;
  if (typeof setProgressVisual === 'function') setProgressVisual(target / video.duration * 100);
  var timeDisplay = document.getElementById('time-display');
  if (timeDisplay && typeof formatProgramTime === 'function') {
    timeDisplay.textContent = formatProgramTime(target) + ' / ' + formatProgramTime(video.duration);
  }
  return target;
}

function bindMvTheaterEvents() {
  var theater = mvTheaterElement('mv-theater');
  var video = mvVideoElement();
  if (!theater || !video) return;

  video.addEventListener('loadeddata', function () {
    setMvStatus('', '', false);
  });
  video.addEventListener('waiting', function () {
    if (mvTheaterState.error) return;
    setMvStatus('loading', '缓冲中…', false);
  });
  video.addEventListener('playing', function () {
    setMvStatus('', '', false);
  });
  video.addEventListener('error', function () {
    if (!mvTheaterState.active) return;
    mvTheaterState.error = 'MV 播放失败';
    setMvStatus('error', 'MV 播放失败', true);
  });
  // MV 放完回到音频，不自动串下一首 MV：看完一支就该回到听歌的状态。
  video.addEventListener('ended', function () {
    if (!mvTheaterState.active) return;
    closeMvTheater();
  });
  ['play', 'pause', 'timeupdate', 'durationchange', 'loadedmetadata', 'seeked'].forEach(function (name) {
    video.addEventListener(name, function () {
      if (!mvTheaterState.active) return;
      if (name === 'play' || name === 'pause') {
        if (typeof setPlayIcon === 'function') setPlayIcon(!video.paused && !video.ended);
      }
      if (typeof updatePlaybackProgressUi === 'function') updatePlaybackProgressUi();
    });
  });
  // 双击视频进/出 MV 全屏铺满。这是剧场自己的形态，不动窗口全屏状态。
  video.addEventListener('dblclick', function () {
    // 双击会先派发两次 click。不吃掉的话一次双击顺带把视频暂停再播放，
    // 画面在切全屏的同时还要卡一下。
    if (mvClickTimer) { clearTimeout(mvClickTimer); mvClickTimer = 0; }
    mvSuppressClickUntil = performance.now() + 320;
    theater.classList.toggle('is-fullscreen');
    bumpMvChromeIdle();
  });
  // 单击播放/暂停延后一点执行，给 dblclick 留出判定窗口。
  video.addEventListener('click', function () {
    if (performance.now() < mvSuppressClickUntil) return;
    if (mvClickTimer) clearTimeout(mvClickTimer);
    mvClickTimer = setTimeout(function () {
      mvClickTimer = 0;
      if (performance.now() < mvSuppressClickUntil) return;
      toggleMvPlayback();
    }, 220);
  });

  theater.addEventListener('pointermove', bumpMvChromeIdle);
  // 点卡片外的暗场退出，和项目里其他弹窗的行为一致。
  theater.addEventListener('pointerdown', function (e) {
    if (e.target === theater || (e.target && e.target.classList.contains('mv-theater-scrim'))) closeMvTheater();
  });

  var closeBtn = mvTheaterElement('mv-close');
  if (closeBtn) closeBtn.addEventListener('click', function () { closeMvTheater(); });
  var retryBtn = mvTheaterElement('mv-status-retry');
  if (retryBtn) retryBtn.addEventListener('click', function () {
    mvTheaterState.error = '';
    loadMvSource(0, true);
  });
  var qualityBtn = mvTheaterElement('mv-quality-btn');
  if (qualityBtn) qualityBtn.addEventListener('click', toggleMvQualityMenu);
  var qualityList = mvTheaterElement('mv-quality-list');
  if (qualityList) qualityList.addEventListener('click', function (e) {
    var option = e.target && e.target.closest ? e.target.closest('[data-mv-resolution]') : null;
    if (!option) return;
    switchMvResolution(option.getAttribute('data-mv-resolution'));
  });

  // MV 模式下的进度拖拽。04-progress-seek.js 里那个 pointerdown 有对应的提前
  // return，两个监听不会同时生效。
  var bar = document.getElementById('progress-bar');
  if (bar) {
    bar.addEventListener('pointerdown', function (e) {
      var media = mvTheaterActiveMedia();
      if (!media || !isFinite(media.duration) || media.duration <= 0) return;
      mvSeekState.active = true;
      mvSeekState.rect = bar.getBoundingClientRect();
      mvSeekState.wasPlaying = !media.paused && !media.ended;
      bar.classList.add('is-dragging');
      try { bar.setPointerCapture(e.pointerId); } catch (err) { }
      if (mvSeekState.wasPlaying) { try { media.pause(); } catch (err) { } }
      mvSeekPreview(e);
    });
    bar.addEventListener('pointermove', function (e) {
      if (!mvSeekState.active) return;
      mvSeekPreview(e);
    });
    var endMvSeek = function (e, commit) {
      if (!mvSeekState.active) return;
      var media = mvTheaterActiveMedia();
      var target = commit !== false ? mvSeekPreview(e) : 0;
      mvSeekState.active = false;
      mvSeekState.rect = null;
      bar.classList.remove('is-dragging');
      try { if (e && e.pointerId != null) bar.releasePointerCapture(e.pointerId); } catch (err) { }
      if (!media) return;
      if (commit !== false && isFinite(target)) {
        try { media.currentTime = target; } catch (err) { }
      }
      if (mvSeekState.wasPlaying) {
        var result = media.play();
        if (result && result.catch) result.catch(function () { });
      }
      mvSeekState.wasPlaying = false;
    };
    bar.addEventListener('pointerup', function (e) { endMvSeek(e, true); });
    bar.addEventListener('pointercancel', function (e) { endMvSeek(e, false); });
    bar.addEventListener('lostpointercapture', function (e) { endMvSeek(e, true); });
  }

  document.addEventListener('pointerdown', function (e) {
    var wrap = mvTheaterElement('mv-quality');
    if (!wrap || !wrap.classList.contains('open')) return;
    if (!wrap.contains(e.target)) closeMvQualityMenu();
  });
  document.addEventListener('keydown', function (e) {
    if (!mvTheaterState.active) return;
    if (e.key === 'Escape') {
      var wrap = mvTheaterElement('mv-quality');
      if (wrap && wrap.classList.contains('open')) { closeMvQualityMenu(); return; }
      closeMvTheater();
    }
  });
}

bindMvTheaterEvents();
syncMvButton();
