var cubeRemoteEnabled = false;
var cubeRemoteSkin = 'cube';
var cubeRemoteOperation = 0;
var cubeRemoteLastPayload = '';
var trayPlaybackLastPayload = '';

function normalizeCubeRemoteSkin(value) {
  var key = String(value || 'cube');
  return /^(cube|bar|moon)$/.test(key) ? key : 'cube';
}

function cubeRemoteCoverUrl(url) {
  var raw = String(url || '').trim();
  if (!raw) return '';
  if (/^(data:|blob:|\/)/i.test(raw) || /^https?:\/\/127\.0\.0\.1(?::\d+)?\//i.test(raw)) return raw;
  if (typeof coverProxySrc === 'function') return coverProxySrc(raw) || '';
  return '';
}

function cubeRemoteCurrentSong() {
  return playQueue && currentIdx >= 0 ? playQueue[currentIdx] : null;
}

function cubeRemoteMvPlaying() {
  var mv = typeof mvTheaterActiveMedia === 'function' ? mvTheaterActiveMedia() : null;
  return !!(mv && !mv.paused && !mv.ended);
}
function cubeRemotePayload() {
  var meta = typeof currentDesktopSongMeta === 'function' ? currentDesktopSongMeta() : {};
  var song = cubeRemoteCurrentSong();
  var cover = '';
  try {
    cover = song && typeof songCoverSrc === 'function' ? (songCoverSrc(song, 160) || song.cover || '') : (meta.cover || '');
  } catch (_) {
    cover = meta.cover || '';
  }
  return {
    enabled: cubeRemoteEnabled,
    skin: cubeRemoteSkin,
    title: meta.title || '未播放',
    artist: meta.artist || '',
    cover: cubeRemoteCoverUrl(cover),
    // MV 模式下音频是暂停的，全局 playing 为 false。遥控端要报真实的出声状态，
    // 否则用户看到「已暂停」而 MV 正在放。
    playing: !!playing || cubeRemoteMvPlaying(),
    volume: clampRange(Number(targetVolume) || 0, 0, 1),
    muted: Number(targetVolume) <= 0.001,
    lyricsEnabled: !!(fx && fx.desktopLyrics),
  };
}

// 变更检测只看身份，不序列化封面本体。本地歌曲的内嵌封面是几百 KB 的
// base64 data URL，按 320ms 轮询去 stringify + 比较会持续占用主线程。
function cubeRemoteIdentitySignature(includeSkinState) {
  var meta = typeof currentDesktopSongMeta === 'function' ? currentDesktopSongMeta() : {};
  var song = cubeRemoteCurrentSong();
  var identity = song
    ? (song.localKey || song.localPath || song.mid || song.hash || song.id || '')
    : '';
  var parts = [
    identity || (meta.title || '') + '|' + (meta.artist || ''),
    meta.title || '',
    meta.artist || '',
    playing ? '1' : '0',
    (clampRange(Number(targetVolume) || 0, 0, 1)).toFixed(3),
    Number(targetVolume) <= 0.001 ? 'm' : '-'
  ];
  if (includeSkinState) {
    parts.push(cubeRemoteEnabled ? '1' : '0', cubeRemoteSkin, fx && fx.desktopLyrics ? '1' : '0');
  }
  return parts.join('');
}

function updateCubeRemoteControls() {
  var toggle = document.getElementById('t-cubeRemote');
  if (toggle) toggle.classList.toggle('on', cubeRemoteEnabled);
  document.querySelectorAll('[data-cube-remote-skin]').forEach(function (button) {
    button.classList.toggle('active', button.dataset.cubeRemoteSkin === cubeRemoteSkin);
    button.setAttribute('aria-pressed', button.dataset.cubeRemoteSkin === cubeRemoteSkin ? 'true' : 'false');
  });
}

function pushCubeRemoteState(force) {
  if (!cubeRemoteEnabled) return;
  var api = getDesktopWindowApi();
  if (!api || typeof api.updateCubeRemote !== 'function') return;
  var signature = cubeRemoteIdentitySignature(true);
  if (!force && signature === cubeRemoteLastPayload) return;
  cubeRemoteLastPayload = signature;
  api.updateCubeRemote(cubeRemotePayload()).catch(function (error) { console.warn('Cube remote update failed:', error); });
}

function pushTrayPlaybackState(force) {
  var api = getDesktopWindowApi();
  if (!api || typeof api.updateTrayPlayback !== 'function') return;
  var signature = cubeRemoteIdentitySignature(false);
  if (!force && signature === trayPlaybackLastPayload) return;
  trayPlaybackLastPayload = signature;
  var payload = cubeRemotePayload();
  api.updateTrayPlayback({
    title: payload.title,
    artist: payload.artist,
    cover: payload.cover,
    playing: payload.playing,
    volume: payload.volume,
    muted: payload.muted,
  }).catch(function (error) { console.warn('Tray playback update failed:', error); });
}

async function setCubeRemoteEnabled(enabled, options) {
  options = options || {};
  var api = getDesktopWindowApi();
  if (!api || typeof api.setCubeRemoteEnabled !== 'function') {
    cubeRemoteEnabled = false;
    updateCubeRemoteControls();
    if (!options.quiet) showToast('音乐遥控器仅在桌面端可用');
    return false;
  }
  var operation = ++cubeRemoteOperation;
  cubeRemoteEnabled = enabled === true;
  updateCubeRemoteControls();
  try {
    var result = await api.setCubeRemoteEnabled(cubeRemoteEnabled, cubeRemotePayload());
    if (operation !== cubeRemoteOperation) return false;
    if (!result || result.ok !== true) throw new Error(result && result.error || 'CUBE_REMOTE_FAILED');
    cubeRemoteEnabled = result.enabled === true;
    cubeRemoteSkin = normalizeCubeRemoteSkin(result.skin);
    cubeRemoteLastPayload = '';
    updateCubeRemoteControls();
    pushCubeRemoteState(true);
    if (!options.quiet) showToast(cubeRemoteEnabled ? '音乐遥控器已开启' : '音乐遥控器已关闭');
    return true;
  } catch (error) {
    if (operation !== cubeRemoteOperation) return false;
    cubeRemoteEnabled = false;
    updateCubeRemoteControls();
    if (!options.quiet) showToast(error && error.message || '音乐遥控器切换失败');
    return false;
  }
}

function toggleCubeRemote() {
  return setCubeRemoteEnabled(!cubeRemoteEnabled);
}

async function setCubeRemoteSkin(value) {
  var next = normalizeCubeRemoteSkin(value);
  var previous = cubeRemoteSkin;
  cubeRemoteSkin = next;
  cubeRemoteLastPayload = '';
  updateCubeRemoteControls();
  var api = getDesktopWindowApi();
  if (!api || typeof api.updateCubeRemote !== 'function') return;
  try {
    var result = await api.updateCubeRemote(cubeRemotePayload());
    if (!result || result.ok !== true) throw new Error(result && result.error || 'CUBE_REMOTE_SKIN_FAILED');
    cubeRemoteSkin = normalizeCubeRemoteSkin(result.skin);
    updateCubeRemoteControls();
    showToast('遥控器样式已切换');
  } catch (error) {
    cubeRemoteSkin = previous;
    updateCubeRemoteControls();
    showToast(error && error.message || '遥控器样式切换失败');
  }
}

function handleCubeRemoteCommand(payload) {
  var command = payload && payload.command;
  if (command === 'toggle-play') togglePlay();
  else if (command === 'next') nextTrack(true);
  else if (command === 'previous') prevTrack(true);
  else if (command === 'set-volume') setVolume(Number(payload.value) || 0, false);
  else if (command === 'mute') toggleMute();
  else if (command === 'toggle-lyrics') toggleFx('desktopLyrics');
}

function handleTrayCommand(payload) {
  var command = payload && payload.command;
  if (command === 'toggle-play') togglePlay();
  else if (command === 'next') nextTrack(true);
  else if (command === 'previous') prevTrack(true);
  else if (command === 'volume') setVolume(clampRange(Number(targetVolume) + (Number(payload.value) || 0), 0, 1), false);
  else if (command === 'mute') toggleMute();
}

async function hydrateCubeRemote() {
  var api = getDesktopWindowApi();
  if (!api || typeof api.getCubeRemoteSettings !== 'function') return;
  try {
    var settings = await api.getCubeRemoteSettings();
    cubeRemoteEnabled = !!(settings && settings.enabled);
    cubeRemoteSkin = normalizeCubeRemoteSkin(settings && settings.skin);
    updateCubeRemoteControls();
    if (cubeRemoteEnabled) await setCubeRemoteEnabled(true, { quiet: true });
  } catch (error) {
    cubeRemoteEnabled = false;
    updateCubeRemoteControls();
    console.warn('Cube remote hydration failed:', error);
  }
}

function bindCubeRemoteController() {
  if (bindCubeRemoteController.bound) return;
  bindCubeRemoteController.bound = true;
  document.querySelectorAll('[data-cube-remote-skin]').forEach(function (button) {
    button.addEventListener('click', function () { setCubeRemoteSkin(button.dataset.cubeRemoteSkin); });
  });
  var api = getDesktopWindowApi();
  if (api && typeof api.onCubeRemoteCommand === 'function') api.onCubeRemoteCommand(handleCubeRemoteCommand);
  if (api && typeof api.onTrayCommand === 'function') api.onTrayCommand(handleTrayCommand);
  if (api && typeof api.onCubeRemoteEnabledState === 'function') {
    api.onCubeRemoteEnabledState(function (payload) {
      cubeRemoteEnabled = !!(payload && payload.enabled);
      cubeRemoteSkin = normalizeCubeRemoteSkin(payload && payload.skin);
      cubeRemoteLastPayload = '';
      updateCubeRemoteControls();
    });
  }
  setInterval(function () {
    pushTrayPlaybackState(false);
    pushCubeRemoteState(false);
  }, 320);
  pushTrayPlaybackState(true);
  hydrateCubeRemote();
  if (typeof hydrateLanRemote === 'function') hydrateLanRemote();
}
