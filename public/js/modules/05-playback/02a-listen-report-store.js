'use strict';

var LISTEN_STATS_V3_DB_NAME = 'mineradio-listen-stats-v3';
var LISTEN_STATS_V3_DB_VERSION = 1;
var LISTEN_STATS_V3_MONTH_STORE = 'months';
var LISTEN_STATS_V3_STARTED_AT_KEY = 'mineradio-listen-stats-v3-started-at';
var listenStatsV3DbPromise = null;
var listenStatsV3WriteQueue = Promise.resolve();

function listenStatsV3MonthKey(timestamp) {
  var date = new Date(Number(timestamp) || Date.now());
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0');
}

function listenStatsV3DayKey(timestamp) {
  var date = new Date(Number(timestamp) || Date.now());
  return listenStatsV3MonthKey(date.getTime()) + '-' + String(date.getDate()).padStart(2, '0');
}

function listenStatsV3StartedAt() {
  try {
    var value = Math.max(0, Number(localStorage.getItem(LISTEN_STATS_V3_STARTED_AT_KEY)) || 0);
    if (value) return value;
    value = Date.now();
    localStorage.setItem(LISTEN_STATS_V3_STARTED_AT_KEY, String(value));
    return value;
  } catch (_) {
    return Date.now();
  }
}

function listenStatsV3ResetStartedAt() {
  var value = Date.now();
  try { localStorage.setItem(LISTEN_STATS_V3_STARTED_AT_KEY, String(value)); } catch (_) { }
  return value;
}

function listenStatsV3OpenDb() {
  if (listenStatsV3DbPromise) return listenStatsV3DbPromise;
  listenStatsV3DbPromise = new Promise(function (resolve, reject) {
    if (!window.indexedDB) {
      reject(new Error('LISTEN_STATS_V3_INDEXEDDB_UNAVAILABLE'));
      return;
    }
    var request = window.indexedDB.open(LISTEN_STATS_V3_DB_NAME, LISTEN_STATS_V3_DB_VERSION);
    request.onupgradeneeded = function () {
      var db = request.result;
      if (!db.objectStoreNames.contains(LISTEN_STATS_V3_MONTH_STORE)) {
        db.createObjectStore(LISTEN_STATS_V3_MONTH_STORE, { keyPath: 'period' });
      }
    };
    request.onsuccess = function () { resolve(request.result); };
    request.onerror = function () {
      listenStatsV3DbPromise = null;
      reject(request.error || new Error('LISTEN_STATS_V3_DB_OPEN_FAILED'));
    };
  });
  return listenStatsV3DbPromise;
}

function listenStatsV3EmptyMonth(period) {
  return {
    version: 3,
    period: String(period || ''),
    totalListenMs: 0,
    sessions: 0,
    completed: 0,
    songs: {},
    artists: {},
    hours: Array(24).fill(0),
    days: {},
    firstRecordedAt: 0,
    lastRecordedAt: 0,
  };
}

function listenStatsV3NormalizeMonth(value, period) {
  value = value && typeof value === 'object' ? value : {};
  var normalized = listenStatsV3EmptyMonth(period || value.period);
  normalized.totalListenMs = Math.max(0, Number(value.totalListenMs) || 0);
  normalized.sessions = Math.max(0, Number(value.sessions) || 0);
  normalized.completed = Math.max(0, Number(value.completed) || 0);
  normalized.songs = value.songs && typeof value.songs === 'object' ? value.songs : {};
  normalized.artists = value.artists && typeof value.artists === 'object' ? value.artists : {};
  normalized.hours = Array.from({ length: 24 }, function (_, index) {
    return Math.max(0, Number(value.hours && value.hours[index]) || 0);
  });
  normalized.days = value.days && typeof value.days === 'object' ? value.days : {};
  normalized.firstRecordedAt = Math.max(0, Number(value.firstRecordedAt) || 0);
  normalized.lastRecordedAt = Math.max(0, Number(value.lastRecordedAt) || 0);
  return normalized;
}

