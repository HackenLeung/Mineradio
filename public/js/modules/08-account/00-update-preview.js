// ============================================================
function formatUpdateBytes(bytes) {
  bytes = Number(bytes) || 0;
  if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(2).replace(/\.00$/, '') + ' GB';
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '') + ' MB';
  if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB';
  return bytes + ' B';
}
function formatUpdateSpeed(bytesPerSecond) {
  bytesPerSecond = Number(bytesPerSecond) || 0;
  return bytesPerSecond > 0 ? (formatUpdateBytes(bytesPerSecond) + '/s') : '';
}
function updateProgressDetailText() {
  var parts = [];
  if (updatePreviewState.attempts > 1 && updatePreviewState.attempt > 0) {
    parts.push('线路 ' + updatePreviewState.attempt + '/' + updatePreviewState.attempts);
  }
  if (updatePreviewState.sourceLabel) parts.push(updatePreviewState.sourceLabel);
  if (updatePreviewState.received > 0) {
    parts.push(updatePreviewState.total > 0
      ? (formatUpdateBytes(updatePreviewState.received) + ' / ' + formatUpdateBytes(updatePreviewState.total))
      : ('已下载 ' + formatUpdateBytes(updatePreviewState.received)));
  }
  var speed = formatUpdateSpeed(updatePreviewState.speedBps);
  if (speed) parts.push(speed);
  if (updatePreviewState.etaSeconds > 0 && updatePreviewState.etaSeconds < 3600) parts.push('约 ' + updatePreviewState.etaSeconds + ' 秒');
  return parts.join(' · ');
}
function initUpdatePreview() {
  renderUpdatePreviewPanel();
  setUpdatePreviewVisible(true);
}

function setUpdatePreviewVisible(visible) {
  updatePreviewState.visible = !!visible;
  var entry = document.getElementById('update-entry');
  if (!entry) return;
  entry.classList.toggle('available', updatePreviewState.visible);
}

async function checkLatestUpdate() {
  try {
    var data = await apiJson('/api/update/latest?t=' + Date.now());
    applyLatestUpdateInfo(data);
  } catch (e) {
    updatePreviewState.preview = true;
    updatePreviewState.updateAvailable = false;
    updatePreviewState.hero = '检查失败，请稍后重试。';
    updatePreviewState.status = 'error';
    updatePreviewState.errorReason = (e && e.message) || '更新检查失败';
    renderUpdatePreviewPanel();
    setUpdatePreviewVisible(true);
  }
}

function applyLatestUpdateInfo(data) {
  data = data || {};
  var release = data.release || {};
  updatePreviewState.currentVersion = data.currentVersion || updatePreviewState.currentVersion;
  updatePreviewState.version = data.latestVersion || release.version || updatePreviewState.currentVersion;
  updatePreviewState.configured = !!data.configured;
  updatePreviewState.preview = !!data.preview;
  updatePreviewState.updateAvailable = !!data.updateAvailable;
  var releaseVersion = String(updatePreviewState.version || '').replace(/^v/i, '');
  updatePreviewState.releaseUrl = release.htmlUrl || data.htmlUrl || ('https://github.com/HackenLeung/Mineradio/releases/tag/v' + encodeURIComponent(releaseVersion));
  updatePreviewState.downloadUrl = '';
  updatePreviewState.patchAvailable = false;
  updatePreviewState.patchUrl = '';
  updatePreviewState.patchFallbackTried = false;
  var statusHero = updatePreviewState.updateAvailable ? '发现新版本，可前往下载页面。' : '当前版本已是最新。';
  updatePreviewState.hero = isUpdateVersionOnlyText(release.summary) ? statusHero : (release.summary || statusHero);
  if (Array.isArray(release.notes) && release.notes.length) {
    updatePreviewState.notes = release.notes.filter(function (note) {
      return !isUpdateVersionOnlyText(note);
    }).slice(0, 4);
  }
  renderUpdatePreviewPanel();
  setUpdatePreviewVisible(true);
}

function isUpdateVersionOnlyText(text) {
  return /^(?:mineradio\s*)?v?\d+(?:\.\d+){1,3}$/i.test(String(text || '').trim());
}

