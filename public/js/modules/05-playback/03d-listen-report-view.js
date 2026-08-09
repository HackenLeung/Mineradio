'use strict';

var listenReportViewState = {
  open: false,
  mode: 'month',
  period: '',
  months: [],
  report: null,
  requestToken: 0,
  previousFocus: null,
  previewTemplate: 'night',
  previewDataUrl: '',
  previewFileName: '',
  previewAssets: null,
  previewAssetKey: '',
  previewRenderToken: 0,
  artistAvatarCache: {},
  artistAvatarFailureCache: {},
};

function listenReportElement(id) {
  return document.getElementById(id);
}

function listenReportCurrentPeriod(mode, now) {
  var date = now instanceof Date ? now : new Date();
  return mode === 'year'
    ? String(date.getFullYear())
    : date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0');
}

function listenReportPeriodLabel(mode, period) {
  if (mode === 'year') return String(period || new Date().getFullYear()) + ' 年';
  var parts = String(period || '').split('-');
  return (Number(parts[0]) || new Date().getFullYear()) + ' 年 ' + (Number(parts[1]) || new Date().getMonth() + 1) + ' 月';
}

function listenReportPeriodOptions(mode, startedAt, now) {
  var start = new Date(Math.max(0, Number(startedAt) || Date.now()));
  var end = now instanceof Date ? now : new Date();
  var values = [];
  if (mode === 'year') {
    for (var year = end.getFullYear(); year >= start.getFullYear(); year--) values.push(String(year));
    return values;
  }
  var cursor = new Date(end.getFullYear(), end.getMonth(), 1);
  var first = new Date(start.getFullYear(), start.getMonth(), 1);
  while (cursor.getTime() >= first.getTime()) {
    values.push(listenStatsV3MonthKey(cursor.getTime()));
    cursor.setMonth(cursor.getMonth() - 1);
  }
  return values;
}

function listenReportEmptyAggregate(mode, period) {
  return {
    mode: mode,
    period: period,
    totalListenMs: 0,
    sessions: 0,
    completed: 0,
    songs: [],
    artists: [],
    hours: Array(24).fill(0),
    days: {},
    firstRecordedAt: 0,
    lastRecordedAt: 0,
  };
}

function listenReportMergeRank(target, source, kind) {
  Object.keys(source || {}).forEach(function (key) {
    var incoming = source[key] && typeof source[key] === 'object' ? source[key] : {};
    var item = target[key] || (kind === 'song'
      ? { key: key, name: incoming.name || '未知歌曲', artist: incoming.artist || '', artistRefs: [], cover: '', provider: '', type: 'song', id: '', localKey: '', localPath: '', listenMs: 0, plays: 0, completed: 0, lastPlayedAt: 0 }
      : { name: incoming.name || key, id: '', mid: '', provider: '', avatar: '', listenMs: 0, plays: 0, completed: 0, lastPlayedAt: 0 });
    if (kind === 'song') {
      ['name', 'artist', 'cover', 'provider', 'type', 'id', 'localKey', 'localPath'].forEach(function (field) {
        if (incoming[field]) item[field] = incoming[field];
      });
      if (Array.isArray(incoming.artistRefs) && incoming.artistRefs.length) item.artistRefs = incoming.artistRefs;
    } else if (incoming.name) {
      item.name = incoming.name;
      ['id', 'mid', 'provider', 'avatar'].forEach(function (field) {
        if (incoming[field]) item[field] = incoming[field];
      });
    }
    item.listenMs += Math.max(0, Number(incoming.listenMs) || 0);
    item.plays += Math.max(0, Number(incoming.plays) || 0);
    item.completed += Math.max(0, Number(incoming.completed) || 0);
    item.lastPlayedAt = Math.max(Number(item.lastPlayedAt) || 0, Number(incoming.lastPlayedAt) || 0);
    target[key] = item;
  });
}

function aggregateListenReportV3(months, mode, period) {
  var aggregate = listenReportEmptyAggregate(mode, period);
  var songMap = {};
  var artistMap = {};
  (Array.isArray(months) ? months : []).forEach(function (month) {
    if (!month || !month.period) return;
    var matches = mode === 'year' ? String(month.period).slice(0, 4) === String(period) : String(month.period) === String(period);
    if (!matches) return;
    aggregate.totalListenMs += Math.max(0, Number(month.totalListenMs) || 0);
    aggregate.sessions += Math.max(0, Number(month.sessions) || 0);
    aggregate.completed += Math.max(0, Number(month.completed) || 0);
    aggregate.firstRecordedAt = aggregate.firstRecordedAt
      ? Math.min(aggregate.firstRecordedAt, Number(month.firstRecordedAt) || aggregate.firstRecordedAt)
      : Math.max(0, Number(month.firstRecordedAt) || 0);
    aggregate.lastRecordedAt = Math.max(aggregate.lastRecordedAt, Number(month.lastRecordedAt) || 0);
    aggregate.hours = aggregate.hours.map(function (value, index) {
      return value + Math.max(0, Number(month.hours && month.hours[index]) || 0);
    });
    Object.keys(month.days || {}).forEach(function (dayKey) {
      aggregate.days[dayKey] = Math.max(0, Number(aggregate.days[dayKey]) || 0) + Math.max(0, Number(month.days[dayKey]) || 0);
    });
    listenReportMergeRank(songMap, month.songs, 'song');
    listenReportMergeRank(artistMap, month.artists, 'artist');
  });
  function rankValues(map) {
    return Object.keys(map).map(function (key) { return map[key]; }).sort(function (a, b) {
      return (Number(b.listenMs) - Number(a.listenMs))
        || (Number(b.plays) - Number(a.plays))
        || (Number(b.lastPlayedAt) - Number(a.lastPlayedAt));
    });
  }
  aggregate.songs = rankValues(songMap);
  aggregate.artists = rankValues(artistMap);
  return aggregate;
}

function listenReportActiveWindow(hours) {
  var values = Array.from({ length: 24 }, function (_, index) { return Math.max(0, Number(hours && hours[index]) || 0); });
  var best = { start: 0, listenMs: 0 };
  for (var start = 0; start < 24; start++) {
    var total = values[start] + values[(start + 1) % 24] + values[(start + 2) % 24];
    if (total > best.listenMs) best = { start: start, listenMs: total };
  }
  best.end = (best.start + 3) % 24;
  best.label = String(best.start).padStart(2, '0') + ':00 - ' + String(best.end).padStart(2, '0') + ':00';
  return best;
}

