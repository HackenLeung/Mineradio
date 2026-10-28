// ============================================================
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
    else if (isError) foot.textContent = '检查失败：' + (updatePreviewState.errorReason || '请稍后重试');
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

// ============================================================
//  登录系统
