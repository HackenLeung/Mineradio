var DOWNLOAD_QUALITY_STORE_KEY = 'mineradio-download-quality-v1';
var downloadCenterOpen = false;
var downloadPollingTimer = null;
var lastDownloadJobs = [];
var downloadDirText = '';
var downloadQuality = readDownloadQualityPreference();

function downloadIconSvg() {
  return '<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/></svg>';
}

function folderLocationIconSvg() {
  return '<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2h6.5A2.5 2.5 0 0 1 21 9.5v7a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5z"/><path d="m10 11 5 2.2-2.1 1-1 2.1z"/></svg>';
}

function isLocalDownloadSong(song) {
  return !!(song && (song.type === 'local' || song.source === 'local' || song.provider === 'local' || song.localUrl || song.localPath));
}

function downloadSongProvider(song) {
  if (isLocalDownloadSong(song)) return 'local';
  var provider = typeof songProviderKey === 'function' ? songProviderKey(song) : (song && (song.provider || song.source || song.type) || 'netease');
  return typeof normalizePlaybackProvider === 'function' ? normalizePlaybackProvider(provider) : provider;
}

function canDownloadSong(song) {
  var provider = downloadSongProvider(song);
  return provider === 'netease' || provider === 'qq' || provider === 'kugou';
}

function normalizeDownloadQuality(value) {
  value = String(value || '').toLowerCase();
  if (!value || value === 'follow' || value === 'auto') return 'follow';
  return typeof normalizePlaybackQuality === 'function' ? normalizePlaybackQuality(value) : value;
}

function readDownloadQualityPreference() {
  try { return normalizeDownloadQuality(localStorage.getItem(DOWNLOAD_QUALITY_STORE_KEY) || 'follow'); }
  catch (_) { return 'follow'; }
}

function effectiveDownloadQuality() {
  var quality = normalizeDownloadQuality(downloadQuality);
  if (quality !== 'follow') return quality;
  return typeof normalizePlaybackQuality === 'function' ? normalizePlaybackQuality(playbackQuality) : (playbackQuality || 'hires');
}

function downloadQualityShortLabel(value) {
  value = normalizeDownloadQuality(value);
  if (value === 'follow') return '跟随播放';
  return typeof playbackQualityLabel === 'function' ? playbackQualityLabel(value) : value;
}

function setDownloadQuality(value) {
  downloadQuality = normalizeDownloadQuality(value);
  try { localStorage.setItem(DOWNLOAD_QUALITY_STORE_KEY, downloadQuality); } catch (_) {}
  if (downloadCenterOpen) renderDownloadCenter();
}

async function downloadSingleSong(song, opts) {
  opts = opts || {};
  if (!song) return;
  if (isLocalDownloadSong(song)) {
    showToast('本地歌曲已在电脑中，可直接打开所在文件夹');
    return;
  }
  if (!canDownloadSong(song)) {
    showToast(downloadSongProvider(song) === 'qishui' ? '汽水音乐暂不支持下载' : '当前音源暂不支持下载');
    return;
  }
  if (!(song.id || song.mid || song.songmid || song.hash)) {
    showToast('歌曲信息不完整，无法下载');
    return;
  }
  try {
    var response = await apiJson('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        songs: [song],
        quality: effectiveDownloadQuality(),
        playlistName: opts.playlistName || ''
      })
    });
    if (!response || response.ok !== true) throw new Error(response && response.error || 'DOWNLOAD_START_FAILED');
    showToast('开始下载：' + (song.name || song.title || '未知歌曲'));
    openDownloadCenter();
  } catch (error) {
    showToast('下载请求失败' + (error && error.message ? '：' + error.message : ''));
  }
}

async function downloadMultipleSongs(songs, playlistName) {
  var downloadable = (songs || []).filter(canDownloadSong);
  if (!downloadable.length) {
    showToast('没有可下载的在线歌曲');
    return;
  }
  try {
    var response = await apiJson('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ songs: downloadable, quality: effectiveDownloadQuality(), playlistName: playlistName || '' })
    });
    if (!response || response.ok !== true) throw new Error(response && response.error || 'DOWNLOAD_START_FAILED');
    showToast('开始下载 ' + downloadable.length + ' 首歌曲');
    openDownloadCenter();
  } catch (error) {
    showToast('批量下载失败' + (error && error.message ? '：' + error.message : ''));
  }
}

function downloadSongFromQueue(index) {
  var song = playQueue && playQueue[index];
  if (song) downloadSingleSong(song);
}

function downloadSongFromSearch(index) {
  var song = playlist && playlist[index];
  if (song) downloadSingleSong(song);
}

function downloadSongFromDetail(index) {
  var song = playlistPanelDetailState && playlistPanelDetailState.tracks && playlistPanelDetailState.tracks[index];
  if (song) downloadSingleSong(song, { playlistName: playlistPanelDetailState.playlist && playlistPanelDetailState.playlist.name || '' });
}