function listenStatsV3IsMusicRecord(record) {
  record = record && typeof record === 'object' ? record : {};
  var kinds = [record.type, record.sourceType, record.itemType, record.kind, record.sourceKey, record.source, record.provider]
    .map(function (value) { return String(value || '').trim().toLowerCase(); })
    .filter(Boolean);
  var excluded = kinds.some(function (kind) {
    return /^(podcast|radio|program|dj|voice|播客|电台|节目|声音)$/.test(kind)
      || /(?:^|[-_:/\s])(podcast|(?:dj|radio|voice)[-_:/\s]?program|播客|电台节目|广播节目|声音节目)(?:$|[-_:/\s])/.test(kind);
  });
  if (excluded) return false;
  return !!(record.key || record.id || record.mid || record.hash || record.localKey || record.localPath || record.name);
}

function listenStatsV3SongKey(record) {
  record = record || {};
  var key = String(record.key || '').trim();
  if (key) return key.slice(0, 240);
  var provider = String(record.provider || record.sourceKey || record.source || record.type || 'song').trim().toLowerCase();
  var id = record.localKey || record.localPath || record.id || record.mid || record.hash || record.mixSongId || record.providerSongId;
  if (id) return (provider + ':' + String(id)).slice(0, 240);
  return (provider + ':' + String(record.name || '') + '|' + String(record.artist || '')).slice(0, 240);
}

function listenStatsV3ArtistNames(value) {
  var seen = Object.create(null);
  return String(value || '').split(/\s*\/\s*|\s*,\s*|、|&/).map(function (name) {
    return name.trim();
  }).filter(function (name) {
    var key = name.toLocaleLowerCase();
    if (!name || seen[key]) return false;
    seen[key] = true;
    return true;
  }).slice(0, 12);
}

function listenStatsV3SafeText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength || 240);
}

function listenStatsV3ArtistRefs(record) {
  record = record || {};
  var fallbackProvider = listenStatsV3SafeText(record.provider || record.sourceKey || record.source || record.type, 48);
  var refs = (Array.isArray(record.artistRefs) ? record.artistRefs : []).map(function (artist) {
    artist = artist && typeof artist === 'object' ? artist : {};
    return {
      name: listenStatsV3SafeText(artist.name, 180),
      id: listenStatsV3SafeText(artist.id, 180),
      mid: listenStatsV3SafeText(artist.mid, 180),
      provider: listenStatsV3SafeText(artist.provider || fallbackProvider, 48),
      avatar: typeof listenStatsSafeCover === 'function' ? listenStatsSafeCover(artist.avatar) : '',
    };
  }).filter(function (artist) { return artist.name; });
  if (refs.length) return refs.slice(0, 12);
  return listenStatsV3ArtistNames(record.artist).map(function (name) {
    return { name: name, id: '', mid: '', provider: fallbackProvider, avatar: '' };
  });
}

function listenStatsV3SongMeta(record) {
  var cover = typeof listenStatsSafeCover === 'function' ? listenStatsSafeCover(record.cover || record.sidecarCover) : '';
  return {
    key: listenStatsV3SongKey(record),
    name: listenStatsV3SafeText(record.name || '未知歌曲', 180),
    artist: listenStatsV3SafeText(record.artist, 240),
    artistRefs: listenStatsV3ArtistRefs(record),
    cover: cover,
    provider: listenStatsV3SafeText(record.provider || record.sourceKey || record.source || record.type, 48),
    type: listenStatsV3SafeText(record.type || 'song', 32),
    id: listenStatsV3SafeText(record.id || record.mid || record.hash || record.providerSongId, 180),
    localKey: listenStatsV3SafeText(record.localKey, 240),
    localPath: listenStatsV3SafeText(record.localPath, 520),
    listenMs: 0,
    plays: 0,
    completed: 0,
    lastPlayedAt: 0,
  };
}

function listenStatsV3EnsureSessionPeriod(session, timestamp) {
  if (!session.listenStatsV3Periods || typeof session.listenStatsV3Periods !== 'object') {
    session.listenStatsV3Periods = {};
  }
  var period = listenStatsV3MonthKey(timestamp);
  if (!session.listenStatsV3Periods[period]) {
    session.listenStatsV3Periods[period] = {
      listenMs: 0,
      hours: Array(24).fill(0),
      days: {},
    };
  }
  return session.listenStatsV3Periods[period];
}