function renderUpdatePreviewPanel() {
  var version = document.getElementById('update-modal-version');
  var hero = document.getElementById('update-hero-main');
  var list = document.getElementById('update-list');
  if (version) version.textContent = 'v' + updatePreviewState.version;
  if (hero) hero.textContent = updatePreviewState.hero || '当前版本，更新检测已就绪。';
  if (list) {
    var notes = Array.isArray(updatePreviewState.notes) && updatePreviewState.notes.length ? updatePreviewState.notes : ['更新检测已就绪'];
    list.innerHTML = notes.map(function (text, i) {
      return '<div class="update-item"><span class="update-item-dot" data-index="' + String(i + 1).padStart(2, '0') + '"></span><div class="update-item-text">' + escHtml(text) + '</div></div>';
    }).join('');
  }
  updateUpdatePreviewProgress(updatePreviewState.progress);
  syncUpdatePreviewStateClass();
}

function syncUpdatePreviewStateClass() {
  var entry = document.getElementById('update-entry');
  var modal = document.querySelector('#update-modal .update-modal');
  var isDownloading = updatePreviewState.status === 'downloading';
  var isError = updatePreviewState.status === 'error';
  if (entry) {
    entry.classList.toggle('downloading', isDownloading);
    entry.classList.remove('ready');
  }
  if (modal) {
    modal.classList.remove('ready');
    modal.classList.toggle('error', isError);
  }
  var label = document.getElementById('update-btn-label');
  var btn = document.getElementById('update-primary-btn');
  if (label) {
    if (isDownloading) label.textContent = '正在检查';
    else label.textContent = updatePreviewState.updateAvailable ? '去下载' : '检查更新';
  }
  if (btn) btn.disabled = false;
  var foot = document.getElementById('update-footnote');
  if (foot) {
    if (isDownloading) foot.textContent = '正在检查 GitHub 最新版本。';
    else if (isError) foot.textContent = '检查失败：' + (updatePreviewState.errorReason || updatePreviewState.errorDetail || updatePreviewState.message || '请稍后重试');
    else foot.textContent = updatePreviewState.updateAvailable ? '不会在软件内下载或安装，点击后打开 GitHub 下载页面。' : '只检查是否有新版本。';
  }
}

function updateUpdatePreviewProgress(progress) {
  updatePreviewState.progress = clampRange(Number(progress) || 0, 0, 100);
  var fill = document.getElementById('update-btn-fill');
  if (fill) fill.style.width = updatePreviewState.progress + '%';
  var ring = document.getElementById('update-progress-ring');
  if (ring) {
    var circumference = 55.29;
    ring.style.strokeDashoffset = (circumference * (1 - updatePreviewState.progress / 100)).toFixed(2);
  }
  syncUpdatePreviewStateClass();
}

function openUpdatePanel() {
  var mask = document.getElementById('update-modal');
  if (!mask) return;
  updatePreviewState.status = 'downloading';
  updatePreviewState.hero = '正在检查 GitHub 最新版本。';
  updatePreviewState.notes = ['只检查是否有新版本', '不会在软件内下载或安装'];
  updateUpdatePreviewProgress(0);
  renderUpdatePreviewPanel();
  openGsapModal(mask);
  updatePreviewState.open = true;
  animateUpdatePanelContents();
  checkLatestUpdate().finally(function () {
    if (updatePreviewState.status === 'downloading') {
      updatePreviewState.status = 'idle';
      updateUpdatePreviewProgress(0);
    }
  });
}

function closeUpdatePanel() {
  closeGsapModal(document.getElementById('update-modal'), function () {
    updatePreviewState.open = false;
  });
}

function animateUpdatePanelContents() {
  if (!window.gsap) return;
  var modal = document.querySelector('#update-modal .update-modal');
  if (!modal) return;
  var parts = [
    modal.querySelector('.update-kicker'),
    modal.querySelector('.update-version'),
    modal.querySelector('.update-hero')
  ].filter(Boolean);
  var items = Array.prototype.slice.call(modal.querySelectorAll('.update-item'));
  var actions = modal.querySelector('.update-actions');
  window.gsap.fromTo(parts,
    { autoAlpha: 0, x: -7, filter: 'blur(5px)' },
    { autoAlpha: 1, x: 0, filter: 'blur(0px)', duration: 0.50, ease: 'power3.out', stagger: 0.045, delay: 0.10, overwrite: true }
  );
  window.gsap.fromTo(items,
    { autoAlpha: 0, x: -8 },
    { autoAlpha: 1, x: 0, duration: 0.34, ease: 'power3.out', stagger: 0.055, delay: 0.25, overwrite: true }
  );
  if (actions) {
    window.gsap.fromTo(actions,
      { autoAlpha: 0, y: 8 },
      { autoAlpha: 1, y: 0, duration: 0.36, ease: 'power3.out', delay: 0.42, overwrite: true }
    );
  }
}

