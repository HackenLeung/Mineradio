'use strict';

var MUSIC_LIBRARY_WALL_OVERSCAN_ROWS = 2;
var musicLibraryWallCloudCatalog = { userId: '', count: 0, cover: '' };
var musicLibraryWallState = {
  active: false,
  level: 1,
  returnHome: false,
  libraries: [],
  detail: null,
  l1ScrollTop: 0,
  detailScrollTops: Object.create(null),
  trackQuery: '',
  locateHighlightTimer: 0,
  locateTargetIndex: -1,
  locateRequestToken: 0,
  gridWindowKey: '',
  renderRaf: 0,
  resizeRaf: 0,
  focusAfterRender: false
};

function musicLibraryWallElement(id) {
  return document.getElementById(id);
}

function isMusicLibraryWallOpen() {
  return !!musicLibraryWallState.active;
}

function musicLibraryWallProviderLabel(provider) {
  provider = typeof normalizePlaylistProvider === 'function' ? normalizePlaylistProvider(provider) : String(provider || 'netease');
  return provider === 'qq' ? '小Q' : (provider === 'kugou' ? '小狗' : '小云');
}

function musicLibraryWallCloudLoggedIn() {
  return typeof loginStatus !== 'undefined'
    && !!(loginStatus && loginStatus.loggedIn)
    && !!musicLibraryWallCloudUserId();
}

function musicLibraryWallCloudUserId() {
  if (typeof loginStatus === 'undefined' || !loginStatus || !loginStatus.loggedIn) return '';
  var raw = loginStatus.userId != null ? loginStatus.userId : loginStatus.uid;
  return raw == null ? '' : String(raw);
}

function musicLibraryWallSyncCloudAccount() {
  var userId = musicLibraryWallCloudUserId();
  if (musicLibraryWallCloudCatalog.userId === userId) return false;
  musicLibraryWallCloudCatalog = { userId: userId, count: 0, cover: '' };
  return true;
}

function musicLibraryWallSyncShelfTheme() {
  var wall = musicLibraryWallElement('music-library-wall');
  if (!wall) return;
  var accent = typeof shelfAccentHex === 'function' ? shelfAccentHex() : '#f4d28a';
  var rgb = typeof hexToRgb === 'function' ? hexToRgb(accent) : null;
  var look = typeof shelfSettings === 'function' ? shelfSettings() : null;
  wall.style.setProperty('--mlw-shelf-accent-rgb', rgb ? [rgb.r, rgb.g, rgb.b].join(', ') : '244, 210, 138');
  wall.style.setProperty('--mlw-shelf-bg-alpha', String(Math.max(.45, Math.min(.94, Number(look && look.bgOpacity) || .72))));
}

function musicLibraryWallCover(song) {
  if (!song) return '';
  if (typeof songCoverSrc === 'function') return songCoverSrc(song, 400) || '';
  if ((song.type === 'local' || song.source === 'local' || song.localKey) && typeof localLibraryCover === 'function') {
    return localLibraryCover(song) || '';
  }
  return song.customCover || song.sidecarCover || song.embeddedCover || song.cover || song.picUrl || song.albumCover || '';
}

function musicLibraryWallInitials(value) {
  var text = String(value || '音乐').trim();
  if (!text) return 'MR';
  var words = text.split(/\s+/).filter(Boolean);
  if (words.length > 1) return (words[0].charAt(0) + words[1].charAt(0)).toUpperCase();
  return text.slice(0, 2).toUpperCase();
}

function musicLibraryWallImageHtml(cover, title) {
  var fallback = '<span class="music-library-wall-art-fallback" aria-hidden="true">' + escHtml(musicLibraryWallInitials(title)) + '</span>';
  if (!cover) return fallback;
  return '<img src="' + escHtml(cover) + '" alt="" loading="lazy" decoding="async" onerror="this.hidden=true;this.parentNode.classList.add(\'is-missing\')">' + fallback;
}

function musicLibraryWallCloseCompetingSurfaces() {
  if (typeof togglePlaylistPanel === 'function') togglePlaylistPanel(false);
  if (typeof setPeek === 'function') {
    setPeek(musicLibraryWallElement('playlist-panel'), false, 'pl');
    setPeek(musicLibraryWallElement('search-area'), false, 'search');
    setPeek(musicLibraryWallElement('fx-panel'), false, 'fx');
  }
  if (typeof setShelfPinnedOpen === 'function') setShelfPinnedOpen(false, true);
  if (typeof safeShelfCloseContent === 'function' && typeof shelfManager !== 'undefined' && shelfManager && shelfManager.hasOpenContent && shelfManager.hasOpenContent()) {
    safeShelfCloseContent('music-library-wall');
  }
}

function musicLibraryWallCancelDetailRequest() {
  var detail = musicLibraryWallState.detail;
  if (!detail) return;
  detail.token += 1;
  if (detail.controller) {
    try { detail.controller.abort(); } catch (e) { }
  }
  if (detail.timer) clearTimeout(detail.timer);
  detail.controller = null;
  detail.timer = 0;
  detail.loading = false;
  detail.loadingMore = false;
}

function openMusicLibraryWall() {
  var wall = musicLibraryWallElement('music-library-wall');
  if (!wall) return false;
  if (!musicLibraryWallState.active) {
    musicLibraryWallState.returnHome = !!(emptyHomeActive || homeForcedOpen);
    musicLibraryWallState.level = 1;
    musicLibraryWallState.detail = null;
    musicLibraryWallState.trackQuery = '';
    musicLibraryWallClearLocateHighlight();
  }
  musicLibraryWallState.active = true;
  document.body.classList.add('music-library-wall-active');
  wall.setAttribute('aria-hidden', 'false');
  musicLibraryWallSyncShelfTheme();
  homeForcedOpen = false;
  homeSuppressed = true;
  if (typeof setHomeControlsLocked === 'function') setHomeControlsLocked(false);
  if (typeof updateEmptyHomeVisibility === 'function') updateEmptyHomeVisibility({ forceLoad: false });
  musicLibraryWallCloseCompetingSurfaces();
  renderMusicLibraryWallFromSources({ resetScroll: true, focus: true });
  if (typeof refreshUserPlaylists === 'function') {
    Promise.resolve(refreshUserPlaylists(false)).then(function () {
      renderMusicLibraryWallFromSources();
    }).catch(function (error) {
      console.warn('[MusicLibraryWallCatalog]', error);
      renderMusicLibraryWallFromSources();
    });
  }
  return true;
}

