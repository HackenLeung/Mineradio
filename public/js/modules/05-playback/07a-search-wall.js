'use strict';

// 全屏搜索页。与音乐库封面墙同层互斥，沿用同一套封面网格语言。
//
// 关键约束：歌曲区直接写全局 playlist。playSearchResult / queueSearchResult /
// toggleLikeSearchResult / collectSearchResult / downloadSongFromSearch /
// openSearchResultArtist 这 6 个 action 全部按下标读 playlist，写进去就能零改动复用。
// 数据层（打分/合并/去重/provider 探测）留在 07-search.js，这里只做渲染与导航。

var SEARCH_WALL_OVERSCAN_ROWS = 2;
var SEARCH_WALL_SONG_PAGE = 60;
var SEARCH_WALL_ARTIST_ROW = 8;
var SEARCH_WALL_ARTIST_HOT_SONGS = 30;
// apiJson 不传 timeoutMs 就完全不设超时，请求会一直悬着。歌手页/专辑有加载态，
// 卡住就成了永久转圈，所以这些请求一律自带上限（与音乐库墙的 12s 一致）。
var SEARCH_WALL_REQUEST_TIMEOUT_MS = 12000;

var searchWallState = {
  active: false,
  view: 'results',
  query: '',
  mode: 'song',
  songs: [],
  visibleCount: 0,
  providerPages: {},
  remoteHasMore: false,
  artists: [],
  artistTotal: 0,
  artistNotice: '',
  loading: false,
  loadingMore: false,
  error: '',
  notice: '',
  token: 0,
  returnHome: false,
  scrollTop: 0,
  gridWindowKey: '',
  renderRaf: 0,
  resizeRaf: 0,
  focusAfterRender: false
};

// 歌手页。与结果页各自持有数据，靠 view 切换；返回时结果页状态（含滚动位置）
// 原样还在。歌手页自己不记滚动 —— 每次进都从顶部开始。
var searchWallArtistState = {
  id: '',
  artist: null,
  songs: [],
  albums: [],
  loading: false,
  error: '',
  token: 0
};

function searchWallElement(id) {
  return document.getElementById(id);
}

function isSearchWallOpen() {
  return !!searchWallState.active;
}

function searchWallSyncShelfTheme() {
  var wall = searchWallElement('search-wall');
  if (!wall) return;
  var accent = typeof shelfAccentHex === 'function' ? shelfAccentHex() : '#f4d28a';
  var rgb = typeof hexToRgb === 'function' ? hexToRgb(accent) : null;
  var look = typeof shelfSettings === 'function' ? shelfSettings() : null;
  wall.style.setProperty('--sw-accent-rgb', rgb ? [rgb.r, rgb.g, rgb.b].join(', ') : '244, 210, 138');
  wall.style.setProperty('--sw-bg-alpha', String(Math.max(.45, Math.min(.94, Number(look && look.bgOpacity) || .72))));
}

function searchWallInitials(value) {
  var text = String(value || '音乐').trim();
  if (!text) return 'MR';
  var words = text.split(/\s+/).filter(Boolean);
  if (words.length > 1) return (words[0].charAt(0) + words[1].charAt(0)).toUpperCase();
  return text.slice(0, 2).toUpperCase();
}

// 兜底首字母和 img 同时渲染：img 盖在上面，加载失败才露出兜底。
// 但只靠层级压不住透明 PNG（头像常有透明底），所以 onload 主动标记
// has-art，CSS 直接把兜底 display:none —— 这才是确定性的做法。
function searchWallImageHtml(cover, title) {
  var fallback = '<span class="sw-art-fallback" aria-hidden="true">' + escHtml(searchWallInitials(title)) + '</span>';
  if (!cover) return fallback;
  return '<img src="' + escHtml(cover) + '" alt="" loading="lazy" decoding="async"'
    + ' onload="this.parentNode.classList.add(\'has-art\')"'
    + ' onerror="this.hidden=true;this.parentNode.classList.remove(\'has-art\');'
    + 'this.parentNode.classList.add(\'is-missing\')">' + fallback;
}

function searchWallCloseCompetingSurfaces() {
  if (typeof togglePlaylistPanel === 'function') togglePlaylistPanel(false);
  if (typeof setPeek === 'function') {
    setPeek(searchWallElement('playlist-panel'), false, 'pl');
    setPeek(searchWallElement('fx-panel'), false, 'fx');
  }
  if (typeof setShelfPinnedOpen === 'function') setShelfPinnedOpen(false, true);
  if (typeof closeMusicLibraryWall === 'function' && typeof isMusicLibraryWallOpen === 'function'
    && isMusicLibraryWallOpen()) {
    closeMusicLibraryWall({ reason: 'search-wall' });
  }
  if (typeof safeShelfCloseContent === 'function' && typeof shelfManager !== 'undefined' && shelfManager
    && shelfManager.hasOpenContent && shelfManager.hasOpenContent()) {
    safeShelfCloseContent('search-wall');
  }
}

function openSearchWall(query, opts) {
  opts = opts || {};
  var wall = searchWallElement('search-wall');
  if (!wall) return false;
  var nextQuery = String(query == null ? searchWallState.query : query).trim();
  if (!searchWallState.active) {
    searchWallState.returnHome = !!(typeof emptyHomeActive !== 'undefined' && emptyHomeActive)
      || !!(typeof homeForcedOpen !== 'undefined' && homeForcedOpen);
    searchWallState.scrollTop = 0;
  }
  searchWallState.active = true;
  searchWallState.mode = opts.mode || (typeof searchMode !== 'undefined' && searchMode !== 'podcast' ? searchMode : 'song');
  document.body.classList.add('search-wall-active');
  wall.setAttribute('aria-hidden', 'false');
  // 显隐交给项目统一的弹窗动效，不自己造一套过渡。
  if (typeof openGsapModal === 'function') openGsapModal(wall);
  else wall.classList.add('show');
  searchWallSyncShelfTheme();
  if (typeof homeForcedOpen !== 'undefined') homeForcedOpen = false;
  if (typeof homeSuppressed !== 'undefined') homeSuppressed = true;
  if (typeof setHomeControlsLocked === 'function') setHomeControlsLocked(false);
  if (typeof updateEmptyHomeVisibility === 'function') updateEmptyHomeVisibility({ forceLoad: false });
  searchWallCloseCompetingSurfaces();
  // 顶部胶囊让位：全屏页自带输入框，两个搜索框同时可见会造成焦点竞争。
  if (typeof setPeek === 'function') setPeek(searchWallElement('search-area'), false, 'search');
  searchWallReleasePillResults();
  var input = searchWallElement('search-wall-input');
  if (input && input.value !== nextQuery) input.value = nextQuery;
  searchWallSyncSourceChips();
  if (nextQuery && nextQuery !== searchWallState.query) {
    searchWallRunSearch(nextQuery, { focusInput: opts.focusInput !== false });
  } else {
    searchWallState.query = nextQuery;
    searchWallState.focusAfterRender = opts.focusInput !== false;
    renderSearchWall({ forceGrid: true });
    if (!nextQuery) searchWallFocusInput();
  }
  return true;
}