function listenReportDuration(milliseconds) {
  var minutes = Math.floor(Math.max(0, Number(milliseconds) || 0) / 60000);
  if (minutes < 60) return minutes + ' 分钟';
  var hours = Math.floor(minutes / 60);
  var rest = minutes % 60;
  return hours + ' 小时' + (rest ? ' ' + rest + ' 分' : '');
}

function listenReportCompactDuration(milliseconds) {
  var minutes = Math.max(0, Math.round((Number(milliseconds) || 0) / 60000));
  if (minutes < 60) return minutes + ' 分钟';
  var hours = Math.floor(minutes / 60);
  return hours + ' 小时' + (minutes % 60 ? ' ' + (minutes % 60) + ' 分' : '');
}

function listenReportCover(item) {
  try {
    if (typeof listenRecordCoverSrc === 'function') {
      var resolved = listenRecordCoverSrc(item);
      if (resolved) return resolved;
    }
    if (typeof songCoverSrc === 'function') return songCoverSrc(item, 240) || item.cover || '';
  } catch (_) { }
  return String(item && item.cover || '');
}

function listenReportInitials(value) {
  var chars = Array.from(String(value || 'MR').replace(/\s+/g, '').trim() || 'MR');
  return chars.slice(0, 2).join('').toUpperCase();
}

function listenReportCreateSongRow(item, index) {
  var row = document.createElement('div');
  row.className = 'listen-report-song-row';
  var rank = document.createElement('span');
  rank.className = 'listen-report-rank';
  rank.textContent = String(index + 1).padStart(2, '0');
  var art = document.createElement('span');
  art.className = 'listen-report-song-art';
  art.textContent = listenReportInitials(item.name);
  var cover = listenReportCover(item);
  if (cover) {
    var image = document.createElement('img');
    image.alt = '';
    image.loading = 'lazy';
    image.decoding = 'async';
    image.addEventListener('load', function () {
      art.classList.add('has-cover');
    }, { once: true });
    image.addEventListener('error', function () {
      art.classList.remove('has-cover');
      image.remove();
    }, { once: true });
    image.src = cover;
    art.appendChild(image);
  }
  var copy = document.createElement('span');
  copy.className = 'listen-report-song-copy';
  var name = document.createElement('strong');
  name.textContent = item.name || '未知歌曲';
  var artist = document.createElement('small');
  artist.textContent = item.artist || '未知歌手';
  copy.appendChild(name);
  copy.appendChild(artist);
  var metric = document.createElement('span');
  metric.className = 'listen-report-row-metric';
  var duration = document.createElement('strong');
  duration.textContent = listenReportCompactDuration(item.listenMs);
  metric.appendChild(duration);
  row.appendChild(rank);
  row.appendChild(art);
  row.appendChild(copy);
  row.appendChild(metric);
  return row;
}

function listenReportRenderSongs(items) {
  var list = listenReportElement('listen-report-song-list');
  if (!list) return;
  list.replaceChildren();
  (items || []).slice(0, 10).forEach(function (item, index) {
    list.appendChild(listenReportCreateSongRow(item, index));
  });
}

function listenReportRenderArtists(items) {
  var list = listenReportElement('listen-report-artist-list');
  if (!list) return;
  list.replaceChildren();
  var artistRows = [];
  (items || []).slice(0, 10).forEach(function (item, index) {
    var row = document.createElement('div');
    row.className = 'listen-report-artist-row';
    var rank = document.createElement('span');
    rank.className = 'listen-report-artist-rank';
    rank.textContent = String(index + 1).padStart(2, '0');
    var art = document.createElement('span');
    art.className = 'listen-report-artist-art';
    art.textContent = listenReportInitials(item.name);
    var copy = document.createElement('span');
    copy.className = 'listen-report-artist-copy';
    var name = document.createElement('strong');
    name.textContent = item.name || '未知歌手';
    copy.appendChild(name);
    var metric = document.createElement('strong');
    metric.className = 'listen-report-artist-metric';
    metric.textContent = listenReportCompactDuration(item.listenMs);
    row.appendChild(rank);
    row.appendChild(art);
    row.appendChild(copy);
    row.appendChild(metric);
    list.appendChild(row);
    artistRows.push({ item: item, art: art });
  });
  if (typeof hydrateListenReportArtistImages === 'function') {
    hydrateListenReportArtistImages(artistRows, listenReportViewState.report).catch(function (error) {
      console.warn('[ListenReportArtists]', error);
    });
  }
}

function listenReportRenderHours(hours, active) {
  var chart = listenReportElement('listen-report-hour-chart');
  if (!chart) return;
  chart.replaceChildren();
  var maximum = Math.max.apply(null, (hours || []).concat([1]));
  for (var hour = 0; hour < 24; hour++) {
    var bar = document.createElement('span');
    bar.className = 'listen-report-hour-bar';
    var activeHour = hour === active.start || hour === (active.start + 1) % 24 || hour === (active.start + 2) % 24;
    if (activeHour && active.listenMs > 0) bar.classList.add('active');
    bar.style.setProperty('--listen-hour-height', Math.max(5, Math.round((Math.max(0, Number(hours[hour]) || 0) / maximum) * 100)) + '%');
    bar.title = String(hour).padStart(2, '0') + ':00 · ' + listenReportCompactDuration(hours[hour]);
    chart.appendChild(bar);
  }
}