function closeMusicLibraryWall(opts) {
  opts = opts || {};
  if (!musicLibraryWallState.active) return false;
  var shouldReturnHome = opts.toHome === true || (opts.playback !== true && musicLibraryWallState.returnHome);
  var content = musicLibraryWallElement('music-library-wall-content');
  if (musicLibraryWallState.level === 1 && content) musicLibraryWallState.l1ScrollTop = content.scrollTop;
  if (musicLibraryWallState.level === 2 && musicLibraryWallState.detail && content) {
    musicLibraryWallState.detailScrollTops[musicLibraryWallState.detail.scrollKey] = content.scrollTop;
  }
  musicLibraryWallCancelDetailRequest();
  musicLibraryWallState.active = false;
  musicLibraryWallState.level = 1;
  musicLibraryWallState.detail = null;
  musicLibraryWallState.trackQuery = '';
  musicLibraryWallClearLocateHighlight();
  document.body.classList.remove('music-library-wall-active');
  var wall = musicLibraryWallElement('music-library-wall');
  if (wall) wall.setAttribute('aria-hidden', 'true');
  homeSuppressed = false;
  homeForcedOpen = !!shouldReturnHome;
  if (typeof setHomeControlsLocked === 'function') setHomeControlsLocked(!!shouldReturnHome);
  if (typeof updateEmptyHomeVisibility === 'function') updateEmptyHomeVisibility({ forceLoad: !!shouldReturnHome });
  if (opts.playback === true && typeof forcePlaybackControlsInteractive === 'function') forcePlaybackControlsInteractive();
  if (shouldReturnHome) requestAnimationFrame(function () {
    var homeLibraryCard = musicLibraryWallElement('home-library-card');
    if (homeLibraryCard) homeLibraryCard.focus();
  });
  return true;
}

function musicLibraryWallBuildLibraries() {
  musicLibraryWallSyncCloudAccount();
  var libraries = [];
  var allLocalCover = musicLibraryWallCover(localLibrarySongs && localLibrarySongs[0]);
  libraries.push({
    kind: 'local-all',
    title: '本地音乐',
    subtitle: (localLibrarySongs ? localLibrarySongs.length : 0) + ' 首 · 全部本地歌曲',
    count: localLibrarySongs ? localLibrarySongs.length : 0,
    cover: allLocalCover
  });
  (localFolderPlaylists || []).forEach(function (folder, folderIndex) {
    var songs = folder && Array.isArray(folder.songs) ? folder.songs : [];
    libraries.push({
      kind: 'local-folder',
      folderIndex: folderIndex,
      title: folder && folder.name || '本地文件夹',
      subtitle: folder && folder.restoreError ? '读取失败 · 本地文件夹' : (songs.length + ' 首 · 本地文件夹'),
      count: songs.length,
      cover: musicLibraryWallCover(songs[0]),
      error: folder && folder.restoreError || ''
    });
  });
  if (musicLibraryWallCloudLoggedIn()) {
    var cloudCount = Number(musicLibraryWallCloudCatalog.count) || 0;
    libraries.push({
      kind: 'netease-cloud',
      provider: 'netease',
      playlistId: 'all',
      title: '网易云音乐云盘',
      subtitle: cloudCount ? (cloudCount + ' 首 · 云端上传歌曲') : '云端上传歌曲 · 小云',
      count: cloudCount,
      cover: musicLibraryWallCloudCatalog.cover || ''
    });
  }
  (userPlaylists || []).forEach(function (playlist) {
    if (!playlist || !playlist.id) return;
    var provider = typeof normalizePlaylistProvider === 'function' ? normalizePlaylistProvider(playlist.provider) : (playlist.provider || 'netease');
    libraries.push({
      kind: 'playlist',
      provider: provider,
      playlistId: playlist.id,
      title: playlist.name || '未命名歌单',
      subtitle: (Number(playlist.trackCount) || 0) + ' 首 · ' + musicLibraryWallProviderLabel(provider),
      count: Number(playlist.trackCount) || 0,
      cover: playlist.cover || '',
      playlist: playlist
    });
  });
  return libraries;
}

function renderMusicLibraryWallFromSources(opts) {
  opts = opts || {};
  var cloudAccountChanged = musicLibraryWallSyncCloudAccount();
  if (!musicLibraryWallState.active) return false;
  if (
    musicLibraryWallState.level === 2
    && musicLibraryWallState.detail
    && (
      (
        musicLibraryWallState.detail.kind === 'playlist'
        && typeof playlistCatalogProviderLoggedIn === 'function'
        && !playlistCatalogProviderLoggedIn(musicLibraryWallState.detail.provider)
      )
      || (musicLibraryWallState.detail.kind === 'netease-cloud' && (!musicLibraryWallCloudLoggedIn() || cloudAccountChanged))
    )
  ) {
    musicLibraryWallCancelDetailRequest();
    musicLibraryWallState.level = 1;
    musicLibraryWallState.detail = null;
    musicLibraryWallState.trackQuery = '';
    opts.resetScroll = true;
  }
  if (musicLibraryWallState.level === 1) {
    musicLibraryWallState.libraries = musicLibraryWallBuildLibraries();
  } else if (musicLibraryWallState.detail && musicLibraryWallState.detail.kind === 'local-all') {
    musicLibraryWallState.detail.tracks = Array.isArray(localLibrarySongs) ? localLibrarySongs.slice() : [];
    musicLibraryWallState.detail.total = musicLibraryWallState.detail.tracks.length;
  } else if (musicLibraryWallState.detail && musicLibraryWallState.detail.kind === 'local-folder') {
    var folder = localFolderPlaylists && localFolderPlaylists[musicLibraryWallState.detail.folderIndex];
    musicLibraryWallState.detail.tracks = folder && Array.isArray(folder.songs) ? folder.songs.slice() : [];
    musicLibraryWallState.detail.total = musicLibraryWallState.detail.tracks.length;
  }
  musicLibraryWallState.focusAfterRender = !!opts.focus;
  renderMusicLibraryWall({ resetScroll: !!opts.resetScroll, forceGrid: true });
  return true;
}

function musicLibraryWallCurrentItems() {
  if (musicLibraryWallState.level === 1) return musicLibraryWallState.libraries || [];
  var detail = musicLibraryWallState.detail;
  var tracks = detail && Array.isArray(detail.tracks) ? detail.tracks : [];
  var query = musicLibraryWallNormalizedTrackQuery();
  var filterLocalTracks = musicLibraryWallCanSearchTracks(detail) && !!query;
  var items = [];
  tracks.forEach(function (song, index) {
    if (!filterLocalTracks || musicLibraryWallTrackMatchesQuery(song, query)) {
      items.push({ song: song, index: index });
    }
  });
  return items;
}

function musicLibraryWallCanSearchTracks(detail) {
  return !!detail && (detail.kind === 'local-all' || detail.kind === 'local-folder');
}

function musicLibraryWallNormalizedTrackQuery() {
  return String(musicLibraryWallState.trackQuery || '').trim().toLowerCase();
}

