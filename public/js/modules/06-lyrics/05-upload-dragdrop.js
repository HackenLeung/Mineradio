// ============================================================
var AUDIO_UPLOAD_EXT_RE = /\.(mp3|flac|wav|ogg|m4a|aac|opus)$/i;
var IMAGE_UPLOAD_EXT_RE = /\.(jpg|jpeg|png|webp)$/i;
function isAudioUploadFile(file) {
  if (!file) return false;
  return /^audio\//i.test(file.type || '') || AUDIO_UPLOAD_EXT_RE.test(file.name || '');
}
function isImageUploadFile(file) {
  if (!file) return false;
  return /^image\//i.test(file.type || '') || IMAGE_UPLOAD_EXT_RE.test(file.name || '');
}
function uploadFileSortKey(file) {
  return String((file && (file.webkitRelativePath || file.name)) || '').toLowerCase();
}
function sortedAudioUploadFiles(files) {
  return Array.prototype.slice.call(files || [])
    .filter(isAudioUploadFile)
    .sort(function (a, b) {
      return uploadFileSortKey(a).localeCompare(uploadFileSortKey(b), 'zh-CN', { numeric: true, sensitivity: 'base' });
    });
}
function firstImageUploadFile(files) {
  var list = Array.prototype.slice.call(files || []);
  for (var i = 0; i < list.length; i++) if (isImageUploadFile(list[i])) return list[i];
  return null;
}
function localSongFromAudioFile(file) {
  var rel = String(file.webkitRelativePath || file.name || '');
  var filename = String(file.name || rel || '本地音乐');
  var title = filename.replace(/\.[^.]+$/, '');
  return hydrateCustomCover({
    type: 'local',
    source: 'local',
    provider: 'local',
    name: title || '本地音乐',
    artist: '本地文件',
    album: rel && rel !== filename ? rel.split(/[\\/]/).slice(0, -1).join(' / ') : '',
    localKey: [rel || filename, file.size || 0, file.lastModified || 0].join(':'),
    localUrl: URL.createObjectURL(file),
    localPath: rel,
    duration: 0
  });
}