function downloadSongFromArtist(index) {
  var song = detailArtistSongs && detailArtistSongs[index];
  if (song) downloadSingleSong(song);
}

function downloadSongFromAlbum(index) {
  var song = detailAlbumSongs && detailAlbumSongs[index];
  if (song) downloadSingleSong(song, { playlistName: detailAlbumContext && detailAlbumContext.album && detailAlbumContext.album.name || '' });
}

function downloadCurrentSong() {
  var song = playQueue && playQueue[currentIdx];
  if (song) downloadSingleSong(song);
}

function downloadAllPlaylistDetail() {
  var tracks = playlistPanelDetailState && playlistPanelDetailState.tracks || [];
  var name = playlistPanelDetailState && playlistPanelDetailState.playlist && playlistPanelDetailState.playlist.name || '';
  downloadMultipleSongs(tracks, name);
}
var downloadPlaylistPanelDetail = downloadAllPlaylistDetail;

async function showLocalSongInFolder(song) {
  if (!isLocalDownloadSong(song)) return;
  var liveSong = typeof localLibraryMatchForPlayback === 'function' ? localLibraryMatchForPlayback(song) : null;
  var filePath = song.localPath || song.filePath || liveSong && (liveSong.localPath || liveSong.filePath) || '';
  if (!filePath) {
    showToast('未找到本地文件路径');
    return;
  }
  if (!window.desktopWindow || typeof window.desktopWindow.showLocalMusicInFolder !== 'function') {
    showToast('仅桌面版支持打开所在文件夹');
    return;
  }
  try {
    var result = await window.desktopWindow.showLocalMusicInFolder(filePath);
    if (!result || result.ok !== true) showToast(result && result.error === 'LOCAL_LIBRARY_FILE_MISSING' ? '本地文件已移动或不存在' : '打开所在文件夹失败');
  } catch (_) {
    showToast('打开所在文件夹失败');
  }
}

function showQueueLocalSongInFolder(index) {
  return showLocalSongInFolder(playQueue && playQueue[index]);
}

function showLocalLibraryDetailSongInFolder(index) {
  var folder = localFolderPlaylists && localFolderPlaylists[localLibraryDetailState.folderIndex];
  return showLocalSongInFolder(folder && folder.songs && folder.songs[index]);
}

function queueSongFileActionHtml(song, index) {
  if (isLocalDownloadSong(song)) {
    return '<button class="queue-file-action" onclick="event.stopPropagation();showQueueLocalSongInFolder(' + index + ')" title="打开所在文件夹" aria-label="打开所在文件夹">' + folderLocationIconSvg() + '</button>';
  }
  if (!canDownloadSong(song)) return '';
  return '<button class="queue-file-action" onclick="event.stopPropagation();downloadSongFromQueue(' + index + ')" title="下载" aria-label="下载">' + downloadIconSvg() + '</button>';
}

function localDetailFileActionHtml(index) {
  return '<button type="button" class="pl-detail-row-action" data-local-detail-folder="' + index + '" title="打开所在文件夹" aria-label="打开所在文件夹">' + folderLocationIconSvg() + '</button>';
}

function onlineDetailDownloadActionHtml(song, index) {
  if (!canDownloadSong(song)) return '';
  return '<button type="button" class="pl-detail-row-action" data-pl-detail-download="' + index + '" title="下载" aria-label="下载">' + downloadIconSvg() + '</button>';
}

function openDownloadCenter() {
  downloadCenterOpen = true;
  refreshDownloadDir();
  renderDownloadCenter();
  startDownloadPolling();
}

function closeDownloadCenter() {
  downloadCenterOpen = false;
  var panel = document.getElementById('download-center');
  if (panel) panel.classList.remove('show');
  stopDownloadPolling();
}

function toggleDownloadCenter() {
  if (downloadCenterOpen) closeDownloadCenter();
  else openDownloadCenter();
}

async function refreshDownloadDir() {
  try {
    if (window.desktopWindow && window.desktopWindow.getDownloadDir) {
      var result = await window.desktopWindow.getDownloadDir();
      if (result && result.dir) {
        downloadDirText = result.dir;
        if (downloadCenterOpen) renderDownloadCenter();
      }
      return;
    }
    var response = await apiJson('/api/download/dir');
    if (response && response.dir) downloadDirText = response.dir;
  } catch (_) {}
}

function startDownloadPolling() {
  stopDownloadPolling();
  pollDownloadStatus();
  downloadPollingTimer = setInterval(pollDownloadStatus, 1200);
}

function stopDownloadPolling() {
  if (!downloadPollingTimer) return;
  clearInterval(downloadPollingTimer);
  downloadPollingTimer = null;
}