function musicLibraryWallTrackMatchesQuery(song, query) {
  if (!query) return true;
  song = song || {};
  var searchable = [
    song.name,
    song.title,
    song.artist,
    song.singer,
    song.album,
    song.fileName,
    song.filePath,
    song.path,
    song.localKey
  ].join(' ').toLowerCase();
  return searchable.indexOf(query) !== -1;
}

function musicLibraryWallVirtualWindow(total) {
  var content = musicLibraryWallElement('music-library-wall-content');
  var grid = musicLibraryWallElement('music-library-wall-grid');
  var width = Math.max(280, grid && grid.clientWidth || content && content.clientWidth || window.innerWidth - 64);
  var gap = window.innerWidth <= 700 ? 12 : 18;
  var minimum = window.innerWidth <= 700 ? 124 : (window.innerWidth <= 1100 ? 142 : 156);
  var columns = Math.max(2, Math.floor((width + gap) / (minimum + gap)));
  var cardWidth = Math.max(96, (width - gap * (columns - 1)) / columns);
  var rowHeight = cardWidth + gap;
  var scrollTop = content ? content.scrollTop : 0;
  var viewport = content ? content.clientHeight : window.innerHeight;
  var startRow = Math.max(0, Math.floor(scrollTop / rowHeight) - MUSIC_LIBRARY_WALL_OVERSCAN_ROWS);
  var endRow = Math.min(Math.ceil(total / columns), Math.ceil((scrollTop + viewport) / rowHeight) + MUSIC_LIBRARY_WALL_OVERSCAN_ROWS);
  return {
    columns: columns,
    rowHeight: rowHeight,
    start: Math.min(total, startRow * columns),
    end: Math.min(total, Math.max((startRow + 1) * columns, endRow * columns)),
    top: Math.max(0, startRow * rowHeight - gap),
    bottom: Math.max(0, (Math.ceil(total / columns) - endRow) * rowHeight - gap)
  };
}

function musicLibraryWallSpacerHtml(position, height) {
  if (height <= 0) return '';
  return '<div class="music-library-wall-spacer ' + position + '" style="height:' + Math.round(height) + 'px" aria-hidden="true"></div>';
}

function musicLibraryWallLibraryCardHtml(item, index) {
  var badge = item.kind === 'playlist'
    ? musicLibraryWallProviderLabel(item.provider)
    : (item.kind === 'netease-cloud' ? '云盘' : (item.kind === 'local-folder' ? '文件夹' : '本地'));
  var className = 'music-library-wall-card library-card' + (item.error ? ' has-error' : '');
  return '<button class="' + className + '" type="button" role="listitem" data-mlw-library-index="' + index + '" aria-label="打开 ' + escHtml(item.title) + '">' +
    '<span class="music-library-wall-art">' + musicLibraryWallImageHtml(item.cover, item.title) +
    '<span class="music-library-wall-card-copy"><span class="music-library-wall-card-eyebrow"><span class="music-library-wall-badge">' + escHtml(badge) + '</span></span>' +
    '<strong>' + escHtml(item.title) + '</strong><small>' + escHtml(item.subtitle) + '</small><i aria-hidden="true"></i></span></span>' +
    '</button>';
}

function musicLibraryWallTrackIsCurrent(song, index) {
  var current = (typeof currentLocalSong !== 'undefined' && currentLocalSong)
    || (playQueue && currentIdx >= 0 ? playQueue[currentIdx] : null);
  if (!song || !current) return false;
  var songIsLocal = song.type === 'local' || song.source === 'local' || song.localKey || song.localPath || song.filePath;
  var currentIsLocal = current.type === 'local' || current.source === 'local' || current.localKey || current.localPath || current.filePath;
  if (songIsLocal && currentIsLocal) {
    if (typeof isSameLocalLibrarySong === 'function' && isSameLocalLibrarySong(song, current)) return true;
    var songKey = String(song.localKey || '').trim();
    var currentKey = String(current.localKey || '').trim();
    if (songKey && currentKey && songKey === currentKey) return true;
    var songPath = String(song.localPath || song.filePath || '').toLowerCase();
    var currentPath = String(current.localPath || current.filePath || '').toLowerCase();
    if (songPath && currentPath && songPath === currentPath) return true;
    return false;
  }
  if (typeof queuePanelItemKey === 'function') {
    return queuePanelItemKey(song, 'wall:' + index) === queuePanelItemKey(current, 'queue:' + currentIdx);
  }
  return song === current;
}

function musicLibraryWallTrackCardHtml(song, index) {
  song = song || {};
  var title = song.name || song.title || ('歌曲 ' + (index + 1));
  var artist = song.artist || song.singer || song.album || (song.type === 'local' ? '本地文件' : '未知歌手');
  var missing = !!song.localMissing;
  var current = musicLibraryWallTrackIsCurrent(song, index);
  var locate = musicLibraryWallState.locateTargetIndex === index ? ' is-locate-highlight' : '';
  var className = 'music-library-wall-card track-card' + (missing ? ' is-unavailable' : '') + (current ? ' is-current' : '') + locate;
  var nextAction = (!missing && song.type !== 'podcast-radio')
    ? '<button class="music-library-wall-card-next" type="button" data-mlw-track-next="1" aria-label="将 ' + escHtml(title) + ' 设为下一首播放" title="下一首播放">' +
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 6h14M5 12h8M5 18h6M17 14v6M14 17h6" /></svg></button>'
    : '';
  return '<div class="' + className + '" role="button" tabindex="0" data-mlw-track-index="' + index + '" aria-label="播放 ' + escHtml(title) + '">' +
    '<span class="music-library-wall-art">' + musicLibraryWallImageHtml(musicLibraryWallCover(song), title) + nextAction +
    '<span class="music-library-wall-card-copy"><span class="music-library-wall-card-eyebrow"><span class="music-library-wall-track-number">#' + String(index + 1).padStart(2, '0') + '</span>' +
    (missing ? '<span class="music-library-wall-unavailable">文件缺失</span>' : '') +
    (current ? '<span class="music-library-wall-now">正在播放</span>' : '') + '</span>' +
    '<strong>' + escHtml(title) + '</strong><small>' + escHtml(artist) + '</small><i aria-hidden="true"></i></span></span>' +
    '</div>';
}