async function startRealUpdateDownload() {
  if (updatePreviewState.status === 'downloading' || updatePreviewState.status === 'opening') return;
  if (updatePreviewState.status === 'ready' && updatePreviewState.installerPath) {
    openDownloadedUpdateInstaller(updatePreviewState.installerPath);
    return;
  }
  if (updatePreviewState.timer) clearInterval(updatePreviewState.timer);
  if (updatePreviewState.pollTimer) clearInterval(updatePreviewState.pollTimer);
  updatePreviewState.status = 'downloading';
  updatePreviewState.progress = 0;
  updatePreviewState.mode = 'installer';
  updatePreviewState.downloadJobId = '';
  updatePreviewState.installerPath = '';
  updatePreviewState.installerOpened = false;
  updatePreviewState.cached = false;
  updatePreviewState.received = 0;
  updatePreviewState.total = 0;
  updatePreviewState.speedBps = 0;
  updatePreviewState.etaSeconds = 0;
  updatePreviewState.sourceLabel = '';
  updatePreviewState.attempt = 0;
  updatePreviewState.attempts = 0;
  updatePreviewState.errorReason = '';
  updatePreviewState.errorDetail = '';
  updatePreviewState.failedAttempts = [];
  updatePreviewState.message = '正在下载完整安装包';
  updateUpdatePreviewProgress(0);
  try {
    var job = await apiJson('/api/update/download', { method: 'POST' });
    if (!job || job.ok === false || !job.id) throw new Error((job && job.error) || 'UPDATE_DOWNLOAD_START_FAILED');
    updatePreviewState.downloadJobId = job.id;
    applyUpdateDownloadJob(job);
    updatePreviewState.pollTimer = setInterval(function () {
      pollUpdateDownloadJob(job.id);
    }, 360);
  } catch (e) {
    updatePreviewState.status = 'error';
    updatePreviewState.errorReason = (e && e.message) || '更新下载启动失败';
    updatePreviewState.errorDetail = updatePreviewState.errorReason;
    updatePreviewState.message = updatePreviewState.errorReason;
    updateUpdatePreviewProgress(0);
    showToast('更新下载启动失败：' + updatePreviewState.errorReason);
  }
}
async function startRealUpdatePatch() {
  if (updatePreviewState.status === 'downloading' || updatePreviewState.status === 'opening') return;
  if (updatePreviewState.status === 'ready' && updatePreviewState.mode === 'patch') {
    restartForAppliedPatch();
    return;
  }
  if (updatePreviewState.timer) clearInterval(updatePreviewState.timer);
  if (updatePreviewState.pollTimer) clearInterval(updatePreviewState.pollTimer);
  updatePreviewState.status = 'downloading';
  updatePreviewState.mode = 'patch';
  updatePreviewState.progress = 0;
  updatePreviewState.patchJobId = '';
  updatePreviewState.installerPath = '';
  updatePreviewState.installerOpened = false;
  updatePreviewState.cached = false;
  updatePreviewState.received = 0;
  updatePreviewState.total = 0;
  updatePreviewState.speedBps = 0;
  updatePreviewState.etaSeconds = 0;
  updatePreviewState.sourceLabel = '';
  updatePreviewState.attempt = 0;
  updatePreviewState.attempts = 0;
  updatePreviewState.errorReason = '';
  updatePreviewState.errorDetail = '';
  updatePreviewState.failedAttempts = [];
  updatePreviewState.patchFallbackTried = false;
  updatePreviewState.message = '正在下载快速补丁';
  updateUpdatePreviewProgress(0);
  try {
    var job = await apiJson('/api/update/patch', { method: 'POST' });
    if (!job || job.ok === false || !job.id) throw new Error((job && job.error) || 'UPDATE_PATCH_START_FAILED');
    updatePreviewState.patchJobId = job.id;
    applyUpdateDownloadJob(job);
    updatePreviewState.pollTimer = setInterval(function () {
      pollUpdatePatchJob(job.id);
    }, 320);
  } catch (e) {
    updatePreviewState.status = 'error';
    updatePreviewState.errorReason = (e && e.message) || '快速补丁不可用';
    updatePreviewState.errorDetail = updatePreviewState.errorReason;
    updatePreviewState.message = updatePreviewState.errorReason;
    updateUpdatePreviewProgress(0);
    updatePreviewState.patchFallbackTried = true;
    showToast('快速补丁不可用，可手动下载完整安装包');
  }
}

