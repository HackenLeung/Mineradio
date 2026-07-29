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
function compactLocalOnlineMetadata(song, provider) {
  if (!song) return null;
  provider = provider || songProviderKey(song);
  if (typeof normalizePlaybackProvider === 'function') provider = normalizePlaybackProvider(provider);
  if (!provider || provider === 'local') provider = 'netease';
  return {
    provider: provider,
    source: provider,
    type: provider === 'kugou' ? 'kugou' : 'song',
    id: song.id || song.trackId || song.hash || '',
    mid: song.mid || song.songmid || '',
    songmid: song.songmid || song.mid || '',
    hash: song.hash || song.audioHash || '',
    albumAudioId: song.albumAudioId || song.album_audio_id || song.mixSongId || '',
    album_audio_id: song.album_audio_id || song.albumAudioId || song.mixSongId || '',
    mixSongId: song.mixSongId || song.mixsongid || song.albumAudioId || '',
    mixsongid: song.mixsongid || song.mixSongId || song.albumAudioId || '',
    albumId: song.albumId || song.album_id || '',
    album_id: song.album_id || song.albumId || '',
    name: song.name || song.title || '',
    artist: song.artist || '',
    artists: Array.isArray(song.artists) ? song.artists.slice(0, 6) : [],
    album: song.album || '',
    cover: song.cover || song.picUrl || song.albumCover || '',
    duration: Number(song.duration) || 0
  };
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
    var metadata = compactLocalOnlineMetadata(candidate, provider);
    if (!metadata) return null;
    metadata.manualMatched = options.manualMatched === true;
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
function isSameLocalLibrarySong(left, right) {
  if (!left || !right) return false;
  var leftKey = String(left.localKey || '');
  var rightKey = String(right.localKey || '');
  if (leftKey && rightKey) return leftKey === rightKey;
  var leftPath = String(left.localPath || left.filePath || '').toLowerCase();
  var rightPath = String(right.localPath || right.filePath || '').toLowerCase();
  return !!(leftPath && rightPath && leftPath === rightPath);
}
function syncResolvedLocalSongReferences(sourceSong) {
  if (!sourceSong) return;
  var currentMatched = false;
  function syncTarget(target) {
    if (!isSameLocalLibrarySong(target, sourceSong) || target === sourceSong) return;
    Object.assign(target, cloneSong(sourceSong), { localMissing: false });
    if (target === playQueue[currentIdx]) currentMatched = true;
  }
  (Array.isArray(localLibrarySongs) ? localLibrarySongs : []).forEach(syncTarget);
  (Array.isArray(localFolderPlaylists) ? localFolderPlaylists : []).forEach(function (folder) {
    (folder && Array.isArray(folder.songs) ? folder.songs : []).forEach(syncTarget);
  });
  (Array.isArray(playQueue) ? playQueue : []).forEach(syncTarget);
  if (currentLocalSong && isSameLocalLibrarySong(currentLocalSong, sourceSong)) {
    if (currentLocalSong !== sourceSong) Object.assign(currentLocalSong, cloneSong(sourceSong), { localMissing: false });
    currentMatched = true;
  }
  if (currentMatched && typeof loadCoverFromUrl === 'function') {
    var cover = localLibraryCover(playQueue[currentIdx] || currentLocalSong || sourceSong);
    if (cover) loadCoverFromUrl(cover, { trackToken: trackSwitchToken, seamlessTrackSwitch: true });
  }
}

function localFolderLyricPayloadText(payload) {
  payload = payload || {};
  var candidates = [
    payload.lyric,
    payload.yrc,
    payload.tlyric,
    payload.lrc && payload.lrc.lyric,
    payload.yrc && payload.yrc.lyric,
    payload.klyric && payload.klyric.lyric,
    payload.lrc && payload.lrc.text
  ];
  for (var i = 0; i < candidates.length; i++) {
    var value = candidates[i];
    if (value && typeof value === 'object') value = value.lyric || value.text || '';
    if (String(value || '').trim().length >= 8) return String(value).trim();
  }
  return '';
}

function updateLocalFolderLyricMatchChip(done) {
  var chip = document.getElementById('local-lyric-match-chip');
  var text = document.getElementById('local-lyric-match-text');
  if (!chip || !text) return;
  var state = localFolderLyricMatchState;
  chip.classList.add('show');
  chip.classList.toggle('done', !!done);
  text.textContent = done
    ? ('解析完成 · 已匹配 ' + state.matched + ' · 未匹配 ' + state.failed)
    : ('解析歌词中 ' + state.done + ' / ' + state.total + ' · 已匹配 ' + state.matched);
  var button = document.getElementById('folder-lyric-match-' + state.folderIndex);
  if (button) {
    button.disabled = state.active;
    button.textContent = state.active ? (state.done + '/' + state.total) : '匹配歌词';
  }
}

function hideLocalFolderLyricMatchChip() {
  var chip = document.getElementById('local-lyric-match-chip');
  if (chip) chip.classList.remove('show', 'done');
}

async function matchLocalSongLyricsWithRetry(song, desktopApi) {
  var lastError = null;
  for (var attempt = 0; attempt < 2; attempt++) {
    try {
      if (song && song.localPath && !song.embeddedMetadataParsed && desktopApi && typeof desktopApi.resolveLocalMusicFile === 'function') {
        var parsed = await desktopApi.resolveLocalMusicFile(song.localPath, { deferCacheSave: true });
        if (parsed && parsed.ok && parsed.file) {
          var existingOnline = song.onlineMetadata;
          var fresh = localSongFromScanFile(parsed.file, song.localFolderPath || '');
          Object.assign(song, fresh, { localMissing: false });
          if (existingOnline) applyLocalOnlineMetadata(song, existingOnline);
          syncResolvedLocalSongReferences(song);
        }
      }
      var inlineLyric = String(song && (song.localLyricText || song.embeddedLyrics) || '').trim();
      if (inlineLyric.length >= 8) return true;
      var metadata = song.onlineMetadata || localMetadataMap[localMetadataKey(song)] || await resolveLocalOnlineMetadata(song, null, { manualMatched: false });
      if (!metadata) throw new Error('LOCAL_ONLINE_METADATA_NOT_FOUND');
      var onlineSong = localOnlineSongForMetadata(song);
      if (!onlineSong) throw new Error('LOCAL_ONLINE_SUBJECT_NOT_FOUND');
      var response = await apiJson(lyricEndpointForSong(onlineSong), { timeoutMs: 9000 });
      if (!localFolderLyricPayloadText(response)) throw new Error('LOCAL_ONLINE_LYRIC_NOT_FOUND');
      var cacheKey = localLyricCacheKey(song, onlineSong);
      if (window.desktopWindow && typeof window.desktopWindow.setLocalLyricsCache === 'function') {
        await window.desktopWindow.setLocalLyricsCache(cacheKey, response || {});
      }
      syncLocalMetadata(song, metadata);
      syncResolvedLocalSongReferences(song);
      return true;
    } catch (error) {
      lastError = error;
      if (attempt === 0) await new Promise(function (resolve) { setTimeout(resolve, 480); });
    }
  }
  throw lastError || new Error('LOCAL_LYRIC_MATCH_FAILED');
}

async function matchLocalFolderLyrics(folderIndex) {
  folderIndex = Number(folderIndex);
  var folder = localFolderPlaylists[folderIndex];
  if (!folder || !Array.isArray(folder.songs) || !folder.songs.length) return;
  if (localFolderLyricMatchState.active) { showToast('已有文件夹正在解析歌词'); return; }
  var desktopApi = typeof getDesktopWindowApi === 'function' ? getDesktopWindowApi() : window.desktopWindow;
  if (!desktopApi || typeof desktopApi.resolveLocalMusicFile !== 'function') {
    showToast('当前环境不支持解析本地音频');
    return;
  }
  localFolderLyricMatchState = { active: true, folderIndex: folderIndex, total: folder.songs.length, done: 0, matched: 0, failed: 0 };
  renderLocalLibraryPanel();
  updateLocalFolderLyricMatchChip(false);
  var cursor = 0;
  async function worker() {
    while (cursor < folder.songs.length) {
      var song = folder.songs[cursor++];
      try {
        await matchLocalSongLyricsWithRetry(song, desktopApi);
        localFolderLyricMatchState.matched += 1;
      } catch (error) {
        localFolderLyricMatchState.failed += 1;
        console.warn('[LocalFolderLyricMatch]', song && song.name, error);
      }
      localFolderLyricMatchState.done += 1;
      updateLocalFolderLyricMatchChip(false);
      if (localFolderLyricMatchState.done % 20 === 0) saveLocalMetadataMap();
    }
  }
  await Promise.all([worker(), worker()]);
  saveLocalMetadataMap();
  if (typeof desktopApi.flushLocalAudioMetadataCache === 'function') {
    try { await desktopApi.flushLocalAudioMetadataCache(); }
    catch (error) { console.warn('[LocalAudioMetadataCacheFlush]', error); }
  }
  localFolderLyricMatchState.active = false;
  rebindRestoredLocalQueueSongs();
  renderLocalLibraryDetailState();
  safeRenderQueuePanel('local-folder-lyric-match');
  updateLocalFolderLyricMatchChip(true);
  var current = currentLocalSong || playQueue[currentIdx];
  if (current && current.type === 'local' && current.localFolderPath === folder.folderPath) fetchLyric(current, trackSwitchToken);
  showToast('歌词解析完成: 已匹配 ' + localFolderLyricMatchState.matched + ' / ' + localFolderLyricMatchState.total);
  setTimeout(function () { if (!localFolderLyricMatchState.active) hideLocalFolderLyricMatchChip(); }, 3800);
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
        '<span class="local-library-meta"><span class="local-library-name">' + escHtml(song.name) + '</span><span class="local-library-sub">' + escHtml(song.artist || song.localFolderName) + '</span></span></button>';
    }).join('') : '<div class="local-library-empty">没有匹配的本地音乐</div>';
    return;
  }
  list.innerHTML = localFolderPlaylists.map(function (folder, folderIndex) {
    var first = folder.songs && folder.songs[0];
    var cover = localLibraryCover(first);
    var expanded = localLibraryDetailState.folderIndex === folderIndex;
    return '<div class="local-library-folder-group"><div class="local-library-folder' + (expanded ? ' expanded' : '') + '" role="button" tabindex="0" aria-expanded="' + (expanded ? 'true' : 'false') + '" onclick="toggleLocalFolderPreview(' + folderIndex + ')" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();toggleLocalFolderPreview(' + folderIndex + ')}">' +
      (cover ? '<img class="local-library-cover" src="' + escHtml(cover) + '" alt="">' : '<span class="local-library-cover"></span>') +
      '<span class="local-library-meta"><span class="local-library-name">' + escHtml(folder.name) + '</span><span class="local-library-sub">' + (folder.songs || []).length + ' 首 · ' + escHtml(folder.folderPath) + '</span></span>' +
      '<button id="folder-lyric-match-' + folderIndex + '" class="folder-lyric-match-btn' + (localFolderLyricMatchState.active && localFolderLyricMatchState.folderIndex === folderIndex ? ' matching' : '') + '" type="button" onclick="event.stopPropagation();matchLocalFolderLyrics(' + folderIndex + ')"' + (localFolderLyricMatchState.active ? ' disabled' : '') + '>' + (localFolderLyricMatchState.active && localFolderLyricMatchState.folderIndex === folderIndex ? (localFolderLyricMatchState.done + '/' + localFolderLyricMatchState.total) : '匹配歌词') + '</button></div></div>';
  }).join('');
}
function localLibraryDetailHtml() {
  var folderIndex = localLibraryDetailState.folderIndex;
  var folder = localFolderPlaylists[folderIndex];
  if (!folder) return '';
  var tracks = Array.isArray(folder.songs) ? folder.songs : [];
  var renderLimit = Math.min(tracks.length, Math.max(PLAYLIST_DETAIL_INITIAL_RENDER, localLibraryDetailState.renderLimit || PLAYLIST_DETAIL_INITIAL_RENDER));
  var cover = localLibraryCover(tracks[0]);
  var coverHtml = cover ? '<img class="pl-detail-cover" src="' + escHtml(cover) + '" alt="" decoding="async" onerror="this.style.opacity=0.2">' : '<div class="pl-detail-cover"></div>';
  var rows = tracks.slice(0, renderLimit).map(function (song, index) {
    var thumb = localLibraryCover(song);
    var thumbHtml = thumb ? '<img src="' + escHtml(thumb) + '" alt="" loading="lazy" decoding="async" onerror="this.style.opacity=0.2">' : '<div style="width:34px;height:34px;border-radius:7px;background:rgba(255,255,255,.06);flex:0 0 auto"></div>';
    return '<div class="pl-detail-row' + (currentLocalSong && currentLocalSong.localKey === song.localKey ? ' now' : '') + '" data-local-detail-row="' + index + '">' +
      thumbHtml + '<div style="flex:1;min-width:0"><div class="pl-detail-row-title">' + escHtml(song.name || '') + '</div>' +
      '<button type="button" class="pl-detail-row-artist" data-local-detail-artist="' + index + '">' + escHtml(song.artist || '本地文件') + '</button></div>' +
      (typeof localDetailFileActionHtml === 'function' ? localDetailFileActionHtml(index) : '') + '</div>';
  }).join('');
  if (!rows) rows = '<div style="text-align:center;padding:14px 0;color:rgba(255,255,255,.30);font-size:11.5px">文件夹里暂无可播放歌曲</div>';
  if (tracks.length > renderLimit) {
    rows += '<button type="button" class="fx-mini-btn ghost pl-detail-load-more" data-local-detail-load-more="1">加载更多 ' + renderLimit + '/' + tracks.length + '</button>';
  } else if (tracks.length > PLAYLIST_DETAIL_INITIAL_RENDER) {
    rows += '<div class="pl-detail-progress">已显示全部 ' + tracks.length + ' 首</div>';
  }
  return '<div class="pl-inline-detail" data-local-detail="' + folderIndex + '"><div class="pl-detail-sticky">' +
    '<div class="pl-detail-head">' + coverHtml + '<div style="flex:1;min-width:0"><div class="pl-detail-title">' + escHtml(folder.name || '本地文件夹') + '</div><div class="pl-detail-sub">' + tracks.length + ' 首 · 本地文件夹</div></div><div class="pl-detail-count">' + renderLimit + '/' + tracks.length + '</div></div>' +
    '<div class="pl-detail-actions"><button class="pl-detail-play" type="button" data-local-detail-play="1"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>播放文件夹</button><button class="fx-mini-btn ghost pl-detail-top-btn" type="button" data-pl-detail-top="1">回到顶部</button></div>' +
    '</div><div class="pl-detail-list">' + rows + '</div></div>';
}
function renderLocalLibraryDetailState() {
  renderLocalLibraryPanel();
  if (typeof renderPlaylistPanelDetailPanel === 'function') renderPlaylistPanelDetailPanel();
}
function playLocalLibraryDetail() {
  if (localLibraryDetailState.folderIndex < 0) return;
  playLocalFolderPlaylist(localLibraryDetailState.folderIndex, 0);
}
function playLocalLibraryDetailTrack(index) {
  if (localLibraryDetailState.folderIndex < 0) return;
  playLocalFolderPlaylist(localLibraryDetailState.folderIndex, index);
}
function openLocalLibraryDetailArtist(index) {
  var folder = localFolderPlaylists[localLibraryDetailState.folderIndex];
  var song = folder && folder.songs && folder.songs[index];
  if (song) openArtistDetailForSong(song);
}
function growLocalLibraryDetailRenderLimit(amount) {
  var folder = localFolderPlaylists[localLibraryDetailState.folderIndex];
  var total = folder && folder.songs ? folder.songs.length : 0;
  if (!folder || !total) return false;
  var current = Math.max(PLAYLIST_DETAIL_INITIAL_RENDER, localLibraryDetailState.renderLimit || PLAYLIST_DETAIL_INITIAL_RENDER);
  var next = Math.min(total, current + (amount || PLAYLIST_DETAIL_BATCH_SIZE));
  if (next <= current) return false;
  var panel = document.getElementById('playlist-detail-panel');
  var keepTop = panel ? panel.scrollTop : 0;
  localLibraryDetailState.renderLimit = next;
  renderLocalLibraryDetailState();
  if (panel) panel.scrollTop = keepTop;
  return true;
}
function maybeGrowLocalLibraryDetailRenderLimit() {
  var panel = document.getElementById('playlist-detail-panel');
  var folder = localFolderPlaylists[localLibraryDetailState.folderIndex];
  if (!panel || !folder || localLibraryDetailState.renderLimit >= (folder.songs || []).length) return;
  if (panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 240) growLocalLibraryDetailRenderLimit();
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
        syncResolvedLocalSongReferences(song);
        if (hydrated % 8 === 0 && localLibraryDetailState.folderIndex === folderIndex) renderLocalLibraryDetailState();
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
    if (localLibraryDetailState.folderIndex === folderIndex) renderLocalLibraryDetailState();
  }).finally(function () { delete localFolderMetadataHydrationJobs[jobKey]; });
  return localFolderMetadataHydrationJobs[jobKey];
}
function toggleLocalFolderPreview(folderIndex) {
  localLibraryDetailState.folderIndex = localLibraryDetailState.folderIndex === folderIndex ? -1 : folderIndex;
  localLibraryDetailState.renderLimit = PLAYLIST_DETAIL_INITIAL_RENDER;
  renderLocalLibraryDetailState();
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
    syncResolvedLocalSongReferences(song);
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
  // 有搜索词时，用匹配结果集（而不是整个本地库）替换队列，并清空搜索框。
  var query = simpleSearchNorm(localLibrarySearchQuery || '');
  var sourceSongs = localLibrarySongs;
  if (query) {
    sourceSongs = localLibrarySongs.filter(function (item) {
      return simpleSearchNorm([item.name, item.artist, item.album, item.localPath, item.localFolderName].filter(Boolean).join(' ')).indexOf(query) >= 0;
    });
    if (!sourceSongs.length || sourceSongs.indexOf(song) < 0) sourceSongs = localLibrarySongs;
    localLibrarySearchQuery = '';
    var searchInput = document.getElementById('local-library-search');
    if (searchInput) searchInput.value = '';
  }
  playQueue = sourceSongs.map(cloneSong);
  currentIdx = Math.max(0, sourceSongs.indexOf(song));
  // 点搜索结果的歌曲 = 替换队列并立即播放，同时把面板切回"当前队列"定位到该曲。
  // skipShuffleOrder：随机模式下也不重排——上面排过的歌要保持原顺序留在队列里，不能被洗牌截走。
  if (typeof switchPlaylistTab === 'function') switchPlaylistTab('queue', { animate: false, refresh: false });
  safeRenderQueuePanel('local-library-play', { scrollCurrent: true });
  safeShelfRebuild('local-library-play', true);
  playQueueAt(currentIdx, { manual: true, skipShuffleOrder: true }).catch(function (e) { console.warn('[LocalLibraryPlay]', e); });
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
  if (typeof renderPlaylistPanelDetailPanel === 'function') renderPlaylistPanelDetailPanel();
});
hydrateLocalMetadataFromDisk();
if (typeof scheduleStartupIdleTask === 'function') scheduleStartupIdleTask(restoreLocalLibraryFolders, 900, 1200);
else setTimeout(restoreLocalLibraryFolders, 1200);

// ============================================================
//  控制台 — 预设卡片 + 主滑块 + 开关 + 三态