function musicLibraryWallFooterHtml() {
  if (musicLibraryWallState.level === 1) {
    if (typeof playlistCatalogSyncState !== 'undefined' && playlistCatalogSyncState.loading) {
      return '<span class="music-library-wall-loading-dot" aria-hidden="true"></span>正在同步用户歌单';
    }
    if (musicLibraryWallState.libraries.length === 1 && !localLibrarySongs.length) {
      return '还没有歌单或本地歌曲；登录音乐平台或导入本地文件夹后会显示在这里。';
    }
    return '';
  }
  var detail = musicLibraryWallState.detail;
  if (!detail) return '';
  var query = musicLibraryWallNormalizedTrackQuery();
  if (musicLibraryWallCanSearchTracks(detail) && query) {
    var matched = musicLibraryWallCurrentItems().length;
    if (!matched) return '没有匹配的本地歌曲';
    return '匹配 ' + matched + '/' + detail.tracks.length + ' 首本地歌曲';
  }
  if (detail.loading && !detail.tracks.length) return '<span class="music-library-wall-loading-dot" aria-hidden="true"></span>正在加载歌曲';
  if (detail.loadingMore) return '<span class="music-library-wall-loading-dot" aria-hidden="true"></span>正在加载后续歌曲 ' + detail.tracks.length + (detail.total ? '/' + detail.total : '');
  if (detail.error) return '<span>' + escHtml(detail.error) + '</span><button type="button" data-mlw-retry="1">重试</button>';
  if (detail.hasMore) return '<button type="button" data-mlw-load-more="1">继续加载 ' + detail.tracks.length + (detail.total ? '/' + detail.total : '') + '</button>';
  if (detail.tracks.length) return '已显示全部 ' + detail.tracks.length + ' 首';
  return '这个音乐库里暂时没有歌曲';
}

function renderMusicLibraryWall(opts) {
  opts = opts || {};
  if (!musicLibraryWallState.active) return;
  musicLibraryWallSyncShelfTheme();
  var wall = musicLibraryWallElement('music-library-wall');
  var content = musicLibraryWallElement('music-library-wall-content');
  var grid = musicLibraryWallElement('music-library-wall-grid');
  var footer = musicLibraryWallElement('music-library-wall-footer');
  var playAll = musicLibraryWallElement('music-library-wall-play-all');
  var title = musicLibraryWallElement('music-library-wall-title');
  var subtitle = musicLibraryWallElement('music-library-wall-subtitle');
  var kicker = musicLibraryWallElement('music-library-wall-kicker');
  var status = musicLibraryWallElement('music-library-wall-status');
  var back = musicLibraryWallElement('music-library-wall-back');
  var search = musicLibraryWallElement('music-library-wall-search');
  var searchInput = musicLibraryWallElement('music-library-wall-search-input');
  var searchClear = musicLibraryWallElement('music-library-wall-search-clear');
  var locateCurrent = musicLibraryWallElement('music-library-wall-locate-current');
  if (!content || !grid) return;
  if (wall) wall.setAttribute('data-level', String(musicLibraryWallState.level));
  if (opts.resetScroll) content.scrollTop = musicLibraryWallState.level === 1
    ? musicLibraryWallState.l1ScrollTop
    : Number(musicLibraryWallState.detail && musicLibraryWallState.detail.scrollTop) || 0;
  var items = musicLibraryWallCurrentItems();
  var virtual = musicLibraryWallVirtualWindow(items.length);
  var detailKey = musicLibraryWallState.detail
    ? [musicLibraryWallState.detail.kind, musicLibraryWallState.detail.provider, musicLibraryWallState.detail.playlistId, musicLibraryWallState.detail.folderIndex].join(':')
    : '';
  var gridWindowKey = [musicLibraryWallState.level, detailKey, musicLibraryWallNormalizedTrackQuery(), items.length, virtual.columns, virtual.start, virtual.end].join('|');
  if (opts.virtualOnly && !opts.forceGrid && gridWindowKey === musicLibraryWallState.gridWindowKey) {
    musicLibraryWallUpdateScrollControls();
    return;
  }
  if (opts.forceGrid || gridWindowKey !== musicLibraryWallState.gridWindowKey) {
    var html = musicLibraryWallSpacerHtml('top', virtual.top);
    for (var index = virtual.start; index < virtual.end; index += 1) {
      if (musicLibraryWallState.level === 1) {
        html += musicLibraryWallLibraryCardHtml(items[index], index);
      } else {
        html += musicLibraryWallTrackCardHtml(items[index].song, items[index].index);
      }
    }
    html += musicLibraryWallSpacerHtml('bottom', virtual.bottom);
    grid.innerHTML = html;
    musicLibraryWallState.gridWindowKey = gridWindowKey;
  }
  if (footer) footer.innerHTML = musicLibraryWallFooterHtml();
  if (musicLibraryWallState.level === 1) {
    musicLibraryWallState.trackQuery = '';
    if (wall) wall.setAttribute('data-local-search', 'false');
    if (search) search.hidden = true;
    if (searchInput) searchInput.value = '';
    if (searchClear) searchClear.hidden = true;
    if (locateCurrent) locateCurrent.hidden = true;
    if (kicker) kicker.textContent = 'LIBRARY · L1';
    if (title) title.textContent = '音乐库';
    if (subtitle) subtitle.textContent = '用户歌单、云盘与本地音乐';
    if (status) status.textContent = items.length + ' 个音乐库';
    if (playAll) playAll.hidden = true;
    if (back) back.setAttribute('aria-label', '返回 Home');
  } else {
    var detail = musicLibraryWallState.detail || {};
    var searchable = musicLibraryWallCanSearchTracks(detail);
    if (wall) wall.setAttribute('data-local-search', searchable ? 'true' : 'false');
    if (search) search.hidden = !searchable;
    if (searchInput && searchInput.value !== musicLibraryWallState.trackQuery) searchInput.value = musicLibraryWallState.trackQuery;
    if (searchClear) searchClear.hidden = !musicLibraryWallNormalizedTrackQuery();
    if (locateCurrent) {
      locateCurrent.hidden = !detail.tracks || !detail.tracks.length;
      locateCurrent.disabled = false;
      locateCurrent.setAttribute('aria-label', '定位当前歌曲');
      locateCurrent.title = '定位当前歌曲';
    }
    if (kicker) kicker.textContent = 'TRACKS · L2';
    if (title) title.textContent = detail.title || '歌曲';
    if (subtitle) subtitle.textContent = detail.subtitle || '歌曲封面墙';
    if (status) status.textContent = searchable && musicLibraryWallNormalizedTrackQuery()
      ? ('匹配 ' + items.length + '/' + detail.tracks.length + ' 首')
      : (detail.total ? ('已加载 ' + items.length + '/' + detail.total) : (items.length + ' 首'));
    if (playAll) playAll.hidden = !detail.tracks || !detail.tracks.length;
    if (back) back.setAttribute('aria-label', '返回音乐库');
  }
  if (musicLibraryWallState.focusAfterRender) {
    musicLibraryWallState.focusAfterRender = false;
    requestAnimationFrame(function () { try { content.focus({ preventScroll: true }); } catch (e) { content.focus(); } });
  }
  musicLibraryWallUpdateScrollControls();
}

function scheduleMusicLibraryWallRender() {
  if (!musicLibraryWallState.active || musicLibraryWallState.renderRaf) return;
  musicLibraryWallState.renderRaf = requestAnimationFrame(function () {
    musicLibraryWallState.renderRaf = 0;
    renderMusicLibraryWall({ virtualOnly: true });
  });
}

