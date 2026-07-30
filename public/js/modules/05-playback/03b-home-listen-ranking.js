var homeListenRankingState = {
  open: false,
  source: 'netease',
  previousFocus: null,
  loading: false,
  requestToken: 0,
  remoteSongs: [],
  controlsBound: false,
};

function homeListenRankingSourceLabel(source) {
  return { recent: '最近播放', netease: '小云', kugou: '小狗', qq: '小Q', local: '本地音乐' }[source] || '当前平台';
}

function homeListenRankingProvider(item) {
  item = item || {};
  var key = String(item.key || '').toLowerCase();
  var raw = String(item.provider || item.sourceKey || item.type || '').trim().toLowerCase();
  if (item.localKey || item.localPath || raw === 'local' || key.indexOf('local:') === 0) return 'local';
  if (raw === 'qq' || key.indexOf('qq:') === 0) return 'qq';
  if (raw === 'kugou' || key.indexOf('kugou:') === 0) return 'kugou';
  if (raw === 'netease' || raw === 'song' || key.indexOf('song:') === 0) return 'netease';
  return '';
}

function homeListenRankingRecentRecord(key) {
  var history = listenStatsState && Array.isArray(listenStatsState.history) ? listenStatsState.history : [];
  for (var i = 0; i < history.length; i++) {
    if (history[i] && String(history[i].key || '') === String(key || '')) return history[i];
  }
  return null;
}

function homeListenRankingLocalRows(source) {
  if (source === 'recent') {
    return (listenStatsState && Array.isArray(listenStatsState.history) ? listenStatsState.history : [])
      .filter(Boolean)
      .slice()
      .sort(function (a, b) { return Number(b.playedAt || 0) - Number(a.playedAt || 0); })
      .slice(0, 100);
  }
  var songs = listenStatsState && listenStatsState.songs && typeof listenStatsState.songs === 'object'
    ? listenStatsState.songs
    : {};
  return Object.keys(songs).map(function (key) {
    var stat = songs[key] || {};
    var recent = homeListenRankingRecentRecord(key) || {};
    return Object.assign({}, recent, stat, { key: key });
  }).filter(function (item) {
    return homeListenRankingProvider(item) === source;
  }).sort(function (a, b) {
    return (Number(b.plays) - Number(a.plays))
      || (Number(b.listenMs) - Number(a.listenMs))
      || (Number(b.lastPlayedAt || b.playedAt) - Number(a.lastPlayedAt || a.playedAt));
  }).slice(0, 100);
}

function homeListenRankingDuration(milliseconds) {
  var minutes = Math.max(0, Math.round((Number(milliseconds) || 0) / 60000));
  if (minutes < 60) return minutes + ' 分钟';
  var hours = Math.floor(minutes / 60);
  var remain = minutes % 60;
  return hours + ' 小时' + (remain ? ' ' + remain + ' 分' : '');
}

function homeListenRankingRecentTime(timestamp) {
  var elapsed = Math.max(0, Date.now() - (Number(timestamp) || 0));
  if (elapsed < 60000) return '刚刚';
  if (elapsed < 3600000) return Math.max(1, Math.floor(elapsed / 60000)) + ' 分钟前';
  if (elapsed < 86400000) return Math.floor(elapsed / 3600000) + ' 小时前';
  if (elapsed < 604800000) return Math.floor(elapsed / 86400000) + ' 天前';
  var date = new Date(Number(timestamp) || 0);
  return (date.getMonth() + 1) + '月' + date.getDate() + '日';
}

function homeListenRankingEscape(value) {
  return typeof escHtml === 'function'
    ? escHtml(String(value == null ? '' : value))
    : String(value == null ? '' : value).replace(/[&<>"']/g, function (character) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
    });
}

function homeListenRankingCoverStyle(item) {
  var cover = String(item && (item.cover || item.picUrl || item.albumCover) || '').trim();
  if (!cover) return '';
  var url = typeof cssImageUrl === 'function' ? cssImageUrl(cover) : cover;
  return ' style="background-image:url(&quot;' + homeListenRankingEscape(url) + '&quot;)"';
}