function closeSearchWall(opts) {
  opts = opts || {};
  if (!searchWallState.active) return false;
  var shouldReturnHome = opts.toHome === true
    || (opts.playback !== true && searchWallState.returnHome);
  var content = searchWallElement('search-wall-content');
  if (content) searchWallState.scrollTop = content.scrollTop;
  searchWallCancelRequest();
  searchWallState.active = false;
  // 复位到结果页，否则下次打开会停在上次那个歌手页。
  searchWallState.view = 'results';
  searchWallArtistState.token += 1;
  searchWallState.gridWindowKey = '';
  document.body.classList.remove('search-wall-active');
  var wall = searchWallElement('search-wall');
  if (wall) {
    wall.setAttribute('aria-hidden', 'true');
    if (typeof closeGsapModal === 'function') closeGsapModal(wall);
    else wall.classList.remove('show');
  }
  if (typeof homeSuppressed !== 'undefined') homeSuppressed = false;
  if (typeof homeForcedOpen !== 'undefined') homeForcedOpen = !!shouldReturnHome;
  if (typeof setHomeControlsLocked === 'function') setHomeControlsLocked(!!shouldReturnHome);
  if (typeof updateEmptyHomeVisibility === 'function') {
    updateEmptyHomeVisibility({ forceLoad: !!shouldReturnHome });
  }
  if (opts.playback === true && typeof forcePlaybackControlsInteractive === 'function') {
    forcePlaybackControlsInteractive();
  }
  return true;
}

function searchWallCancelRequest() {
  searchWallState.token += 1;
  searchWallState.loading = false;
  searchWallState.loadingMore = false;
}

// 左上那颗按钮两种语义共用一个左向箭头：结果页=退出搜索，歌手页=回结果页。
// 图标不变，只换无障碍标签与提示，避免按钮在两种状态下跳字形。
function searchWallSyncBackButton() {
  var button = searchWallElement('search-wall-back');
  if (!button) return;
  var inArtist = searchWallState.view === 'artist';
  var label = inArtist ? '返回搜索结果' : '关闭搜索';
  button.classList.toggle('is-back', inArtist);
  button.setAttribute('aria-label', label);
  button.title = label;
}

function searchWallFocusInput() {
  var input = searchWallElement('search-wall-input');
  if (!input) return;
  requestAnimationFrame(function () {
    try { input.focus({ preventScroll: true }); } catch (e) { input.focus(); }
  });
}

// 全屏页一旦接管 playlist，胶囊那份渲染状态就过期了。它的 IntersectionObserver
// 若再触发 appendNextSearchResults，会用 searchMusicRenderState.songs 取歌、
// 却把下标写进 onclick —— 而下标此刻指向全屏页的 playlist，点谁播谁全错位。
// 清掉 key 就能让它的守卫直接 bail，同时断开 observer。
function searchWallReleasePillResults() {
  if (typeof resetSearchMusicRenderState === 'function') resetSearchMusicRenderState();
  if (typeof searchLastResultQuery !== 'undefined') searchLastResultQuery = '';
  var results = searchWallElement('search-results');
  if (results) results.classList.remove('show');
}

function searchWallSourceLabel(mode) {
  return mode === 'netease' ? '小云' : (mode === 'qq' ? '小Q' : (mode === 'kugou' ? '小狗' : '全部音源'));
}

function searchWallSyncSourceChips() {
  var host = searchWallElement('search-wall-sources');
  if (!host) return;
  Array.prototype.forEach.call(host.querySelectorAll('[data-sw-source]'), function (chip) {
    var mode = chip.getAttribute('data-sw-source') || 'song';
    var active = mode === searchWallState.mode;
    chip.setAttribute('aria-pressed', active ? 'true' : 'false');
    var ready = mode === 'song' || typeof searchProviderCanSearch !== 'function' || searchProviderCanSearch(mode);
    chip.disabled = !ready;
    chip.title = ready ? searchWallSourceLabel(mode) : (searchWallSourceLabel(mode) + '：搜索能力未就绪');
  });
}

// 歌手只有小云有搜索接口（cloudsearch type=100）。小狗只有 song_search_v2，
// 小Q 要靠写死为 0 的 multi_zhida，都拿不到歌手，所以筛到这两个音源时不出歌手区。
function searchWallArtistsAvailable(mode) {
  return mode === 'song' || mode === 'netease';
}

// 与歌曲搜索并行发，不阻塞歌曲结果落地：歌手区来了再单独重绘一次。
function searchWallFetchArtists(query, token) {
  if (!searchWallArtistsAvailable(searchWallState.mode)) {
    searchWallState.artistNotice = searchWallSourceLabel(searchWallState.mode) + ' 没有歌手搜索接口';
    return;
  }
  // apiJson 默认不带超时（timeoutMs 缺省为 0 时不创建 AbortController），
  // 上游一挂请求就悬着。歌手区必须自带上限，否则永远停在加载态。
  apiJson('/api/search/artists?keywords=' + encodeURIComponent(query) + '&limit=' + SEARCH_WALL_ARTIST_ROW,
    { timeoutMs: SEARCH_WALL_REQUEST_TIMEOUT_MS })
    .then(function (data) {
      if (token !== searchWallState.token || !searchWallState.active) return;
      var artists = data && Array.isArray(data.artists) ? data.artists : [];
      searchWallState.artists = artists;
      searchWallState.artistTotal = Number(data && data.total) || artists.length;
      searchWallState.artistNotice = '';
      if (searchWallState.view === 'results') renderSearchWall({ forceGrid: true });
    })
    .catch(function (error) {
      console.warn('[SearchWallArtists]', error);
      if (token !== searchWallState.token) return;
      searchWallState.artists = [];
      searchWallState.artistNotice = '歌手搜索失败';
      if (searchWallState.view === 'results') renderSearchWall({ forceGrid: true });
    });
}