function musicLibraryWallOpenLibrary(index) {
  var item = musicLibraryWallState.libraries[index];
  var content = musicLibraryWallElement('music-library-wall-content');
  if (!item || !musicLibraryWallState.active) return;
  musicLibraryWallState.l1ScrollTop = content ? content.scrollTop : 0;
  musicLibraryWallCancelDetailRequest();
  musicLibraryWallState.level = 2;
  musicLibraryWallState.trackQuery = '';
  musicLibraryWallClearLocateHighlight();
  var detailScrollKey = [item.kind, item.provider || '', item.playlistId || '', item.folderIndex == null ? '' : item.folderIndex].join(':');
  musicLibraryWallState.detail = {
    kind: item.kind,
    title: item.title,
    subtitle: item.subtitle,
    provider: item.provider || '',
    playlistId: item.playlistId || '',
    playlist: item.playlist || null,
    folderIndex: item.folderIndex == null ? -1 : item.folderIndex,
    scrollKey: detailScrollKey,
    scrollTop: Number(musicLibraryWallState.detailScrollTops[detailScrollKey]) || 0,
    tracks: [],
    total: Number(item.count) || 0,
    nextOffset: 0,
    hasMore: item.kind === 'playlist',
    // The request function owns the loading transition. Starting true here
    // would make its duplicate-request guard suppress the initial page.
    loading: false,
    loadingMore: false,
    error: '',
    token: 1,
    controller: null,
    timer: 0
  };
  if (item.kind === 'netease-cloud') musicLibraryWallState.detail.hasMore = true;
  if (item.kind === 'local-all') {
    musicLibraryWallState.detail.tracks = Array.isArray(localLibrarySongs) ? localLibrarySongs.slice() : [];
    musicLibraryWallState.detail.total = musicLibraryWallState.detail.tracks.length;
    musicLibraryWallState.detail.loading = false;
    musicLibraryWallState.detail.hasMore = false;
  } else if (item.kind === 'local-folder') {
    var folder = localFolderPlaylists && localFolderPlaylists[item.folderIndex];
    musicLibraryWallState.detail.tracks = folder && Array.isArray(folder.songs) ? folder.songs.slice() : [];
    musicLibraryWallState.detail.total = musicLibraryWallState.detail.tracks.length;
    musicLibraryWallState.detail.loading = false;
    musicLibraryWallState.detail.hasMore = false;
  }
  if (content) content.scrollTop = musicLibraryWallState.detail.scrollTop;
  renderMusicLibraryWall({ resetScroll: true, forceGrid: true });
  if (item.kind === 'playlist' || item.kind === 'netease-cloud') {
    musicLibraryWallLoadDetailPage('initial');
  } else if (typeof hydrateLocalFolderPreview === 'function') {
    var folderIndexes = item.kind === 'local-folder'
      ? [item.folderIndex]
      : (localFolderPlaylists || []).map(function (_, folderIndex) { return folderIndex; });
    // 每个文件夹水合完就重画一次，"全部本地"下不必等整轮 IPC 扫完才看到封面。
    var redrawHydratedWall = function () {
      if (musicLibraryWallState.active && musicLibraryWallState.detail && musicLibraryWallState.detail.scrollKey === detailScrollKey) {
        renderMusicLibraryWallFromSources();
      }
    };
    folderIndexes.reduce(function (promise, folderIndex) {
      return promise
        .then(function () { return hydrateLocalFolderPreview(folderIndex); })
        .then(redrawHydratedWall);
    }, Promise.resolve()).catch(function (error) { console.warn('[MusicLibraryWallLocalCover]', error); });
  }
}

function musicLibraryWallBack() {
  if (!musicLibraryWallState.active) return;
  if (musicLibraryWallState.level === 2) {
    var content = musicLibraryWallElement('music-library-wall-content');
    if (content && musicLibraryWallState.detail) {
      musicLibraryWallState.detailScrollTops[musicLibraryWallState.detail.scrollKey] = content.scrollTop;
    }
    musicLibraryWallCancelDetailRequest();
    musicLibraryWallState.level = 1;
    musicLibraryWallState.detail = null;
    musicLibraryWallState.trackQuery = '';
    musicLibraryWallClearLocateHighlight();
    renderMusicLibraryWallFromSources({ resetScroll: true, focus: true });
    return;
  }
  closeMusicLibraryWall({ toHome: true, reason: 'back' });
}

async function musicLibraryWallLoadDetailPage(reason) {
  var detail = musicLibraryWallState.detail;
  var isCloud = !!(detail && detail.kind === 'netease-cloud');
  var cloudUserId = isCloud ? musicLibraryWallCloudUserId() : '';
  if (!musicLibraryWallState.active || musicLibraryWallState.level !== 2 || !detail || (detail.kind !== 'playlist' && !isCloud)) return false;
  if (detail.loading || detail.loadingMore || (reason !== 'initial' && !detail.hasMore)) return false;
  var offset = reason === 'initial' ? 0 : Math.max(0, Number(detail.nextOffset) || detail.tracks.length);
  var token = detail.token;
  var controller = window.AbortController ? new AbortController() : null;
  detail.controller = controller;
  detail.loading = reason === 'initial' && !detail.tracks.length;
  detail.loadingMore = reason !== 'initial';
  detail.error = '';
  if (controller) detail.timer = setTimeout(function () { controller.abort(); }, 12000);
  renderMusicLibraryWall();
  try {
    var limit = typeof PLAYLIST_DETAIL_BATCH_SIZE === 'number' ? PLAYLIST_DETAIL_BATCH_SIZE : 80;
    var endpoint = isCloud
      ? '/api/user/cloud?limit=' + encodeURIComponent(limit) + '&offset=' + encodeURIComponent(offset)
      : playlistTracksEndpoint(detail.provider, detail.playlistId, { limit: limit, offset: offset });
    var response = await apiJson(endpoint, controller ? { signal: controller.signal } : { timeoutMs: 12000 });
    if (!musicLibraryWallState.active || musicLibraryWallState.detail !== detail || detail.token !== token) return false;
    if (isCloud && cloudUserId !== musicLibraryWallCloudUserId()) return false;
    var rawTracks = response && (response.tracks || response.songs) || [];
    if (response && response.error && !rawTracks.length) throw new Error(response.message || response.error);
    var mapped = rawTracks.map(cloneSong);
    var added = typeof appendPlaylistPanelDetailTracks === 'function'
      ? appendPlaylistPanelDetailTracks(detail.tracks, mapped)
      : (Array.prototype.push.apply(detail.tracks, mapped), mapped.length);
    var responseTotal = Number(response && (response.total || (response.playlist && response.playlist.trackCount))) || 0;
    detail.total = Math.max(detail.total || 0, responseTotal, detail.tracks.length);
    if (isCloud) {
      musicLibraryWallCloudCatalog.count = responseTotal;
      if (!musicLibraryWallCloudCatalog.cover && mapped[0]) musicLibraryWallCloudCatalog.cover = musicLibraryWallCover(mapped[0]);
    }
    detail.nextOffset = Math.max(offset + rawTracks.length, Number(response && response.nextOffset) || 0);
    detail.hasMore = !!(response && response.hasMore) || (!!detail.total && detail.nextOffset < detail.total);
    if (!rawTracks.length || (!added && detail.nextOffset <= offset)) detail.hasMore = false;
    detail.loading = false;
    detail.loadingMore = false;
    detail.error = response && response.warning || '';
    renderMusicLibraryWall();
    return added > 0;
  } catch (error) {
    if (!musicLibraryWallState.active || musicLibraryWallState.detail !== detail || detail.token !== token) return false;
    if (error && error.name === 'AbortError') detail.error = '歌曲加载超时，请重试';
    else detail.error = '歌曲加载失败，请重试';
    detail.loading = false;
    detail.loadingMore = false;
    console.warn('[MusicLibraryWallDetail]', detail.playlistId, reason, error);
    renderMusicLibraryWall();
    return false;
  } finally {
    if (detail.timer) clearTimeout(detail.timer);
    if (musicLibraryWallState.detail === detail && detail.token === token) {
      detail.timer = 0;
      detail.controller = null;
    }
  }
}