function listenReportRender(report) {
  listenReportViewState.report = report;
  var loading = listenReportElement('listen-report-loading');
  var empty = listenReportElement('listen-report-empty');
  var body = listenReportElement('listen-report-body');
  if (loading) loading.hidden = true;
  var hasData = !!(report && report.sessions > 0 && report.songs.length);
  if (empty) empty.hidden = hasData;
  if (body) body.hidden = !hasData;
  if (!hasData) {
    var start = listenReportElement('listen-report-empty-start');
    if (start) start.textContent = '统计从 ' + new Date(listenStatsV3StartedAt()).toLocaleDateString('zh-CN') + ' 开始';
    var exportButton = listenReportElement('listen-report-export');
    if (exportButton) exportButton.disabled = true;
    return;
  }
  var current = listenReportCurrentPeriod(report.mode);
  var currentPeriod = report.period === current;
  listenReportElement('listen-report-period-kicker').textContent = report.mode === 'year' ? 'YEAR IN MUSIC' : 'MONTH IN MUSIC';
  listenReportElement('listen-report-period-title').textContent = listenReportPeriodLabel(report.mode, report.period);
  listenReportElement('listen-report-cutoff').textContent = currentPeriod
    ? '统计截至 ' + new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })
    : '完整周期报告';
  listenReportElement('listen-report-total-time').textContent = listenReportDuration(report.totalListenMs);
  listenReportElement('listen-report-song-count').textContent = String(report.songs.length);
  listenReportElement('listen-report-day-count').textContent = String(Object.keys(report.days).length);
  var active = listenReportActiveWindow(report.hours);
  listenReportElement('listen-report-active-window').textContent = active.label;
  listenReportRenderHours(report.hours, active);
  listenReportRenderSongs(report.songs);
  listenReportRenderArtists(report.artists);
  var exportButton = listenReportElement('listen-report-export');
  if (exportButton) exportButton.disabled = false;
}