function readLocalLibraryFolderPaths() {
  try {
    var paths = JSON.parse(localStorage.getItem(LOCAL_LIBRARY_FOLDERS_STORE_KEY) || '[]');
    return Array.isArray(paths) ? paths.map(String).filter(Boolean) : [];
  } catch (e) { return []; }
}
function saveLocalLibraryFolderPaths(paths) {
  try { localStorage.setItem(LOCAL_LIBRARY_FOLDERS_STORE_KEY, JSON.stringify((paths || []).map(String).filter(Boolean))); } catch (e) { }
}
function localFolderPlaylistName(folderPath) {
  var parts = String(folderPath || '').replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || '本地音乐';
}
function readLocalMetadataMap() {
  try {
    var parsed = JSON.parse(localStorage.getItem(LOCAL_METADATA_STORE_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) { return {}; }
}
var localMetadataMap = readLocalMetadataMap();
var localMetadataSaveTimer = 0;
function saveLocalMetadataMap() {
  try { localStorage.setItem(LOCAL_METADATA_STORE_KEY, JSON.stringify(localMetadataMap || {})); } catch (e) { }
  if (window.desktopWindow && typeof window.desktopWindow.setLocalOnlineMetadataCache === 'function') {
    if (localMetadataSaveTimer) clearTimeout(localMetadataSaveTimer);
    localMetadataSaveTimer = setTimeout(function () {
      localMetadataSaveTimer = 0;
      window.desktopWindow.setLocalOnlineMetadataCache(localMetadataMap || {}).catch(function () { });
    }, 450);
  }
}
function hydrateLocalMetadataFromDisk() {
  if (!window.desktopWindow || typeof window.desktopWindow.getLocalOnlineMetadataCache !== 'function') return;
  window.desktopWindow.getLocalOnlineMetadataCache().then(function (result) {
    if (!result || !result.ok || !result.payload || typeof result.payload !== 'object') return;
    localMetadataMap = Object.assign({}, result.payload, localMetadataMap || {});
    try { localStorage.setItem(LOCAL_METADATA_STORE_KEY, JSON.stringify(localMetadataMap)); } catch (e) { }
  }).catch(function () { });
}
function localMetadataKey(song) {
  return String(song && (song.localKey || song.filePath || song.localPath) || '');
}
function localMetadataQuery(song) {
  song = song || {};
  return [song.name || song.title || '', String(song.artist || '').replace(/^本地文件$/, '')].filter(Boolean).join(' ').trim();
}
function normalizeLocalMatchCandidate(candidate, provider) {
  candidate = cloneSong(candidate || {});
  candidate.provider = provider || songProviderKey(candidate);
  candidate.source = candidate.provider;
  return candidate;
}
function localMetadataMatchScore(song, candidate, query) {
  var score = typeof scoreSongSearchResult === 'function' ? scoreSongSearchResult(candidate, query, 0) : 0;
  if (typeof isSameTitleArtist === 'function' && isSameTitleArtist(song, candidate)) score += 160;
  var sourceTitle = simpleSearchNorm(song && (song.name || song.title) || '');
  var candidateTitle = simpleSearchNorm(candidate && (candidate.name || candidate.title) || '');
  if (sourceTitle && candidateTitle === sourceTitle) score += 80;
  return score;
}
async function fetchLocalMetadataCandidates(song, query, provider) {
  provider = provider || (typeof normalizePlaybackProvider === 'function' ? normalizePlaybackProvider(activeAccountProvider) : 'netease');
  if (provider === 'local') provider = 'netease';
  var url = typeof controlSourceSearchUrl === 'function'
    ? controlSourceSearchUrl(provider, query)
    : '/api/search?keywords=' + encodeURIComponent(query) + '&limit=10';
  var data = await apiJson(url, { timeoutMs: 6500 });
  var list = data && (data.songs || data.result || []);
  if (!Array.isArray(list)) list = [];
  return list.map(function (candidate) { return normalizeLocalMatchCandidate(candidate, provider); });
}
function syncLocalMetadata(song, metadata) {
  var key = localMetadataKey(song);
  if (!key || !metadata) return;
  localMetadataMap[key] = Object.assign({}, metadata, { updatedAt: Date.now() });
  saveLocalMetadataMap();
}
function applyLocalOnlineMetadata(song, metadata, token) {
  if (!song || !metadata || (token != null && token !== trackSwitchToken)) return false;
  song.onlineMetadata = Object.assign({}, metadata);
  song.manualMatched = metadata.manualMatched === true;
  if (metadata.cover && !song.sidecarCover && !song.embeddedCover && !song.customCover) song.cover = metadata.cover;
  if (metadata.lyric) song.lyric = metadata.lyric;
  if (metadata.yrc) song.yrc = metadata.yrc;
  return true;
}
async function resolveLocalOnlineMetadata(song, token, options) {
  options = options || {};
  var key = localMetadataKey(song);
  if (!key) return null;
  var saved = localMetadataMap[key];
  if (saved) {
    applyLocalOnlineMetadata(song, saved, token);
    return saved;
  }
  var query = localMetadataQuery(song);
  if (!query || options.manualOnly) return null;
  try {
    var provider = options.provider || (typeof normalizePlaybackProvider === 'function' ? normalizePlaybackProvider(activeAccountProvider) : 'netease');
    if (provider === 'local') provider = 'netease';
    var candidates = await fetchLocalMetadataCandidates(song, query, provider);
    if (token != null && token !== trackSwitchToken) return null;
    var ranked = candidates.map(function (candidate) {
      return { candidate: candidate, score: localMetadataMatchScore(song, candidate, query) };
    }).sort(function (a, b) { return b.score - a.score; });
    if (!ranked.length || ranked[0].score < 100) return null;
    var candidate = ranked[0].candidate;
    var metadata = {
      provider: provider,
      id: candidate.id || '', mid: candidate.mid || candidate.songmid || '', songmid: candidate.songmid || candidate.mid || '',
      hash: candidate.hash || candidate.audioHash || '', albumAudioId: candidate.albumAudioId || candidate.album_audio_id || candidate.mixSongId || '',
      mixSongId: candidate.mixSongId || candidate.albumAudioId || '', name: candidate.name || candidate.title || '', artist: candidate.artist || '',
      album: candidate.album || '', cover: candidate.cover || candidate.picUrl || candidate.albumCover || '', duration: Number(candidate.duration) || 0,
      manualMatched: options.manualMatched === true
    };
    syncLocalMetadata(song, metadata);
    applyLocalOnlineMetadata(song, metadata, token);
    return metadata;
  } catch (e) {
    console.warn('[LocalMetadataMatch]', e);
    return null;
  }
}
function localSongFromScanFile(file, folderPath) {
  file = file || {};
  var relativePath = String(file.relativePath || file.webkitRelativePath || file.name || '');
  var filename = String(file.name || relativePath || '本地音乐');
  var title = String(file.embeddedTitle || filename.replace(/\.[^.]+$/, '') || '本地音乐');
  var artist = String(file.embeddedArtist || (Array.isArray(file.embeddedArtists) ? file.embeddedArtists.join(' / ') : '') || '本地文件');
  var localKey = [file.filePath || file.fullPath || relativePath, file.size || 0, file.lastModified || 0].join(':');
  var song = hydrateCustomCover({
    type: 'local', source: 'local', provider: 'local', name: title, artist: artist,
    album: file.embeddedAlbum || (relativePath ? relativePath.split(/[\\/]/).slice(0, -1).join(' / ') : ''),
    duration: Number(file.embeddedDuration) || 0,
    localKey: localKey, localUrl: file.url || '', localPath: file.filePath || file.fullPath || relativePath,
    localFolderPath: folderPath || '', localFolderName: localFolderPlaylistName(folderPath),
    sidecarCover: file.sidecarCoverUrl || '', embeddedCover: file.embeddedCover || '',
    localLyricText: file.sidecarLyricText || '', embeddedLyrics: file.embeddedLyrics || '',
    localMissing: !file.url
  });
  song.cover = song.customCover || song.sidecarCover || song.embeddedCover || '';
  var saved = localMetadataMap[localKey];
  if (saved) applyLocalOnlineMetadata(song, saved);
  return song;
}
function updateLocalLibraryFolder(folderPath, files) {
  var songs = (files || []).map(function (file) { return localSongFromScanFile(file, folderPath); });
  var entry = { folderPath: folderPath, name: localFolderPlaylistName(folderPath), songs: songs };
  var existing = localFolderPlaylists.findIndex(function (item) { return item && item.folderPath === folderPath; });
  if (existing >= 0) localFolderPlaylists[existing] = entry;
  else localFolderPlaylists.push(entry);
  localLibrarySongs = [];
  localFolderPlaylists.forEach(function (folder) { localLibrarySongs = localLibrarySongs.concat(folder.songs || []); });
  return entry;
}
function localLibraryCover(song) {
  return song && (song.customCover || song.sidecarCover || song.embeddedCover || song.cover) || '';
}
function renderLocalLibraryPanel() {
  var list = document.getElementById('local-library-list');
  var chip = document.getElementById('local-library-chip');
  if (!list) return;
  if (chip) chip.textContent = localLibrarySongs.length ? ('本地音乐 ' + localLibrarySongs.length + ' 首 · ' + localFolderPlaylists.length + ' 个文件夹') : '未导入本地文件夹';
  var query = simpleSearchNorm(localLibrarySearchQuery || '');
  if (!localFolderPlaylists.length) {
    list.innerHTML = '<div class="local-library-empty">添加音乐文件夹后会在这里显示，并在下次启动时自动恢复。</div>';
    return;
  }
  if (query) {
    var matches = localLibrarySongs.filter(function (song) {
      return simpleSearchNorm([song.name, song.artist, song.album, song.localPath, song.localFolderName].filter(Boolean).join(' ')).indexOf(query) >= 0;
    });
    list.innerHTML = matches.length ? matches.slice(0, 240).map(function (song) {
      var index = localLibrarySongs.indexOf(song);
      var cover = localLibraryCover(song);
      return '<button class="local-library-song' + (currentLocalSong && currentLocalSong.localKey === song.localKey ? ' now' : '') + '" type="button" onclick="playLocalLibrarySong(' + index + ')">' +
        (cover ? '<img class="local-library-cover" src="' + escHtml(cover) + '" alt="">' : '<span class="local-library-cover"></span>') +
        '<span class="local-library-meta"><span class="local-library-name">' + escHtml(song.name) + '</span><span class="local-library-sub">' + escHtml(song.artist || song.localFolderName) + '</span></span><span class="local-library-action">播放</span></button>';
    }).join('') : '<div class="local-library-empty">没有匹配的本地音乐</div>';
    return;
  }
  list.innerHTML = localFolderPlaylists.map(function (folder, folderIndex) {
    var first = folder.songs && folder.songs[0];
    var cover = localLibraryCover(first);
    var expanded = localLibraryDetailState.folderIndex === folderIndex;
    var songs = expanded ? (folder.songs || []).slice(0, 120).map(function (song, songIndex) {
      var songCover = localLibraryCover(song);
      return '<button class="local-library-song' + (currentLocalSong && currentLocalSong.localKey === song.localKey ? ' now' : '') + '" type="button" onclick="event.stopPropagation();playLocalFolderPlaylist(' + folderIndex + ',' + songIndex + ')">' +
        (songCover ? '<img class="local-library-cover" src="' + escHtml(songCover) + '" alt="">' : '<span class="local-library-cover"></span>') +
        '<span class="local-library-meta"><span class="local-library-name">' + escHtml(song.name) + '</span><span class="local-library-sub">' + escHtml(song.artist || '本地文件') + '</span></span><span class="local-library-action">播放</span></button>';
    }).join('') : '';
    return '<div class="local-library-folder-group"><button class="local-library-folder" type="button" onclick="toggleLocalFolderPreview(' + folderIndex + ')">' +
      (cover ? '<img class="local-library-cover" src="' + escHtml(cover) + '" alt="">' : '<span class="local-library-cover"></span>') +
      '<span class="local-library-meta"><span class="local-library-name">' + escHtml(folder.name) + '</span><span class="local-library-sub">' + (folder.songs || []).length + ' 首 · ' + escHtml(folder.folderPath) + '</span></span><span class="local-library-action">' + (expanded ? '收起' : '预览') + '</span></button>' + songs + '</div>';
  }).join('');
}
var localFolderMetadataHydrationJobs = {};
async function hydrateLocalFolderPreview(folderIndex) {
  var folder = localFolderPlaylists[Number(folderIndex) || 0];
  if (!folder || !folder.folderPath || !window.desktopWindow || typeof window.desktopWindow.resolveLocalMusicFile !== 'function') return;
  var jobKey = String(folder.folderPath).toLowerCase();
  if (localFolderMetadataHydrationJobs[jobKey]) return localFolderMetadataHydrationJobs[jobKey];
  var songs = (folder.songs || []).slice(0, 120);
  var cursor = 0;
  var hydrated = 0;
  async function worker() {
    while (cursor < songs.length) {
      var song = songs[cursor++];
      if (!song || !song.localPath || (song.embeddedMetadataParsed && (song.embeddedCover || song.sidecarCover))) continue;
      try {
        var result = await window.desktopWindow.resolveLocalMusicFile(song.localPath, { deferCacheSave: true });
        if (!result || !result.ok || !result.file) continue;
        var fresh = localSongFromScanFile(result.file, folder.folderPath);
        var existingOnline = song.onlineMetadata;
        Object.assign(song, fresh, { localMissing: false });
        if (existingOnline) applyLocalOnlineMetadata(song, existingOnline);
        hydrated += 1;
        if (hydrated % 8 === 0 && localLibraryDetailState.folderIndex === folderIndex) renderLocalLibraryPanel();
      } catch (error) {
        console.warn('[LocalFolderMetadata]', song.localPath, error);
      }
    }
  }
  var workers = [];
  for (var workerIndex = 0; workerIndex < Math.min(3, songs.length); workerIndex++) workers.push(worker());
  localFolderMetadataHydrationJobs[jobKey] = Promise.all(workers).then(function () {
    if (window.desktopWindow && typeof window.desktopWindow.flushLocalAudioMetadataCache === 'function') {
      window.desktopWindow.flushLocalAudioMetadataCache().catch(function () { });
    }
    if (localLibraryDetailState.folderIndex === folderIndex) renderLocalLibraryPanel();
  }).finally(function () { delete localFolderMetadataHydrationJobs[jobKey]; });
  return localFolderMetadataHydrationJobs[jobKey];
}
function toggleLocalFolderPreview(folderIndex) {
  localLibraryDetailState.folderIndex = localLibraryDetailState.folderIndex === folderIndex ? -1 : folderIndex;
  renderLocalLibraryPanel();
  if (localLibraryDetailState.folderIndex === folderIndex) hydrateLocalFolderPreview(folderIndex);
}
async function openLocalFolderImport() {
  if (!window.desktopWindow || typeof window.desktopWindow.chooseLocalMusicFolder !== 'function') {
    triggerUploadInput('folder');
    return;
  }
  var result = await window.desktopWindow.chooseLocalMusicFolder();
  if (!result || result.canceled) return;
  if (!result.ok) { showToast('本地文件夹读取失败'); return; }
  updateLocalLibraryFolder(result.folderPath, result.files || []);
  var paths = readLocalLibraryFolderPaths();
  if (paths.indexOf(result.folderPath) < 0) paths.push(result.folderPath);
  saveLocalLibraryFolderPaths(paths);
  renderLocalLibraryPanel();
  showToast('已导入 ' + (result.files || []).length + ' 首本地音乐');
}
async function restoreLocalLibraryFolders() {
  if (!window.desktopWindow || typeof window.desktopWindow.scanLocalMusicFolder !== 'function') return;
  var paths = readLocalLibraryFolderPaths();
  for (var i = 0; i < paths.length; i++) {
    try {
      var result = await window.desktopWindow.scanLocalMusicFolder(paths[i]);
      if (result && result.ok) updateLocalLibraryFolder(result.folderPath, result.files || []);
    } catch (e) { console.warn('[LocalLibraryRestore]', paths[i], e); }
  }
  rebindRestoredLocalQueueSongs();
  renderLocalLibraryPanel();
}
async function ensureFreshLocalPlaybackUrl(song) {
  if (!song || !song.localPath || !window.desktopWindow || typeof window.desktopWindow.resolveLocalMusicFile !== 'function') return !!(song && song.localUrl);
  try {
    var result = await window.desktopWindow.resolveLocalMusicFile(song.localPath, { deferCacheSave: true });
    if (!result || !result.ok || !result.file) { song.localMissing = true; return false; }
    var fresh = localSongFromScanFile(result.file, song.localFolderPath || '');
    Object.assign(song, fresh, { localMissing: false });
    return !!song.localUrl;
  } catch (e) { song.localMissing = true; return false; }
}
function rebindRestoredLocalQueueSongs() {
  if (!Array.isArray(playQueue) || !playQueue.length) return;
  var byPath = {};
  localLibrarySongs.forEach(function (song) { if (song.localPath) byPath[String(song.localPath).toLowerCase()] = song; });
  playQueue.forEach(function (song, index) {
    if (!song || song.type !== 'local') return;
    var fresh = byPath[String(song.localPath || '').toLowerCase()];
    if (fresh) playQueue[index] = Object.assign(song, cloneSong(fresh), { localMissing: false });
    else song.localMissing = true;
  });
}
function playLocalLibrarySong(index) {
  var song = localLibrarySongs[Number(index) || 0];
  if (!song) return;
  playQueue = localLibrarySongs.map(cloneSong);
  currentIdx = Math.max(0, localLibrarySongs.indexOf(song));
  safeRenderQueuePanel('local-library-play', { scrollCurrent: true });
  safeShelfRebuild('local-library-play', true);
  playQueueAt(currentIdx, { manual: true }).catch(function (e) { console.warn('[LocalLibraryPlay]', e); });
}
function playLocalFolderPlaylist(folderIndex, songIndex) {
  var folder = localFolderPlaylists[Number(folderIndex) || 0];
  if (!folder || !folder.songs || !folder.songs.length) return;
  playQueue = folder.songs.map(cloneSong);
  currentIdx = Math.max(0, Math.min(playQueue.length - 1, Number(songIndex) || 0));
  safeRenderQueuePanel('local-folder-play', { scrollCurrent: true });
  safeShelfRebuild('local-folder-play', true);
  playQueueAt(currentIdx, { manual: true }).catch(function (e) { console.warn('[LocalFolderPlay]', e); });
}
var uploadFilePickerActiveUntil = 0;
var uploadFilePickerFocusArmed = false;
var uploadFilePickerFocusTimer = null;
function uploadImportNow() {
  return (window.performance && typeof performance.now === 'function') ? performance.now() : Date.now();
}
function isUploadPanelOpen() {
  var panel = document.getElementById('upload-panel');
  return !!(panel && panel.classList.contains('show'));
}
function pinUploadSearchArea() {
  var area = document.getElementById('search-area');
  if (area && typeof setPeek === 'function') setPeek(area, true, 'search');
}
function keepUploadImportActive(ms) {
  uploadFilePickerActiveUntil = Math.max(uploadFilePickerActiveUntil, uploadImportNow() + (ms || 12000));
  pinUploadSearchArea();
}
function isUploadImportActive() {
  return isUploadPanelOpen() || uploadImportNow() < uploadFilePickerActiveUntil;
}
function clearUploadFilePickerFocusTimer() {
  if (uploadFilePickerFocusTimer) {
    clearTimeout(uploadFilePickerFocusTimer);
    uploadFilePickerFocusTimer = null;
  }
}
function disarmUploadFilePickerFocus() {
  if (!uploadFilePickerFocusArmed) return;
  uploadFilePickerFocusArmed = false;
  window.removeEventListener('focus', handleUploadFilePickerFocus);
}
function handleUploadFilePickerFocus() {
  disarmUploadFilePickerFocus();
  keepUploadImportActive(900);
  clearUploadFilePickerFocusTimer();
  uploadFilePickerFocusTimer = setTimeout(function () {
    uploadFilePickerFocusTimer = null;
    uploadFilePickerActiveUntil = 0;
    if (isUploadPanelOpen()) closeUploadPanel();
  }, 900);
}
function armUploadFilePickerFocus() {
  disarmUploadFilePickerFocus();
  uploadFilePickerFocusArmed = true;
  window.addEventListener('focus', handleUploadFilePickerFocus);
}
function finishUploadFilePicker(closePanel) {
  uploadFilePickerActiveUntil = 0;
  clearUploadFilePickerFocusTimer();
  disarmUploadFilePickerFocus();
  if (closePanel) closeUploadPanel({ keepPicker: true });
}
function openUploadPanel() {
  closeUploadTip(false);
  var actions = document.getElementById('upload-actions');
  var panel = document.getElementById('upload-panel');
  if (!panel) return;
  var hidden = !actions;
  if (!hidden) {
    try {
      var style = getComputedStyle(actions);
      hidden = style.display === 'none' || style.visibility === 'hidden' || actions.getClientRects().length === 0;
    } catch (e) { }
  }
  if (hidden) {
    triggerUploadInput('audio');
    return;
  }
  panel.classList.add('show');
  pinUploadSearchArea();
}
function closeUploadPanel(opts) {
  opts = opts || {};
  if (!opts.keepPicker) uploadFilePickerActiveUntil = 0;
  var panel = document.getElementById('upload-panel');
  if (panel) panel.classList.remove('show');
}
function toggleUploadPanel(event) {
  if (event) event.stopPropagation();
  var panel = document.getElementById('upload-panel');
  if (!panel) return;
  if (panel.classList.contains('show')) closeUploadPanel();
  else openUploadPanel();
}
function triggerUploadInput(kind) {
  if (kind === 'folder' && window.desktopWindow && typeof window.desktopWindow.chooseLocalMusicFolder === 'function') {
    closeUploadPanel();
    openLocalFolderImport();
    return;
  }
  var id = kind === 'cover' ? 'cover-input' : (kind === 'folder' ? 'folder-input' : 'file-input');
  var input = document.getElementById(id);
  if (!input) {
    closeUploadPanel();
    return;
  }
  keepUploadImportActive(kind === 'folder' ? 120000 : 45000);
  armUploadFilePickerFocus();
  try {
    input.click();
  } catch (e) {
    console.warn('[LocalImport] failed to open file picker', e);
    finishUploadFilePicker(false);
  }
}
function importLocalAudioSongs(songs, opts) {
  opts = opts || {};
  songs = Array.isArray(songs) ? songs.filter(Boolean) : [];
  if (!songs.length) return false;
  homeForcedOpen = false;
  homeSuppressed = false;
  setHomeControlsLocked(false);
  playQueue = songs.map(cloneSong);
  currentIdx = 0;
  currentLocalSong = null;
  activeRadioContext = null;
  safeRenderQueuePanel('local-import', { scrollCurrent: miniQueueOpen });
  safeShelfRebuild('local-import', true);
  forcePlaybackControlsInteractive();
  updateEmptyHomeVisibility({ forceLoad: false });
  showToast(songs.length > 1 ? ('已导入 ' + songs.length + ' 首本地音乐') : '正在播放本地音乐');
  Promise.resolve(playQueueAt(0, { manual: true })).then(function () {
    if (opts.coverFile && currentIdx === 0 && playQueue[0]) {
      loadCoverFromFile(opts.coverFile, { trackToken: trackSwitchToken, deferHeavy: false, delay: 0, timeout: 260 });
    }
  }).catch(function (e) { console.warn('[LocalImport]', e); });
  return true;
}
function handleCoverFiles(files) {
  finishUploadFilePicker(true);
  var imgFile = firstImageUploadFile(files);
  if (!imgFile) {
    showToast('没有找到可用的封面图片');
    return;
  }
  loadCoverFromFile(imgFile, null);
  updateCustomCoverButton();
}
function handleFiles(files, opts) {
  finishUploadFilePicker(true);
  opts = opts || {};
  var audioFiles = sortedAudioUploadFiles(files);
  var imgFile = firstImageUploadFile(files);
  if (audioFiles.length) {
    var songs = audioFiles.map(localSongFromAudioFile);
    importLocalAudioSongs(songs, { coverFile: songs.length === 1 ? imgFile : null, mode: opts.mode || '' });
    return;
  }
  if (imgFile) {
    handleCoverFiles([imgFile]);
    return;
  }
  showToast('没有找到可导入的音乐或封面文件');
}
var fileInput = document.getElementById('file-input');
if (fileInput) fileInput.addEventListener('change', function (e) { handleFiles(e.target.files, { mode: 'audio' }); e.target.value = ''; });
var coverInput = document.getElementById('cover-input');
if (coverInput) coverInput.addEventListener('change', function (e) { handleCoverFiles(e.target.files); e.target.value = ''; });
var folderInput = document.getElementById('folder-input');
if (folderInput) folderInput.addEventListener('change', function (e) { handleFiles(e.target.files, { mode: 'folder' }); e.target.value = ''; });
var lyricFontInput = document.getElementById('lyric-font-input');
if (lyricFontInput) lyricFontInput.addEventListener('change', function (e) { handleLyricFontFiles(e.target.files); e.target.value = ''; });
document.addEventListener('click', function (e) {
  var panel = document.getElementById('upload-panel');
  if (!panel || !panel.classList.contains('show')) return;
  if (e.target && e.target.closest && e.target.closest('#upload-actions')) return;
  closeUploadPanel();
});
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') closeUploadPanel();
});
var dropOv = document.getElementById('drop-overlay'), dragCount = 0;
document.addEventListener('dragenter', function (e) { e.preventDefault(); dragCount++; dropOv.classList.add('show'); });
document.addEventListener('dragleave', function (e) { e.preventDefault(); dragCount--; if (dragCount <= 0) { dragCount = 0; dropOv.classList.remove('show'); } });
document.addEventListener('dragover', function (e) { e.preventDefault(); });
document.addEventListener('drop', function (e) {
  e.preventDefault(); dragCount = 0; dropOv.classList.remove('show');
  if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
});

var localLibrarySearchInput = document.getElementById('local-library-search');
if (localLibrarySearchInput) localLibrarySearchInput.addEventListener('input', function () {
  localLibrarySearchQuery = localLibrarySearchInput.value || '';
  renderLocalLibraryPanel();
});
hydrateLocalMetadataFromDisk();
if (typeof scheduleStartupIdleTask === 'function') scheduleStartupIdleTask(restoreLocalLibraryFolders, 900, 1200);
else setTimeout(restoreLocalLibraryFolders, 1200);

// ============================================================
//  控制台 — 预设卡片 + 主滑块 + 开关 + 三态