function musicLibraryWallCommitTrackPlayback(detail, index, opts) {
  if (!detail || !detail.tracks[index]) return false;
  opts = opts || {};
  var result = null;
  if (detail.kind === 'local-all') {
    playQueue = detail.tracks.map(cloneSong);
    currentIdx = Math.max(0, Math.min(playQueue.length - 1, Number(index) || 0));
    if (typeof switchPlaylistTab === 'function') switchPlaylistTab('queue', { animate: false, refresh: false });
    safeRenderQueuePanel('music-library-wall-local-all', { scrollCurrent: true });
    safeShelfRebuild('music-library-wall-local-all', true);
    result = playQueueAt(currentIdx, { manual: true, coverDeliveryToken: opts.coverDeliveryToken });
  } else if (detail.kind === 'local-folder') {
    playQueue = detail.tracks.map(cloneSong);
    currentIdx = Math.max(0, Math.min(playQueue.length - 1, Number(index) || 0));
    safeRenderQueuePanel('music-library-wall-local-folder', { scrollCurrent: true });
    safeShelfRebuild('music-library-wall-local-folder', true);
    result = playQueueAt(currentIdx, { manual: true, coverDeliveryToken: opts.coverDeliveryToken });
  } else if (detail.kind === 'playlist' || detail.kind === 'netease-cloud') {
    var providerId = detail.kind === 'netease-cloud'
      ? 'netease-cloud:' + (detail.playlistId || 'all')
      : (typeof playlistPanelProviderId === 'function'
        ? playlistPanelProviderId(detail.provider, detail.playlistId)
        : (detail.provider === 'qq' ? 'qq:' : (detail.provider === 'kugou' ? 'kugou:' : '')) + detail.playlistId);
    result = loadPlaylistIntoQueueById(providerId, true, detail.title || '', {
      seedTracks: detail.tracks,
      startIndex: index,
      total: detail.total,
      nextOffset: detail.nextOffset,
      hasMore: detail.hasMore,
      preserveHomeState: false,
      coverDeliveryToken: opts.coverDeliveryToken
    });
  }
  if (result && typeof result.catch === 'function') result.catch(function (error) { console.warn('[MusicLibraryWallPlay]', error); });
  return result;
}

function musicLibraryWallPlayTrack(index, sourceCard) {
  var detail = musicLibraryWallState.detail;
  if (!detail || !detail.tracks[index]) return false;
  var playTrack = function (playbackOpts) { return musicLibraryWallCommitTrackPlayback(detail, index, playbackOpts); };
  var deliveryScheduled = false;
  if (sourceCard && typeof startCoverDeliveryFromMusicLibraryCard === 'function') {
    deliveryScheduled = startCoverDeliveryFromMusicLibraryCard(sourceCard, detail.tracks[index], {
      onPlaybackReady: playTrack
    });
    if (deliveryScheduled) {
      musicLibraryWallState.returnHome = false;
      // 先让音乐库墙退场，飞行中的封面继续留在全局投递层，控制条等抵达时再 reveal。
      closeMusicLibraryWall({ playback: false, reason: 'track-cover-delivery' });
      return true;
    }
  }
  if (!deliveryScheduled && typeof coverDeliveryCancel === 'function') {
    coverDeliveryCancel('music-library-playback');
  }
  var result = playTrack();
  musicLibraryWallState.returnHome = false;
  closeMusicLibraryWall({ playback: true, reason: 'track-play' });
  return true;
}

function musicLibraryWallPlayAll() {
  if (musicLibraryWallState.level !== 2) return false;
  return musicLibraryWallPlayTrack(0);
}

function musicLibraryWallFindCurrentTrackIndex(detail) {
  if (!detail || !Array.isArray(detail.tracks)) return -1;
  for (var index = 0; index < detail.tracks.length; index += 1) {
    if (musicLibraryWallTrackIsCurrent(detail.tracks[index], index)) return index;
  }
  return -1;
}

function musicLibraryWallSetSearchQuery(value, opts) {
  opts = opts || {};
  var detail = musicLibraryWallState.detail;
  if (!musicLibraryWallState.active || !musicLibraryWallCanSearchTracks(detail)) return false;
  var query = String(value || '').trim();
  var input = musicLibraryWallElement('music-library-wall-search-input');
  if (musicLibraryWallState.trackQuery === query && (!input || input.value === query)) return false;
  musicLibraryWallState.trackQuery = query;
  if (input && input.value !== query) input.value = query;
  if (opts.resetScroll !== false) {
    var content = musicLibraryWallElement('music-library-wall-content');
    if (content) content.scrollTop = 0;
    detail.scrollTop = 0;
    musicLibraryWallState.detailScrollTops[detail.scrollKey] = 0;
  }
  renderMusicLibraryWall({ forceGrid: true });
  return true;
}

function musicLibraryWallScrollBehavior() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}

function musicLibraryWallClearLocateHighlight(keepCard) {
  if (musicLibraryWallState.locateHighlightTimer) {
    clearTimeout(musicLibraryWallState.locateHighlightTimer);
    musicLibraryWallState.locateHighlightTimer = 0;
  }
  musicLibraryWallState.locateTargetIndex = -1;
  var grid = musicLibraryWallElement('music-library-wall-grid');
  if (!grid) return;
  Array.prototype.forEach.call(grid.querySelectorAll('.is-locate-highlight'), function (card) {
    if (card !== keepCard) card.classList.remove('is-locate-highlight');
  });
}