function listenStatsV3EmptyContribution() {
  return {
    listenMs: 0,
    hours: Array(24).fill(0),
    days: {},
  };
}

function listenStatsV3RestoreContribution(session, period, contribution) {
  if (!session || !period) return;
  if (!session.listenStatsV3Periods || typeof session.listenStatsV3Periods !== 'object') {
    session.listenStatsV3Periods = {};
  }
  var target = session.listenStatsV3Periods[period] || listenStatsV3EmptyContribution();
  if (!target.days || typeof target.days !== 'object') target.days = {};
  target.listenMs += Math.max(0, Number(contribution && contribution.listenMs) || 0);
  target.hours = Array.from({ length: 24 }, function (_, index) {
    return Math.max(0, Number(target.hours && target.hours[index]) || 0)
      + Math.max(0, Number(contribution && contribution.hours && contribution.hours[index]) || 0);
  });
  Object.keys(contribution && contribution.days || {}).forEach(function (dayKey) {
    target.days[dayKey] = Math.max(0, Number(target.days[dayKey]) || 0)
      + Math.max(0, Number(contribution.days[dayKey]) || 0);
  });
  session.listenStatsV3Periods[period] = target;
}

function trackListenStatsV3Delta(session, timestamp, deltaMs) {
  if (!session || !(deltaMs > 0)) return;
  var date = new Date(Number(timestamp) || Date.now());
  var period = listenStatsV3EnsureSessionPeriod(session, date.getTime());
  var rounded = Math.max(0, Number(deltaMs) || 0);
  period.listenMs += rounded;
  period.hours[date.getHours()] = Math.max(0, Number(period.hours[date.getHours()]) || 0) + rounded;
  var dayKey = listenStatsV3DayKey(date.getTime());
  period.days[dayKey] = Math.max(0, Number(period.days[dayKey]) || 0) + rounded;
}

function listenStatsV3TakePendingPeriods(session) {
  var periods = session && session.listenStatsV3Periods && typeof session.listenStatsV3Periods === 'object'
    ? session.listenStatsV3Periods
    : {};
  session.listenStatsV3Periods = {};
  return periods;
}