function renderHomeListenRankingRows(rows, source, remote) {
  var list = document.getElementById('home-listen-ranking-list');
  var status = document.getElementById('home-listen-ranking-status');
  if (!list || !status) return;
  list._homeListenRankingRows = rows;
  if (!rows.length) {
    list.innerHTML = '<div class="home-platform-recommend-empty"><strong>还没有' + homeListenRankingEscape(homeListenRankingSourceLabel(source)) + '排行</strong>' +
      '<span>完整播放、听满约 45 秒或达到歌曲一半后，才会计入有效听歌。</span></div>';
    status.textContent = source === 'netease' ? '小云账号周榜为空；本机记录也暂时为空。' : '这里显示本机有效听歌记录。';
    return;
  }
  status.classList.remove('is-error');
  status.textContent = source === 'recent'
    ? '本机最近有效播放 · 共 ' + rows.length + ' 首'
    : remote
    ? '小云账号周榜 · 点击歌曲即可播放'
    : homeListenRankingSourceLabel(source) + '本机有效听歌排行 · 共 ' + rows.length + ' 首';
  list.innerHTML = rows.map(function (item, index) {
    var plays = Number(item.playCount != null ? item.playCount : item.plays) || 0;
    var metric = source === 'recent'
      ? homeListenRankingRecentTime(item.playedAt || item.lastPlayedAt)
      : (remote ? (plays + ' 次') : (plays + ' 次 · ' + homeListenRankingDuration(item.listenMs)));
    return '<button class="home-listen-ranking-row" type="button" data-listen-ranking-index="' + index + '">' +
      '<span class="home-listen-ranking-number">' + (index + 1) + '</span>' +
      '<span class="home-listen-ranking-cover"' + homeListenRankingCoverStyle(item) + '></span>' +
      '<span class="home-listen-ranking-copy"><strong>' + homeListenRankingEscape(item.name || item.title || '未知歌曲') + '</strong>' +
      '<small>' + homeListenRankingEscape(item.artist || item.source || homeListenRankingSourceLabel(source)) + '</small></span>' +
      '<span class="home-listen-ranking-stat">' + homeListenRankingEscape(metric) + '</span>' +
      '<span class="home-platform-recommend-arrow" aria-hidden="true">›</span></button>';
  }).join('');
}

function syncHomeListenRankingTabs(source) {
  document.querySelectorAll('[data-listen-ranking-source]').forEach(function (button) {
    var active = button.getAttribute('data-listen-ranking-source') === source;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  });
}

function syncHomeListenRankingHeading(source) {
  var recent = source === 'recent';
  var title = document.getElementById('home-listen-ranking-title');
  var description = document.getElementById('home-listen-ranking-description');
  var refresh = document.getElementById('home-listen-ranking-refresh');
  if (title) title.textContent = recent ? '最近播放' : '听歌排行';
  if (description) description.textContent = recent
    ? '按最近播放时间展示本机有效听歌记录；点击歌曲可重新播放。'
    : '小云显示账号周榜；小狗、小Q和本地显示本机有效听歌记录。';
  if (refresh) refresh.textContent = recent ? '刷新最近记录' : '刷新当前排行';
}

async function loadHomeListenRanking(source, refresh) {
  source = /^(recent|netease|kugou|qq|local)$/.test(String(source || '')) ? source : 'netease';
  homeListenRankingState.source = source;
  syncHomeListenRankingTabs(source);
  syncHomeListenRankingHeading(source);
  var status = document.getElementById('home-listen-ranking-status');
  var list = document.getElementById('home-listen-ranking-list');
  if (!status || !list) return;
  var localRows = homeListenRankingLocalRows(source);
  if (source !== 'netease') {
    renderHomeListenRankingRows(localRows, source, false);
    return;
  }
  var requestToken = ++homeListenRankingState.requestToken;
  homeListenRankingState.loading = true;
  status.classList.remove('is-error');
  status.textContent = '正在读取小云账号周榜…';
  list.innerHTML = '<div class="home-platform-recommend-loading">正在加载听歌排行</div>';
  try {
    var payload = await apiJson('/api/listen/ranking?type=week' + (refresh ? '&refresh=1' : ''), { timeoutMs: 9000 });
    if (requestToken !== homeListenRankingState.requestToken) return;
    if (!payload || payload.error || payload.loggedIn === false) throw new Error(payload && (payload.error || payload.message) || 'LISTEN_RANKING_UNAVAILABLE');
    var songs = payload && Array.isArray(payload.songs) ? payload.songs : [];
    homeListenRankingState.remoteSongs = songs;
    renderHomeListenRankingRows(songs.length ? songs : localRows, source, songs.length > 0);
  } catch (error) {
    if (requestToken !== homeListenRankingState.requestToken) return;
    homeListenRankingState.remoteSongs = [];
    renderHomeListenRankingRows(localRows, source, false);
    status.classList.toggle('is-error', !localRows.length);
    status.textContent = localRows.length
      ? '小云账号周榜暂不可用，已显示本机小云有效听歌记录。'
      : '小云账号周榜暂不可用；登录后重试，或先完整播放歌曲生成本机记录。';
  } finally {
    if (requestToken === homeListenRankingState.requestToken) homeListenRankingState.loading = false;
  }
}