function musicLibraryWallHighlightLocateCard(card, targetIndex) {
  if (!card) return;
  // 虚拟列表可能已在滚动过程中给目标卡片启动过一次动画，避免在滚动结束时重播。
  var alreadyHighlighted = card.classList.contains('is-locate-highlight');
  musicLibraryWallClearLocateHighlight(alreadyHighlighted ? card : null);
  var numericIndex = Number(targetIndex);
  if (isFinite(numericIndex) && numericIndex >= 0) musicLibraryWallState.locateTargetIndex = numericIndex;
  if (!alreadyHighlighted) {
    card.classList.remove('is-locate-highlight');
    void card.offsetWidth;
    card.classList.add('is-locate-highlight');
  }
  musicLibraryWallState.locateHighlightTimer = setTimeout(function () {
    musicLibraryWallState.locateTargetIndex = -1;
    musicLibraryWallState.locateHighlightTimer = 0;
    var grid = musicLibraryWallElement('music-library-wall-grid');
    if (!grid) return;
    Array.prototype.forEach.call(grid.querySelectorAll('.is-locate-highlight'), function (highlightedCard) {
      highlightedCard.classList.remove('is-locate-highlight');
    });
  }, 760);
}

function musicLibraryWallQueueTrackNext(index) {
  var detail = musicLibraryWallState.detail;
  index = Number(index);
  var song = detail && Array.isArray(detail.tracks) && index >= 0 ? detail.tracks[index] : null;
  if (!song || song.localMissing || song.type === 'podcast-radio') return false;
  if (musicLibraryWallTrackIsCurrent(song, index)) {
    if (typeof showToast === 'function') showToast('这首歌正在播放');
    return false;
  }
  if (typeof queueDetailSongNext === 'function') {
    queueDetailSongNext(song);
  } else if (typeof queueSongNext === 'function') {
    queueSongNext(song);
    if (typeof showToast === 'function') showToast('已设为下一首: ' + (song.name || song.title || ''));
  } else {
    return false;
  }
  return true;
}

function musicLibraryWallLocateCurrentTrack() {
  var detail = musicLibraryWallState.detail;
  var content = musicLibraryWallElement('music-library-wall-content');
  if (!musicLibraryWallState.active || musicLibraryWallState.level !== 2 || !detail || !content) return false;
  var targetIndex = musicLibraryWallFindCurrentTrackIndex(detail);
  if (targetIndex < 0) {
    if (typeof showToast === 'function') showToast('当前歌曲不在这个音乐库中');
    return false;
  }
  var locateRequestToken = ++musicLibraryWallState.locateRequestToken;
  musicLibraryWallClearLocateHighlight();
  if (musicLibraryWallNormalizedTrackQuery() && !musicLibraryWallTrackMatchesQuery(detail.tracks[targetIndex], musicLibraryWallNormalizedTrackQuery())) {
    musicLibraryWallSetSearchQuery('', { resetScroll: false });
  }
  musicLibraryWallState.locateTargetIndex = targetIndex;
  var items = musicLibraryWallCurrentItems();
  var visibleIndex = -1;
  for (var index = 0; index < items.length; index += 1) {
    if (items[index].index === targetIndex) {
      visibleIndex = index;
      break;
    }
  }
  if (visibleIndex < 0) {
    musicLibraryWallState.locateTargetIndex = -1;
    return false;
  }
  var virtual = musicLibraryWallVirtualWindow(items.length);
  var row = Math.floor(visibleIndex / virtual.columns);
  var targetTop = Math.max(0, row * virtual.rowHeight - (content.clientHeight - virtual.rowHeight) * .42);
  var behavior = musicLibraryWallScrollBehavior();
  content.scrollTo({ top: targetTop, behavior: behavior });
  var highlightStartedAt = Date.now();
  var focusAndHighlight = function () {
    if (!musicLibraryWallState.active || musicLibraryWallState.detail !== detail || musicLibraryWallState.locateRequestToken !== locateRequestToken) return;
    var grid = musicLibraryWallElement('music-library-wall-grid');
    var card = grid && grid.querySelector('[data-mlw-track-index="' + targetIndex + '"]');
    var scrollSettled = behavior !== 'smooth' || Math.abs(content.scrollTop - targetTop) <= 12;
    if (!card || !scrollSettled) {
      if (Date.now() - highlightStartedAt < 1600) window.setTimeout(focusAndHighlight, 60);
      return;
    }
    try { card.focus({ preventScroll: true }); } catch (e) { card.focus(); }
    musicLibraryWallHighlightLocateCard(card, targetIndex);
  };
  window.setTimeout(focusAndHighlight, behavior === 'smooth' ? 180 : 0);
  return true;
}

function musicLibraryWallScrollToTop() {
  var content = musicLibraryWallElement('music-library-wall-content');
  if (!content) return false;
  content.scrollTo({ top: 0, behavior: musicLibraryWallScrollBehavior() });
  return true;
}

function musicLibraryWallUpdateScrollControls() {
  var content = musicLibraryWallElement('music-library-wall-content');
  var toTop = musicLibraryWallElement('music-library-wall-to-top');
  if (!toTop) return;
  var show = !!(
    musicLibraryWallState.active
    && musicLibraryWallState.level === 2
    && musicLibraryWallCanSearchTracks(musicLibraryWallState.detail)
    && content
    && content.scrollTop > Math.max(160, content.clientHeight * .34)
  );
  toTop.hidden = !show;
}

function musicLibraryWallResetCardTilt(card) {
  if (!card || !card.style) return;
  ['--mlw-tilt-x', '--mlw-tilt-y', '--mlw-shadow-x', '--mlw-shadow-y', '--mlw-glare-x', '--mlw-glare-y'].forEach(function (name) {
    card.style.removeProperty(name);
  });
}

function musicLibraryWallUpdateCardTilt(card, event) {
  if (!card || !event || (event.pointerType && event.pointerType !== 'mouse' && event.pointerType !== 'pen')) return;
  var rect = card.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  var x = Math.max(-1, Math.min(1, ((event.clientX - rect.left) / rect.width - 0.5) * 2));
  var y = Math.max(-1, Math.min(1, ((event.clientY - rect.top) / rect.height - 0.5) * 2));
  card.style.setProperty('--mlw-tilt-x', (-y * 3.8).toFixed(2) + 'deg');
  card.style.setProperty('--mlw-tilt-y', (x * 5.2).toFixed(2) + 'deg');
  card.style.setProperty('--mlw-shadow-x', (-x * 16).toFixed(1) + 'px');
  card.style.setProperty('--mlw-shadow-y', (24 + y * 7).toFixed(1) + 'px');
  card.style.setProperty('--mlw-glare-x', ((x + 1) * 50).toFixed(1) + '%');
  card.style.setProperty('--mlw-glare-y', ((y + 1) * 50).toFixed(1) + '%');
}