async function searchWallRunSearch(query, opts) {
  opts = opts || {};
  query = String(query || '').trim();
  var token = ++searchWallState.token;
  searchWallState.query = query;
  searchWallState.songs = [];
  searchWallState.visibleCount = 0;
  searchWallState.providerPages = {};
  searchWallState.remoteHasMore = false;
  searchWallState.artists = [];
  searchWallState.artistTotal = 0;
  searchWallState.artistNotice = '';
  searchWallState.error = '';
  searchWallState.notice = '';
  searchWallState.gridWindowKey = '';
  if (!query) {
    searchWallState.loading = false;
    renderSearchWall({ forceGrid: true });
    if (opts.focusInput !== false) searchWallFocusInput();
    return false;
  }
  searchWallFetchArtists(query, token);
  searchWallState.loading = true;
  renderSearchWall({ forceGrid: true });
  if (opts.focusInput !== false) searchWallFocusInput();
  try {
    var page = await fetchMusicSearchResults(query, searchWallState.mode);
    if (token !== searchWallState.token || !searchWallState.active) return false;
    var songs = page && Array.isArray(page.songs) ? page.songs : [];
    searchWallState.songs = songs;
    searchWallState.providerPages = (page && page.providerPages) || {};
    searchWallState.remoteHasMore = !!(page && page.hasMore);
    searchWallState.visibleCount = Math.min(songs.length, SEARCH_WALL_SONG_PAGE);
    searchWallState.loading = false;
    // 全局 playlist 是那 6 个 index 型 action 的唯一数据源，必须同步。
    playlist = songs;
    searchWallReleasePillResults();
    if (songs.length) {
      if (typeof rememberSearchQuery === 'function') rememberSearchQuery(query);
      if (typeof syncLikeStatusForSongs === 'function') {
        syncLikeStatusForSongs(songs.slice(0, searchWallState.visibleCount));
      }
    } else if (typeof searchProviderNotice !== 'undefined' && searchProviderNotice) {
      searchWallState.notice = searchProviderNotice;
    }
    var content = searchWallElement('search-wall-content');
    if (content) content.scrollTop = 0;
    searchWallState.scrollTop = 0;
    renderSearchWall({ forceGrid: true });
    return songs.length > 0;
  } catch (error) {
    console.warn('[SearchWall]', query, error);
    if (token !== searchWallState.token || !searchWallState.active) return false;
    searchWallState.loading = false;
    searchWallState.error = '搜索暂时失败，请稍后重试';
    renderSearchWall({ forceGrid: true });
    return false;
  }
}

async function searchWallLoadMore() {
  if (!searchWallState.active || searchWallState.loading || searchWallState.loadingMore) return false;
  // 只有结果页有分页。歌手页调到这儿会改 playlist，把它从歌手的歌抢走。
  if (searchWallState.view !== 'results') return false;
  // 先吃掉本地还没渲染的部分，真到底了再向上游要下一页。
  if (searchWallState.visibleCount < searchWallState.songs.length) {
    searchWallState.visibleCount = Math.min(
      searchWallState.songs.length,
      searchWallState.visibleCount + SEARCH_WALL_SONG_PAGE
    );
    if (typeof syncLikeStatusForSongs === 'function') {
      syncLikeStatusForSongs(searchWallState.songs.slice(0, searchWallState.visibleCount));
    }
    renderSearchWall({ forceGrid: true });
    return true;
  }
  if (!searchWallState.remoteHasMore) return false;
  var token = searchWallState.token;
  var query = searchWallState.query;
  var mode = searchWallState.mode;
  searchWallState.loadingMore = true;
  renderSearchWall();
  try {
    var page = await fetchMusicSearchResults(query, mode, searchWallState.providerPages);
    if (token !== searchWallState.token || !searchWallState.active) return false;
    var before = searchWallState.songs.length;
    var merged = typeof mergeUniqueSearchSongPools === 'function'
      ? mergeUniqueSearchSongPools(searchWallState.songs, (page && page.songs) || [])
      : searchWallState.songs;
    searchWallState.songs = merged;
    searchWallState.providerPages = (page && page.providerPages) || {};
    searchWallState.remoteHasMore = !!(page && page.hasMore) && merged.length > before;
    searchWallState.visibleCount = Math.min(merged.length, searchWallState.visibleCount + SEARCH_WALL_SONG_PAGE);
    searchWallState.loadingMore = false;
    playlist = merged;
    searchWallReleasePillResults();
    if (typeof syncLikeStatusForSongs === 'function') {
      syncLikeStatusForSongs(merged.slice(before, searchWallState.visibleCount));
    }
    renderSearchWall({ forceGrid: true });
    return merged.length > before;
  } catch (error) {
    console.warn('[SearchWallLoadMore]', error);
    if (token !== searchWallState.token) return false;
    searchWallState.loadingMore = false;
    searchWallState.remoteHasMore = false;
    renderSearchWall();
    return false;
  }
}

function searchWallVisibleSongs() {
  return searchWallState.songs.slice(0, searchWallState.visibleCount);
}

// 歌曲网格在滚动容器里的起点。歌手区插在它上面之后，网格不再从内容区顶部开始，
// 直接拿 scrollTop 算行会整体偏移，行窗口就取错了。
function searchWallGridOffsetTop() {
  var content = searchWallElement('search-wall-content');
  var grid = searchWallElement('search-wall-song-grid');
  if (!content || !grid) return 0;
  var offset = 0;
  var node = grid;
  while (node && node !== content) {
    offset += node.offsetTop || 0;
    node = node.offsetParent;
    // offsetParent 可能因为定位上下文直接跳过 content，防跑飞。
    if (node && node !== content && !content.contains(node)) return offset;
  }
  return offset;
}

// 与音乐库墙同构的行窗口计算：卡片是 1:1 且靠 auto-fill 分列，
// 所以列宽能从容器宽度反推，不必读每张卡的实际尺寸。
function searchWallVirtualWindow(total) {
  var content = searchWallElement('search-wall-content');
  var grid = searchWallElement('search-wall-song-grid');
  var width = Math.max(280, (grid && grid.clientWidth) || (content && content.clientWidth) || window.innerWidth - 64);
  var gap = window.innerWidth <= 700 ? 12 : 18;
  var minimum = window.innerWidth <= 700 ? 124 : (window.innerWidth <= 1100 ? 142 : 156);
  var columns = Math.max(2, Math.floor((width + gap) / (minimum + gap)));
  var cardWidth = Math.max(96, (width - gap * (columns - 1)) / columns);
  var rowHeight = cardWidth + gap;
  var scrollTop = Math.max(0, (content ? content.scrollTop : 0) - searchWallGridOffsetTop());
  var viewport = content ? content.clientHeight : window.innerHeight;
  var rows = Math.ceil(total / columns);
  var startRow = Math.max(0, Math.floor(scrollTop / rowHeight) - SEARCH_WALL_OVERSCAN_ROWS);
  var endRow = Math.min(rows, Math.ceil((scrollTop + viewport) / rowHeight) + SEARCH_WALL_OVERSCAN_ROWS);
  return {
    columns: columns,
    rowHeight: rowHeight,
    start: Math.min(total, startRow * columns),
    end: Math.min(total, Math.max((startRow + 1) * columns, endRow * columns)),
    top: Math.max(0, startRow * rowHeight - gap),
    bottom: Math.max(0, (rows - endRow) * rowHeight - gap)
  };
}