function closeHomeListenRanking() {
  var mask = document.getElementById('home-listen-ranking-mask');
  homeListenRankingState.open = false;
  homeListenRankingState.requestToken++;
  if (mask) {
    mask.classList.remove('show');
    mask.setAttribute('aria-hidden', 'true');
  }
  var previous = homeListenRankingState.previousFocus;
  homeListenRankingState.previousFocus = null;
  if (previous && typeof previous.focus === 'function') previous.focus();
}

function playHomeListenRankingItem(index) {
  var list = document.getElementById('home-listen-ranking-list');
  var rows = list && Array.isArray(list._homeListenRankingRows) ? list._homeListenRankingRows : [];
  var item = rows[Number(index) || 0];
  if (!item) return;
  closeHomeListenRanking();
  if (homeListenRankingState.source !== 'netease' || item.plays != null || item.localKey || item.localPath) {
    Promise.resolve(playHomeRecent(item)).catch(function (error) { console.warn('[HomeListenRanking]', error); });
    return;
  }
  var song = Object.assign({ provider: 'netease', source: 'netease', type: 'song' }, item);
  playQueue = [cloneSong(song)];
  currentIdx = 0;
  safeRenderQueuePanel('home-listen-ranking');
  safeShelfRebuild('home-listen-ranking', true);
  forcePlaybackControlsInteractive();
  Promise.resolve(playQueueAt(0, { manual: true, context: { type: 'listen-ranking', playlistName: '小云听歌排行' } }))
    .catch(function (error) { console.warn('[HomeListenRanking]', error); });
}

function bindHomeListenRankingControls() {
  if (homeListenRankingState.controlsBound) return;
  homeListenRankingState.controlsBound = true;
  var mask = document.getElementById('home-listen-ranking-mask');
  var tabs = document.getElementById('home-listen-ranking-tabs');
  var list = document.getElementById('home-listen-ranking-list');
  var close = document.getElementById('home-listen-ranking-close');
  var done = document.getElementById('home-listen-ranking-done');
  var refresh = document.getElementById('home-listen-ranking-refresh');
  if (tabs) tabs.addEventListener('click', function (event) {
    var button = event.target.closest('[data-listen-ranking-source]');
    if (button) loadHomeListenRanking(button.getAttribute('data-listen-ranking-source'), false);
  });
  if (list) list.addEventListener('click', function (event) {
    var row = event.target.closest('[data-listen-ranking-index]');
    if (row) playHomeListenRankingItem(row.getAttribute('data-listen-ranking-index'));
  });
  if (close) close.addEventListener('click', closeHomeListenRanking);
  if (done) done.addEventListener('click', closeHomeListenRanking);
  if (refresh) refresh.addEventListener('click', function () { loadHomeListenRanking(homeListenRankingState.source, true); });
  if (mask) mask.addEventListener('click', function (event) { if (event.target === mask) closeHomeListenRanking(); });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && homeListenRankingState.open) closeHomeListenRanking();
  });
}

function openHomeListenRanking(preferredSource) {
  bindHomeListenRankingControls();
  var mask = document.getElementById('home-listen-ranking-mask');
  if (!mask) return;
  homeListenRankingState.previousFocus = document.activeElement;
  homeListenRankingState.open = true;
  mask.classList.add('show');
  mask.setAttribute('aria-hidden', 'false');
  var source = /^(recent|netease|kugou|qq|local)$/.test(String(preferredSource || '')) ? preferredSource : 'netease';
  loadHomeListenRanking(source, false);
  setTimeout(function () {
    var active = mask.querySelector('[data-listen-ranking-source="' + source + '"]');
    if (active) active.focus();
  }, 0);
}

bindHomeListenRankingControls();