function listenStatsV3PutContribution(db, periodKey, record, contribution, flags) {
  return new Promise(function (resolve, reject) {
    var transaction = db.transaction(LISTEN_STATS_V3_MONTH_STORE, 'readwrite');
    var store = transaction.objectStore(LISTEN_STATS_V3_MONTH_STORE);
    var request = store.get(periodKey);
    request.onsuccess = function () {
      var month = listenStatsV3NormalizeMonth(request.result, periodKey);
      var listenMs = Math.max(0, Math.round(Number(contribution.listenMs) || 0));
      var songKey = listenStatsV3SongKey(record);
      var song = month.songs[songKey] && typeof month.songs[songKey] === 'object'
        ? month.songs[songKey]
        : listenStatsV3SongMeta(record);
      var recordedAt = Math.max(0, Number(record.playedAt) || Date.now());

      month.totalListenMs += listenMs;
      month.sessions += flags.addSession ? 1 : 0;
      month.completed += flags.addCompleted ? 1 : 0;
      month.firstRecordedAt = month.firstRecordedAt ? Math.min(month.firstRecordedAt, recordedAt) : recordedAt;
      month.lastRecordedAt = Math.max(month.lastRecordedAt, recordedAt);
      month.hours = month.hours.map(function (value, index) {
        return Math.max(0, Number(value) || 0) + Math.max(0, Math.round(Number(contribution.hours && contribution.hours[index]) || 0));
      });
      Object.keys(contribution.days || {}).forEach(function (dayKey) {
        month.days[dayKey] = Math.max(0, Number(month.days[dayKey]) || 0) + Math.max(0, Math.round(Number(contribution.days[dayKey]) || 0));
      });

      var fresh = listenStatsV3SongMeta(record);
      song.name = fresh.name || song.name;
      song.artist = fresh.artist || song.artist;
      if (fresh.artistRefs.length) song.artistRefs = fresh.artistRefs;
      song.cover = fresh.cover || song.cover || '';
      song.provider = fresh.provider || song.provider || '';
      song.type = fresh.type || song.type || 'song';
      song.id = fresh.id || song.id || '';
      song.localKey = fresh.localKey || song.localKey || '';
      song.localPath = fresh.localPath || song.localPath || '';
      song.listenMs = Math.max(0, Number(song.listenMs) || 0) + listenMs;
      song.plays = Math.max(0, Number(song.plays) || 0) + (flags.addSession ? 1 : 0);
      song.completed = Math.max(0, Number(song.completed) || 0) + (flags.addCompleted ? 1 : 0);
      song.lastPlayedAt = Math.max(Number(song.lastPlayedAt) || 0, recordedAt);
      month.songs[songKey] = song;

      listenStatsV3ArtistRefs(record).forEach(function (freshArtist) {
        var name = freshArtist.name;
        var artistKey = name.toLocaleLowerCase();
        var artist = month.artists[artistKey] && typeof month.artists[artistKey] === 'object'
          ? month.artists[artistKey]
          : { name: name, id: '', mid: '', provider: '', avatar: '', listenMs: 0, plays: 0, completed: 0, lastPlayedAt: 0 };
        artist.name = name;
        artist.id = freshArtist.id || artist.id || '';
        artist.mid = freshArtist.mid || artist.mid || '';
        artist.provider = freshArtist.provider || artist.provider || '';
        artist.avatar = freshArtist.avatar || artist.avatar || '';
        artist.listenMs = Math.max(0, Number(artist.listenMs) || 0) + listenMs;
        artist.plays = Math.max(0, Number(artist.plays) || 0) + (flags.addSession ? 1 : 0);
        artist.completed = Math.max(0, Number(artist.completed) || 0) + (flags.addCompleted ? 1 : 0);
        artist.lastPlayedAt = Math.max(Number(artist.lastPlayedAt) || 0, recordedAt);
        month.artists[artistKey] = artist;
      });
      store.put(month);
    };
    request.onerror = function () { reject(request.error || new Error('LISTEN_STATS_V3_MONTH_READ_FAILED')); };
    transaction.oncomplete = function () { resolve(); };
    transaction.onerror = function () { reject(transaction.error || new Error('LISTEN_STATS_V3_MONTH_WRITE_FAILED')); };
    transaction.onabort = function () { reject(transaction.error || new Error('LISTEN_STATS_V3_MONTH_WRITE_ABORTED')); };
  });
}