function searchWallSpacerHtml(position, height) {
  if (height <= 0) return '';
  return '<div class="sw-spacer ' + position + '" style="height:' + Math.round(height) + 'px" aria-hidden="true"></div>';
}

function searchWallSongIsCurrent(song) {
  var current = (typeof playQueue !== 'undefined' && playQueue && typeof currentIdx !== 'undefined'
    && currentIdx >= 0) ? playQueue[currentIdx] : null;
  if (!song || !current) return false;
  if (typeof queueItemKey === 'function') return queueItemKey(song) === queueItemKey(current);
  return song === current;
}

function searchWallSongCardHtml(song, index) {
  song = song || {};
  var title = song.name || song.title || ('歌曲 ' + (index + 1));
  var artist = song.artist || song.singer || song.album || '未知歌手';
  var current = searchWallSongIsCurrent(song);
  var liked = typeof isSongLiked === 'function' && isSongLiked(song);
  var vip = typeof songRequiresVip === 'function' && songRequiresVip(song);
  var sourceLabel = typeof songProviderKey === 'function'
    ? searchWallSourceLabel(songProviderKey(song))
    : '';
  // 图标一律复用播放队列那三个，别自己画：手画的「收藏」和「下一首」都是
  // 列表+加号，在卡片上几乎分不出来。队列里「下一首播放」用的是汉字「下」。
  var heart = typeof heartIconSvg === 'function'
    ? heartIconSvg()
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20s-7-4.35-7-9.5A3.9 3.9 0 0 1 12 8a3.9 3.9 0 0 1 7 2.5C19 15.65 12 20 12 20z"/></svg>';
  var collectIcon = typeof playlistPlusIconSvg === 'function'
    ? playlistPlusIconSvg()
    : '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.9"'
      + ' stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h10"/><path d="M4 11h10"/>'
      + '<path d="M4 16h7"/><path d="M18 14v6"/><path d="M15 17h6"/></svg>';
  var actions = '<span class="sw-card-actions">'
    + '<button class="sw-card-action' + (liked ? ' is-liked' : '') + '" type="button" data-sw-like="' + index + '"'
    + ' title="' + (liked ? '取消红心' : '红心喜欢') + '" aria-label="' + (liked ? '取消红心' : '红心喜欢') + '">'
    + heart + '</button>'
    + '<button class="sw-card-action" type="button" data-sw-collect="' + index + '" title="收藏到歌单"'
    + ' aria-label="收藏到歌单">' + collectIcon + '</button>'
    + '<button class="sw-card-action is-next" type="button" data-sw-next="' + index + '" title="下一首播放"'
    + ' aria-label="下一首播放">下</button>'
    + '</span>';
  return '<div class="sw-card' + (current ? ' is-current' : '') + '" role="button" tabindex="0"'
    + ' data-sw-song="' + index + '" aria-label="播放 ' + escHtml(title) + '">'
    + '<span class="sw-art">' + searchWallImageHtml(
      typeof songCoverSrc === 'function' ? songCoverSrc(song, 400) : (song.cover || ''), title) + actions
    + '<span class="sw-card-copy"><span class="sw-eyebrow">'
    + (sourceLabel ? '<span class="sw-badge">' + escHtml(sourceLabel) + '</span>' : '')
    + (vip ? '<span class="sw-flag is-vip">VIP</span>' : '')
    + (current ? '<span class="sw-flag is-now">正在播放</span>' : '') + '</span>'
    + '<strong>' + escHtml(title) + '</strong><small>' + escHtml(artist) + '</small><i aria-hidden="true"></i>'
    + '</span></span></div>';
}

function searchWallArtistCountLabel(artist) {
  artist = artist || {};
  var bits = [];
  if (artist.musicSize) bits.push(artist.musicSize + ' 首');
  if (artist.albumSize) bits.push(artist.albumSize + ' 张专辑');
  if (!bits.length && artist.alias && artist.alias.length) return artist.alias.join(' / ');
  return bits.join(' · ') || '小云歌手';
}

function searchWallArtistCardHtml(artist, index) {
  artist = artist || {};
  var name = artist.name || ('歌手 ' + (index + 1));
  var cover = artist.avatar
    ? (typeof coverUrlWithSize === 'function' ? coverUrlWithSize(artist.avatar, 400) : artist.avatar)
    : '';
  return '<div class="sw-card is-artist" role="button" tabindex="0"'
    + ' data-sw-artist="' + escHtml(String(artist.id || '')) + '" aria-label="查看歌手 ' + escHtml(name) + '">'
    + '<span class="sw-art">' + searchWallImageHtml(cover, name)
    + '<span class="sw-card-copy"><span class="sw-eyebrow"><span class="sw-badge">歌手</span></span>'
    + '<strong>' + escHtml(name) + '</strong>'
    + '<small>' + escHtml(searchWallArtistCountLabel(artist)) + '</small><i aria-hidden="true"></i>'
    + '</span></span></div>';
}

function searchWallArtistSectionHtml() {
  if (searchWallState.artistNotice && !searchWallState.artists.length) {
    return '<section class="sw-section" data-sw-section="artist">'
      + '<div class="sw-section-head"><h2>歌手</h2></div>'
      + '<div class="sw-section-note">' + escHtml(searchWallState.artistNotice) + '</div></section>';
  }
  if (!searchWallState.artists.length) return '';
  return '<section class="sw-section" data-sw-section="artist">'
    + '<div class="sw-section-head"><h2>歌手</h2>'
    + '<span class="sw-section-count">' + (searchWallState.artistTotal || searchWallState.artists.length) + '</span></div>'
    + '<div class="sw-grid is-artist-row" role="list">'
    + searchWallState.artists.map(searchWallArtistCardHtml).join('')
    + '</div></section>';
}