async function pollUpdateDownloadJob(id) {
  if (!id) return;
  try {
    var job = await apiJson('/api/update/download/status?id=' + encodeURIComponent(id) + '&t=' + Date.now());
    applyUpdateDownloadJob(job);
  } catch (e) {
    if (updatePreviewState.pollTimer) clearInterval(updatePreviewState.pollTimer);
    updatePreviewState.pollTimer = null;
    updatePreviewState.status = 'error';
    updatePreviewState.errorReason = '更新下载状态读取失败';
    updatePreviewState.errorDetail = (e && e.message) || updatePreviewState.errorReason;
    updatePreviewState.message = updatePreviewState.errorReason;
    updateUpdatePreviewProgress(updatePreviewState.progress || 0);
    showToast('更新下载状态读取失败');
  }
}
async function pollUpdatePatchJob(id) {
  if (!id) return;
  try {
    var job = await apiJson('/api/update/patch/status?id=' + encodeURIComponent(id) + '&t=' + Date.now());
    applyUpdateDownloadJob(job);
  } catch (e) {
    if (updatePreviewState.pollTimer) clearInterval(updatePreviewState.pollTimer);
    updatePreviewState.pollTimer = null;
    updatePreviewState.status = 'error';
    updatePreviewState.errorReason = '快速补丁状态读取失败';
    updatePreviewState.errorDetail = (e && e.message) || updatePreviewState.errorReason;
    updatePreviewState.message = updatePreviewState.errorReason;
    updateUpdatePreviewProgress(updatePreviewState.progress || 0);
    showToast('快速补丁状态读取失败');
  }
}

function applyUpdateDownloadJob(job) {
  if (!job || job.ok === false || job.status === 'error') {
    if (updatePreviewState.pollTimer) clearInterval(updatePreviewState.pollTimer);
    updatePreviewState.pollTimer = null;
    updatePreviewState.mode = (job && job.mode) || updatePreviewState.mode || 'installer';
    updatePreviewState.received = Number(job && job.received || 0);
    updatePreviewState.total = Number(job && job.total || 0);
    updatePreviewState.speedBps = Number(job && job.speedBps || 0);
    updatePreviewState.etaSeconds = Number(job && job.etaSeconds || 0);
    updatePreviewState.sourceLabel = (job && job.sourceLabel) || updatePreviewState.sourceLabel || '';
    updatePreviewState.attempt = Number(job && job.attempt || 0);
    updatePreviewState.attempts = Number(job && job.attempts || 0);
    updatePreviewState.errorReason = (job && (job.errorReason || job.message || job.error)) || '请稍后重试';
    updatePreviewState.errorDetail = (job && job.errorDetail) || '';
    updatePreviewState.failedAttempts = Array.isArray(job && job.failedAttempts) ? job.failedAttempts : [];
    updatePreviewState.message = (job && job.message) || updatePreviewState.errorReason;
    updatePreviewState.status = 'error';
    updateUpdatePreviewProgress(job && job.progress || updatePreviewState.progress || 0);
    if (updatePreviewState.mode === 'patch' && updatePreviewState.downloadUrl && !updatePreviewState.patchFallbackTried) {
      updatePreviewState.patchFallbackTried = true;
      showToast('快速补丁失败，可手动下载完整安装包：' + updatePreviewState.errorReason);
      return;
    }
    showToast('更新下载失败：' + updatePreviewState.errorReason);
    return;
  }
  if (job.id) updatePreviewState.downloadJobId = job.id;
  updatePreviewState.mode = job.mode || updatePreviewState.mode || 'installer';
  if (updatePreviewState.mode === 'patch') updatePreviewState.patchJobId = job.id || updatePreviewState.patchJobId;
  updatePreviewState.received = Number(job.received || 0);
  updatePreviewState.total = Number(job.total || 0);
  updatePreviewState.speedBps = Number(job.speedBps || 0);
  updatePreviewState.etaSeconds = Number(job.etaSeconds || 0);
  updatePreviewState.sourceLabel = job.sourceLabel || '';
  updatePreviewState.attempt = Number(job.attempt || 0);
  updatePreviewState.attempts = Number(job.attempts || 0);
  updatePreviewState.errorReason = job.errorReason || '';
  updatePreviewState.errorDetail = job.errorDetail || '';
  updatePreviewState.failedAttempts = Array.isArray(job.failedAttempts) ? job.failedAttempts : [];
  updatePreviewState.message = job.message || '';
  updatePreviewState.restartRequired = !!job.restartRequired;
  updatePreviewState.cached = !!job.cached;
  if (job.status === 'downloading' || job.status === 'queued') {
    updatePreviewState.status = 'downloading';
    updateUpdatePreviewProgress(job.progress || 0);
    return;
  }
  if (job.status === 'ready') {
    if (updatePreviewState.pollTimer) clearInterval(updatePreviewState.pollTimer);
    updatePreviewState.pollTimer = null;
    updatePreviewState.status = 'ready';
    updatePreviewState.installerPath = job.filePath || '';
    updateUpdatePreviewProgress(100);
    pulseUpdateReady();
    if (updatePreviewState.mode === 'patch') {
      showToast(updatePreviewState.restartRequired ? '快速补丁已应用，重启后生效' : '快速补丁已应用');
    } else if (updatePreviewState.installerPath) {
      showToast(updatePreviewState.cached ? '已复用上次下载的安装包' : '安装包已下载，点击按钮打开');
    }
  }
}
async function restartForAppliedPatch() {
  if (!updatePreviewState.restartRequired) return;
  try {
    if (window.desktopWindow && typeof window.desktopWindow.restartApp === 'function') {
      await window.desktopWindow.restartApp();
      return;
    }
  } catch (e) { }
  showToast('请手动重启 Mineradio 让补丁生效');
}