function flushListenStatsV3Session(session, completed, force) {
  if (!session || !listenStatsV3IsMusicRecord(session.song || {})) return Promise.resolve(false);
  var eligible = completed === true || Number(session.listenMs) >= 45000 || Number(session.maxProgress) >= 0.5;
  if (!eligible && force !== true) return Promise.resolve(false);
  if (!eligible) return Promise.resolve(false);
  var periods = listenStatsV3TakePendingPeriods(session);
  var completionPeriod = completed === true ? listenStatsV3MonthKey(Date.now()) : '';
  var record = Object.assign({}, session.song || {}, {
    key: session.key || session.song && session.song.key || '',
    playedAt: Date.now(),
  });
  if (!session.listenStatsV3RecordedPeriods) session.listenStatsV3RecordedPeriods = {};
  if (!session.listenStatsV3CompletedPeriods) session.listenStatsV3CompletedPeriods = {};
  if (completionPeriod && !session.listenStatsV3CompletedPeriods[completionPeriod] && !periods[completionPeriod]) {
    periods[completionPeriod] = listenStatsV3EmptyContribution();
  }
  var periodKeys = Object.keys(periods).filter(function (period) {
    return periods[period] && (Number(periods[period].listenMs) > 0
      || (period === completionPeriod && !session.listenStatsV3CompletedPeriods[period]));
  });
  if (!periodKeys.length) return Promise.resolve(false);

  listenStatsV3WriteQueue = listenStatsV3WriteQueue.catch(function () { }).then(async function () {
    var extraPeriods = listenStatsV3TakePendingPeriods(session);
    Object.keys(extraPeriods).forEach(function (period) {
      listenStatsV3RestoreContribution({ listenStatsV3Periods: periods }, period, extraPeriods[period]);
    });
    if (completionPeriod && !session.listenStatsV3CompletedPeriods[completionPeriod] && !periods[completionPeriod]) {
      periods[completionPeriod] = listenStatsV3EmptyContribution();
    }
    periodKeys = Object.keys(periods).filter(function (period) {
      return periods[period] && (Number(periods[period].listenMs) > 0
        || (period === completionPeriod && !session.listenStatsV3CompletedPeriods[period]));
    });
    var processed = 0;
    try {
      var db = await listenStatsV3OpenDb();
      for (var index = 0; index < periodKeys.length; index++) {
        var period = periodKeys[index];
        var addSession = !session.listenStatsV3RecordedPeriods[period];
        var addCompleted = completed === true && period === completionPeriod && !session.listenStatsV3CompletedPeriods[period];
        await listenStatsV3PutContribution(db, period, record, periods[period], {
          addSession: addSession,
          addCompleted: addCompleted,
        });
        session.listenStatsV3RecordedPeriods[period] = true;
        if (addCompleted) session.listenStatsV3CompletedPeriods[period] = true;
        processed = index + 1;
      }
    } catch (error) {
      periodKeys.slice(processed).forEach(function (period) {
        listenStatsV3RestoreContribution(session, period, periods[period]);
      });
      throw error;
    }
    if (typeof refreshListenReportView === 'function' && typeof listenReportViewState !== 'undefined' && listenReportViewState.open) {
      refreshListenReportView(true);
    }
    return true;
  }).catch(function (error) {
    console.warn('[ListenStatsV3Write]', error);
    return false;
  });
  return listenStatsV3WriteQueue;
}

function recordListenStatsV3Tick(session, force) {
  if (!session) return Promise.resolve(false);
  var eligible = Number(session.listenMs) >= 45000 || Number(session.maxProgress) >= 0.5;
  if (!eligible) return Promise.resolve(false);
  var now = Date.now();
  if (force !== true && session.listenStatsV3LastFlushAt && now - session.listenStatsV3LastFlushAt < 15000) {
    return Promise.resolve(false);
  }
  session.listenStatsV3LastFlushAt = now;
  return flushListenStatsV3Session(session, false, false);
}

function recordListenStatsV3Final(session, completed) {
  return flushListenStatsV3Session(session, completed === true, false);
}

async function readListenStatsV3Months() {
  await listenStatsV3WriteQueue.catch(function () { });
  var db = await listenStatsV3OpenDb();
  return new Promise(function (resolve, reject) {
    var transaction = db.transaction(LISTEN_STATS_V3_MONTH_STORE, 'readonly');
    var request = transaction.objectStore(LISTEN_STATS_V3_MONTH_STORE).getAll();
    request.onsuccess = function () {
      resolve((request.result || []).map(function (month) {
        return listenStatsV3NormalizeMonth(month, month && month.period);
      }).sort(function (a, b) { return String(a.period).localeCompare(String(b.period)); }));
    };
    request.onerror = function () { reject(request.error || new Error('LISTEN_STATS_V3_READ_FAILED')); };
  });
}

function clearListenStatsV3() {
  listenStatsV3WriteQueue = listenStatsV3WriteQueue.catch(function () { }).then(function () {
    return listenStatsV3OpenDb();
  }).then(function (db) {
    return new Promise(function (resolve, reject) {
      var transaction = db.transaction(LISTEN_STATS_V3_MONTH_STORE, 'readwrite');
      transaction.objectStore(LISTEN_STATS_V3_MONTH_STORE).clear();
      transaction.oncomplete = function () { resolve(true); };
      transaction.onerror = function () { reject(transaction.error || new Error('LISTEN_STATS_V3_CLEAR_FAILED')); };
      transaction.onabort = function () { reject(transaction.error || new Error('LISTEN_STATS_V3_CLEAR_ABORTED')); };
    });
  }).then(function (result) {
    listenStatsV3ResetStartedAt();
    return result;
  });
  return listenStatsV3WriteQueue;
}

listenStatsV3StartedAt();