// ---------- 歌手页 ----------
function searchWallOpenArtist(artistId) {
  artistId = String(artistId || '').trim();
  if (!artistId || !searchWallState.active) return false;
  var content = searchWallElement('search-wall-content');
  // 只在从结果页进来时记结果页的滚动位置。歌手页里点重试也会走到这儿，
  // 那时 scrollTop 是歌手页的，存下来会毁掉返回结果页的还原。
  if (content && searchWallState.view !== 'artist') searchWallState.scrollTop = content.scrollTop;
  var token = ++searchWallArtistState.token;
  searchWallArtistState.id = artistId;
  searchWallArtistState.artist = searchWallState.artists.filter(function (a) {
    return String(a && a.id) === artistId;
  })[0] || null;
  searchWallArtistState.songs = [];
  searchWallArtistState.albums = [];
  searchWallArtistState.loading = true;
  searchWallArtistState.error = '';
  searchWallState.view = 'artist';
  searchWallState.gridWindowKey = '';
  if (content) content.scrollTop = 0;
  renderSearchWall({ forceGrid: true });

  // 详情与专辑各自成败，一个挂了另一个照常显示。
  Promise.allSettled([
    apiJson('/api/artist/detail?id=' + encodeURIComponent(artistId) + '&limit=' + SEARCH_WALL_ARTIST_HOT_SONGS,
      { timeoutMs: SEARCH_WALL_REQUEST_TIMEOUT_MS }),
    apiJson('/api/artist/albums?id=' + encodeURIComponent(artistId) + '&limit=24',
      { timeoutMs: SEARCH_WALL_REQUEST_TIMEOUT_MS })
  ]).then(function (results) {
    if (token !== searchWallArtistState.token || !searchWallState.active) return;
    var detail = results[0].status === 'fulfilled' ? results[0].value : null;
    var albumData = results[1].status === 'fulfilled' ? results[1].value : null;
    if (detail && detail.artist) {
      searchWallArtistState.artist = Object.assign({}, searchWallArtistState.artist || {}, detail.artist);
    }
    var cloner = typeof cloneSong === 'function' ? cloneSong : function (s) { return s; };
    searchWallArtistState.songs = (detail && Array.isArray(detail.songs) ? detail.songs : []).map(cloner);
    searchWallArtistState.albums = albumData && Array.isArray(albumData.albums) ? albumData.albums : [];
    searchWallArtistState.loading = false;
    if (!searchWallArtistState.songs.length && !searchWallArtistState.albums.length) {
      searchWallArtistState.error = results[0].status === 'rejected'
        ? '歌手主页加载失败' : '这位歌手暂时没有可显示的内容';
    }
    // 歌手页的歌曲也要能用那 6 个 index 型 action，同样得占住 playlist。
    if (searchWallArtistState.songs.length) {
      playlist = searchWallArtistState.songs;
      searchWallReleasePillResults();
      if (typeof syncLikeStatusForSongs === 'function') syncLikeStatusForSongs(searchWallArtistState.songs);
    }
    renderSearchWall({ forceGrid: true });
  });
  return true;
}

function searchWallBackToResults() {
  if (searchWallState.view !== 'artist') return false;
  searchWallArtistState.token += 1;
  searchWallState.view = 'results';
  searchWallState.gridWindowKey = '';
  // 回结果页必须把 playlist 换回歌曲结果，否则卡片下标会指向歌手页那批歌。
  playlist = searchWallState.songs;
  searchWallReleasePillResults();
  renderSearchWall({ forceGrid: true });
  var content = searchWallElement('search-wall-content');
  if (content) content.scrollTop = Number(searchWallState.scrollTop) || 0;
  return true;
}

function searchWallAlbumCardHtml(album, index) {
  album = album || {};
  var name = album.name || ('专辑 ' + (index + 1));
  var cover = album.cover
    ? (typeof coverUrlWithSize === 'function' ? coverUrlWithSize(album.cover, 400) : album.cover)
    : '';
  var year = album.publishTime ? new Date(album.publishTime).getFullYear() : '';
  var meta = [year || '', album.size ? album.size + ' 首' : ''].filter(Boolean).join(' · ');
  return '<div class="sw-card" role="button" tabindex="0" data-sw-album="' + escHtml(String(album.id || '')) + '"'
    + ' aria-label="打开专辑 ' + escHtml(name) + '">'
    + '<span class="sw-art">' + searchWallImageHtml(cover, name)
    + '<span class="sw-card-copy"><span class="sw-eyebrow"><span class="sw-badge">专辑</span></span>'
    + '<strong>' + escHtml(name) + '</strong><small>' + escHtml(meta || '小云专辑') + '</small>'
    + '<i aria-hidden="true"></i></span></span></div>';
}

function searchWallArtistViewHtml() {
  var artist = searchWallArtistState.artist || {};
  var name = artist.name || '歌手';
  var avatar = artist.avatar
    ? (typeof coverUrlWithSize === 'function' ? coverUrlWithSize(artist.avatar, 300) : artist.avatar)
    : '';
  var hero = '<section class="sw-artist-hero">'
    + '<span class="sw-artist-avatar">' + searchWallImageHtml(avatar, name) + '</span>'
    + '<div class="sw-artist-meta"><span class="sw-artist-eyebrow">歌手 · 小云</span>'
    + '<h2>' + escHtml(name) + '</h2>'
    + '<p>' + escHtml(searchWallArtistCountLabel(artist)) + '</p>'
    + '</div></section>';
  if (searchWallArtistState.loading) return hero + '<div class="sw-empty">正在载入歌手主页…</div>';
  // 失败必须给重试入口。歌手页的 footer 是空的，没有别处能重来。
  if (searchWallArtistState.error) {
    return hero + '<div class="sw-empty">' + escHtml(searchWallArtistState.error)
      + '<button class="sw-retry" type="button" data-sw-artist-retry="1">重试</button></div>';
  }
  var out = hero;
  if (searchWallArtistState.songs.length) {
    out += '<section class="sw-section" data-sw-section="artist-song">'
      + '<div class="sw-section-head"><h2>热门歌曲</h2>'
      + '<span class="sw-section-count">' + searchWallArtistState.songs.length + '</span></div>'
      + '<div class="sw-grid" role="list">'
      + searchWallArtistState.songs.map(searchWallSongCardHtml).join('')
      + '</div></section>';
  }
  if (searchWallArtistState.albums.length) {
    out += '<section class="sw-section" data-sw-section="artist-album">'
      + '<div class="sw-section-head"><h2>专辑</h2>'
      + '<span class="sw-section-count">' + searchWallArtistState.albums.length + '</span></div>'
      + '<div class="sw-grid" role="list">'
      + searchWallArtistState.albums.map(searchWallAlbumCardHtml).join('')
      + '</div></section>';
  }
  return out;
}