async function pollDownloadStatus() {
  try {
    var response = await apiJson('/api/download/status');
    if (!response || !Array.isArray(response.jobs)) return;
    lastDownloadJobs = response.jobs;
    if (response.dir) downloadDirText = response.dir;
    updateDownloadBadge();
    if (downloadCenterOpen) renderDownloadCenter();
  } catch (_) {}
}

function updateDownloadBadge() {
  var active = lastDownloadJobs.filter(function (job) { return ['queued', 'resolving', 'downloading'].indexOf(job.status) >= 0; }).length;
  var badge = document.getElementById('dl-center-badge');
  if (!badge) return;
  badge.textContent = active ? String(active) : '';
  badge.hidden = !active;
}

var DOWNLOAD_QUALITY_CHOICES = [
  { value: 'follow', label: '跟随播放' },
  { value: 'jymaster', label: '母带' },
  { value: 'hires', label: '臻音' },
  { value: 'lossless', label: '无损' },
  { value: 'exhigh', label: '极高' },
  { value: 'standard', label: '标准' }
];

function renderDownloadQualityPicker() {
  var current = normalizeDownloadQuality(downloadQuality);
  return '<div class="dl-quality"><div class="dl-quality-label"><span>下载音质</span><b>' + escHtml(downloadQualityShortLabel(current)) + '</b></div><div class="dl-quality-opts">' +
    DOWNLOAD_QUALITY_CHOICES.map(function (choice) {
      return '<button type="button" class="dl-quality-opt' + (choice.value === current ? ' active' : '') + '" onclick="setDownloadQuality(\'' + choice.value + '\')">' + choice.label + '</button>';
    }).join('') + '</div></div>';
}

function downloadJobStatusText(job) {
  if (job.status === 'done') return '完成';
  if (job.status === 'error') return '失败';
  if (job.status === 'skipped') return '跳过';
  if (job.status === 'cancelled') return '已取消';
  if (job.status === 'downloading') return (Number(job.progress) || 0) + '%';
  if (job.status === 'resolving') return '解析中';
  return '排队';
}

function renderDownloadCenter() {
  var panel = document.getElementById('download-center');
  if (!panel) return;
  panel.classList.add('show');
  var jobs = lastDownloadJobs.slice().reverse().slice(0, 50);
  var html = '<div class="dl-center-header"><span>下载中心</span><button type="button" class="dl-center-close" onclick="closeDownloadCenter()">×</button></div>';
  if (downloadDirText) html += '<div class="dl-center-dir" title="' + escHtml(downloadDirText) + '"><span>下载目录</span><b>' + escHtml(downloadDirText) + '</b></div>';
  html += '<div class="dl-center-actions"><button type="button" onclick="openDownloadFolder()">打开文件夹</button>';
  if (window.desktopWindow && window.desktopWindow.isDesktop) html += '<button type="button" onclick="changeDownloadFolder()">修改目录</button><button type="button" onclick="resetDownloadFolder()">恢复默认</button>';
  html += '</div>' + renderDownloadQualityPicker();
  if (!jobs.length) html += '<div class="dl-center-empty">暂无下载任务</div>';
  else html += '<div class="dl-center-list">' + jobs.map(function (job) {
    var statusClass = job.status === 'done' ? ' done' : (job.status === 'error' ? ' error' : (job.status === 'skipped' ? ' skipped' : ' active'));
    return '<div class="dl-center-item' + statusClass + '"><div class="dl-item-info"><strong>' + escHtml(job.songName || '') + '</strong><small>' + escHtml(job.songArtist || job.message || '') + '</small></div><span class="dl-item-status">' + downloadJobStatusText(job) + '</span>' +
      (job.status === 'downloading' ? '<div class="dl-item-bar"><i style="width:' + Math.max(0, Math.min(100, Number(job.progress) || 0)) + '%"></i></div>' : '') + '</div>';
  }).join('') + '</div>';
  panel.innerHTML = html;
}

async function openDownloadFolder() {
  if (!window.desktopWindow || !window.desktopWindow.openDownloadDir) {
    showToast('仅桌面版支持打开文件夹');
    return;
  }
  var result = await window.desktopWindow.openDownloadDir();
  if (!result || result.ok !== true) showToast('打开下载文件夹失败');
}

async function changeDownloadFolder() {
  if (!window.desktopWindow || !window.desktopWindow.setDownloadDir) return;
  var result = await window.desktopWindow.setDownloadDir();
  if (result && result.ok && result.dir) {
    downloadDirText = result.dir;
    renderDownloadCenter();
    showToast('下载目录已更新');
  }
}

async function resetDownloadFolder() {
  if (!window.desktopWindow || !window.desktopWindow.resetDownloadDir) return;
  var result = await window.desktopWindow.resetDownloadDir();
  if (result && result.ok && result.dir) {
    downloadDirText = result.dir;
    renderDownloadCenter();
    showToast('已恢复默认下载目录');
  }
}