function listenReportSyncControls() {
  document.querySelectorAll('[data-listen-report-mode]').forEach(function (button) {
    var active = button.getAttribute('data-listen-report-mode') === listenReportViewState.mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  var select = listenReportElement('listen-report-period-select');
  if (!select) return;
  var options = listenReportPeriodOptions(listenReportViewState.mode, listenStatsV3StartedAt());
  if (options.indexOf(listenReportViewState.period) < 0) listenReportViewState.period = options[0] || listenReportCurrentPeriod(listenReportViewState.mode);
  select.replaceChildren();
  options.forEach(function (period) {
    var option = document.createElement('option');
    option.value = period;
    option.textContent = listenReportPeriodLabel(listenReportViewState.mode, period);
    option.selected = period === listenReportViewState.period;
    select.appendChild(option);
  });
}

async function refreshListenReportView(quiet) {
  if (!listenReportViewState.open) return null;
  var token = ++listenReportViewState.requestToken;
  var loading = listenReportElement('listen-report-loading');
  if (!quiet && loading) loading.hidden = false;
  try {
    if (typeof updateListenStatsTick === 'function') updateListenStatsTick(true);
    if (typeof recordListenStatsV3Tick === 'function' && typeof listenSession !== 'undefined' && listenSession) {
      await recordListenStatsV3Tick(listenSession, true);
    }
    var months = await readListenStatsV3Months();
    if (token !== listenReportViewState.requestToken) return null;
    listenReportViewState.months = months;
    listenReportSyncControls();
    var report = aggregateListenReportV3(months, listenReportViewState.mode, listenReportViewState.period);
    listenReportRender(report);
    return report;
  } catch (error) {
    if (token !== listenReportViewState.requestToken) return null;
    console.warn('[ListenReportRead]', error);
    if (loading) {
      loading.hidden = false;
      loading.textContent = '听歌报告暂时无法读取';
    }
    return null;
  }
}

function listenReportCloseCompetingSurfaces() {
  if (typeof isMusicLibraryWallOpen === 'function' && isMusicLibraryWallOpen()) closeMusicLibraryWall({ playback: true });
  if (typeof togglePlaylistPanel === 'function') togglePlaylistPanel(false);
  if (typeof setPeek === 'function') {
    setPeek(listenReportElement('playlist-panel'), false, 'pl');
    setPeek(listenReportElement('search-area'), false, 'search');
    setPeek(listenReportElement('fx-panel'), false, 'fx');
  }
}

function openListenReportView() {
  var view = listenReportElement('listen-report-view');
  if (!view) return false;
  if (!listenReportViewState.open) {
    listenReportViewState.previousFocus = document.activeElement;
    listenReportViewState.mode = 'month';
    listenReportViewState.period = listenReportCurrentPeriod('month');
  }
  listenReportViewState.open = true;
  document.body.classList.add('listen-report-open');
  view.classList.add('show');
  view.setAttribute('aria-hidden', 'false');
  listenReportCloseCompetingSurfaces();
  listenReportSyncControls();
  refreshListenReportView(false);
  requestAnimationFrame(function () {
    var scroll = listenReportElement('listen-report-scroll');
    if (scroll) { scroll.scrollTop = 0; scroll.focus(); }
  });
  return true;
}

function closeListenReportView() {
  if (!listenReportViewState.open) return false;
  showListenReportClearDialog(false);
  showListenReportPreviewDialog(false);
  listenReportViewState.open = false;
  listenReportViewState.requestToken += 1;
  document.body.classList.remove('listen-report-open');
  var view = listenReportElement('listen-report-view');
  if (view) {
    view.classList.remove('show');
    view.setAttribute('aria-hidden', 'true');
  }
  var target = listenReportViewState.previousFocus;
  listenReportViewState.previousFocus = null;
  if (target && typeof target.focus === 'function') requestAnimationFrame(function () { target.focus(); });
  return true;
}

function listenReportSetMode(mode) {
  mode = mode === 'year' ? 'year' : 'month';
  if (listenReportViewState.mode === mode) return;
  listenReportViewState.mode = mode;
  listenReportViewState.period = listenReportCurrentPeriod(mode);
  listenReportSyncControls();
  listenReportRender(aggregateListenReportV3(listenReportViewState.months, mode, listenReportViewState.period));
}

function listenReportSetPeriod(period) {
  listenReportViewState.period = String(period || listenReportCurrentPeriod(listenReportViewState.mode));
  listenReportRender(aggregateListenReportV3(listenReportViewState.months, listenReportViewState.mode, listenReportViewState.period));
}

function listenReportCanvasText(ctx, text, x, y, maxWidth) {
  text = String(text || '');
  if (!maxWidth || ctx.measureText(text).width <= maxWidth) {
    ctx.fillText(text, x, y);
    return text;
  }
  var clipped = text;
  while (clipped.length > 1 && ctx.measureText(clipped + '...').width > maxWidth) clipped = clipped.slice(0, -1);
  ctx.fillText(clipped + '...', x, y);
  return clipped;
}

function listenReportCanvasRoundRect(ctx, x, y, width, height, radius) {
  radius = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

function listenReportPosterAccent() {
  var accent = '#f4d28a';
  try {
    var accentRgb = getComputedStyle(document.documentElement).getPropertyValue('--fc-accent-rgb').trim();
    if (/^\d+\s*,\s*\d+\s*,\s*\d+$/.test(accentRgb)) accent = 'rgb(' + accentRgb + ')';
  } catch (_) { }
  return accent;
}

function listenReportPosterTemplate(value) {
  return /^(night|particle|glass)$/.test(String(value || '')) ? String(value) : 'night';
}

function listenReportPosterTemplateLabel(value) {
  return { night: '封面矩阵', particle: '霓虹切片', glass: '主角登场' }[listenReportPosterTemplate(value)];
}

function listenReportPosterTrackRow(ctx, item, index, x, y, width, accent, textColor, mutedColor) {
  ctx.fillStyle = accent;
  listenReportCanvasRoundRect(ctx, x, y, 68, 68, 13);
  ctx.fill();
  ctx.fillStyle = '#071013';
  ctx.font = '800 22px "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(String(index + 1).padStart(2, '0'), x + 34, y + 43);
  ctx.textAlign = 'left';
  ctx.fillStyle = textColor;
  ctx.font = '700 24px "Segoe UI", "Microsoft YaHei", sans-serif';
  listenReportCanvasText(ctx, item.name || '未知歌曲', x + 96, y + 28, width - 310);
  ctx.fillStyle = mutedColor;
  ctx.font = '500 17px "Segoe UI", "Microsoft YaHei", sans-serif';
  listenReportCanvasText(ctx, item.artist || '未知歌手', x + 96, y + 57, width - 310);
  ctx.fillStyle = textColor;
  ctx.font = '650 18px "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(listenReportCompactDuration(item.listenMs), x + width, y + 41);
  ctx.textAlign = 'left';
}

function renderListenReportNightPoster(report) {
  var canvas = document.createElement('canvas');
  canvas.width = 1080;
  canvas.height = 1920;
  var ctx = canvas.getContext('2d');
  var active = listenReportActiveWindow(report.hours);
  var maxHour = Math.max.apply(null, report.hours.concat([1]));
  var accent = listenReportPosterAccent();
  var colors = [accent, '#a8b2bb', '#7e8b95', '#c2b7a4', '#8ca39e'];
  ctx.fillStyle = '#080a0d';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  var disc = ctx.createRadialGradient(846, 190, 12, 846, 190, 190);
  disc.addColorStop(0, accent);
  disc.addColorStop(.04, '#080a0d');
  disc.addColorStop(.30, '#1b1e22');
  disc.addColorStop(.31, '#0b0d10');
  disc.addColorStop(.58, '#171a1e');
  disc.addColorStop(.59, '#080a0d');
  disc.addColorStop(1, 'rgba(8,10,13,0)');
  ctx.globalAlpha = .72;
  ctx.fillStyle = disc;
  ctx.fillRect(640, 0, 440, 410);
  ctx.globalAlpha = 1;
  ctx.fillStyle = accent;
  ctx.fillRect(0, 0, 20, canvas.height);
  ctx.fillStyle = '#f4f5f2';
  ctx.font = '700 28px "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.fillText('MINERADIO', 78, 102);
  ctx.fillStyle = '#8f9696';
  ctx.font = '600 20px "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.fillText(report.mode === 'year' ? 'YEAR IN MUSIC' : 'MONTH IN MUSIC', 78, 144);
  ctx.fillStyle = '#f4f5f2';
  ctx.font = '700 48px "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.fillText(listenReportPeriodLabel(report.mode, report.period), 78, 224);

  ctx.fillStyle = '#8f9696';
  ctx.font = '500 22px "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.fillText('收听时长', 78, 310);
  ctx.fillStyle = '#f4f5f2';
  ctx.font = '800 88px "Segoe UI", "Microsoft YaHei", sans-serif';
  listenReportCanvasText(ctx, listenReportDuration(report.totalListenMs), 78, 410, 930);

  var metricLabels = ['听过歌曲', '聆听天数'];
  var metricValues = [report.songs.length, Object.keys(report.days).length];
  metricValues.forEach(function (value, index) {
    var x = 78 + index * 462;
    ctx.fillStyle = colors[index + 1];
    ctx.fillRect(x, 475, 54, 6);
    ctx.fillStyle = '#f4f5f2';
    ctx.font = '750 40px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.fillText(String(value), x, 540);
    ctx.fillStyle = '#8f9696';
    ctx.font = '500 19px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.fillText(metricLabels[index], x, 574);
  });

  ctx.fillStyle = '#1b1d1e';
  listenReportCanvasRoundRect(ctx, 78, 630, 924, 250, 18);
  ctx.fill();
  ctx.fillStyle = '#8f9696';
  ctx.font = '600 18px "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.fillText('MOST ACTIVE HOURS', 112, 682);
  ctx.fillStyle = '#f4f5f2';
  ctx.font = '750 42px "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.fillText(active.label, 112, 742);
  report.hours.forEach(function (value, hour) {
    var height = Math.max(5, Math.round((Math.max(0, Number(value) || 0) / maxHour) * 78));
    var activeHour = hour === active.start || hour === (active.start + 1) % 24 || hour === (active.start + 2) % 24;
    ctx.fillStyle = activeHour ? accent : '#3a4045';
    ctx.fillRect(112 + hour * 35, 832 - height, 22, height);
  });

  ctx.fillStyle = '#f4f5f2';
  ctx.font = '750 30px "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.fillText('TOP TRACKS', 78, 960);
  report.songs.slice(0, 5).forEach(function (item, index) {
    var y = 1025 + index * 126;
    ctx.fillStyle = colors[index % colors.length];
    listenReportCanvasRoundRect(ctx, 78, y, 76, 76, 14);
    ctx.fill();
    ctx.fillStyle = '#101112';
    ctx.font = '800 24px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(String(index + 1).padStart(2, '0'), 116, y + 48);
    ctx.textAlign = 'left';
    ctx.fillStyle = '#f4f5f2';
    ctx.font = '700 25px "Segoe UI", "Microsoft YaHei", sans-serif';
    listenReportCanvasText(ctx, item.name || '未知歌曲', 184, y + 31, 570);
    ctx.fillStyle = '#8f9696';
    ctx.font = '500 18px "Segoe UI", "Microsoft YaHei", sans-serif';
    listenReportCanvasText(ctx, item.artist || '未知歌手', 184, y + 62, 570);
    ctx.fillStyle = '#d7dcda';
    ctx.font = '650 20px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(listenReportCompactDuration(item.listenMs), 1002, y + 42);
    ctx.textAlign = 'left';
  });

  ctx.fillStyle = '#f4f5f2';
  ctx.font = '750 30px "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.fillText('TOP ARTISTS', 78, 1656);
  report.artists.slice(0, 5).forEach(function (item, index) {
    var column = index % 2;
    var row = Math.floor(index / 2);
    var x = 78 + column * 462;
    var y = 1712 + row * 54;
    ctx.fillStyle = colors[(index + 1) % colors.length];
    ctx.fillRect(x, y - 20, 9, 28);
    ctx.fillStyle = '#f4f5f2';
    ctx.font = '650 22px "Segoe UI", "Microsoft YaHei", sans-serif';
    listenReportCanvasText(ctx, (index + 1) + '. ' + (item.name || '未知歌手'), x + 26, y, 300);
    ctx.fillStyle = '#8f9696';
    ctx.font = '500 17px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.fillText(listenReportCompactDuration(item.listenMs), x + 26, y + 28);
  });
  ctx.fillStyle = '#5f6665';
  ctx.font = '500 17px "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.fillText('本地生成 · ' + new Date().toLocaleDateString('zh-CN'), 78, 1884);
  return canvas;
}

function renderListenReportParticlePoster(report) {
  var canvas = document.createElement('canvas');
  canvas.width = 1080;
  canvas.height = 1920;
  var ctx = canvas.getContext('2d');
  var active = listenReportActiveWindow(report.hours);
  var maxHour = Math.max.apply(null, report.hours.concat([1]));
  var accent = listenReportPosterAccent();
  var mint = '#79ead8';
  var background = ctx.createLinearGradient(0, 0, 1080, 1920);
  background.addColorStop(0, '#071416');
  background.addColorStop(.48, '#081012');
  background.addColorStop(1, '#030708');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  var glow = ctx.createRadialGradient(540, 492, 24, 540, 492, 430);
  glow.addColorStop(0, 'rgba(121,234,216,.18)');
  glow.addColorStop(.48, 'rgba(52,126,122,.08)');
  glow.addColorStop(1, 'rgba(3,7,8,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(80, 20, 920, 940);

  for (var particle = 0; particle < 112; particle++) {
    var particleX = (particle * 149 + 37) % 1080;
    var particleY = (particle * 251 + 91) % 1880;
    var particleRadius = particle % 11 === 0 ? 2.4 : particle % 4 === 0 ? 1.5 : .8;
    ctx.globalAlpha = .16 + (particle % 7) * .065;
    ctx.fillStyle = particle % 9 === 0 ? accent : particle % 3 === 0 ? mint : '#dff8f2';
    ctx.beginPath();
    ctx.arc(particleX, particleY, particleRadius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  ctx.fillStyle = '#e9f7f3';
  ctx.font = '750 27px "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.fillText('MINERADIO', 72, 92);
  ctx.fillStyle = '#75a09a';
  ctx.font = '650 18px "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.fillText('PARTICLE FIELD / 02', 72, 126);
  ctx.textAlign = 'right';
  ctx.fillStyle = '#b8cfca';
  ctx.font = '650 22px "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.fillText(listenReportPeriodLabel(report.mode, report.period), 1008, 104);
  ctx.textAlign = 'left';

  var centerX = 540;
  var centerY = 470;
  report.hours.forEach(function (value, hour) {
    var startAngle = -Math.PI / 2 + hour / 24 * Math.PI * 2 + .018;
    var endAngle = -Math.PI / 2 + (hour + 1) / 24 * Math.PI * 2 - .018;
    var strength = Math.max(0, Number(value) || 0) / maxHour;
    var activeHour = hour === active.start || hour === (active.start + 1) % 24 || hour === (active.start + 2) % 24;
    ctx.strokeStyle = activeHour ? mint : 'rgba(164,205,197,' + (.12 + strength * .48) + ')';
    ctx.lineWidth = activeHour ? 16 : 7 + strength * 7;
    ctx.beginPath();
    ctx.arc(centerX, centerY, 246, startAngle, endAngle);
    ctx.stroke();
  });
  [194, 282].forEach(function (radius, index) {
    ctx.strokeStyle = index ? 'rgba(121,234,216,.08)' : 'rgba(121,234,216,.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
    ctx.stroke();
  });
  for (var orbit = 0; orbit < 22; orbit++) {
    var angle = orbit * 2.39996;
    var distance = 205 + (orbit % 4) * 27;
    ctx.fillStyle = orbit % 5 === 0 ? accent : mint;
    ctx.globalAlpha = .42 + (orbit % 3) * .18;
    ctx.beginPath();
    ctx.arc(centerX + Math.cos(angle) * distance, centerY + Math.sin(angle) * distance, 3 + orbit % 3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.textAlign = 'center';
  ctx.fillStyle = '#76a29b';
  ctx.font = '650 20px "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.fillText('你的收听声场', centerX, centerY - 70);
  ctx.fillStyle = '#f2fbf8';
  ctx.font = '800 76px "Segoe UI", "Microsoft YaHei", sans-serif';
  listenReportCanvasText(ctx, listenReportDuration(report.totalListenMs), centerX, centerY + 22, 570);
  ctx.fillStyle = mint;
  ctx.font = '700 21px "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.fillText(active.label, centerX, centerY + 78);
  ctx.fillStyle = '#60857f';
  ctx.font = '600 16px "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.fillText('MOST ACTIVE HOURS', centerX, centerY + 108);
  ctx.textAlign = 'left';

  var particleMetrics = [
    { value: report.songs.length, label: '听过歌曲' },
    { value: Object.keys(report.days).length, label: '聆听天数' },
  ];
  particleMetrics.forEach(function (metric, index) {
    var metricX = 154 + index * 430;
    ctx.fillStyle = 'rgba(121,234,216,.055)';
    listenReportCanvasRoundRect(ctx, metricX, 796, 342, 116, 58);
    ctx.fill();
    ctx.strokeStyle = 'rgba(121,234,216,.16)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = index ? accent : mint;
    ctx.font = '780 38px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.fillText(String(metric.value), metricX + 38, 864);
    ctx.fillStyle = '#75958f';
    ctx.font = '600 18px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.fillText(metric.label, metricX + 116, 860);
  });

  ctx.fillStyle = '#e9f7f3';
  ctx.font = '760 28px "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.fillText('TOP TRACKS', 72, 1012);
  ctx.fillStyle = '#5d827b';
  ctx.font = '600 17px "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText('SIGNAL / LISTEN TIME', 1008, 1010);
  ctx.textAlign = 'left';
  report.songs.slice(0, 5).forEach(function (item, index) {
    var rowY = 1062 + index * 112;
    ctx.strokeStyle = 'rgba(121,234,216,.10)';
    ctx.beginPath();
    ctx.moveTo(72, rowY + 88);
    ctx.lineTo(1008, rowY + 88);
    ctx.stroke();
    listenReportPosterTrackRow(ctx, item, index, 72, rowY, 936, index === 0 ? mint : 'rgba(151,201,192,.72)', '#edf9f6', '#6f928c');
  });

  ctx.fillStyle = '#e9f7f3';
  ctx.font = '760 28px "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.fillText('TOP ARTISTS', 72, 1680);
  report.artists.slice(0, 5).forEach(function (item, index) {
    var artistX = 72 + (index % 2) * 476;
    var artistY = 1732 + Math.floor(index / 2) * 54;
    ctx.fillStyle = index === 0 ? mint : accent;
    ctx.beginPath();
    ctx.arc(artistX + 7, artistY - 6, index === 0 ? 7 : 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#d9ebe7';
    ctx.font = '650 21px "Segoe UI", "Microsoft YaHei", sans-serif';
    listenReportCanvasText(ctx, (index + 1) + '  ' + (item.name || '未知歌手'), artistX + 27, artistY, 300);
    ctx.fillStyle = '#668982';
    ctx.font = '550 16px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(listenReportCompactDuration(item.listenMs), artistX + 444, artistY);
    ctx.textAlign = 'left';
  });
  ctx.fillStyle = '#43615c';
  ctx.font = '500 17px "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.fillText('MINERADIO · 本地生成 · ' + new Date().toLocaleDateString('zh-CN'), 72, 1880);
  return canvas;
}

function renderListenReportGlassPoster(report) {
  var canvas = document.createElement('canvas');
  canvas.width = 1080;
  canvas.height = 1920;
  var ctx = canvas.getContext('2d');
  var active = listenReportActiveWindow(report.hours);
  var accent = listenReportPosterAccent();
  var ice = '#a7d9ef';
  var background = ctx.createLinearGradient(0, 0, 1080, 1920);
  background.addColorStop(0, '#1a2432');
  background.addColorStop(.42, '#0b1018');
  background.addColorStop(1, '#05070b');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  var sideGlow = ctx.createRadialGradient(1050, 340, 0, 1050, 340, 620);
  sideGlow.addColorStop(0, 'rgba(98,171,203,.22)');
  sideGlow.addColorStop(1, 'rgba(5,7,11,0)');
  ctx.fillStyle = sideGlow;
  ctx.fillRect(350, 0, 730, 940);
  for (var bar = 0; bar < 38; bar++) {
    var barHeight = 42 + Math.abs(Math.sin(bar * .78) * 190) + (bar % 5) * 12;
    ctx.fillStyle = bar % 7 === 0 ? accent : ice;
    ctx.globalAlpha = .025 + (bar % 4) * .014;
    ctx.fillRect(26 + bar * 29, 1920 - barHeight, 13, barHeight);
  }
  ctx.globalAlpha = 1;

  function glassPanel(x, y, width, height, radius, alpha) {
    var panel = ctx.createLinearGradient(x, y, x + width, y + height);
    panel.addColorStop(0, 'rgba(255,255,255,' + alpha + ')');
    panel.addColorStop(1, 'rgba(255,255,255,.025)');
    ctx.fillStyle = panel;
    listenReportCanvasRoundRect(ctx, x, y, width, height, radius);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.13)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,.20)';
    listenReportCanvasRoundRect(ctx, x + 22, y + 18, Math.min(110, width - 44), 3, 2);
    ctx.fill();
  }

  ctx.fillStyle = '#f4f8fb';
  ctx.font = '750 28px "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.fillText('MINERADIO', 68, 94);
  ctx.fillStyle = '#8796a6';
  ctx.font = '650 18px "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.fillText('GLASS SPECTRUM / 03', 68, 128);
  ctx.textAlign = 'right';
  ctx.fillStyle = '#c4d0da';
  ctx.font = '650 22px "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.fillText(listenReportPeriodLabel(report.mode, report.period), 1012, 105);
  ctx.textAlign = 'left';

  glassPanel(68, 182, 944, 420, 26, .085);
  ctx.fillStyle = '#8c9baa';
  ctx.font = '650 19px "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.fillText('TOTAL LISTENING', 108, 262);
  ctx.fillStyle = '#f7fafc';
  ctx.font = '800 82px "Segoe UI", "Microsoft YaHei", sans-serif';
  listenReportCanvasText(ctx, listenReportDuration(report.totalListenMs), 108, 366, 820);
  ctx.fillStyle = ice;
  ctx.fillRect(108, 403, 88, 5);
  ctx.fillStyle = '#dce7ee';
  ctx.font = '720 27px "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.fillText(active.label, 108, 466);
  ctx.fillStyle = '#7e8e9c';
  ctx.font = '570 17px "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.fillText('最常听歌时段', 108, 499);
  var glassMetrics = [
    { value: report.songs.length, label: '听过歌曲' },
    { value: Object.keys(report.days).length, label: '聆听天数' },
  ];
  glassMetrics.forEach(function (metric, index) {
    var metricX = 586 + index * 190;
    ctx.fillStyle = index ? accent : ice;
    ctx.font = '780 44px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.fillText(String(metric.value), metricX, 483);
    ctx.fillStyle = '#7e8e9c';
    ctx.font = '570 17px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.fillText(metric.label, metricX, 519);
  });

  glassPanel(68, 650, 944, 696, 26, .065);
  ctx.fillStyle = '#f4f8fb';
  ctx.font = '760 28px "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.fillText('TOP TRACKS', 108, 728);
  ctx.textAlign = 'right';
  ctx.fillStyle = '#718291';
  ctx.font = '600 17px "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.fillText('LISTEN TIME', 972, 728);
  ctx.textAlign = 'left';
  report.songs.slice(0, 5).forEach(function (item, index) {
    var rowY = 774 + index * 108;
    if (index > 0) {
      ctx.strokeStyle = 'rgba(255,255,255,.075)';
      ctx.beginPath();
      ctx.moveTo(108, rowY - 18);
      ctx.lineTo(972, rowY - 18);
      ctx.stroke();
    }
    listenReportPosterTrackRow(ctx, item, index, 108, rowY, 864, index === 0 ? ice : 'rgba(179,197,210,.68)', '#f3f7fa', '#82919e');
  });

  glassPanel(68, 1392, 944, 356, 26, .055);
  ctx.fillStyle = '#f4f8fb';
  ctx.font = '760 28px "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.fillText('TOP ARTISTS', 108, 1470);
  report.artists.slice(0, 5).forEach(function (item, index) {
    var artistColumn = index % 2;
    var artistRow = Math.floor(index / 2);
    var artistX = 108 + artistColumn * 432;
    var artistY = 1534 + artistRow * 66;
    ctx.fillStyle = index === 0 ? ice : accent;
    ctx.fillRect(artistX, artistY - 25, 5, 38);
    ctx.fillStyle = '#e5edf2';
    ctx.font = '670 21px "Segoe UI", "Microsoft YaHei", sans-serif';
    listenReportCanvasText(ctx, String(index + 1).padStart(2, '0') + '  ' + (item.name || '未知歌手'), artistX + 22, artistY, 274);
    ctx.fillStyle = '#71818f';
    ctx.font = '550 16px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.fillText(listenReportCompactDuration(item.listenMs), artistX + 22, artistY + 27);
  });
  ctx.fillStyle = '#596774';
  ctx.font = '500 17px "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.fillText('MINERADIO · 本地生成 · ' + new Date().toLocaleDateString('zh-CN'), 68, 1868);
  return canvas;
}

function renderListenReportPoster(report, template) {
  var selected = listenReportPosterTemplate(template);
  if (selected === 'particle') return renderListenReportParticlePoster(report);
  if (selected === 'glass') return renderListenReportGlassPoster(report);
  return renderListenReportNightPoster(report);
}

async function updateListenReportPreviewImage() {
  var report = listenReportViewState.report;
  if (!report || !(report.sessions > 0) || !report.songs.length) return false;
  var renderToken = ++listenReportViewState.previewRenderToken;
  var stage = listenReportElement('listen-report-preview-stage');
  var confirm = listenReportElement('listen-report-preview-confirm');
  if (stage) {
    stage.classList.add('is-loading');
    stage.setAttribute('aria-busy', 'true');
  }
  if (confirm) confirm.disabled = true;
  try {
    var assets = typeof prepareListenReportPosterAssets === 'function'
      ? await prepareListenReportPosterAssets(report)
      : null;
    if (renderToken !== listenReportViewState.previewRenderToken) return false;
    var template = listenReportPosterTemplate(listenReportViewState.previewTemplate);
    var canvas = typeof renderModernListenReportPoster === 'function'
      ? renderModernListenReportPoster(report, template, assets)
      : renderListenReportPoster(report, template);
    listenReportViewState.previewDataUrl = canvas.toDataURL('image/png');
    listenReportViewState.previewFileName = 'Mineradio-听歌报告-' + listenReportPosterTemplateLabel(template) + '-' + report.period + '.png';
    var image = listenReportElement('listen-report-preview-image');
    if (image) image.src = listenReportViewState.previewDataUrl;
    return true;
  } finally {
    if (stage && renderToken === listenReportViewState.previewRenderToken) {
      stage.classList.remove('is-loading');
      stage.setAttribute('aria-busy', 'false');
    }
    if (confirm && renderToken === listenReportViewState.previewRenderToken) confirm.disabled = false;
  }
}

async function setListenReportPreviewTemplate(template) {
  var selected = listenReportPosterTemplate(template);
  listenReportViewState.previewTemplate = selected;
  var picker = listenReportElement('listen-report-template-picker');
  if (picker) {
    Array.from(picker.querySelectorAll('[data-listen-report-template]')).forEach(function (button) {
      var active = button.getAttribute('data-listen-report-template') === selected;
      button.classList.toggle('active', active);
      button.setAttribute('aria-checked', active ? 'true' : 'false');
    });
  }
  if (listenReportViewState.previewDataUrl) await updateListenReportPreviewImage();
}

async function exportListenReportImage() {
  var report = listenReportViewState.report;
  if (!report || !(report.sessions > 0) || !report.songs.length) return;
  var button = listenReportElement('listen-report-export');
  if (button) button.disabled = true;
  try {
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    showListenReportPreviewDialog(true);
    await updateListenReportPreviewImage();
  } catch (error) {
    console.warn('[ListenReportPreview]', error);
    if (typeof showToast === 'function') showToast('报告图片预览失败');
  } finally {
    if (button) button.disabled = false;
  }
}

function showListenReportPreviewDialog(show) {
  var mask = listenReportElement('listen-report-preview-mask');
  if (!mask) return;
  mask.classList.toggle('show', show === true);
  mask.setAttribute('aria-hidden', show === true ? 'false' : 'true');
  if (show === true) {
    var confirm = listenReportElement('listen-report-preview-confirm');
    if (confirm) setTimeout(function () { confirm.focus(); }, 0);
    return;
  }
  var image = listenReportElement('listen-report-preview-image');
  if (image) image.removeAttribute('src');
  listenReportViewState.previewRenderToken += 1;
  listenReportViewState.previewDataUrl = '';
  listenReportViewState.previewFileName = '';
}

async function confirmExportListenReportImage() {
  var dataUrl = listenReportViewState.previewDataUrl;
  var fileName = listenReportViewState.previewFileName;
  if (!dataUrl || !fileName) return;
  var button = listenReportElement('listen-report-preview-confirm');
  if (button) button.disabled = true;
  try {
    if (window.desktopWindow && typeof window.desktopWindow.exportPngFile === 'function') {
      var result = await window.desktopWindow.exportPngFile({ defaultName: fileName, dataUrl: dataUrl });
      if (result && result.canceled) return;
      if (!result || result.ok !== true) throw new Error(result && result.error || 'PNG_EXPORT_FAILED');
      showListenReportPreviewDialog(false);
      if (typeof showToast === 'function') showToast('报告图片已导出');
      return;
    }
    var link = document.createElement('a');
    link.download = fileName;
    link.href = dataUrl;
    link.click();
    showListenReportPreviewDialog(false);
    if (typeof showToast === 'function') showToast('报告图片已导出');
  } catch (error) {
    console.warn('[ListenReportExport]', error);
    if (typeof showToast === 'function') showToast('报告图片导出失败');
  } finally {
    if (button) button.disabled = false;
  }
}

function showListenReportClearDialog(show) {
  var mask = listenReportElement('listen-report-clear-mask');
  if (!mask) return;
  mask.classList.toggle('show', show === true);
  mask.setAttribute('aria-hidden', show === true ? 'false' : 'true');
  if (show === true) {
    var confirm = listenReportElement('listen-report-clear-confirm');
    if (confirm) setTimeout(function () { confirm.focus(); }, 0);
  }
}

async function confirmClearListenReportData() {
  var confirm = listenReportElement('listen-report-clear-confirm');
  if (confirm) confirm.disabled = true;
  try {
    var currentSong = null;
    var currentContext = null;
    if (listenSession) {
      currentSong = typeof currentCoverSong === 'function' ? currentCoverSong() : null;
      currentContext = listenSession.context || activeRadioContext;
      listenSession = null;
      if (currentSong) beginListenSession(currentSong, currentContext);
    }
    await clearListenStatsV3();
    try {
      localStorage.removeItem(HOME_LISTEN_STATS_KEY);
      localStorage.removeItem(HOME_LISTEN_ROLLUP_V2_KEY);
    } catch (_) { }
    listenStatsState = { history: [], songs: {}, artists: {}, updatedAt: Date.now() };
    showListenReportClearDialog(false);
    await refreshListenReportView(false);
    if (typeof renderHomeDashboard === 'function') renderHomeDashboard();
    if (typeof showToast === 'function') showToast('听歌统计已清空');
  } catch (error) {
    console.warn('[ListenReportClear]', error);
    if (typeof showToast === 'function') showToast('听歌统计清空失败');
  } finally {
    if (confirm) confirm.disabled = false;
  }
}

function bindListenReportControls() {
  if (bindListenReportControls.bound) return;
  bindListenReportControls.bound = true;
  var back = listenReportElement('listen-report-back');
  var tabs = listenReportElement('listen-report-mode-tabs');
  var select = listenReportElement('listen-report-period-select');
  var exportButton = listenReportElement('listen-report-export');
  var clearButton = listenReportElement('listen-report-clear');
  var clearCancel = listenReportElement('listen-report-clear-cancel');
  var clearConfirm = listenReportElement('listen-report-clear-confirm');
  var clearMask = listenReportElement('listen-report-clear-mask');
  var previewClose = listenReportElement('listen-report-preview-close');
  var previewCancel = listenReportElement('listen-report-preview-cancel');
  var previewConfirm = listenReportElement('listen-report-preview-confirm');
  var previewMask = listenReportElement('listen-report-preview-mask');
  var templatePicker = listenReportElement('listen-report-template-picker');
  var reportMask = listenReportElement('listen-report-view');
  if (back) back.addEventListener('click', closeListenReportView);
  if (tabs) tabs.addEventListener('click', function (event) {
    var button = event.target.closest('[data-listen-report-mode]');
    if (button) listenReportSetMode(button.getAttribute('data-listen-report-mode'));
  });
  if (select) select.addEventListener('change', function () { listenReportSetPeriod(select.value); });
  if (exportButton) exportButton.addEventListener('click', exportListenReportImage);
  if (clearButton) clearButton.addEventListener('click', function () { showListenReportClearDialog(true); });
  if (clearCancel) clearCancel.addEventListener('click', function () { showListenReportClearDialog(false); });
  if (clearConfirm) clearConfirm.addEventListener('click', confirmClearListenReportData);
  if (clearMask) clearMask.addEventListener('click', function (event) {
    if (event.target === clearMask) showListenReportClearDialog(false);
  });
  if (previewClose) previewClose.addEventListener('click', function () { showListenReportPreviewDialog(false); });
  if (previewCancel) previewCancel.addEventListener('click', function () { showListenReportPreviewDialog(false); });
  if (previewConfirm) previewConfirm.addEventListener('click', confirmExportListenReportImage);
  if (templatePicker) templatePicker.addEventListener('click', function (event) {
    var button = event.target.closest('[data-listen-report-template]');
    if (button) setListenReportPreviewTemplate(button.getAttribute('data-listen-report-template')).catch(function (error) {
      console.warn('[ListenReportTemplate]', error);
      if (typeof showToast === 'function') showToast('报告模板切换失败');
    });
  });
  if (previewMask) previewMask.addEventListener('click', function (event) {
    if (event.target === previewMask) showListenReportPreviewDialog(false);
  });
  if (reportMask) reportMask.addEventListener('click', function (event) {
    if (event.target === reportMask) closeListenReportView();
  });
  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    var mask = listenReportElement('listen-report-clear-mask');
    if (mask && mask.classList.contains('show')) {
      showListenReportClearDialog(false);
      return;
    }
    var preview = listenReportElement('listen-report-preview-mask');
    if (preview && preview.classList.contains('show')) {
      showListenReportPreviewDialog(false);
      return;
    }
    if (listenReportViewState.open) closeListenReportView();
  });
}

bindListenReportControls();