function searchWallFooterHtml() {
  if (!searchWallState.query) return '';
  if (searchWallState.loading) {
    return '<span class="sw-loading-dot" aria-hidden="true"></span>正在搜索 “' + escHtml(searchWallState.query) + '”';
  }
  if (searchWallState.error) {
    return '<span>' + escHtml(searchWallState.error) + '</span><button type="button" data-sw-retry="1">重试</button>';
  }
  if (searchWallState.loadingMore) {
    return '<span class="sw-loading-dot" aria-hidden="true"></span>正在加载更多歌曲';
  }
  var total = searchWallState.songs.length;
  if (!total) return '';
  var shown = Math.min(searchWallState.visibleCount, total);
  if (shown < total || searchWallState.remoteHasMore) {
    return '<button type="button" data-sw-load-more="1">继续加载 ' + shown + '/' + total
      + (searchWallState.remoteHasMore ? '+' : '') + '</button>';
  }
  return '已显示全部 ' + total + ' 首';
}

function searchWallEmptyHtml() {
  if (searchWallState.loading) {
    return '<div class="sw-empty">正在搜索 “' + escHtml(searchWallState.query) + '”…</div>';
  }
  // 搜索历史在顶部胶囊的下拉里，这里不重复一份。
  if (!searchWallState.query) {
    return '<div class="sw-empty">输入关键词搜索歌曲与歌手</div>';
  }
  if (searchWallState.error) return '<div class="sw-empty">' + escHtml(searchWallState.error) + '</div>';
  return '<div class="sw-empty">' + escHtml(searchWallState.notice || '没有找到相关歌曲') + '</div>';
}

function renderSearchWall(opts) {
  opts = opts || {};
  if (!searchWallState.active) return;
  searchWallSyncShelfTheme();
  var content = searchWallElement('search-wall-content');
  var body = searchWallElement('search-wall-body');
  var footer = searchWallElement('search-wall-footer');
  var clear = searchWallElement('search-wall-clear');
  if (!content || !body) return;
  var songs = searchWallVisibleSongs();
  var total = searchWallState.songs.length;
  if (clear) clear.hidden = !searchWallState.query;
  searchWallSyncBackButton();

  // 歌手页不虚拟化：热门歌曲上限 30、专辑上限 24，一次画完比维护两套窗口划算。
  if (searchWallState.view === 'artist') {
    var artistKey = ['artist', searchWallArtistState.id, searchWallArtistState.loading,
      searchWallArtistState.error, searchWallArtistState.songs.length,
      searchWallArtistState.albums.length].join('|');
    if (opts.forceGrid || artistKey !== searchWallState.gridWindowKey) {
      body.innerHTML = searchWallArtistViewHtml();
      searchWallState.gridWindowKey = artistKey;
    }
    if (footer) footer.innerHTML = '';
    searchWallUpdateScrollControls();
    return;
  }

  if (!songs.length) {
    // 没歌不等于没歌手：搜歌手名时常常是歌手区有货、歌曲区空。
    var artistOnly = searchWallArtistSectionHtml();
    var emptyKey = ['empty', searchWallState.query, searchWallState.loading, searchWallState.error,
      searchWallState.artists.length, searchWallState.artistNotice].join('|');
    if (opts.forceGrid || emptyKey !== searchWallState.gridWindowKey) {
      body.innerHTML = artistOnly + searchWallEmptyHtml();
      searchWallState.gridWindowKey = emptyKey;
    }
    if (footer) footer.innerHTML = searchWallFooterHtml();
    searchWallUpdateScrollControls();
    if (searchWallState.focusAfterRender) {
      searchWallState.focusAfterRender = false;
      searchWallFocusInput();
    }
    return;
  }

  var virtual = searchWallVirtualWindow(songs.length);
  var artistSection = searchWallArtistSectionHtml();
  var windowKey = ['song', searchWallState.query, searchWallState.mode, songs.length, total,
    searchWallState.artists.length, searchWallState.artistNotice,
    virtual.columns, virtual.start, virtual.end].join('|');
  if (opts.virtualOnly && !opts.forceGrid && windowKey === searchWallState.gridWindowKey) {
    searchWallUpdateScrollControls();
    return;
  }
  if (opts.forceGrid || windowKey !== searchWallState.gridWindowKey) {
    var cards = searchWallSpacerHtml('top', virtual.top);
    for (var index = virtual.start; index < virtual.end; index += 1) {
      cards += searchWallSongCardHtml(songs[index], index);
    }
    cards += searchWallSpacerHtml('bottom', virtual.bottom);
    body.innerHTML = artistSection
      + '<section class="sw-section" data-sw-section="song">'
      + '<div class="sw-section-head"><h2>歌曲</h2>'
      + '<span class="sw-section-count">' + total + (searchWallState.remoteHasMore ? '+' : '') + '</span></div>'
      + '<div id="search-wall-song-grid" class="sw-grid" role="list">' + cards + '</div>'
      + '</section>';
    searchWallState.gridWindowKey = windowKey;
  }
  if (footer) footer.innerHTML = searchWallFooterHtml();
  if (searchWallState.focusAfterRender) {
    searchWallState.focusAfterRender = false;
    searchWallFocusInput();
  }
  searchWallUpdateScrollControls();
}

function scheduleSearchWallRender() {
  if (!searchWallState.active || searchWallState.renderRaf) return;
  searchWallState.renderRaf = requestAnimationFrame(function () {
    searchWallState.renderRaf = 0;
    renderSearchWall({ virtualOnly: true });
  });
}

function searchWallScrollBehavior() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}

function searchWallScrollToTop() {
  var content = searchWallElement('search-wall-content');
  if (!content) return false;
  content.scrollTo({ top: 0, behavior: searchWallScrollBehavior() });
  return true;
}

function searchWallUpdateScrollControls() {
  var content = searchWallElement('search-wall-content');
  var toTop = searchWallElement('search-wall-to-top');
  if (!toTop) return;
  toTop.hidden = !(searchWallState.active && content
    && content.scrollTop > Math.max(160, content.clientHeight * .34));
}

// 当前视图的歌曲来源。歌手页用它自己那批热门歌曲，两个视图切换时
// playlist 也跟着换（见 searchWallOpenArtist / searchWallBackToResults），
// 所以下标始终和 playlist 对齐。
function searchWallActiveSongs() {
  return searchWallState.view === 'artist' ? searchWallArtistState.songs : searchWallState.songs;
}