async function openDownloadedUpdateInstaller(filePath) {
  if (!filePath) return;
  if (updatePreviewState.installerOpened) return;
  updatePreviewState.status = 'opening';
  syncUpdatePreviewStateClass();
  try {
    if (window.desktopWindow && window.desktopWindow.openUpdateInstaller) {
      var result = await window.desktopWindow.openUpdateInstaller(filePath);
      if (!result || result.ok === false) throw new Error((result && result.error) || 'OPEN_UPDATE_FAILED');
      updatePreviewState.installerOpened = true;
      updatePreviewState.status = 'ready';
      syncUpdatePreviewStateClass();
      showToast('安装包已打开');
      return;
    }
    throw new Error('DESKTOP_BRIDGE_MISSING');
  } catch (e) {
    updatePreviewState.status = 'ready';
    syncUpdatePreviewStateClass();
    if (updatePreviewState.releaseUrl) window.open(updatePreviewState.releaseUrl, '_blank');
    showToast('无法自动打开安装包，已尝试打开更新页面');
  }
}

function startUpdatePreviewDownload() {
  if (updatePreviewState.updateAvailable) {
    var releaseVersion = String(updatePreviewState.version || '').replace(/^v/i, '');
    var releaseUrl = updatePreviewState.releaseUrl || ('https://github.com/HackenLeung/Mineradio/releases/tag/v' + encodeURIComponent(releaseVersion));
    window.open(releaseUrl, '_blank');
    showToast('已打开下载页面');
    return;
  }
  if (updatePreviewState.status === 'downloading') return;
  updatePreviewState.status = 'downloading';
  updateUpdatePreviewProgress(0);
  checkLatestUpdate().finally(function () {
    updatePreviewState.status = 'idle';
    updateUpdatePreviewProgress(0);
  });
  showToast('正在检查更新');
}

function pulseUpdateReady() {
  var btn = document.getElementById('update-primary-btn');
  if (!window.gsap) return;
  if (btn) {
    window.gsap.fromTo(btn,
      { boxShadow: '0 0 0 rgba(244,210,138,0), inset 0 1px 0 rgba(255,255,255,.09)' },
      { boxShadow: '0 0 24px rgba(244,210,138,.16), inset 0 1px 0 rgba(255,255,255,.11)', duration: 0.42, yoyo: true, repeat: 1, ease: 'sine.inOut', overwrite: true }
    );
  }
}

// ============================================================
//  登录系统
