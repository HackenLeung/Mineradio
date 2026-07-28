var cubeRemoteEnabled = false;
var cubeRemoteSkin = 'cube';
var cubeRemoteOperation = 0;
var cubeRemoteLastPayload = '';

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

function cubeRemotePayload() {
  var meta = typeof currentDesktopSongMeta === 'function' ? currentDesktopSongMeta() : {};
  var song = playQueue && currentIdx >= 0 ? playQueue[currentIdx] : null;
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
    playing: !!playing,
    volume: clampRange(Number(targetVolume) || 0, 0, 1),
    muted: Number(targetVolume) <= 0.001,
    lyricsEnabled: !!(fx && fx.desktopLyrics),
  };
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
  var payload = cubeRemotePayload();
  var signature = JSON.stringify(payload);
  if (!force && signature === cubeRemoteLastPayload) return;
  cubeRemoteLastPayload = signature;
  api.updateCubeRemote(payload).catch(function (error) { console.warn('Cube remote update failed:', error); });
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
  if (api && typeof api.onCubeRemoteEnabledState === 'function') {
    api.onCubeRemoteEnabledState(function (payload) {
      cubeRemoteEnabled = !!(payload && payload.enabled);
      cubeRemoteSkin = normalizeCubeRemoteSkin(payload && payload.skin);
      cubeRemoteLastPayload = '';
      updateCubeRemoteControls();
    });
  }
  setInterval(function () { pushCubeRemoteState(false); }, 320);
  hydrateCubeRemote();
}