// 这些 action 全部按下标读全局 playlist，取数时已经把对应数组写进去了。
// 播放前先退场，避免 playSearchResult 里对 #search-results 的收尾操作打在隐藏的胶囊上。
function searchWallPlaySong(index) {
  index = Number(index);
  if (!searchWallActiveSongs()[index]) return false;
  searchWallState.returnHome = false;
  closeSearchWall({ playback: true, reason: 'song-play' });
  if (typeof playSearchResult === 'function') playSearchResult(index);
  return true;
}

function searchWallQueueSongNext(index) {
  index = Number(index);
  if (!searchWallActiveSongs()[index]) return false;
  if (typeof queueSearchResult === 'function') queueSearchResult(index);
  return true;
}

function searchWallToggleLike(index) {
  index = Number(index);
  if (!searchWallActiveSongs()[index]) return false;
  if (typeof toggleLikeSearchResult !== 'function') return false;
  toggleLikeSearchResult(index);
  // 红心状态是异步回写的，等一拍再重绘才能拿到新值。
  setTimeout(function () {
    if (searchWallState.active) renderSearchWall({ forceGrid: true });
  }, 220);
  return true;
}

function searchWallCollectSong(index) {
  index = Number(index);
  if (!searchWallActiveSongs()[index]) return false;
  if (typeof collectSearchResult === 'function') collectSearchResult(index);
  return true;
}

// 点专辑卡：拉曲目、整张入队、从第一首起播，然后关弹窗。
// 沿用 playAlbumDetailSong 的约定（skipShuffleOrder，保持专辑顺序）。
function searchWallOpenAlbum(albumId) {
  albumId = String(albumId || '').trim();
  if (!albumId) return false;
  if (typeof showToast === 'function') showToast('正在载入专辑…');
  apiJson('/api/album/detail?id=' + encodeURIComponent(albumId) + '&limit=80',
    { timeoutMs: SEARCH_WALL_REQUEST_TIMEOUT_MS })
    .then(function (data) {
      var raw = data && Array.isArray(data.songs) ? data.songs : [];
      if (!raw.length) {
        if (typeof showToast === 'function') showToast('这张专辑没有可播放的曲目');
        return;
      }
      var cloner = typeof cloneSong === 'function' ? cloneSong : function (s) { return s; };
      playQueue = raw.map(cloner);
      currentIdx = 0;
      if (typeof safeRenderQueuePanel === 'function') safeRenderQueuePanel('search-wall-album');
      if (typeof safeShelfRebuild === 'function') safeShelfRebuild('search-wall-album', true);
      searchWallState.returnHome = false;
      closeSearchWall({ playback: true, reason: 'album-play' });
      return playQueueAt(0, { manual: true, skipShuffleOrder: true });
    })
    .catch(function (error) {
      console.warn('[SearchWallAlbum]', albumId, error);
      if (typeof showToast === 'function') showToast('专辑加载失败');
    });
  return true;
}

function searchWallSetMode(mode) {
  mode = (mode === 'netease' || mode === 'qq' || mode === 'kugou') ? mode : 'song';
  if (searchWallState.mode === mode) return false;
  searchWallState.mode = mode;
  // 与顶部胶囊共用同一个 searchMode，避免两处状态漂移。只同步模式本身：
  // 完整的 setSearchMode 会 clearSearchResults()（清空弹窗正在用的 playlist）
  // 并把胶囊重新 peek 出来，两个副作用在这里都是纯粹的破坏。
  if (typeof syncSearchModeOnly === 'function') syncSearchModeOnly(mode);
  searchWallSyncSourceChips();
  if (searchWallState.query) searchWallRunSearch(searchWallState.query, { focusInput: false });
  else renderSearchWall({ forceGrid: true });
  return true;
}

function searchWallResetCardTilt(card) {
  if (!card || !card.style) return;
  ['--sw-tilt-x', '--sw-tilt-y', '--sw-shadow-x', '--sw-shadow-y', '--sw-glare-x', '--sw-glare-y']
    .forEach(function (name) { card.style.removeProperty(name); });
}

function searchWallUpdateCardTilt(card, event) {
  if (!card || !event) return;
  if (event.pointerType && event.pointerType !== 'mouse' && event.pointerType !== 'pen') return;
  var rect = card.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  var x = Math.max(-1, Math.min(1, ((event.clientX - rect.left) / rect.width - 0.5) * 2));
  var y = Math.max(-1, Math.min(1, ((event.clientY - rect.top) / rect.height - 0.5) * 2));
  card.style.setProperty('--sw-tilt-x', (-y * 3.8).toFixed(2) + 'deg');
  card.style.setProperty('--sw-tilt-y', (x * 5.2).toFixed(2) + 'deg');
  card.style.setProperty('--sw-shadow-x', (-x * 16).toFixed(1) + 'px');
  card.style.setProperty('--sw-shadow-y', (24 + y * 7).toFixed(1) + 'px');
  card.style.setProperty('--sw-glare-x', ((x + 1) * 50).toFixed(1) + '%');
  card.style.setProperty('--sw-glare-y', ((y + 1) * 50).toFixed(1) + '%');
}

var searchWallDebounceTimer = 0;
var searchWallMask = searchWallElement('search-wall');
var searchWallBackButton = searchWallElement('search-wall-back');
var searchWallForm = searchWallElement('search-wall-search');
var searchWallInput = searchWallElement('search-wall-input');
var searchWallClearButton = searchWallElement('search-wall-clear');
var searchWallSourcesHost = searchWallElement('search-wall-sources');
var searchWallContent = searchWallElement('search-wall-content');
var searchWallBody = searchWallElement('search-wall-body');
var searchWallFooterHost = searchWallElement('search-wall-footer');
var searchWallToTopButton = searchWallElement('search-wall-to-top');

if (searchWallBackButton) searchWallBackButton.addEventListener('click', function () {
  // 歌手页先退回结果页，再按一次才关弹窗。
  if (searchWallBackToResults()) return;
  closeSearchWall({ toHome: true, reason: 'back' });
});

// 点遮罩空白处关闭。08-account 的 bindModalBackdropClose 加载序更后，
// 这里自己绑，免得依赖模块顺序。
if (searchWallMask) searchWallMask.addEventListener('click', function (event) {
  if (event.target !== searchWallMask) return;
  closeSearchWall({ toHome: true, reason: 'backdrop' });
});

if (searchWallForm) searchWallForm.addEventListener('submit', function (event) {
  event.preventDefault();
  clearTimeout(searchWallDebounceTimer);
  searchWallRunSearch(searchWallInput ? searchWallInput.value : '', { focusInput: false });
});