var musicLibraryWallBackButton = musicLibraryWallElement('music-library-wall-back');
var musicLibraryWallSearchForm = musicLibraryWallElement('music-library-wall-search');
var musicLibraryWallSearchInput = musicLibraryWallElement('music-library-wall-search-input');
var musicLibraryWallSearchClear = musicLibraryWallElement('music-library-wall-search-clear');
var musicLibraryWallLocateCurrentButton = musicLibraryWallElement('music-library-wall-locate-current');
var musicLibraryWallPlayAllButton = musicLibraryWallElement('music-library-wall-play-all');
var musicLibraryWallContent = musicLibraryWallElement('music-library-wall-content');
var musicLibraryWallGrid = musicLibraryWallElement('music-library-wall-grid');
var musicLibraryWallFooter = musicLibraryWallElement('music-library-wall-footer');
var musicLibraryWallToTopButton = musicLibraryWallElement('music-library-wall-to-top');

if (musicLibraryWallBackButton) musicLibraryWallBackButton.addEventListener('click', musicLibraryWallBack);
if (musicLibraryWallSearchForm) musicLibraryWallSearchForm.addEventListener('submit', function (event) {
  event.preventDefault();
});
if (musicLibraryWallSearchInput) musicLibraryWallSearchInput.addEventListener('input', function (event) {
  musicLibraryWallSetSearchQuery(event.target.value);
});
if (musicLibraryWallSearchClear) musicLibraryWallSearchClear.addEventListener('click', function () {
  musicLibraryWallSetSearchQuery('');
  if (musicLibraryWallSearchInput) musicLibraryWallSearchInput.focus();
});
if (musicLibraryWallLocateCurrentButton) musicLibraryWallLocateCurrentButton.addEventListener('click', musicLibraryWallLocateCurrentTrack);
if (musicLibraryWallPlayAllButton) musicLibraryWallPlayAllButton.addEventListener('click', musicLibraryWallPlayAll);
if (musicLibraryWallToTopButton) musicLibraryWallToTopButton.addEventListener('click', musicLibraryWallScrollToTop);
if (musicLibraryWallGrid) musicLibraryWallGrid.addEventListener('click', function (event) {
  var nextAction = event.target.closest('[data-mlw-track-next]');
  if (nextAction && musicLibraryWallGrid.contains(nextAction)) {
    event.preventDefault();
    event.stopPropagation();
    var nextCard = nextAction.closest('[data-mlw-track-index]');
    if (nextCard) {
      musicLibraryWallQueueTrackNext(Number(nextCard.getAttribute('data-mlw-track-index')) || 0);
    }
    return;
  }
  var libraryCard = event.target.closest('[data-mlw-library-index]');
  if (libraryCard && musicLibraryWallGrid.contains(libraryCard)) {
    musicLibraryWallOpenLibrary(Number(libraryCard.getAttribute('data-mlw-library-index')) || 0);
    return;
  }
  var trackCard = event.target.closest('[data-mlw-track-index]');
  if (trackCard && musicLibraryWallGrid.contains(trackCard)) {
    musicLibraryWallPlayTrack(Number(trackCard.getAttribute('data-mlw-track-index')) || 0, trackCard);
  }
});
if (musicLibraryWallGrid) musicLibraryWallGrid.addEventListener('keydown', function (event) {
  if (event.target.closest('[data-mlw-track-next]')) return;
  var card = event.target.closest('[data-mlw-track-index]');
  if (!card || !musicLibraryWallGrid.contains(card)) return;
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  musicLibraryWallPlayTrack(Number(card.getAttribute('data-mlw-track-index')) || 0, card);
});
if (musicLibraryWallGrid) musicLibraryWallGrid.addEventListener('pointermove', function (event) {
  var card = event.target.closest('.music-library-wall-card');
  if (card && musicLibraryWallGrid.contains(card)) musicLibraryWallUpdateCardTilt(card, event);
});
if (musicLibraryWallGrid) musicLibraryWallGrid.addEventListener('pointerout', function (event) {
  var card = event.target.closest('.music-library-wall-card');
  if (!card || !musicLibraryWallGrid.contains(card)) return;
  if (event.relatedTarget && card.contains(event.relatedTarget)) return;
  musicLibraryWallResetCardTilt(card);
});
if (musicLibraryWallGrid) musicLibraryWallGrid.addEventListener('pointerleave', function () {
  Array.prototype.forEach.call(musicLibraryWallGrid.querySelectorAll('.music-library-wall-card'), musicLibraryWallResetCardTilt);
});
if (musicLibraryWallFooter) musicLibraryWallFooter.addEventListener('click', function (event) {
  var retry = event.target.closest('[data-mlw-retry],[data-mlw-load-more]');
  if (retry && musicLibraryWallFooter.contains(retry)) musicLibraryWallLoadDetailPage('manual');
});
if (musicLibraryWallContent) musicLibraryWallContent.addEventListener('scroll', function () {
  if (musicLibraryWallState.level === 1) musicLibraryWallState.l1ScrollTop = musicLibraryWallContent.scrollTop;
  else if (musicLibraryWallState.detail) {
    musicLibraryWallState.detail.scrollTop = musicLibraryWallContent.scrollTop;
    musicLibraryWallState.detailScrollTops[musicLibraryWallState.detail.scrollKey] = musicLibraryWallContent.scrollTop;
  }
  musicLibraryWallUpdateScrollControls();
  scheduleMusicLibraryWallRender();
  if (musicLibraryWallState.level === 2 && musicLibraryWallState.detail && (musicLibraryWallState.detail.kind === 'playlist' || musicLibraryWallState.detail.kind === 'netease-cloud')) {
    if (musicLibraryWallContent.scrollTop + musicLibraryWallContent.clientHeight >= musicLibraryWallContent.scrollHeight - 520) {
      musicLibraryWallLoadDetailPage('scroll');
    }
  } else if (musicLibraryWallState.level === 1 && typeof requestNextPlaylistCatalogPage === 'function') {
    if (musicLibraryWallContent.scrollTop + musicLibraryWallContent.clientHeight >= musicLibraryWallContent.scrollHeight - 520) {
      requestNextPlaylistCatalogPage('music-library-wall');
    }
  }
}, { passive: true });

window.addEventListener('resize', function () {
  if (!musicLibraryWallState.active || musicLibraryWallState.resizeRaf) return;
  musicLibraryWallState.resizeRaf = requestAnimationFrame(function () {
    musicLibraryWallState.resizeRaf = 0;
    renderMusicLibraryWall({ forceGrid: true });
  });
});

document.addEventListener('keydown', function (event) {
  if (!musicLibraryWallState.active || event.key !== 'Escape') return;
  event.preventDefault();
  event.stopPropagation();
  closeMusicLibraryWall({ reason: 'escape' });
}, true);