if (searchWallInput) searchWallInput.addEventListener('input', function (event) {
  clearTimeout(searchWallDebounceTimer);
  var value = event.target.value;
  searchWallDebounceTimer = setTimeout(function () {
    searchWallRunSearch(value, { focusInput: false });
  }, 220);
});

if (searchWallInput) searchWallInput.addEventListener('keydown', function (event) {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  event.stopPropagation();
  // 歌手页优先退回结果页，别把关键词清掉。
  if (searchWallBackToResults()) return;
  if (searchWallInput.value) {
    searchWallInput.value = '';
    clearTimeout(searchWallDebounceTimer);
    searchWallRunSearch('', { focusInput: true });
    return;
  }
  closeSearchWall({ reason: 'escape-input' });
});

if (searchWallClearButton) searchWallClearButton.addEventListener('click', function () {
  if (searchWallInput) searchWallInput.value = '';
  clearTimeout(searchWallDebounceTimer);
  searchWallRunSearch('', { focusInput: true });
});

if (searchWallSourcesHost) searchWallSourcesHost.addEventListener('click', function (event) {
  var chip = event.target.closest('[data-sw-source]');
  if (!chip || !searchWallSourcesHost.contains(chip) || chip.disabled) return;
  searchWallSetMode(chip.getAttribute('data-sw-source') || 'song');
});

if (searchWallToTopButton) searchWallToTopButton.addEventListener('click', searchWallScrollToTop);

if (searchWallBody) searchWallBody.addEventListener('click', function (event) {
  var like = event.target.closest('[data-sw-like]');
  if (like && searchWallBody.contains(like)) {
    event.preventDefault();
    event.stopPropagation();
    searchWallToggleLike(like.getAttribute('data-sw-like'));
    return;
  }
  var collect = event.target.closest('[data-sw-collect]');
  if (collect && searchWallBody.contains(collect)) {
    event.preventDefault();
    event.stopPropagation();
    searchWallCollectSong(collect.getAttribute('data-sw-collect'));
    return;
  }
  var next = event.target.closest('[data-sw-next]');
  if (next && searchWallBody.contains(next)) {
    event.preventDefault();
    event.stopPropagation();
    searchWallQueueSongNext(next.getAttribute('data-sw-next'));
    return;
  }
  var artistRetry = event.target.closest('[data-sw-artist-retry]');
  if (artistRetry && searchWallBody.contains(artistRetry)) {
    searchWallOpenArtist(searchWallArtistState.id);
    return;
  }
  var artistCard = event.target.closest('[data-sw-artist]');
  if (artistCard && searchWallBody.contains(artistCard)) {
    searchWallOpenArtist(artistCard.getAttribute('data-sw-artist'));
    return;
  }
  var albumCard = event.target.closest('[data-sw-album]');
  if (albumCard && searchWallBody.contains(albumCard)) {
    searchWallOpenAlbum(albumCard.getAttribute('data-sw-album'));
    return;
  }
  var card = event.target.closest('[data-sw-song]');
  if (card && searchWallBody.contains(card)) {
    searchWallPlaySong(card.getAttribute('data-sw-song'));
  }
});

if (searchWallBody) searchWallBody.addEventListener('keydown', function (event) {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  if (event.target.closest('[data-sw-like],[data-sw-collect],[data-sw-next]')) return;
  var artistCard = event.target.closest('[data-sw-artist]');
  if (artistCard && searchWallBody.contains(artistCard)) {
    event.preventDefault();
    searchWallOpenArtist(artistCard.getAttribute('data-sw-artist'));
    return;
  }
  var albumCard = event.target.closest('[data-sw-album]');
  if (albumCard && searchWallBody.contains(albumCard)) {
    event.preventDefault();
    searchWallOpenAlbum(albumCard.getAttribute('data-sw-album'));
    return;
  }
  var card = event.target.closest('[data-sw-song]');
  if (!card || !searchWallBody.contains(card)) return;
  event.preventDefault();
  searchWallPlaySong(card.getAttribute('data-sw-song'));
});

if (searchWallBody) searchWallBody.addEventListener('pointermove', function (event) {
  var card = event.target.closest('.sw-card');
  if (card && searchWallBody.contains(card)) searchWallUpdateCardTilt(card, event);
});

if (searchWallBody) searchWallBody.addEventListener('pointerout', function (event) {
  var card = event.target.closest('.sw-card');
  if (!card || !searchWallBody.contains(card)) return;
  if (event.relatedTarget && card.contains(event.relatedTarget)) return;
  searchWallResetCardTilt(card);
});

if (searchWallBody) searchWallBody.addEventListener('pointerleave', function () {
  Array.prototype.forEach.call(searchWallBody.querySelectorAll('.sw-card'), searchWallResetCardTilt);
});

if (searchWallFooterHost) searchWallFooterHost.addEventListener('click', function (event) {
  var retry = event.target.closest('[data-sw-retry]');
  if (retry && searchWallFooterHost.contains(retry)) {
    searchWallRunSearch(searchWallState.query, { focusInput: false });
    return;
  }
  var more = event.target.closest('[data-sw-load-more]');
  if (more && searchWallFooterHost.contains(more)) searchWallLoadMore();
});

if (searchWallContent) searchWallContent.addEventListener('scroll', function () {
  searchWallUpdateScrollControls();
  // 歌手页的滚动与结果页无关：既不能把结果页存的位置冲掉（返回会还原到错处），
  // 也不能触发结果页的加载更多 —— 那会 playlist = merged，
  // 把 playlist 从歌手的歌抢走，歌手页卡片下标随即错位。
  if (searchWallState.view === 'artist') return;
  searchWallState.scrollTop = searchWallContent.scrollTop;
  scheduleSearchWallRender();
  if (searchWallContent.scrollTop + searchWallContent.clientHeight >= searchWallContent.scrollHeight - 520) {
    searchWallLoadMore();
  }
}, { passive: true });

window.addEventListener('resize', function () {
  if (!searchWallState.active || searchWallState.resizeRaf) return;
  searchWallState.resizeRaf = requestAnimationFrame(function () {
    searchWallState.resizeRaf = 0;
    renderSearchWall({ forceGrid: true });
  });
});

document.addEventListener('keydown', function (event) {
  if (!searchWallState.active || event.key !== 'Escape') return;
  // 输入框自己的 Escape 处理会先跑（先清词、空词才关页），别在这里重复关闭。
  if (event.target && event.target.id === 'search-wall-input') return;
  event.preventDefault();
  event.stopPropagation();
  // 歌手页先退回结果页，和返回按钮保持一致。
  if (searchWallBackToResults()) return;
  closeSearchWall({ reason: 'escape' });
}, true);

