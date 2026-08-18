// ====================================================================
//  粒子音乐可视化播放器 — Server v2
//  - 小云搜索 / 歌曲URL / 封面/音频代理
//  - 扫码登录 (login_qr_*) + cookie 持久化 (./.cookie)
//  - 试听检测 (freeTrialInfo) + 全 quality 探测
//  - 所有受保护 API 都会带上已登录用户的 cookie
// ====================================================================
const {
  search,
  cloudsearch,
  song_detail,
  song_url,
  song_url_v1,
  login_qr_key,
  login_qr_create,
  login_qr_check,
  login_status,
  vip_info,
  vip_info_v2,
  logout,
  user_account,
  user_playlist,
  comment_music,
  album,
  artist_detail,
  artist_top_song,
  artist_songs,
  like: like_song,
  likelist,
  song_like_check,
  album_sub,
  album_sublist,
  playlist_subscribe,
  comment,
  comment_like,
  listen_data_total,
  playlist_tracks,
  playlist_track_add,
  playlist_create,
  playlist_detail,
  playlist_track_all,
  personalized,
  recommend_resource,
  recommend_songs,
  dj_detail,
  dj_program,
  dj_hot,
  dj_sublist,
  user_audio,
  dj_paygift,
  record_recent_voice,
  sati_resource_sub_list,
  lyric,
  lyric_new,
  user_record,
  user_cloud,
  user_cloud_detail,
} = require('NeteaseCloudMusicApi');
const {
  scrobble: enhancedNeteaseScrobble,
  song_cloud_download: enhancedNeteaseCloudDownload,
  cloud_lyric_get: enhancedNeteaseCloudLyricGet,
} = require('@neteasecloudmusicapienhanced/api');
const http = require('http');
const https = require('https');
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const tls = require('tls');
const { once } = require('events');
const { fileURLToPath } = require('url');
const { analyzePodcastDjStream, analyzePodcastDjIntro } = require('./dj-analyzer');
const {
  normalizeQQVipPayload: normalizeQQVipPayloadStrict,
  resolveQQVipFromProbes,
  qqVipSessionCacheKey,
  qqVipCacheTtlMs,
  qqVipObjectLooksExpired: qqVipObjectLooksExpiredStrict,
} = require('./qq-vip-api');
const {
  handleKugouSearch,
  handleKugouSongUrl,
  handleKugouLyric,
  handleKugouGuessLike,
  handleKugouUserPlaylists,
  handleKugouPlaylistTracks,
  handleKugouLikeCheck,
  handleKugouLikeToggle,
  handleKugouPlaylistAddSong,
  getKugouLoginInfo,
  normalizeKugouCookieInput,
  kugouCookieHasPlayback,
  extractKugouAuth,
  kugouAudioReferer,
} = require('./kugou-api');
const PORT = process.env.PORT || 3000;
// 默认只监听回环：74 个 /api/* 端点没有逐个鉴权，绑 0.0.0.0 会把本地音乐流和
// 账号相关接口暴露给同一局域网内的任何设备。需要局域网遥控时显式设
// MINERADIO_HOST=0.0.0.0，此时非回环来源只能访问 /api/remote/*（见 requestIsLoopback）。
// 仍读旧的 HOST 以兼容既有启动脚本，但不再作为默认值。
const HOST = process.env.MINERADIO_HOST || process.env.HOST || '127.0.0.1';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DEFAULT_COOKIE_FILE = path.join(__dirname, '.cookie');
const DEFAULT_QQ_COOKIE_FILE = path.join(__dirname, '.qq-cookie');
const DEFAULT_KUGOU_COOKIE_FILE = path.join(__dirname, '.kugou-cookie');

const UPDATE_WORK_DIR = process.env.MINERADIO_UPDATE_DIR || path.join(__dirname, 'updates');
const UPDATE_DOWNLOAD_DIR = process.env.MINERADIO_UPDATE_DOWNLOAD_DIR || path.join(UPDATE_WORK_DIR, 'downloads');
const MUSIC_DOWNLOAD_DIR = process.env.MINERADIO_DOWNLOAD_DIR || path.join(__dirname, 'downloads');
const UPDATE_PATCH_BACKUP_DIR = process.env.MINERADIO_PATCH_BACKUP_DIR || path.join(UPDATE_WORK_DIR, 'backups', 'patches');
const DEFAULT_CACHE_ROOT = process.resourcesPath
  ? path.join(path.dirname(process.resourcesPath), 'MineradioCache')
  : path.join(__dirname, 'MineradioCache');
const BEATMAP_CACHE_DIR = process.env.MINERADIO_BEAT_CACHE_DIR || path.join(DEFAULT_CACHE_ROOT, 'beatmaps');
const LISTEN_SYNC_JOURNAL_FILE = process.env.MINERADIO_LISTEN_SYNC_FILE || path.join(__dirname, 'data', 'listen-sync-journal.json');
const LISTEN_SYNC_JOURNAL_LIMIT = 600;
const APP_PACKAGE = readPackageInfo();
const APP_VERSION = process.env.MINERADIO_VERSION || APP_PACKAGE.version || '1.3.3';
const UPDATE_CONFIG = readUpdateConfig(APP_PACKAGE);
const PATCH_MAX_BYTES = 12 * 1024 * 1024;
const PATCH_ALLOWED_ROOTS = new Set(['public', 'desktop', 'build']);
const PATCH_ALLOWED_FILES = new Set(['server.js', 'dj-analyzer.js', 'package.json', 'package-lock.json']);
const UPDATE_FALLBACK_NOTES = [
  '电影镜头节奏更松',
  '音源失败自动换源',
  '右上角更新提示',
];
const OPEN_METEO_FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const OPEN_METEO_GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const WEATHER_DEFAULT_LOCATION = {
  name: '广州',
  country: 'China',
  latitude: 23.1291,
  longitude: 113.2644,
  timezone: 'Asia/Shanghai',
};

// IP geolocation sources, tried in order. All but the last use https; ip-api is
// kept as a cleartext last resort because it is the one historically known to be
// reachable from mainland networks. Each source gets a short timeout so a dead
// one costs little before the chain moves on.
const WEATHER_IP_LOCATION_TIMEOUT_MS = 3500;
const WEATHER_IP_LOCATION_SOURCES = [
  {
    provider: 'ipwho.is',
    url: 'https://ipwho.is/',
    parse: (b) => (b && b.success !== false ? {
      city: b.city,
      region: b.region,
      country: b.country,
      latitude: b.latitude,
      longitude: b.longitude,
      timezone: b.timezone && b.timezone.id,
      ip: b.ip,
    } : null),
  },
  {
    // Direct host: freeipapi.com answers with a 302 here and requestText does not
    // follow redirects.
    provider: 'freeipapi.com',
    url: 'https://free.freeipapi.com/api/json',
    parse: (b) => (b ? {
      city: b.cityName,
      region: b.regionName,
      country: b.countryName,
      latitude: b.latitude,
      longitude: b.longitude,
      timezone: Array.isArray(b.timeZones) ? b.timeZones[0] : b.timeZone,
      ip: b.ipAddress,
    } : null),
  },
  {
    provider: 'ip-api',
    url: 'http://ip-api.com/json/?fields=status,message,country,regionName,city,lat,lon,timezone,query&lang=zh-CN',
    parse: (b) => (b && b.status === 'success' ? {
      city: b.city,
      region: b.regionName,
      country: b.country,
      latitude: b.lat,
      longitude: b.lon,
      timezone: b.timezone,
      ip: b.query,
    } : null),
  },
];
const WEATHER_IP_LOCATION_CACHE_TTL_MS = 10 * 60 * 1000;
let weatherIpLocationCache = null;

const updateDownloadJobs = new Map();

// Local-library files are exposed through opaque, process-local ids. The
// renderer never receives a file:// URL, and callers cannot turn this route
// into an arbitrary filesystem reader by guessing a path.
const localMediaIndex = new Map();
const localMediaPathIds = new Map();

function registerLocalMediaPath(filePath) {
  const target = path.resolve(String(filePath || ''));
  if (!target) return '';
  let id = localMediaPathIds.get(target);
  if (!id) {
    id = crypto.randomBytes(18).toString('base64url');
    localMediaPathIds.set(target, id);
  }
  localMediaIndex.set(id, target);
  return id;
}

async function streamRegisteredLocalMedia(req, res, target) {
  let stat;
  try {
    stat = await fs.promises.stat(target);
  } catch (_) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  // The await above yields the event loop, so the client may have gone away
  // (seek, skip, window closed) before we get here.
  if (res.destroyed || res.writableEnded) return;
  if (!stat.isFile()) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  let start = 0;
  let end = Math.max(0, stat.size - 1);
  let status = 200;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(req.headers.range || '');
  if (match) {
    start = match[1] ? Math.max(0, Number(match[1])) : 0;
    end = match[2] ? Math.min(end, Number(match[2])) : end;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= stat.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      res.end();
      return;
    }
    status = 206;
  }

  const headers = {
    'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
    'Content-Length': String(Math.max(0, end - start + 1)),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600',
    'Access-Control-Allow-Origin': '*',
  };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(target, { start, end }).on('error', () => res.destroy()).pipe(res);
}

function loadListenSyncJournal() {
  try {
    const parsed = JSON.parse(fs.readFileSync(LISTEN_SYNC_JOURNAL_FILE, 'utf8'));
    const entries = parsed && parsed.entries && typeof parsed.entries === 'object' ? parsed.entries : {};
    return { version: 1, entries };
  } catch (_) {
    return { version: 1, entries: {} };
  }
}

let listenSyncJournal = loadListenSyncJournal();

function listenSyncAccountKey(provider, credential) {
  return String(provider || '') + ':' + crypto.createHash('sha256').update(String(credential || '')).digest('hex').slice(0, 16);
}

function listenSyncJournalKey(provider, credential, sessionId) {
  return listenSyncAccountKey(provider, credential) + ':' + String(sessionId || '');
}

const LISTEN_SYNC_JOURNAL_FLUSH_DELAY_MS = 1500;
let listenSyncJournalFlushTimer = null;
let listenSyncJournalDirty = false;

function trimListenSyncJournal() {
  const entries = Object.entries(listenSyncJournal.entries || {})
    .sort((a, b) => Number(b[1] && b[1].submittedAt || 0) - Number(a[1] && a[1].submittedAt || 0))
    .slice(0, LISTEN_SYNC_JOURNAL_LIMIT);
  listenSyncJournal.entries = Object.fromEntries(entries);
}

function listenSyncJournalPaths() {
  return {
    dir: path.dirname(LISTEN_SYNC_JOURNAL_FILE),
    temp: LISTEN_SYNC_JOURNAL_FILE + '.tmp-' + process.pid,
  };
}

// A single track reports several times (startplay, progress, finish), so writing
// the whole journal on each call meant repeated multi-KB sync writes on the
// request path. Coalesce them and write off the hot path; flushListenSyncJournalSync
// guarantees durability when the process is going away.
function persistListenSyncJournal() {
  trimListenSyncJournal();
  listenSyncJournalDirty = true;
  if (listenSyncJournalFlushTimer) return;
  listenSyncJournalFlushTimer = setTimeout(() => {
    listenSyncJournalFlushTimer = null;
    const payload = JSON.stringify(listenSyncJournal, null, 2);
    listenSyncJournalDirty = false;
    const { dir, temp } = listenSyncJournalPaths();
    fs.promises.mkdir(dir, { recursive: true })
      .then(() => fs.promises.writeFile(temp, payload, 'utf8'))
      .then(() => fs.promises.rename(temp, LISTEN_SYNC_JOURNAL_FILE))
      .catch((err) => {
        listenSyncJournalDirty = true;
        console.warn('[ListenSyncJournal] deferred write failed:', err.message);
      });
  }, LISTEN_SYNC_JOURNAL_FLUSH_DELAY_MS);
  if (listenSyncJournalFlushTimer.unref) listenSyncJournalFlushTimer.unref();
}

function flushListenSyncJournalSync() {
  if (listenSyncJournalFlushTimer) {
    clearTimeout(listenSyncJournalFlushTimer);
    listenSyncJournalFlushTimer = null;
  }
  if (!listenSyncJournalDirty) return;
  try {
    const { dir, temp } = listenSyncJournalPaths();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(temp, JSON.stringify(listenSyncJournal, null, 2), 'utf8');
    fs.renameSync(temp, LISTEN_SYNC_JOURNAL_FILE);
    listenSyncJournalDirty = false;
  } catch (err) {
    console.warn('[ListenSyncJournal] flush failed:', err.message);
  }
}

process.on('exit', flushListenSyncJournalSync);

function rememberListenSyncSubmission(key, result) {
  listenSyncJournal.entries[key] = {
    provider: result.provider,
    songId: String(result.songId || ''),
    sourceId: String(result.sourceId || ''),
    listenSeconds: Math.max(0, Number(result.listenSeconds) || 0),
    platformCode: Number(result.platformCode) || 0,
    reporter: String(result.reporter || ''),
    startplayCode: Number(result.startplayCode) || 0,
    playCode: Number(result.playCode) || 0,
    submittedAt: Date.now(),
    accountDurationSync: result.accountDurationSync || 'unsupported',
    historySynced: !!result.historySynced,
  };
  try {
    persistListenSyncJournal();
  } catch (err) {
    console.warn('[ListenSyncJournal]', err.message);
  }
}

function applySystemCertificateAuthorities() {
  try {
    if (typeof tls.getCACertificates !== 'function' || typeof tls.setDefaultCACertificates !== 'function') return;
    const bundled = tls.getCACertificates('default') || [];
    const system = tls.getCACertificates('system') || [];
    if (!system.length) return;
    const seen = new Set();
    const merged = [];
    bundled.concat(system).forEach(cert => {
      if (!cert || seen.has(cert)) return;
      seen.add(cert);
      merged.push(cert);
    });
    if (merged.length > bundled.length) tls.setDefaultCACertificates(merged);
  } catch (e) {
    console.warn('[TLS] system CA merge skipped:', e.message);
  }
}

applySystemCertificateAuthorities();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
  '.svg':  'image/svg+xml',
  '.mp3':  'audio/mpeg',
  '.flac': 'audio/flac',
  '.wav':  'audio/wav',
  '.ogg':  'audio/ogg',
  '.opus': 'audio/ogg',
  '.m4a':  'audio/mp4',
  '.mp4':  'audio/mp4',
  '.aac':  'audio/aac',
  '.webm': 'audio/webm',
};

// ---------- Cookie 持久化 ----------
const COOKIE_ATTRIBUTE_NAMES = new Set(['path', 'domain', 'expires', 'max-age', 'samesite', 'secure', 'httponly']);
function collectCookiePair(picked, key, value) {
  key = String(key || '').trim();
  if (!key || COOKIE_ATTRIBUTE_NAMES.has(key.toLowerCase())) return;
  if (value === null || value === undefined) return;
  picked.set(key, String(value).trim());
}
function collectCookieInput(input, picked) {
  if (input === null || input === undefined) return;
  if (Array.isArray(input)) {
    input.forEach(item => collectCookieInput(item, picked));
    return;
  }
  if (typeof input === 'object') {
    if (input.name && Object.prototype.hasOwnProperty.call(input, 'value')) {
      collectCookiePair(picked, input.name, input.value);
      return;
    }
    Object.keys(input).forEach(key => {
      const value = input[key];
      if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'value')) {
        collectCookiePair(picked, key, value.value);
      } else if (typeof value !== 'object') {
        collectCookiePair(picked, key, value);
      }
    });
    return;
  }
  String(input).split(/\r?\n/).forEach(line => {
    line.split(';').forEach(part => {
      const raw = String(part || '').trim();
      const idx = raw.indexOf('=');
      if (idx <= 0) return;
      collectCookiePair(picked, raw.slice(0, idx), raw.slice(idx + 1));
    });
  });
}
function normalizeCookieHeader(input) {
  const picked = new Map();
  collectCookieInput(input, picked);
  return Array.from(picked.entries())
    .filter(([key, value]) => key && value != null && String(value) !== '')
    .map(([key, value]) => `${key}=${value}`)
    .join('; ');
}
function rawCookieFallback(input) {
  if (typeof input === 'string') return input.trim();
  if (Array.isArray(input) && input.every(item => typeof item === 'string')) return input.join('; ').trim();
  return '';
}
function getCookieFile() {
  return process.env.COOKIE_FILE || DEFAULT_COOKIE_FILE;
}
function getQQCookieFile() {
  return process.env.QQ_COOKIE_FILE || DEFAULT_QQ_COOKIE_FILE;
}
function getKugouCookieFile() {
  return process.env.KUGOU_COOKIE_FILE || DEFAULT_KUGOU_COOKIE_FILE;
}
function readConfiguredCookieFile(file) {
  try {
    if (file && fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  } catch (_) {}
  return '';
}
function writeConfiguredCookieFile(file, value) {
  try {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, String(value || ''), 'utf8');
  } catch (_) {}
}
const configuredCookieStores = {
  netease: { file: '', value: '', getFile: getCookieFile },
  qq: { file: '', value: '', getFile: getQQCookieFile },
  kugou: { file: '', value: '', getFile: getKugouCookieFile },
};
function refreshConfiguredCookieStore(store, force) {
  const file = store.getFile();
  if (force || store.file !== file) {
    store.file = file;
    store.value = readConfiguredCookieFile(file);
  }
  return store.value;
}
function saveConfiguredCookieStore(store, value) {
  const file = store.getFile();
  store.file = file;
  store.value = String(value || '');
  writeConfiguredCookieFile(file, store.value);
  return store.value;
}
let userCookie = '';
function saveCookie(c) {
  userCookie = saveConfiguredCookieStore(configuredCookieStores.netease, normalizeCookieHeader(c) || rawCookieFallback(c));
  clearNeteaseLoginInfoCache();
}

let qqCookie = '';
function saveQQCookie(c) {
  qqCookie = saveConfiguredCookieStore(configuredCookieStores.qq, normalizeCookieHeader(c) || rawCookieFallback(c));
  qqVipInfoCache.clear();
  clearQQLikedPlaylistCoverCache();
}

let kugouCookie = '';
function saveKugouCookie(c) {
  kugouCookie = saveConfiguredCookieStore(configuredCookieStores.kugou, normalizeCookieHeader(c) || rawCookieFallback(c));
}

function refreshConfiguredCookieStores(force) {
  userCookie = refreshConfiguredCookieStore(configuredCookieStores.netease, force);
  qqCookie = refreshConfiguredCookieStore(configuredCookieStores.qq, force);
  kugouCookie = refreshConfiguredCookieStore(configuredCookieStores.kugou, force);
}
function refreshQQConfiguredCookieStore(force) {
  qqCookie = refreshConfiguredCookieStore(configuredCookieStores.qq, force);
  return qqCookie;
}
refreshConfiguredCookieStores(true);

function clearAllRuntimeLoginCredentials(reason) {
  userCookie = '';
  qqCookie = '';
  kugouCookie = '';
  Object.keys(configuredCookieStores).forEach((key) => {
    configuredCookieStores[key].value = '';
  });
  clearNeteaseLoginInfoCache();
  qqVipInfoCache.clear();
  clearQQLikedPlaylistCoverCache();
  return {
    ok: true,
    reason: String(reason || 'login-reset'),
  };
}

// ---------- 工具 ----------
function serveStatic(res, filePath) {
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'text/plain',
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    });
    res.end(data);
  });
}

// index-loader 必须在 DOMContentLoaded 前同步注入模块（有两个模块直接监听该事件，
// 改异步会让它们静默失效）。旧实现为此让浏览器同步请求 110 个文件，冷启动时会
// 卡到 loadURL 的 15s 上限。模块顺序仍只维护在 index-loader.js；服务端读同一份名单，
// 并行读盘后按原顺序拼成一次响应，把 110 次浏览器往返收成一次。
function indexModulePathsFromLoader(loaderText) {
  const declaration = /const\s+modulePaths\s*=\s*\[([\s\S]*?)\];/.exec(String(loaderText || ''));
  if (!declaration) throw new Error('INDEX_MODULE_PATHS_MISSING');
  const paths = [];
  const literal = /'([^'\\]*(?:\\.[^'\\]*)*)'/g;
  let match;
  while ((match = literal.exec(declaration[1]))) paths.push(match[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\'));
  if (!paths.length) throw new Error('INDEX_MODULE_PATHS_EMPTY');
  return paths;
}

async function serveIndexModulesBundle(res) {
  try {
    const publicDir = path.join(__dirname, 'public');
    const loaderText = await fs.promises.readFile(path.join(publicDir, 'js', 'index-loader.js'), 'utf8');
    const modulePaths = indexModulePathsFromLoader(loaderText);
    const modules = await Promise.all(modulePaths.map(async (relativePath) => {
      const normalized = String(relativePath || '').replace(/\\/g, '/');
      if (!normalized || normalized.startsWith('/') || normalized.includes('../')) throw new Error('INDEX_MODULE_PATH_INVALID');
      const absolutePath = path.resolve(publicDir, normalized);
      if (absolutePath !== publicDir && !absolutePath.startsWith(publicDir + path.sep)) throw new Error('INDEX_MODULE_PATH_OUTSIDE_PUBLIC');
      return fs.promises.readFile(absolutePath, 'utf8');
    }));
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    });
    res.end(modules.join('\n;\n') + '\n//# sourceURL=mineradio-index-modules.js\n');
  } catch (error) {
    console.error('[StartupBundle]', error && (error.stack || error.message || error));
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('Failed to build startup module bundle');
  }
}
// 这里以前固定发 Access-Control-Allow-Origin: *，等于允许任何网页跨站读取账号态、
// 歌单、听歌数据 —— 服务只绑回环挡不住这类攻击，因为恶意页面的 JS 就跑在本机浏览器里，
// 127.0.0.1 对它完全可达。去掉之后 sendJSON 和 sendPrivateJSON 等价，直接转发，
// 免得两份响应头各自漂移。媒体流（本地音乐、音频代理、封面代理）另有自己的 CORS 头，
// 那是 <audio> 和 canvas 取像素必需的，不走这里。
function sendJSON(res, data, status) {
  sendPrivateJSON(res, data, status);
}
function sendPrivateJSON(res, data, status) {
  res.writeHead(status || 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
  });
  res.end(JSON.stringify(data));
}
function sendText(res, text, status) {
  res.writeHead(status || 200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
  });
  res.end(String(text == null ? '' : text));
}
// 只有回环来源算「本机」。IPv6 映射形式（::ffff:127.0.0.1）和 ::1 都要认，
// 否则 Windows 上双栈监听时本机请求会被误判成外部来源。
function requestIsLoopback(req) {
  // 遥控监听器绑在 0.0.0.0 上，它上面的请求一律不算本机 —— 否则本机回环连到
  // 遥控端口就能访问管理面，把「管理面只服务本机」这层降级成「谁能连上都算本机」。
  if (req && req.__mineradioForceRemote === true) return false;
  const raw = String((req && req.socket && req.socket.remoteAddress) || '');
  if (!raw) return false;
  const addr = raw.replace(/^::ffff:/i, '');
  return addr === '127.0.0.1' || addr === '::1' || addr.startsWith('127.');
}
function requestHasTrustedLocalOrigin(req) {
  if (!requestIsLoopback(req)) return false;
  const fetchSite = String((req && req.headers && req.headers['sec-fetch-site']) || '').toLowerCase();
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return false;
  const rawOrigin = String((req && req.headers && req.headers.origin) || '').trim();
  // Native clients and local regression tests do not send Origin. Browsers do send it for
  // cross-origin fetch/form POSTs, which is the caller class this guard must distinguish.
  if (!rawOrigin) return true;
  try {
    const origin = new URL(rawOrigin);
    const host = String(origin.hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
    const port = Number(origin.port || (origin.protocol === 'http:' ? 80 : 0));
    return origin.protocol === 'http:'
      && (host === '127.0.0.1' || host === 'localhost' || host === '::1')
      && port === mainBoundPort();
  } catch (_) {
    return false;
  }
}
function requireTrustedLocalManagementRequest(req, res) {
  if (!requestIsLoopback(req)) {
    sendPrivateJSON(res, { ok: false, error: 'LOOPBACK_ONLY' }, 403);
    return false;
  }
  if (!requestHasTrustedLocalOrigin(req)) {
    sendPrivateJSON(res, { ok: false, error: 'LOCAL_ORIGIN_FORBIDDEN' }, 403);
    return false;
  }
  return true;
}
function requireJSONRequest(req, res) {
  const type = String((req && req.headers && req.headers['content-type']) || '')
    .split(';', 1)[0].trim().toLowerCase();
  if (type === 'application/json') return true;
  sendPrivateJSON(res, { ok: false, error: 'JSON_CONTENT_TYPE_REQUIRED' }, 415);
  return false;
}
// 诊断和遥控数据不能跟着 DEFAULT_CACHE_ROOT：那个值在 Electron 下解析到
// node_modules/electron/dist/MineradioCache（npm install 或升级 Electron 会整个删掉重建），
// 裸跑 node 时又解析到项目根目录 —— 同一台机器两个位置，数据看起来会「凭空消失」。
// 这两类数据要长期累积，固定放项目/安装目录旁边的 MineradioCache。
const STABLE_CACHE_ROOT = path.join(__dirname, 'MineradioCache');
const DIAGNOSTICS_DIR = process.env.MINERADIO_DIAG_DIR || path.join(STABLE_CACHE_ROOT, 'diagnostics');
const STALL_LOG_FILE = path.join(DIAGNOSTICS_DIR, 'stall.jsonl');
const STALL_LOG_MAX_LINES = 500;
const STALL_LOG_MAX_BYTES = 1024 * 1024;

// ====================================================================
//  局域网遥控：配对鉴权
// ====================================================================
// 配对码只有 6 位数字（100 万组合），局域网内高速爆破是几分钟的事，
// 所以「限速 + 失败即废码」是这套机制的必要条件，不是可选加固。
const REMOTE_DIR = process.env.MINERADIO_REMOTE_DIR || path.join(STABLE_CACHE_ROOT, 'remote');
const REMOTE_TOKEN_FILE = path.join(REMOTE_DIR, 'remote-tokens.json');
const REMOTE_PAIRING_TTL_MS = 10 * 60 * 1000;
const REMOTE_PAIRING_MAX_FAILURES = 5;
const REMOTE_TOKEN_LIMIT = 16;
const REMOTE_STATE_STALE_MS = 8000;

const remoteAuth = {
  code: '',
  issuedAt: 0,
  failures: 0,
  tokens: new Map(),
  loaded: false,
  lastLockoutAt: 0,
  preferredPort: 0,
};

function normalizeRemoteListenerPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 1024 && port <= 65535 ? port : 0;
}

function generateRemotePairingCode() {
  // 用 CSPRNG 而不是 Math.random：配对码是这套鉴权唯一的准入凭据。
  // 取模到 900000 再加 100000，保证恒为 6 位且不以 0 开头。
  return String(100000 + (crypto.randomBytes(4).readUInt32BE(0) % 900000));
}

function rotateRemotePairingCode(reason) {
  remoteAuth.code = generateRemotePairingCode();
  remoteAuth.issuedAt = Date.now();
  remoteAuth.failures = 0;
  // 只有用户显式换码才消掉「被爆破过」的提示。自动补码（过期/配对后）不能消，
  // 否则那条提示会在下一次读取时立刻被抹掉，用户永远看不到。
  if (reason === 'requested') remoteAuth.lastLockoutAt = 0;
  if (reason) console.log('[Remote] pairing code issued:', reason);
  return remoteAuth.code;
}

// 配对码只在用户主动要求时存在。配对成功、撤销设备、过期后都清空而不是换新：
// 界面上挂着一个没人需要的码，它每次静默轮换都像是随机在变，而且屏幕上显示的
// 码随时可能已经失效 —— 扫了也配不上，还查不出原因。
function clearRemotePairingCode(reason) {
  if (!remoteAuth.code) return;
  remoteAuth.code = '';
  remoteAuth.issuedAt = 0;
  remoteAuth.failures = 0;
  // 因爆破被作废这件事必须能跨清空活下来告诉用户 —— 否则码只是「消失了」，
  // 用户不知道刚有人在猜他的配对码。生成新码时才清掉这个标记。
  if (reason === 'locked-out') remoteAuth.lastLockoutAt = Date.now();
  if (reason) console.log('[Remote] pairing code cleared:', reason);
}

function remotePairingExpiresInMs() {
  if (!remoteAuth.code) return 0;
  return Math.max(0, REMOTE_PAIRING_TTL_MS - (Date.now() - remoteAuth.issuedAt));
}

function remotePairingUsable() {
  return !!remoteAuth.code
    && remotePairingExpiresInMs() > 0
    && remoteAuth.failures < REMOTE_PAIRING_MAX_FAILURES;
}

// 二维码常驻显示，所以屏幕上的码必须永远是能用的：缺码或已过期就地补一个。
// 「静默换码让人困惑」这个问题不靠隐藏码来解决,而是靠界面明确写出
// 「配对成功后自动换码」+ 倒计时,让轮换变成预期行为而不是意外。
function readRemotePairingCodeState() {
  if (remoteAuth.code && !remotePairingUsable()) {
    clearRemotePairingCode(remoteAuth.failures >= REMOTE_PAIRING_MAX_FAILURES ? 'locked-out' : 'expired');
  }
  if (!remoteAuth.code) rotateRemotePairingCode('auto');
  return {
    code: remoteAuth.code,
    hasCode: true,
    expiresInMs: remotePairingExpiresInMs(),
  };
}

async function loadRemoteTokens() {
  if (remoteAuth.loaded) return;
  remoteAuth.loaded = true;
  try {
    const raw = await fs.promises.readFile(REMOTE_TOKEN_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    remoteAuth.preferredPort = normalizeRemoteListenerPort(parsed && parsed.preferredPort);
    const list = Array.isArray(parsed && parsed.tokens) ? parsed.tokens : [];
    list.forEach((entry) => {
      const token = String((entry && entry.token) || '');
      if (token.length < 32) return;
      remoteAuth.tokens.set(token, {
        token,
        label: String((entry && entry.label) || '设备').slice(0, 60),
        pairedAt: Number(entry && entry.pairedAt) || Date.now(),
        lastSeenAt: Number(entry && entry.lastSeenAt) || 0,
      });
    });
  } catch (err) {
    if (err && err.code !== 'ENOENT') console.warn('[Remote] token store read failed:', err.message);
  }
}

async function saveRemoteTokens() {
  try {
    await fs.promises.mkdir(REMOTE_DIR, { recursive: true });
    const payload = JSON.stringify({
      preferredPort: normalizeRemoteListenerPort(remoteAuth.preferredPort),
      tokens: Array.from(remoteAuth.tokens.values()),
    }, null, 2);
    const tmp = REMOTE_TOKEN_FILE + '.tmp';
    await fs.promises.writeFile(tmp, payload, 'utf8');
    await fs.promises.rename(tmp, REMOTE_TOKEN_FILE);
  } catch (err) {
    console.warn('[Remote] token store write failed:', err.message);
  }
}

// 定长比较：token 比对必须避免因提前返回而泄露前缀匹配长度。
function safeTokenEqual(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function extractRemoteToken(req, url) {
  const header = req && req.headers ? String(req.headers['x-mineradio-token'] || '') : '';
  if (header) return header.trim();
  const query = url && url.searchParams ? String(url.searchParams.get('token') || '') : '';
  return query.trim();
}

async function authorizeRemoteRequest(req, url) {
  await loadRemoteTokens();
  const presented = extractRemoteToken(req, url);
  if (!presented) return null;
  for (const entry of remoteAuth.tokens.values()) {
    if (safeTokenEqual(entry.token, presented)) {
      entry.lastSeenAt = Date.now();
      return entry;
    }
  }
  return null;
}

async function pairRemoteDevice(body, req) {
  await loadRemoteTokens();
  const submitted = String((body && body.code) || '').replace(/\D/g, '');
  if (!remoteAuth.code) return { ok: false, error: 'PAIRING_CODE_UNAVAILABLE' };
  if (remoteAuth.failures >= REMOTE_PAIRING_MAX_FAILURES) {
    return { ok: false, error: 'PAIRING_LOCKED', message: '尝试次数过多，请在电脑上重新生成配对码' };
  }
  if (remotePairingExpiresInMs() <= 0) {
    return { ok: false, error: 'PAIRING_CODE_EXPIRED', message: '配对码已过期，请在电脑上重新生成' };
  }
  if (submitted.length !== 6 || !safeTokenEqual(submitted, remoteAuth.code)) {
    remoteAuth.failures += 1;
    const locked = remoteAuth.failures >= REMOTE_PAIRING_MAX_FAILURES;
    if (locked) console.warn('[Remote] pairing locked after repeated failures');
    return {
      ok: false,
      error: locked ? 'PAIRING_LOCKED' : 'PAIRING_CODE_INVALID',
      remainingAttempts: Math.max(0, REMOTE_PAIRING_MAX_FAILURES - remoteAuth.failures),
    };
  }
  const token = crypto.randomBytes(32).toString('hex');
  const entry = {
    token,
    label: String((body && body.label) || '').slice(0, 60)
      || `设备 ${String((req && req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/i, '') || '未知'}`,
    pairedAt: Date.now(),
    lastSeenAt: Date.now(),
  };
  remoteAuth.tokens.set(token, entry);
  // 超出上限时先淘汰最久未活跃的设备，避免 token 无限累积。
  if (remoteAuth.tokens.size > REMOTE_TOKEN_LIMIT) {
    const sorted = Array.from(remoteAuth.tokens.values()).sort((a, b) => a.lastSeenAt - b.lastSeenAt);
    while (remoteAuth.tokens.size > REMOTE_TOKEN_LIMIT) {
      const victim = sorted.shift();
      if (!victim) break;
      remoteAuth.tokens.delete(victim.token);
    }
  }
  // 配对成功即换新码：一个码只换一台设备，旧二维码截图立即失效。
  // 直接换而不是清空，二维码常驻显示时不会出现一段「没有码」的空窗。
  rotateRemotePairingCode('paired');
  await saveRemoteTokens();
  return { ok: true, token, label: entry.label };
}

async function revokeRemoteTokens() {
  await loadRemoteTokens();
  const removed = remoteAuth.tokens.size;
  remoteAuth.tokens.clear();
  await saveRemoteTokens();
  // 撤销后立刻换新码：旧码可能已被截图流出，而且界面上的二维码要保持可用。
  rotateRemotePairingCode('revoked');
  return { ok: true, removed };
}

// 虚拟网卡命名在各产品/各语言下差别很大（Windows 的 Hyper-V 交换机就叫
// `vEthernet (Default Switch)`，不含 "hyper-v" 字样），所以名字匹配只能当辅助信号。
const VIRTUAL_ADAPTER_PATTERN = /vethernet|hyper-?v|vmware|virtualbox|vbox|wsl|docker|tailscale|zerotier|tap-?windows|openvpn|wintun|bluetooth|npcap|loopback|radmin|parallels|utun/i;

// 主信号：问内核「往公网发包时会选哪个源地址」。UDP connect 只写本地路由表、
// 不发任何数据包，但结果就是操作系统的真实选路，比猜网卡名可靠得多。
function detectPrimaryLanAddress() {
  return new Promise((resolve) => {
    let settled = false;
    let socket = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try { if (socket) socket.close(); } catch (_) {}
      resolve(value);
    };
    try {
      socket = require('dgram').createSocket('udp4');
      socket.once('error', () => finish(''));
      // 8.8.8.8 只用于让内核做选路判断，不会真的发包。
      socket.connect(53, '8.8.8.8', () => {
        try { finish(socket.address().address || ''); }
        catch (_) { finish(''); }
      });
    } catch (_) {
      finish('');
    }
    setTimeout(() => finish(''), 400);
  });
}

async function listRemoteLanAddresses() {
  const primary = await detectPrimaryLanAddress();
  const groups = os.networkInterfaces();
  const out = [];
  Object.keys(groups).forEach((name) => {
    (groups[name] || []).forEach((info) => {
      if (info.family !== 'IPv4' && info.family !== 4) return;
      if (info.internal) return;
      const likelyVirtual = VIRTUAL_ADAPTER_PATTERN.test(name);
      out.push({
        name,
        address: info.address,
        likelyVirtual,
        // 内核选中的出网地址就是手机该连的那个：手机和电脑在同一个路由器下，
        // 走的是同一张网卡。
        primary: !!primary && info.address === primary,
      });
    });
  });
  // primary 优先，其次非虚拟，最后按 192.168.* 这类家用网段靠前。
  out.sort((a, b) => {
    if (a.primary !== b.primary) return a.primary ? -1 : 1;
    if (a.likelyVirtual !== b.likelyVirtual) return a.likelyVirtual ? 1 : -1;
    const homeA = /^192\.168\./.test(a.address) ? 0 : 1;
    const homeB = /^192\.168\./.test(b.address) ? 0 : 1;
    if (homeA !== homeB) return homeA - homeB;
    return a.address.localeCompare(b.address);
  });
  return out;
}

// 遥控状态由渲染进程推来（它才持有播放状态），服务端只做缓存 + 陈旧判断。
const REMOTE_COVER_MAX_BYTES = 6 * 1024 * 1024;
const remoteStateCache = { payload: null, updatedAt: 0, coverUrl: '', coverData: '' };
function storeRemoteState(body) {
  // 封面来源留在服务端，不随状态下发：data URL 可能几百 KB，每秒轮询都带上
  // 会把手机流量和主线程一起吃掉。手机只拿到一个带版本号的相对地址。
  remoteStateCache.coverUrl = String((body && body.coverUrl) || '').slice(0, 2000);
  remoteStateCache.coverData = /^data:image\//i.test(String((body && body.coverData) || ''))
    ? String(body.coverData).slice(0, REMOTE_COVER_MAX_BYTES)
    : '';
  remoteStateCache.payload = {
    title: String((body && body.title) || '').slice(0, 200),
    artist: String((body && body.artist) || '').slice(0, 200),
    playing: (body && body.playing) === true,
    volume: Math.max(0, Math.min(1, Number(body && body.volume) || 0)),
    muted: (body && body.muted) === true,
    lyricsEnabled: (body && body.lyricsEnabled) === true,
    currentTime: Number.isFinite(Number(body && body.currentTime)) ? Number(body.currentTime) : null,
    duration: Number.isFinite(Number(body && body.duration)) ? Number(body.duration) : null,
    queueLength: Number.isFinite(Number(body && body.queueLength)) ? Number(body.queueLength) : null,
    playMode: String((body && body.playMode) || '').slice(0, 40),
  };
  remoteStateCache.updatedAt = Date.now();
  // 版本号让手机能靠 URL 变化换图，同时避免缓存住上一首的封面。
  remoteStateCache.payload.coverVersion = remoteStateCache.coverUrl || remoteStateCache.coverData
    ? crypto.createHash('sha1')
      .update(remoteStateCache.coverUrl || remoteStateCache.coverData.slice(0, 4096))
      .digest('hex').slice(0, 12)
    : '';
  return remoteStateCache.payload;
}
function readRemoteState() {
  const age = remoteStateCache.updatedAt ? Date.now() - remoteStateCache.updatedAt : Infinity;
  const payload = remoteStateCache.payload
    ? Object.assign({}, remoteStateCache.payload, {
      cover: remoteStateCache.payload.coverVersion
        ? '/api/remote/cover?v=' + remoteStateCache.payload.coverVersion
        : '',
    })
    : null;
  return {
    ok: true,
    stale: !(age < REMOTE_STATE_STALE_MS),
    ageMs: Number.isFinite(age) ? age : null,
    state: payload,
  };
}

// 把封面转发给手机。data URL 直接解码回二进制，http(s) 由服务端代取 ——
// 手机不能直连音乐平台的图床（缺 Referer 会被挡），也不该拿到平台地址。
async function serveRemoteCover(req, res) {
  if (remoteStateCache.coverData) {
    const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(remoteStateCache.coverData);
    if (!match) {
      res.writeHead(404, { 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    const buffer = Buffer.from(match[2], 'base64');
    res.writeHead(200, {
      'Content-Type': match[1],
      'Content-Length': String(buffer.length),
      'Cache-Control': 'private, max-age=300',
    });
    res.end(req.method === 'HEAD' ? undefined : buffer);
    return;
  }
  if (!remoteStateCache.coverUrl) {
    res.writeHead(404, { 'Cache-Control': 'no-store' });
    res.end();
    return;
  }
  try {
    const upstream = await fetch(remoteStateCache.coverUrl, {
      headers: { 'User-Agent': UA, 'Referer': 'https://music.163.com/' },
    });
    if (!upstream.ok || !upstream.body) {
      res.writeHead(502, { 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': upstream.headers.get('content-type') || 'image/jpeg',
      'Cache-Control': 'private, max-age=300',
    });
    if (req.method === 'HEAD') { res.end(); return; }
    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.end(buffer);
  } catch (err) {
    console.warn('[RemoteCover]', err && err.message);
    if (!res.headersSent) res.writeHead(502, { 'Cache-Control': 'no-store' });
    res.end();
  }
}

// 命令下发口。server.js 不能 require electron（浏览器模式下要能单跑），
// 所以由 main.js 注入；未注入时明确回 503，不静默丢命令。
let remoteCommandSink = null;
const REMOTE_ALLOWED_COMMANDS = new Set([
  'toggle-play', 'next', 'previous', 'set-volume', 'mute', 'toggle-lyrics',
]);
function setRemoteCommandSink(fn) {
  remoteCommandSink = typeof fn === 'function' ? fn : null;
}
function dispatchRemoteCommand(body) {
  const command = String((body && body.command) || '');
  if (!REMOTE_ALLOWED_COMMANDS.has(command)) {
    return { ok: false, error: 'COMMAND_NOT_ALLOWED', command };
  }
  if (!remoteCommandSink) return { ok: false, error: 'REMOTE_SINK_UNAVAILABLE' };
  const payload = { command };
  if (command === 'set-volume') {
    const value = Number(body && body.value);
    if (!Number.isFinite(value)) return { ok: false, error: 'VOLUME_VALUE_REQUIRED' };
    payload.value = Math.max(0, Math.min(1, value));
  }
  try {
    remoteCommandSink(payload);
  } catch (err) {
    console.warn('[Remote] command dispatch failed:', err && err.message);
    return { ok: false, error: 'REMOTE_DISPATCH_FAILED' };
  }
  return { ok: true, command, value: payload.value };
}
function readPackageInfo() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return {};
  }
}
function parseGitHubRepository(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const direct = raw.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (direct) return { owner: direct[1], repo: direct[2].replace(/\.git$/i, '') };
  const github = raw.match(/github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[#/?].*)?$/i);
  if (github) return { owner: github[1], repo: github[2].replace(/\.git$/i, '') };
  return null;
}
function readUpdateConfig(pkg) {
  const local = (pkg && pkg.mineradio && pkg.mineradio.update) || {};
  const disabled = local.disabled === true || local.provider === 'none';
  if (disabled) {
    return {
      provider: local.provider || 'none',
      owner: '',
      repo: '',
      configured: false,
      disabled: true,
      preview: false,
      preferMirrors: false,
      mirrors: [],
      manifest: '',
    };
  }
  const repoHint = process.env.MINERADIO_UPDATE_REPOSITORY
    || process.env.GITHUB_REPOSITORY
    || local.repository
    || local.github
    || (pkg && pkg.repository && (pkg.repository.url || pkg.repository))
    || '';
  const parsed = parseGitHubRepository(repoHint) || {};
  const owner = process.env.MINERADIO_UPDATE_OWNER || local.owner || parsed.owner || '';
  const repo = process.env.MINERADIO_UPDATE_REPO || local.repo || parsed.repo || '';
  return {
    provider: local.provider || 'github',
    owner,
    repo,
    configured: !!(owner && repo),
    disabled: false,
    preview: local.preview !== false,
    preferMirrors: local.preferMirrors !== false,
    mirrors: readUpdateMirrors(local),
    manifest: process.env.MINERADIO_UPDATE_MANIFEST
      || process.env.MINERADIO_UPDATE_MANIFEST_URL
      || process.env.MINERADIO_UPDATE_MANIFEST_FILE
      || '',
  };
}
function parseUpdateMirrorList(value) {
  if (Array.isArray(value)) return value;
  return String(value || '').split(/[\n,;]/);
}
function readUpdateMirrors(local) {
  const envMirrors = process.env.MINERADIO_UPDATE_MIRRORS || process.env.MINERADIO_UPDATE_MIRROR || '';
  const raw = envMirrors
    ? parseUpdateMirrorList(envMirrors)
    : parseUpdateMirrorList(local.mirrors || local.downloadMirrors || []);
  const seen = new Set();
  const mirrors = [];
  raw.forEach(item => {
    const url = String(item || '').trim();
    if (!/^https?:\/\//i.test(url)) return;
    const key = url.replace(/\/+$/, '').toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    mirrors.push(url);
  });
  return mirrors.slice(0, 6);
}
function normalizeDigest(value, algorithm) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const prefix = new RegExp('^' + algorithm + ':', 'i');
  return raw.replace(prefix, '').trim().replace(/^['"]|['"]$/g, '');
}
function assetDigestInfo(asset) {
  const digest = String(asset && asset.digest || '').trim();
  return {
    sha256: normalizeDigest((asset && asset.sha256) || (/^sha256:/i.test(digest) ? digest : ''), 'sha256').toLowerCase(),
    sha512: normalizeDigest((asset && asset.sha512) || (/^sha512:/i.test(digest) ? digest : ''), 'sha512'),
  };
}
function buildMirrorUrl(originalUrl, mirror) {
  const source = String(originalUrl || '').trim();
  const base = String(mirror || '').trim();
  if (!/^https?:\/\//i.test(source) || !/^https?:\/\//i.test(base)) return '';
  if (base.includes('{encodedUrl}')) return base.replace(/\{encodedUrl\}/g, encodeURIComponent(source));
  if (base.includes('{url}')) return base.replace(/\{url\}/g, source);
  return base.replace(/\/+$/, '/') + source;
}
function uniqueDownloadCandidates(urls, opts) {
  opts = opts || {};
  const directUrls = (Array.isArray(urls) ? urls : [urls])
    .map(url => String(url || '').trim())
    .filter(url => /^https?:\/\//i.test(url));
  const directSet = new Set(directUrls.map(url => url.toLowerCase()));
  const mirrors = opts.useMirrors === false ? [] : (UPDATE_CONFIG.mirrors || []);
  const mirrored = [];
  directUrls.forEach(source => {
    mirrors.forEach((mirror, index) => {
      const url = buildMirrorUrl(source, mirror);
      if (url) mirrored.push({
        url,
        label: '国内加速线路 ' + (index + 1),
        mirrored: true,
      });
    });
  });
  const direct = directUrls.map(url => ({
    url,
    label: directSet.has(url.toLowerCase()) ? 'GitHub 直连' : '下载线路',
    mirrored: false,
  }));
  const ordered = UPDATE_CONFIG.preferMirrors === false ? direct.concat(mirrored) : mirrored.concat(direct);
  const seen = new Set();
  return ordered.filter(item => {
    const key = item.url.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function publicDownloadUrls(candidates) {
  return (Array.isArray(candidates) ? candidates : [])
    .map(item => item && item.url)
    .filter(Boolean);
}
function normalizeVersion(value) {
  return String(value || '').trim().replace(/^v/i, '').replace(/[+].*$/, '').replace(/-.+$/, '');
}
function compareVersions(a, b) {
  const aa = normalizeVersion(a).split('.').map(n => parseInt(n, 10) || 0);
  const bb = normalizeVersion(b).split('.').map(n => parseInt(n, 10) || 0);
  const len = Math.max(aa.length, bb.length, 3);
  for (let i = 0; i < len; i++) {
    const left = aa[i] || 0;
    const right = bb[i] || 0;
    if (left > right) return 1;
    if (left < right) return -1;
  }
  return 0;
}
function cleanReleaseLine(line) {
  return String(line || '')
    .replace(/^\s*#{1,6}\s*/, '')
    .replace(/^\s*[-*]\s+/, '')
    .replace(/^\s*\d+[.)]\s+/, '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .trim();
}
function extractReleaseNotes(body) {
  const notes = [];
  String(body || '').split(/\r?\n/).forEach(line => {
    const text = cleanReleaseLine(line);
    if (!text) return;
    if (/^(what'?s changed|changes|changelog|full changelog|更新日志)$/i.test(text)) return;
    if (/^https?:\/\//i.test(text)) return;
    if (text.length > 72) return;
    notes.push(text);
  });
  return notes.slice(0, 4);
}
function pickReleaseAsset(assets) {
  const list = Array.isArray(assets) ? assets : [];
  const preferred = list.find(a => /\.(exe|msi)$/i.test(a && a.name || ''))
    || list.find(a => /\.(zip|7z)$/i.test(a && a.name || ''))
    || list[0];
  if (!preferred) return null;
  const digest = assetDigestInfo(preferred);
  const candidates = uniqueDownloadCandidates(preferred.browser_download_url || '');
  return {
    name: preferred.name || '',
    size: preferred.size || 0,
    contentType: preferred.content_type || '',
    downloadUrl: preferred.browser_download_url || '',
    downloadUrls: publicDownloadUrls(candidates),
    sha256: digest.sha256 || '',
    sha512: digest.sha512 || '',
  };
}
function patchAssetVersions(name) {
  const matches = String(name || '').match(/\d+(?:[._-]\d+){1,3}/g) || [];
  return matches.map(item => normalizeVersion(item.replace(/[._-]/g, '.'))).filter(Boolean);
}
function pickPatchAsset(assets, currentVersion, latestVersion) {
  const list = Array.isArray(assets) ? assets : [];
  const current = normalizeVersion(currentVersion || APP_VERSION);
  const latest = normalizeVersion(latestVersion || '');
  const preferred = list.find(a => {
    const name = String(a && a.name || '');
    if (!/\.(patch\.json|patch|json)$/i.test(name)) return false;
    const versions = patchAssetVersions(name);
    if (latest) return versions[0] === current && versions[versions.length - 1] === latest;
    return versions[0] === current && name.toLowerCase().includes('patch');
  }) || list.find(a => {
    const name = String(a && a.name || '');
    if (!/\.(patch\.json|patch|json)$/i.test(name)) return false;
    const versions = patchAssetVersions(name);
    return versions[0] === current && name.toLowerCase().includes('patch');
  }) || list.find(a => /\.(patch\.json|patch)$/i.test(a && a.name || ''));
  if (!preferred) return null;
  const digest = assetDigestInfo(preferred);
  const candidates = uniqueDownloadCandidates(preferred.browser_download_url || '');
  return {
    name: preferred.name || '',
    size: preferred.size || 0,
    contentType: preferred.content_type || '',
    downloadUrl: preferred.browser_download_url || '',
    downloadUrls: publicDownloadUrls(candidates),
    sha256: digest.sha256 || '',
    sha512: digest.sha512 || '',
  };
}
function updateAssetNameFromUrl(value) {
  try {
    const u = new URL(String(value || ''));
    const base = path.basename(decodeURIComponent(u.pathname || ''));
    if (base) return base;
  } catch (_) {}
  return path.basename(String(value || '').split('?')[0]) || '';
}
function normalizeManifestUpdateInfo(data) {
  data = data || {};
  const release = data.release || {};
  const asset = release.asset || data.asset || {};
  const latestVersion = normalizeVersion(
    data.latestVersion
    || data.version
    || release.version
    || release.tagName
    || release.tag_name
    || release.name
    || APP_VERSION
  ) || APP_VERSION;
  const downloadUrl = release.downloadUrl || data.downloadUrl || asset.downloadUrl || asset.browser_download_url || '';
  const patch = release.patch || data.patch || null;
  const assetUrls = [downloadUrl].concat(Array.isArray(asset.downloadUrls) ? asset.downloadUrls : []);
  const patchUrls = patch ? [patch.downloadUrl].concat(Array.isArray(patch.downloadUrls) ? patch.downloadUrls : []) : [];
  const patchInfo = patch && patch.downloadUrl ? {
    name: patch.name || updateAssetNameFromUrl(patch.downloadUrl) || `Mineradio-${APP_VERSION}→${latestVersion}.patch.json`,
    size: Number(patch.size || 0) || 0,
    contentType: patch.contentType || patch.content_type || 'application/json',
    downloadUrl: patch.downloadUrl,
    downloadUrls: publicDownloadUrls(uniqueDownloadCandidates(patchUrls)),
    from: normalizeVersion(patch.from || APP_VERSION),
    to: normalizeVersion(patch.to || latestVersion),
    sha256: normalizeDigest(patch.sha256 || '', 'sha256').toLowerCase(),
    sha512: normalizeDigest(patch.sha512 || '', 'sha512'),
  } : null;
  const notes = Array.isArray(release.notes) && release.notes.length
    ? release.notes.slice(0, 4).map(cleanReleaseLine).filter(Boolean)
    : (extractReleaseNotes(release.body || data.body).length ? extractReleaseNotes(release.body || data.body) : UPDATE_FALLBACK_NOTES);
  const assetInfo = downloadUrl ? {
    name: asset.name || updateAssetNameFromUrl(downloadUrl) || `Mineradio-${latestVersion}-Setup.exe`,
    size: Number(asset.size || 0) || 0,
    contentType: asset.contentType || asset.content_type || '',
    downloadUrl,
    downloadUrls: publicDownloadUrls(uniqueDownloadCandidates(assetUrls)),
    sha256: normalizeDigest(asset.sha256 || '', 'sha256').toLowerCase(),
    sha512: normalizeDigest(asset.sha512 || release.sha512 || data.sha512 || '', 'sha512'),
  } : null;
  return {
    configured: true,
    preview: false,
    updateAvailable: data.updateAvailable != null ? !!data.updateAvailable : compareVersions(latestVersion, APP_VERSION) > 0,
    currentVersion: APP_VERSION,
    latestVersion,
    release: {
      tagName: release.tagName || release.tag_name || data.tagName || ('v' + latestVersion),
      name: release.name || data.name || ('Mineradio v' + latestVersion),
      version: latestVersion,
      publishedAt: release.publishedAt || release.published_at || data.publishedAt || '',
      htmlUrl: release.htmlUrl || release.html_url || data.htmlUrl || '',
      downloadUrl,
      asset: assetInfo,
      patch: patchInfo,
      patchAvailable: !!(patchInfo && patchInfo.downloadUrl && compareVersions(latestVersion, APP_VERSION) > 0),
      summary: release.summary || data.summary || notes[0] || '发现新版本，建议更新。',
      notes,
    },
    source: 'manifest',
  };
}
async function readUpdateManifest(ref) {
  const value = String(ref || '').trim();
  if (!value) throw new Error('UPDATE_MANIFEST_MISSING');
  if (/^https?:\/\//i.test(value)) {
    const resp = await fetch(value, {
      headers: { 'User-Agent': `Mineradio/${APP_VERSION}` },
    });
    if (!resp.ok) throw new Error('Update manifest ' + resp.status);
    return resp.json();
  }
  const file = /^file:/i.test(value) ? fileURLToPath(value) : path.resolve(value);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
async function fetchManifestUpdateInfo(ref) {
  try {
    const data = await readUpdateManifest(ref);
    return normalizeManifestUpdateInfo(data);
  } catch (err) {
    return localUpdateFallback(err.message || 'Update manifest failed', { configured: true });
  }
}
// BEATMAP_CACHE_DIR is a module-load constant, so the derived path/drive fields
// never change while this module is loaded. Only `available` can flip at runtime
// (removable drive unplugged), so the probe result gets a short TTL instead of
// being cached for the process lifetime.
const BEAT_CACHE_ROOT_PROBE_TTL_MS = 5000;
let beatCacheRootStatic = null;
let beatCacheRootProbe = { available: false, checkedAt: 0 };
let beatCacheDirEnsured = false;

function beatCacheRootInfo() {
  if (!beatCacheRootStatic) {
    const dir = path.resolve(BEATMAP_CACHE_DIR);
    const root = path.parse(dir).root;
    const drive = root ? root.replace(/[\\\/]+$/, '').toUpperCase() : '';
    beatCacheRootStatic = { dir, root, drive, allowed: !!root && !/^C:$/i.test(drive) };
  }
  const info = beatCacheRootStatic;
  if (!info.allowed) return { ...info, available: false };
  const now = Date.now();
  if (now - beatCacheRootProbe.checkedAt >= BEAT_CACHE_ROOT_PROBE_TTL_MS) {
    beatCacheRootProbe = { available: fs.existsSync(info.root), checkedAt: now };
    if (!beatCacheRootProbe.available) beatCacheDirEnsured = false;
  }
  return { ...info, available: beatCacheRootProbe.available };
}
function ensureBeatMapCacheDir() {
  const info = beatCacheRootInfo();
  if (!info.allowed) {
    const err = new Error('BEAT_CACHE_ON_C_DRIVE_DISABLED');
    err.code = 'BEAT_CACHE_ON_C_DRIVE_DISABLED';
    err.info = info;
    throw err;
  }
  if (!info.available) {
    const err = new Error('BEAT_CACHE_DRIVE_UNAVAILABLE');
    err.code = 'BEAT_CACHE_DRIVE_UNAVAILABLE';
    err.info = info;
    throw err;
  }
  if (!beatCacheDirEnsured) {
    fs.mkdirSync(info.dir, { recursive: true });
    beatCacheDirEnsured = true;
  }
  return info.dir;
}
function safeBeatMapCacheFile(key) {
  const raw = String(key || '').trim();
  if (!raw || raw.length > 240) return null;
  const hash = crypto.createHash('sha1').update(raw).digest('hex');
  const label = raw.replace(/[^a-z0-9_.-]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'beatmap';
  return path.join(ensureBeatMapCacheDir(), `${label}-${hash}.json`);
}
function compactBeatMapCachePayload(body) {
  const key = String(body && body.key || '').trim();
  const map = body && body.map;
  if (!key || !map || typeof map !== 'object') return null;
  return {
    v: 1,
    key,
    savedAt: Date.now(),
    meta: {
      provider: String(body.provider || '').slice(0, 32),
      title: String(body.title || '').slice(0, 160),
      artist: String(body.artist || '').slice(0, 160),
      mode: String(body.mode || 'mr').slice(0, 32),
    },
    map,
  };
}
async function readBeatMapCache(key) {
  const file = safeBeatMapCacheFile(key);
  if (!file) return null;
  // Read directly and treat a missing file as a miss: this drops one stat call
  // per lookup and avoids the exists/read race.
  let text;
  try {
    text = await fs.promises.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  const raw = JSON.parse(text);
  return raw && raw.map ? raw : null;
}
async function writeBeatMapCache(body) {
  const payload = compactBeatMapCachePayload(body);
  if (!payload) return { ok: false, error: 'INVALID_BEATMAP_CACHE_PAYLOAD' };
  const file = safeBeatMapCacheFile(payload.key);
  if (!file) return { ok: false, error: 'INVALID_BEATMAP_CACHE_KEY' };
  const tmp = file + '.tmp';
  const data = JSON.stringify(payload);
  try {
    await fs.promises.writeFile(tmp, data);
  } catch (err) {
    // The cache dir is only created once per process. If it was removed while the
    // drive stayed mounted, rebuild it and retry once before giving up.
    if (err.code !== 'ENOENT') throw err;
    beatCacheDirEnsured = false;
    ensureBeatMapCacheDir();
    await fs.promises.writeFile(tmp, data);
  }
  await fs.promises.rename(tmp, file);
  return { ok: true, key: payload.key, savedAt: payload.savedAt, dir: path.dirname(file) };
}
function localUpdateFallback(reason, opts) {
  opts = opts || {};
  const configured = !!(opts.configured != null ? opts.configured : false);
  return {
    configured,
    preview: UPDATE_CONFIG.preview,
    updateAvailable: false,
    currentVersion: APP_VERSION,
    latestVersion: APP_VERSION,
    release: {
      tagName: 'v' + APP_VERSION,
      name: 'Mineradio v' + APP_VERSION,
      version: APP_VERSION,
      htmlUrl: '',
      downloadUrl: '',
      summary: '当前版本，更新检测已就绪。',
      notes: UPDATE_FALLBACK_NOTES,
    },
    reason: reason || '',
  };
}
function updateError(code, message, cause) {
  const err = new Error(message || code);
  err.code = code;
  if (cause) err.cause = cause;
  return err;
}
function classifyUpdateError(err) {
  const code = String(err && err.code || '').trim();
  const message = String(err && err.message || err || '').trim();
  const detail = message || code || '未知错误';
  if (/HASH|DIGEST|CHECKSUM/i.test(code + ' ' + message)) {
    return { code: code || 'UPDATE_HASH_MISMATCH', reason: '文件校验失败，可能是线路缓存异常，已拦截该安装包。', detail };
  }
  if (/SIZE_MISMATCH|content length/i.test(code + ' ' + message)) {
    return { code: code || 'UPDATE_SIZE_MISMATCH', reason: '下载文件大小不一致，可能是网络中断或线路缓存不完整。', detail };
  }
  if (/AbortError|TIMEOUT|ETIMEDOUT|timeout/i.test(code + ' ' + message)) {
    return { code: code || 'UPDATE_TIMEOUT', reason: '连接超时，当前网络到更新线路不稳定。', detail };
  }
  if (/ENOTFOUND|EAI_AGAIN|DNS|fetch failed|getaddrinfo/i.test(code + ' ' + message)) {
    return { code: code || 'UPDATE_DNS_FAILED', reason: '域名解析失败，可能是当前网络无法连接该更新线路。', detail };
  }
  if (/ECONNRESET|ECONNREFUSED|socket|network/i.test(code + ' ' + message)) {
    return { code: code || 'UPDATE_NETWORK_FAILED', reason: '网络连接被中断，已尝试切换更新线路。', detail };
  }
  const http = message.match(/\bHTTP[_\s-]?(\d{3})\b/i) || message.match(/\b(\d{3})\b/);
  if (http) {
    const status = Number(http[1]);
    if (status === 403) return { code: code || 'UPDATE_HTTP_403', reason: '更新线路返回 403，可能被限流或拦截。', detail };
    if (status === 404) return { code: code || 'UPDATE_HTTP_404', reason: '更新文件不存在，可能 release 资源还没有同步完成。', detail };
    if (status >= 500) return { code: code || 'UPDATE_HTTP_5XX', reason: '更新线路服务器异常，请稍后重试。', detail };
    return { code: code || ('UPDATE_HTTP_' + status), reason: '更新线路返回 HTTP ' + status + '。', detail };
  }
  return { code: code || 'UPDATE_FAILED', reason: '更新失败：' + detail, detail };
}
async function fetchWithTimeout(url, opts, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 12000);
  try {
    return await fetch(url, Object.assign({}, opts || {}, { signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
}
function promiseWithTimeout(promise, timeoutMs, code) {
  let timer = null;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(code || 'PROVIDER_REQUEST_TIMEOUT');
        err.code = code || 'PROVIDER_REQUEST_TIMEOUT';
        reject(err);
      }, Math.max(250, Number(timeoutMs) || 5000));
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
async function readStreamChunkWithTimeout(reader, timeoutMs) {
  let timer = null;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error('UPSTREAM_STREAM_IDLE_TIMEOUT');
          err.code = 'UPSTREAM_STREAM_IDLE_TIMEOUT';
          reject(err);
        }, timeoutMs || 12000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function fetchTextFromCandidates(candidates, timeoutMs) {
  const list = Array.isArray(candidates) && candidates.length ? candidates : [];
  const failures = [];
  for (let i = 0; i < list.length; i++) {
    const candidate = list[i];
    try {
      const resp = await fetchWithTimeout(candidate.url, {
        headers: { 'User-Agent': `Mineradio/${APP_VERSION}` },
      }, timeoutMs || 6500);
      if (!resp.ok) throw updateError('HTTP_' + resp.status, 'HTTP ' + resp.status);
      return { text: await resp.text(), candidate };
    } catch (err) {
      const info = classifyUpdateError(err);
      failures.push(candidate.label + ': ' + info.reason);
    }
  }
  throw updateError('UPDATE_ALL_LINES_FAILED', failures.join('；') || 'All update lines failed');
}
function yamlScalar(text, key) {
  const pattern = new RegExp('^\\s*' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:\\s*(.+?)\\s*$', 'm');
  const match = String(text || '').match(pattern);
  if (!match) return '';
  return match[1].trim().replace(/^['"]|['"]$/g, '');
}
function githubReleaseDownloadUrl(version, fileName) {
  const tag = 'v' + normalizeVersion(version);
  const encodedOwner = encodeURIComponent(UPDATE_CONFIG.owner);
  const encodedRepo = encodeURIComponent(UPDATE_CONFIG.repo);
  const encodedName = String(fileName || '').split('/').map(part => encodeURIComponent(part)).join('/');
  return `https://github.com/${encodedOwner}/${encodedRepo}/releases/download/${tag}/${encodedName}`;
}
function parseLatestYmlUpdateInfo(text, reason) {
  const latestVersion = normalizeVersion(yamlScalar(text, 'version') || APP_VERSION) || APP_VERSION;
  const assetPath = yamlScalar(text, 'path') || yamlScalar(text, 'url') || `Mineradio-${latestVersion}-Setup.exe`;
  const sha512 = normalizeDigest(yamlScalar(text, 'sha512'), 'sha512');
  const size = Number(yamlScalar(text, 'size') || 0) || 0;
  const releaseDate = yamlScalar(text, 'releaseDate');
  const downloadUrl = githubReleaseDownloadUrl(latestVersion, assetPath);
  const candidates = uniqueDownloadCandidates(downloadUrl);
  const asset = {
    name: updateAssetNameFromUrl(downloadUrl) || assetPath,
    size,
    contentType: 'application/octet-stream',
    downloadUrl,
    downloadUrls: publicDownloadUrls(candidates),
    sha256: '',
    sha512,
  };
  return {
    configured: true,
    preview: false,
    updateAvailable: compareVersions(latestVersion, APP_VERSION) > 0,
    currentVersion: APP_VERSION,
    latestVersion,
    release: {
      tagName: 'v' + latestVersion,
      name: 'Mineradio v' + latestVersion,
      version: latestVersion,
      publishedAt: releaseDate,
      htmlUrl: `https://github.com/${UPDATE_CONFIG.owner}/${UPDATE_CONFIG.repo}/releases/tag/v${latestVersion}`,
      downloadUrl,
      asset,
      patch: null,
      patchAvailable: false,
      summary: '发现新版本，已启用备用更新线路。',
      notes: ['更新检测已切换到备用线路', '下载时会自动选择国内加速线路', '下载失败会显示具体原因和当前速度'],
    },
    source: 'latest-yml',
    reason: reason || '',
  };
}
async function fetchLatestYmlUpdateInfo(reason) {
  if (!UPDATE_CONFIG.configured || UPDATE_CONFIG.provider !== 'github') throw updateError('UPDATE_REPOSITORY_NOT_CONFIGURED');
  const latestYmlUrl = `https://github.com/${encodeURIComponent(UPDATE_CONFIG.owner)}/${encodeURIComponent(UPDATE_CONFIG.repo)}/releases/latest/download/latest.yml`;
  const candidates = uniqueDownloadCandidates(latestYmlUrl);
  const result = await fetchTextFromCandidates(candidates, 6500);
  return parseLatestYmlUpdateInfo(result.text, reason);
}
async function fetchLatestUpdateInfo() {
  if (UPDATE_CONFIG.manifest) return fetchManifestUpdateInfo(UPDATE_CONFIG.manifest);
  if (!UPDATE_CONFIG.configured || UPDATE_CONFIG.provider !== 'github') return localUpdateFallback();
  const apiUrl = `https://api.github.com/repos/${encodeURIComponent(UPDATE_CONFIG.owner)}/${encodeURIComponent(UPDATE_CONFIG.repo)}/releases/latest`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8500);
  try {
    const resp = await fetch(apiUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': `Mineradio/${APP_VERSION}`,
        'Accept': 'application/vnd.github+json',
      },
    });
    if (!resp.ok) {
      try { return await fetchLatestYmlUpdateInfo('GitHub Releases ' + resp.status); }
      catch (_) { return localUpdateFallback('GitHub Releases ' + resp.status, { configured: true }); }
    }
    const data = await resp.json();
    const latestVersion = normalizeVersion(data.tag_name || data.name || APP_VERSION) || APP_VERSION;
    const asset = pickReleaseAsset(data.assets);
    const patch = pickPatchAsset(data.assets, APP_VERSION, latestVersion);
    const notes = extractReleaseNotes(data.body).length ? extractReleaseNotes(data.body) : UPDATE_FALLBACK_NOTES;
    return {
      configured: true,
      preview: false,
      updateAvailable: compareVersions(latestVersion, APP_VERSION) > 0,
      currentVersion: APP_VERSION,
      latestVersion,
      release: {
        tagName: data.tag_name || ('v' + latestVersion),
        name: data.name || ('Mineradio v' + latestVersion),
        version: latestVersion,
        publishedAt: data.published_at || '',
        htmlUrl: data.html_url || '',
        downloadUrl: asset ? asset.downloadUrl : '',
        asset,
        patch,
        patchAvailable: !!(patch && patch.downloadUrl && compareVersions(latestVersion, APP_VERSION) > 0),
        summary: notes[0] || '发现新版本，建议更新。',
        notes,
      },
    };
  } catch (err) {
    const reason = err && err.message || 'Update check failed';
    try { return await fetchLatestYmlUpdateInfo(reason); }
    catch (fallbackErr) { return localUpdateFallback((fallbackErr && fallbackErr.message) || reason, { configured: true }); }
  } finally {
    clearTimeout(timer);
  }
}
function safeUpdateFileName(name, version) {
  const raw = String(name || '').trim() || `Mineradio-${version || APP_VERSION}.exe`;
  const cleaned = raw
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  return cleaned || `Mineradio-${version || APP_VERSION}.exe`;
}
function publicUpdateJob(job) {
  if (!job) return { ok: false, error: 'UPDATE_JOB_NOT_FOUND' };
  return {
    ok: job.status !== 'error',
    id: job.id,
    status: job.status,
    progress: job.progress || 0,
    received: job.received || 0,
    total: job.total || 0,
    speedBps: job.speedBps || 0,
    etaSeconds: job.etaSeconds || 0,
    sourceLabel: job.sourceLabel || '',
    attempt: job.attempt || 0,
    attempts: job.attempts || 0,
    mode: job.mode || 'installer',
    message: job.message || '',
    restartRequired: !!job.restartRequired,
    cached: !!job.cached,
    fileName: job.fileName || '',
    filePath: job.status === 'ready' ? job.filePath : '',
    version: job.version || '',
    releaseUrl: job.releaseUrl || '',
    error: job.error || '',
    errorReason: job.errorReason || '',
    errorDetail: job.errorDetail || '',
    failedAttempts: Array.isArray(job.failedAttempts) ? job.failedAttempts.slice(0, 6) : [],
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}
function activeUpdateJobFor(version) {
  const jobs = Array.from(updateDownloadJobs.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return jobs.find(job => job.version === version && (job.status === 'queued' || job.status === 'downloading' || job.status === 'ready'));
}
function trimUpdateJobs() {
  const jobs = Array.from(updateDownloadJobs.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  jobs.slice(8).forEach(job => updateDownloadJobs.delete(job.id));
}
async function downloadUpdateAsset(job) {
  const tmpPath = job.filePath + '.download';
  try {
    fs.mkdirSync(UPDATE_DOWNLOAD_DIR, { recursive: true });
    job.status = 'downloading';
    job.updatedAt = Date.now();

    const resp = await fetch(job.downloadUrl, {
      headers: {
        'User-Agent': `Mineradio/${APP_VERSION}`,
      },
    });
    if (!resp.ok) throw new Error('Download failed ' + resp.status);

    const totalHeader = parseInt(resp.headers.get('content-length') || '0', 10) || 0;
    job.total = totalHeader || job.total || 0;
    job.received = 0;
    job.progress = 0;
    job.speedBps = 0;
    job.etaSeconds = 0;
    job.message = job.total ? '正在下载完整安装包' : '正在下载完整安装包，等待服务器返回大小';
    job.updatedAt = Date.now();
    let speedWindowAt = Date.now();
    let speedWindowBytes = 0;

    const writer = fs.createWriteStream(tmpPath);
    const reader = resp.body.getReader();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const buf = Buffer.from(chunk.value);
        job.received += buf.length;
        speedWindowBytes += buf.length;
        const now = Date.now();
        if (now - speedWindowAt >= 900) {
          job.speedBps = Math.round(speedWindowBytes / Math.max(0.001, (now - speedWindowAt) / 1000));
          speedWindowAt = now;
          speedWindowBytes = 0;
        }
        if (job.total > 0) {
          job.progress = Math.max(1, Math.min(99, Math.round((job.received / job.total) * 100)));
          job.etaSeconds = job.speedBps > 0 ? Math.max(0, Math.round((job.total - job.received) / job.speedBps)) : 0;
        } else {
          const kb = Math.max(1, job.received / 1024);
          job.progress = Math.max(1, Math.min(88, Math.round(Math.log10(kb + 1) * 24)));
        }
        job.message = job.total > 0 ? '正在下载完整安装包' : '正在下载完整安装包，服务器未提供总大小';
        job.updatedAt = Date.now();
        if (!writer.write(buf)) await once(writer, 'drain');
      }
    } finally {
      writer.end();
      await once(writer, 'finish').catch(() => {});
    }

    if (fs.existsSync(job.filePath)) fs.unlinkSync(job.filePath);
    fs.renameSync(tmpPath, job.filePath);
    job.status = 'ready';
    job.progress = 100;
    job.message = '安装包已下载';
    job.updatedAt = Date.now();
  } catch (e) {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
    job.status = 'error';
    job.error = e.message || 'UPDATE_DOWNLOAD_FAILED';
    job.updatedAt = Date.now();
  }
}
function sha512Base64(buffer) {
  return crypto.createHash('sha512').update(buffer).digest('base64');
}
function sha512Hex(buffer) {
  return crypto.createHash('sha512').update(buffer).digest('hex');
}
function verifyUpdateBuffer(buffer, job) {
  const expectedSize = Number(job.expectedSize || job.total || 0) || 0;
  if (expectedSize > 0 && buffer.length !== expectedSize) {
    throw updateError('UPDATE_SIZE_MISMATCH', `Expected ${expectedSize} bytes, got ${buffer.length}`);
  }
  const expectedSha256 = normalizeDigest(job.sha256 || '', 'sha256').toLowerCase();
  if (expectedSha256 && sha256Hex(buffer) !== expectedSha256) {
    throw updateError('UPDATE_SHA256_MISMATCH', 'Downloaded sha256 mismatch');
  }
  const expectedSha512 = normalizeDigest(job.sha512 || '', 'sha512');
  if (expectedSha512) {
    const actualBase64 = sha512Base64(buffer);
    const actualHex = sha512Hex(buffer).toLowerCase();
    if (actualBase64 !== expectedSha512 && actualHex !== expectedSha512.toLowerCase()) {
      throw updateError('UPDATE_SHA512_MISMATCH', 'Downloaded sha512 mismatch');
    }
  }
}
function verifyUpdateFile(filePath, job) {
  verifyUpdateBuffer(fs.readFileSync(filePath), job);
}
function moveInvalidUpdateFile(filePath, reason) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return;
    const dir = path.dirname(filePath);
    const ext = path.extname(filePath);
    const base = path.basename(filePath, ext);
    const invalidPath = path.join(dir, `${base}.invalid-${Date.now()}${ext || '.bin'}`);
    fs.renameSync(filePath, invalidPath);
    console.warn('[UpdateDownload] cached installer moved aside:', reason || 'invalid', invalidPath);
  } catch (e) {
    console.warn('[UpdateDownload] failed to move invalid cached installer:', e.message);
  }
}
function reuseVerifiedInstallerJob(opts) {
  if (!opts || !opts.filePath || !fs.existsSync(opts.filePath)) return null;
  if (!opts.expectedSize && !opts.sha256 && !opts.sha512) return null;
  const now = Date.now();
  const stat = fs.statSync(opts.filePath);
  const job = {
    id: 'cached-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 8),
    status: 'ready',
    progress: 100,
    received: stat.size || 0,
    total: opts.expectedSize || stat.size || 0,
    speedBps: 0,
    etaSeconds: 0,
    sourceLabel: '本地缓存',
    attempt: 0,
    attempts: opts.attempts || 0,
    mode: 'installer',
    message: '安装包已下载，可直接打开安装',
    fileName: opts.fileName || path.basename(opts.filePath),
    filePath: opts.filePath,
    version: opts.version || '',
    downloadUrl: opts.downloadUrl || '',
    downloadCandidates: opts.downloadCandidates || [],
    expectedSize: opts.expectedSize || 0,
    sha256: opts.sha256 || '',
    sha512: opts.sha512 || '',
    releaseUrl: opts.releaseUrl || '',
    failedAttempts: [],
    cached: true,
    createdAt: now,
    updatedAt: now,
    error: '',
  };
  try {
    verifyUpdateFile(opts.filePath, job);
    updateDownloadJobs.set(job.id, job);
    trimUpdateJobs();
    return job;
  } catch (err) {
    moveInvalidUpdateFile(opts.filePath, (err && err.message) || 'cache verification failed');
    return null;
  }
}
function setUpdateJobError(job, err, fallbackMessage) {
  const info = classifyUpdateError(err);
  job.status = 'error';
  job.error = info.code;
  job.errorReason = info.reason;
  job.errorDetail = info.detail;
  job.message = fallbackMessage || info.reason;
  job.updatedAt = Date.now();
}
function prepareUpdateJobAttempt(job, candidate, index, total) {
  job.status = 'downloading';
  job.sourceLabel = candidate.label || '下载线路';
  job.attempt = index + 1;
  job.attempts = total;
  job.received = 0;
  job.speedBps = 0;
  job.etaSeconds = 0;
  job.error = '';
  job.errorReason = '';
  job.errorDetail = '';
  job.updatedAt = Date.now();
}
function ensureMirrorCanBeVerified(job, candidate) {
  if (!candidate || !candidate.mirrored) return;
  if (job.sha256 || job.sha512) return;
  throw updateError('MIRROR_HASH_MISSING', 'Mirror download skipped because no digest is available');
}
async function downloadUpdateAssetWithMirrors(job) {
  const tmpPath = job.filePath + '.download';
  const candidates = Array.isArray(job.downloadCandidates) && job.downloadCandidates.length
    ? job.downloadCandidates
    : uniqueDownloadCandidates(job.downloadUrl || '');
  const failures = [];
  fs.mkdirSync(UPDATE_DOWNLOAD_DIR, { recursive: true });
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    try {
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
      ensureMirrorCanBeVerified(job, candidate);
      prepareUpdateJobAttempt(job, candidate, i, candidates.length);
      job.message = job.total ? '正在下载完整安装包' : '正在下载完整安装包，等待服务器返回大小';

      const resp = await fetchWithTimeout(candidate.url, {
        headers: { 'User-Agent': `Mineradio/${APP_VERSION}` },
      }, 14000);
      if (!resp.ok) throw updateError('HTTP_' + resp.status, 'HTTP ' + resp.status);

      const totalHeader = parseInt(resp.headers.get('content-length') || '0', 10) || 0;
      job.total = totalHeader || job.expectedSize || job.total || 0;
      job.progress = 0;
      job.updatedAt = Date.now();
      let speedWindowAt = Date.now();
      let speedWindowBytes = 0;

      const writer = fs.createWriteStream(tmpPath);
      const reader = resp.body.getReader();
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          const buf = Buffer.from(chunk.value);
          job.received += buf.length;
          speedWindowBytes += buf.length;
          const now = Date.now();
          if (now - speedWindowAt >= 900) {
            job.speedBps = Math.round(speedWindowBytes / Math.max(0.001, (now - speedWindowAt) / 1000));
            speedWindowAt = now;
            speedWindowBytes = 0;
          }
          if (job.total > 0) {
            job.progress = Math.max(1, Math.min(99, Math.round((job.received / job.total) * 100)));
            job.etaSeconds = job.speedBps > 0 ? Math.max(0, Math.round((job.total - job.received) / job.speedBps)) : 0;
          } else {
            const kb = Math.max(1, job.received / 1024);
            job.progress = Math.max(1, Math.min(88, Math.round(Math.log10(kb + 1) * 24)));
          }
          job.message = job.total > 0 ? '正在下载完整安装包' : '正在下载完整安装包，服务器未提供总大小';
          job.updatedAt = Date.now();
          if (!writer.write(buf)) await once(writer, 'drain');
        }
      } finally {
        writer.end();
        await once(writer, 'finish').catch(() => {});
      }

      verifyUpdateFile(tmpPath, job);
      if (fs.existsSync(job.filePath)) fs.unlinkSync(job.filePath);
      fs.renameSync(tmpPath, job.filePath);
      job.status = 'ready';
      job.progress = 100;
      job.etaSeconds = 0;
      job.message = '安装包已下载';
      job.updatedAt = Date.now();
      return;
    } catch (err) {
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
      const info = classifyUpdateError(err);
      failures.push({ source: candidate.label || '下载线路', reason: info.reason, detail: info.detail });
      job.failedAttempts = failures.slice(-6);
      job.message = i < candidates.length - 1 ? ((candidate.label || '当前线路') + '失败，正在切换线路') : info.reason;
      job.updatedAt = Date.now();
      if (i >= candidates.length - 1) setUpdateJobError(job, err, '下载失败：' + info.reason);
    }
  }
}
function startUpdateDownloadJob(info) {
  const release = info && info.release ? info.release : {};
  const asset = release.asset || {};
  const downloadUrl = release.downloadUrl || asset.downloadUrl || '';
  if (!info || !info.configured) return { ok: false, error: 'UPDATE_REPOSITORY_NOT_CONFIGURED' };
  if (!info.updateAvailable) return { ok: false, error: 'NO_UPDATE_AVAILABLE' };
  if (!/^https?:\/\//i.test(downloadUrl)) return { ok: false, error: 'UPDATE_ASSET_MISSING' };

  const version = info.latestVersion || release.version || '';
  const existing = activeUpdateJobFor(version);
  if (existing) return publicUpdateJob(existing);

  const fileName = safeUpdateFileName(asset.name || '', version);
  const filePath = path.join(UPDATE_DOWNLOAD_DIR, fileName);
  const downloadCandidates = uniqueDownloadCandidates([downloadUrl].concat(Array.isArray(asset.downloadUrls) ? asset.downloadUrls : []));
  const expectedSize = asset.size || 0;
  const sha256 = normalizeDigest(asset.sha256 || '', 'sha256').toLowerCase();
  const sha512 = normalizeDigest(asset.sha512 || '', 'sha512');
  const cached = reuseVerifiedInstallerJob({
    fileName,
    filePath,
    version,
    downloadUrl,
    downloadCandidates,
    expectedSize,
    sha256,
    sha512,
    releaseUrl: release.htmlUrl || '',
    attempts: downloadCandidates.length,
  });
  if (cached) return publicUpdateJob(cached);

  const now = Date.now();
  const job = {
    id: now.toString(36) + '-' + Math.random().toString(36).slice(2, 8),
    status: 'queued',
    progress: 0,
    received: 0,
    total: expectedSize,
    mode: 'installer',
    fileName,
    filePath,
    version,
    downloadUrl,
    downloadCandidates,
    expectedSize,
    sha256,
    sha512,
    releaseUrl: release.htmlUrl || '',
    sourceLabel: '',
    attempt: 0,
    attempts: downloadCandidates.length,
    failedAttempts: [],
    createdAt: now,
    updatedAt: now,
    error: '',
  };
  updateDownloadJobs.set(job.id, job);
  trimUpdateJobs();
  downloadUpdateAssetWithMirrors(job);
  return publicUpdateJob(job);
}
function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}
function safePatchRelativePath(value) {
  const rel = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!rel || rel.includes('\0')) return '';
  const parts = rel.split('/').filter(Boolean);
  if (!parts.length || parts.some(part => part === '..' || part === '.')) return '';
  const root = parts[0];
  if (PATCH_ALLOWED_FILES.has(rel)) return rel;
  if (!PATCH_ALLOWED_ROOTS.has(root)) return '';
  if (/\.(exe|dll|node|msi|bat|cmd|ps1|pfx|pem|key)$/i.test(rel)) return '';
  return parts.join('/');
}
function patchTargetPath(rel) {
  const safeRel = safePatchRelativePath(rel);
  if (!safeRel) return null;
  const target = path.resolve(__dirname, safeRel);
  const root = path.resolve(__dirname);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}
function decodePatchFile(file) {
  if (!file || typeof file !== 'object') return null;
  if (typeof file.contentBase64 === 'string') return Buffer.from(file.contentBase64, 'base64');
  if (typeof file.content === 'string') return Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8');
  return null;
}
function backupPatchTarget(job, rel, target) {
  if (!fs.existsSync(target)) return;
  const backup = path.join(UPDATE_PATCH_BACKUP_DIR, job.id, rel);
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.copyFileSync(target, backup);
}
function writePatchFile(job, file) {
  const rel = safePatchRelativePath(file.path || file.name);
  const target = rel ? patchTargetPath(rel) : null;
  const content = decodePatchFile(file);
  if (!rel || !target || !content) throw new Error('INVALID_PATCH_FILE');
  if (content.length > PATCH_MAX_BYTES) throw new Error('PATCH_FILE_TOO_LARGE');
  const expected = String(file.sha256 || '').trim().toLowerCase();
  const actual = sha256Hex(content);
  if (expected && expected !== actual) throw new Error('PATCH_HASH_MISMATCH:' + rel);
  backupPatchTarget(job, rel, target);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = target + '.mineradio-patch';
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, target);
  if (expected && sha256Hex(fs.readFileSync(target)) !== expected) throw new Error('PATCH_WRITE_VERIFY_FAILED:' + rel);
  return rel;
}
function normalizePatchPayload(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('INVALID_PATCH_PAYLOAD');
  const type = String(payload.type || payload.kind || '');
  if (type && type !== 'mineradio-resource-patch') throw new Error('UNSUPPORTED_PATCH_TYPE');
  const from = normalizeVersion(payload.from || payload.baseVersion || '');
  const to = normalizeVersion(payload.to || payload.version || payload.targetVersion || '');
  const files = Array.isArray(payload.files) ? payload.files : [];
  if (!from || compareVersions(from, APP_VERSION) !== 0) throw new Error('PATCH_VERSION_MISMATCH');
  if (!to || compareVersions(to, APP_VERSION) <= 0) throw new Error('PATCH_TARGET_VERSION_INVALID');
  if (!files.length) throw new Error('PATCH_EMPTY');
  if (files.length > 40) throw new Error('PATCH_TOO_MANY_FILES');
  return { from, to, files, restartRequired: payload.restartRequired !== false };
}
async function downloadAndApplyPatch(job) {
  const chunks = [];
  try {
    fs.mkdirSync(UPDATE_DOWNLOAD_DIR, { recursive: true });
    job.status = 'downloading';
    job.mode = 'patch';
    job.message = '正在下载快速补丁';
    job.updatedAt = Date.now();

    const resp = await fetch(job.downloadUrl, {
      headers: { 'User-Agent': `Mineradio/${APP_VERSION}` },
    });
    if (!resp.ok) throw new Error('Patch download failed ' + resp.status);

    job.total = parseInt(resp.headers.get('content-length') || '0', 10) || job.total || 0;
    job.received = 0;
    const reader = resp.body.getReader();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const buf = Buffer.from(chunk.value);
      job.received += buf.length;
      if (job.received > PATCH_MAX_BYTES) throw new Error('PATCH_TOO_LARGE');
      chunks.push(buf);
      job.progress = job.total > 0
        ? Math.max(1, Math.min(84, Math.round((job.received / job.total) * 84)))
        : Math.max(1, Math.min(76, Math.round(Math.log10(job.received / 1024 + 1) * 24)));
      job.updatedAt = Date.now();
    }

    const raw = Buffer.concat(chunks);
    const expectedPatchHash = String(job.sha256 || '').trim().toLowerCase();
    if (expectedPatchHash && sha256Hex(raw) !== expectedPatchHash) throw new Error('PATCH_PACKAGE_HASH_MISMATCH');
    const patch = normalizePatchPayload(JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, '')));
    job.version = patch.to;
    job.message = '正在应用快速补丁';
    job.progress = 88;
    job.updatedAt = Date.now();
    const changed = [];
    patch.files.forEach(file => changed.push(writePatchFile(job, file)));
    job.changedFiles = changed;
    job.status = 'ready';
    job.progress = 100;
    job.restartRequired = patch.restartRequired;
    job.message = patch.restartRequired ? '快速补丁已应用，重启后生效' : '快速补丁已应用';
    job.updatedAt = Date.now();
  } catch (e) {
    job.status = 'error';
    job.error = e.message || 'PATCH_APPLY_FAILED';
    job.message = '快速补丁失败，可改用完整安装包';
    job.updatedAt = Date.now();
  }
}
async function downloadPatchBufferFromCandidate(job, candidate, index, total) {
  ensureMirrorCanBeVerified(job, candidate);
  prepareUpdateJobAttempt(job, candidate, index, total);
  job.mode = 'patch';
  job.message = '正在下载快速补丁';
  job.progress = 0;
  job.updatedAt = Date.now();

  const resp = await fetchWithTimeout(candidate.url, {
    headers: { 'User-Agent': `Mineradio/${APP_VERSION}` },
  }, 12000);
  if (!resp.ok) throw updateError('HTTP_' + resp.status, 'HTTP ' + resp.status);

  job.total = parseInt(resp.headers.get('content-length') || '0', 10) || job.expectedSize || job.total || 0;
  job.received = 0;
  const chunks = [];
  const reader = resp.body.getReader();
  let speedWindowAt = Date.now();
  let speedWindowBytes = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    const buf = Buffer.from(chunk.value);
    job.received += buf.length;
    speedWindowBytes += buf.length;
    if (job.received > PATCH_MAX_BYTES) throw updateError('PATCH_TOO_LARGE', 'Patch package is too large');
    chunks.push(buf);
    const now = Date.now();
    if (now - speedWindowAt >= 700) {
      job.speedBps = Math.round(speedWindowBytes / Math.max(0.001, (now - speedWindowAt) / 1000));
      speedWindowAt = now;
      speedWindowBytes = 0;
    }
    job.progress = job.total > 0
      ? Math.max(1, Math.min(84, Math.round((job.received / job.total) * 84)))
      : Math.max(1, Math.min(76, Math.round(Math.log10(job.received / 1024 + 1) * 24)));
    job.etaSeconds = job.total > 0 && job.speedBps > 0 ? Math.max(0, Math.round((job.total - job.received) / job.speedBps)) : 0;
    job.updatedAt = Date.now();
  }
  const raw = Buffer.concat(chunks);
  verifyUpdateBuffer(raw, job);
  return raw;
}
async function downloadAndApplyPatchWithMirrors(job) {
  const candidates = Array.isArray(job.downloadCandidates) && job.downloadCandidates.length
    ? job.downloadCandidates
    : uniqueDownloadCandidates(job.downloadUrl || '');
  const failures = [];
  fs.mkdirSync(UPDATE_DOWNLOAD_DIR, { recursive: true });
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    try {
      const raw = await downloadPatchBufferFromCandidate(job, candidate, i, candidates.length);
      const patch = normalizePatchPayload(JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, '')));
      job.version = patch.to;
      job.message = '正在应用快速补丁';
      job.progress = 88;
      job.etaSeconds = 0;
      job.updatedAt = Date.now();
      const changed = [];
      patch.files.forEach(file => changed.push(writePatchFile(job, file)));
      job.changedFiles = changed;
      job.status = 'ready';
      job.progress = 100;
      job.restartRequired = patch.restartRequired;
      job.message = patch.restartRequired ? '快速补丁已应用，重启后生效' : '快速补丁已应用';
      job.updatedAt = Date.now();
      return;
    } catch (err) {
      const info = classifyUpdateError(err);
      failures.push({ source: candidate.label || '下载线路', reason: info.reason, detail: info.detail });
      job.failedAttempts = failures.slice(-6);
      job.message = i < candidates.length - 1 ? ((candidate.label || '当前线路') + '失败，正在切换线路') : info.reason;
      job.updatedAt = Date.now();
      if (i >= candidates.length - 1) setUpdateJobError(job, err, '快速补丁失败：' + info.reason);
    }
  }
}
function startUpdatePatchJob(info) {
  const release = info && info.release ? info.release : {};
  const patch = release.patch || {};
  const downloadUrl = patch.downloadUrl || '';
  if (!info || !info.configured) return { ok: false, error: 'UPDATE_REPOSITORY_NOT_CONFIGURED' };
  if (!info.updateAvailable) return { ok: false, error: 'NO_UPDATE_AVAILABLE' };
  if (!release.patchAvailable || !/^https?:\/\//i.test(downloadUrl)) return { ok: false, error: 'PATCH_ASSET_MISSING' };

  const version = info.latestVersion || release.version || patch.to || '';
  const existing = Array.from(updateDownloadJobs.values())
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .find(job => job.mode === 'patch' && job.version === version && (job.status === 'queued' || job.status === 'downloading' || job.status === 'ready'));
  if (existing) return publicUpdateJob(existing);

  const now = Date.now();
  const downloadCandidates = uniqueDownloadCandidates([downloadUrl].concat(Array.isArray(patch.downloadUrls) ? patch.downloadUrls : []));
  const job = {
    id: 'patch-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 8),
    status: 'queued',
    progress: 0,
    received: 0,
    total: patch.size || 0,
    mode: 'patch',
    fileName: patch.name || safeUpdateFileName('', version).replace(/\.exe$/i, '.patch.json'),
    filePath: '',
    version,
    downloadUrl,
    downloadCandidates,
    releaseUrl: release.htmlUrl || '',
    expectedSize: patch.size || 0,
    sha256: normalizeDigest(patch.sha256 || '', 'sha256').toLowerCase(),
    sha512: normalizeDigest(patch.sha512 || '', 'sha512'),
    restartRequired: true,
    sourceLabel: '',
    attempt: 0,
    attempts: downloadCandidates.length,
    failedAttempts: [],
    message: '等待下载快速补丁',
    createdAt: now,
    updatedAt: now,
    error: '',
  };
  updateDownloadJobs.set(job.id, job);
  trimUpdateJobs();
  downloadAndApplyPatchWithMirrors(job);
  return publicUpdateJob(job);
}
// ========== 音乐下载引擎 ==========
const musicDownloadJobs = new Map();
const musicDownloadQueue = [];
let musicDownloadActive = 0;
const MUSIC_DOWNLOAD_CONCURRENCY = 3;
const MUSIC_DOWNLOAD_ILLEGAL_CHARS = /[\\/:*?"<>|]+/g;

function musicDownloadSanitizeFilename(name) {
  return String(name || '').replace(MUSIC_DOWNLOAD_ILLEGAL_CHARS, ' ').replace(/\s{2,}/g, ' ').trim() || '未知';
}

function musicDownloadExtForUrl(audioUrl) {
  let pathname = '';
  try { pathname = new URL(audioUrl).pathname.toLowerCase(); } catch (_) {}
  if (/\.flac$/.test(pathname)) return '.flac';
  if (/\.(m4a|mp4)$/.test(pathname)) return '.m4a';
  if (/\.ogg$/.test(pathname)) return '.ogg';
  if (/\.wav$/.test(pathname)) return '.wav';
  return '.mp3';
}

function musicDownloadArtistText(song) {
  const raw = song && (song.artist || song.artists || song.singer || song.author_name) || '';
  if (Array.isArray(raw)) return raw.map(a => (a && (a.name || a)) || '').filter(Boolean).join(' / ');
  return String(raw || '');
}

function musicDownloadFilename(song, audioUrl) {
  const artist = musicDownloadSanitizeFilename(musicDownloadArtistText(song));
  const name = musicDownloadSanitizeFilename(song && (song.name || song.title) || '');
  const base = artist && artist !== '未知' ? `${artist} - ${name}` : name;
  return base + musicDownloadExtForUrl(audioUrl);
}

function publicMusicJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    songId: job.songId,
    songName: job.songName,
    songArtist: job.songArtist,
    provider: job.provider,
    status: job.status,
    progress: job.progress || 0,
    received: job.received || 0,
    total: job.total || 0,
    speedBps: job.speedBps || 0,
    fileName: job.fileName || '',
    filePath: job.filePath || '',
    error: job.error || '',
    message: job.message || '',
    batchId: job.batchId || '',
    createdAt: job.createdAt || 0,
    updatedAt: job.updatedAt || 0,
  };
}

function musicDownloadProviderKey(song) {
  if (!song) return 'netease';
  if (song.type === 'local' || song.source === 'local' || song.provider === 'local' || song.localUrl || song.localPath) return 'local';
  if (song.provider === 'qq' || song.source === 'qq' || song.type === 'qq' || song.songmid || song.mediaMid || song.media_mid) return 'qq';
  if (song.provider === 'kugou' || song.source === 'kugou' || song.type === 'kugou' || song.hash || song.albumAudioId || song.album_audio_id) return 'kugou';
      return 'netease';
}

async function resolveMusicDownloadUrl(song, quality) {
  const provider = musicDownloadProviderKey(song);
  if (provider === 'local') return { url: null, error: '本地歌曲无需下载', trial: false };
    if (provider === 'qq') {
    const mid = song.mid || song.songmid || song.id || '';
    const mediaMid = song.mediaMid || song.media_mid || song.fileMediaMid || '';
    const data = await handleQQSongUrl(mid, mediaMid, quality, song);
    if (!data || !data.url || data.playable === false) return { url: null, error: data && data.message || '无法获取小Q下载地址', trial: false };
    return { url: data.url, error: '', trial: !!data.trial };
  }
  if (provider === 'kugou') {
    const hash = song.hash || song.id || '';
    const albumAudioId = song.albumAudioId || song.album_audio_id || '';
    const albumId = song.albumId || song.album_id || '';
    const qualityHashes = song.qualityHashes || song.quality_hashes || null;
    const data = await handleKugouSongUrl(hash, albumAudioId, albumId, quality, qualityHashes);
    if (!data || !data.url || !data.playable) return { url: null, error: data && data.message || '无法获取小狗播放地址', trial: false };
    return { url: data.url, error: '', trial: !!data.trial };
  }
  const loginInfo = await getLoginInfo();
  const data = await handleSongUrl(song.id, loginInfo, quality);
  if (!data || !data.url) return { url: null, error: data && data.message || '无法获取播放地址', trial: !!(data && data.trial) };
  if (data.trial) return { url: data.url, error: '仅试听片段，跳过下载', trial: true };
  return { url: data.url, error: '', trial: false };
}

async function executeMusicDownload(job) {
  try {
    const rootDir = getMusicDownloadDir();
    fs.mkdirSync(rootDir, { recursive: true });
    job.status = 'resolving';
    job.message = '正在获取音频地址';
    job.updatedAt = Date.now();
    const resolved = await resolveMusicDownloadUrl(job.song, job.quality);
    if (!resolved.url || resolved.trial) {
      job.status = 'skipped';
      job.error = resolved.error || (resolved.trial ? '仅试听，跳过' : '无法获取下载地址');
      job.message = job.error;
      job.updatedAt = Date.now();
      return;
    }
    const fileName = musicDownloadFilename(job.song, resolved.url);
    const subDir = job.playlistName ? path.join(rootDir, musicDownloadSanitizeFilename(job.playlistName)) : rootDir;
    fs.mkdirSync(subDir, { recursive: true });
    const filePath = path.join(subDir, fileName);
    job.fileName = fileName;
    job.filePath = filePath;
    if (fs.existsSync(filePath)) {
      job.status = 'done';
      job.progress = 100;
      job.message = '文件已存在，跳过';
      job.updatedAt = Date.now();
      return;
    }
    job.status = 'downloading';
    job.message = '正在下载';
    job.updatedAt = Date.now();
    const resp = await fetch(resolved.url, { headers: audioProxyHeadersFor(resolved.url, '') });
    if (!resp.ok) throw new Error('下载失败 HTTP ' + resp.status);
    job.total = parseInt(resp.headers.get('content-length') || '0', 10) || 0;
    job.received = 0;
    job.progress = 0;
    let speedWindowAt = Date.now();
    let speedWindowBytes = 0;
    const tmpPath = filePath + '.download';
    const writer = fs.createWriteStream(tmpPath);
    const reader = resp.body.getReader();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const buf = Buffer.from(chunk.value);
        job.received += buf.length;
        speedWindowBytes += buf.length;
        const now = Date.now();
        if (now - speedWindowAt >= 800) {
          job.speedBps = Math.round(speedWindowBytes / Math.max(0.001, (now - speedWindowAt) / 1000));
          speedWindowAt = now;
          speedWindowBytes = 0;
        }
        job.progress = job.total > 0
          ? Math.max(1, Math.min(99, Math.round((job.received / job.total) * 100)))
          : Math.max(1, Math.min(88, Math.round(Math.log10(Math.max(1, job.received / 1024) + 1) * 24)));
        job.updatedAt = now;
        if (!writer.write(buf)) await once(writer, 'drain');
      }
    } finally {
      writer.end();
      await once(writer, 'finish').catch(() => {});
    }
    if (fs.existsSync(filePath)) try { fs.unlinkSync(filePath); } catch (_) {}
    fs.renameSync(tmpPath, filePath);
    job.status = 'done';
    job.progress = 100;
    job.message = '下载完成';
    job.updatedAt = Date.now();
  } catch (error) {
    job.status = 'error';
    job.error = error && error.message || 'DOWNLOAD_FAILED';
    job.message = '下载失败: ' + job.error;
    job.updatedAt = Date.now();
    const tmpPath = (job.filePath || '') + '.download';
    try { if (tmpPath && fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
  }
}

function drainMusicDownloadQueue() {
  while (musicDownloadActive < MUSIC_DOWNLOAD_CONCURRENCY && musicDownloadQueue.length) {
    const job = musicDownloadQueue.shift();
    if (job.status === 'cancelled') continue;
    musicDownloadActive += 1;
    executeMusicDownload(job).finally(() => {
      musicDownloadActive -= 1;
      drainMusicDownloadQueue();
    });
  }
}

function pruneMusicDownloadJobs() {
  if (musicDownloadJobs.size <= 300) return;
  const finished = Array.from(musicDownloadJobs.values())
    .filter(job => ['done', 'error', 'skipped', 'cancelled'].includes(job.status))
    .sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
  let removable = musicDownloadJobs.size - 300;
  for (const job of finished) {
    if (removable-- <= 0) break;
    musicDownloadJobs.delete(job.id);
  }
}

function enqueueMusicDownload(song, opts) {
  opts = opts || {};
  pruneMusicDownloadJobs();
  const provider = musicDownloadProviderKey(song);
  const job = {
    id: 'dl-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
    songId: String(song.id || song.mid || song.songmid || song.hash || ''),
    songName: String(song.name || song.title || '未知'),
    songArtist: musicDownloadArtistText(song),
    provider,
    song,
    quality: opts.quality || 'hires',
    playlistName: opts.playlistName || '',
    batchId: opts.batchId || '',
    status: 'queued',
    progress: 0,
    received: 0,
    total: 0,
    speedBps: 0,
    fileName: '',
    filePath: '',
    error: '',
    message: '排队中',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  musicDownloadJobs.set(job.id, job);
  musicDownloadQueue.push(job);
  drainMusicDownloadQueue();
  return job;
}

function getMusicDownloadDir() {
  return process.env.MINERADIO_DOWNLOAD_DIR || MUSIC_DOWNLOAD_DIR;
}
// ========== /音乐下载引擎 ==========

function readRequestBody(req) {
  // 只认 application/json。以前 JSON.parse 失败会回退成表单解析，等于允许拿
  // text/plain 发 JSON 体 —— 那是 CORS 简单请求，浏览器不发预检，任何网页都能
  // 跨站写这些端点（顶替登录 cookie 正是走的这条路）。前端所有带 body 的 POST
  // 都显式带 application/json，回退分支只服务攻击者。
  const type = String((req && req.headers && req.headers['content-type']) || '')
    .split(';', 1)[0].trim().toLowerCase();
  const acceptsBody = type === 'application/json';
  return new Promise(resolve => {
    let raw = '';
    req.on('data', chunk => {
      // 不接收的请求体也要读完再丢弃，否则连接会挂在半截等客户端发完。
      if (!acceptsBody) return;
      raw += chunk;
      if (raw.length > 8 * 1024 * 1024) req.destroy();
    });
    req.on('end', () => {
      if (!acceptsBody || !raw) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); }
      catch (e) { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}
function compactDiagNumber(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const factor = Math.pow(10, digits);
  return Math.round(n * factor) / factor;
}
// 只保留判断「该恢复到哪一层」需要的字段，并且截断字符串：
// 这个文件会跨重启累积，不能让 src 或歌名把它撑爆。
function normalizeStallLogEntry(body) {
  const src = String((body && body.src) || '');
  return {
    ts: new Date().toISOString(),
    reason: String((body && body.reason) || 'unknown').slice(0, 40),
    currentTime: compactDiagNumber(body && body.currentTime),
    duration: compactDiagNumber(body && body.duration),
    readyState: Number.isFinite(Number(body && body.readyState)) ? Number(body.readyState) : null,
    networkState: Number.isFinite(Number(body && body.networkState)) ? Number(body.networkState) : null,
    paused: (body && body.paused) === true,
    seeking: (body && body.seeking) === true,
    bufferedEnd: compactDiagNumber(body && body.bufferedEnd),
    audioCtxState: String((body && body.audioCtxState) || '').slice(0, 20),
    lastWaitingAgoMs: Number.isFinite(Number(body && body.lastWaitingAgoMs)) ? Math.round(Number(body.lastWaitingAgoMs)) : null,
    smartTransition: (body && body.smartTransition) === true,
    // clock-resumed 专有：冻结持续时长与恢复后位置是否跳变。
    frozenForMs: Number.isFinite(Number(body && body.frozenForMs)) ? Math.round(Number(body.frozenForMs)) : null,
    resumedFromSameTime: body && typeof body.resumedFromSameTime === 'boolean' ? body.resumedFromSameTime : null,
    // prefetch-throughput 专有：预读实际聚合吞吐。和 clock-frozen 同一条时间线，
    // 用来判定 CDN 是按连接还是按 IP 限速——并行预读能不能成立全看这个。
    throughputKbps: Number.isFinite(Number(body && body.throughputKbps)) ? Math.round(Number(body.throughputKbps)) : null,
    sampleBytes: Number.isFinite(Number(body && body.sampleBytes)) ? Math.round(Number(body.sampleBytes)) : null,
    sampleMs: Number.isFinite(Number(body && body.sampleMs)) ? Math.round(Number(body.sampleMs)) : null,
    connections: Number.isFinite(Number(body && body.connections)) ? Math.round(Number(body.connections)) : null,
    songKey: String((body && body.songKey) || '').slice(0, 120),
    title: String((body && body.title) || '').slice(0, 120),
    src: src.slice(0, 120),
  };
}
async function appendStallLogEntry(body) {
  const entry = normalizeStallLogEntry(body);
  await fs.promises.mkdir(DIAGNOSTICS_DIR, { recursive: true });
  await fs.promises.appendFile(STALL_LOG_FILE, JSON.stringify(entry) + '\n', 'utf8');
  await trimStallLogIfNeeded();
  return entry;
}
// 超限时砍掉最老的行。appendFile 本身不需要读全文，只有这里越界才读一次。
async function trimStallLogIfNeeded() {
  try {
    const stat = await fs.promises.stat(STALL_LOG_FILE);
    if (stat.size <= STALL_LOG_MAX_BYTES) {
      const quickLines = Math.ceil(stat.size / 160);
      if (quickLines <= STALL_LOG_MAX_LINES) return;
    }
    const raw = await fs.promises.readFile(STALL_LOG_FILE, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    if (lines.length <= STALL_LOG_MAX_LINES && stat.size <= STALL_LOG_MAX_BYTES) return;
    const kept = lines.slice(-STALL_LOG_MAX_LINES);
    const tmp = STALL_LOG_FILE + '.tmp';
    await fs.promises.writeFile(tmp, kept.join('\n') + '\n', 'utf8');
    await fs.promises.rename(tmp, STALL_LOG_FILE);
  } catch (_) {}
}
function formatStallLogLine(entry) {
  const ts = String(entry.ts || '').replace('T', ' ').replace(/\.\d+Z$/, '');
  const parts = [
    `[${ts}]`,
    String(entry.reason || 'unknown').padEnd(14),
    `t=${entry.currentTime == null ? '?' : entry.currentTime}`,
    `dur=${entry.duration == null ? '?' : entry.duration}`,
    `rs=${entry.readyState == null ? '?' : entry.readyState}`,
    `ns=${entry.networkState == null ? '?' : entry.networkState}`,
    `buf=${entry.bufferedEnd == null ? '?' : entry.bufferedEnd}`,
    `ctx=${entry.audioCtxState || '?'}`,
    `waiting=${entry.lastWaitingAgoMs == null ? 'never' : entry.lastWaitingAgoMs + 'ms'}`,
  ];
  if (entry.frozenForMs != null) parts.push(`frozenFor=${entry.frozenForMs}ms`);
  // 吞吐行没有 t/dur/rs 这些播放器字段，上面那串会全是 ?；这里补上真正有内容的。
  if (entry.throughputKbps != null) parts.push(`throughput=${entry.throughputKbps}KB/s`);
  if (entry.connections != null) parts.push(`conns=${entry.connections}`);
  if (entry.sampleMs != null) parts.push(`over=${entry.sampleMs}ms`);
  if (entry.resumedFromSameTime === false) parts.push('position-jumped');
  if (entry.smartTransition) parts.push('smart-transition');
  if (entry.paused) parts.push('paused');
  if (entry.seeking) parts.push('seeking');
  if (entry.title) parts.push(`| ${entry.title}`);
  return parts.join(' ');
}
async function readStallLogReport() {
  const header = [`file: ${STALL_LOG_FILE}`];
  let lines = [];
  try {
    const raw = await fs.promises.readFile(STALL_LOG_FILE, 'utf8');
    lines = raw.split('\n').filter(Boolean);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      header.push('entries: 0');
      header.push('');
      header.push('还没有记录。播放期间如果出现媒体时钟冻结，这里会出现条目。');
      return header.join('\n') + '\n';
    }
    throw err;
  }
  header.push(`entries: ${lines.length}`);

  // 攒到几百条时逐行读没法看，先给一份汇总：冻结次数、起播/中途分布、
  // 恢复时长的中位数与最大值。这几个数字直接对应「改动有没有效果」。
  const parsed = [];
  lines.forEach((line) => {
    try { parsed.push(JSON.parse(line)); } catch (_) {}
  });
  const frozen = parsed.filter((e) => e.reason === 'clock-frozen');
  const resumed = parsed.filter((e) => e.reason === 'clock-resumed');
  if (frozen.length) {
    const atStart = frozen.filter((e) => Number(e.currentTime) < 0.5).length;
    const durations = resumed
      .map((e) => Number(e.frozenForMs))
      .filter((v) => Number.isFinite(v))
      .sort((a, b) => a - b);
    header.push('');
    header.push('---- 汇总 ----');
    header.push(`冻结次数: ${frozen.length}（起播 ${atStart} / 中途 ${frozen.length - atStart}）`);
    if (durations.length) {
      const median = durations[Math.floor(durations.length / 2)];
      header.push(`已恢复: ${durations.length} 次 · 检测后耗时中位数 ${median}ms · 最长 ${durations[durations.length - 1]}ms`);
      header.push('（实际卡顿时长约为上述数值 + 1000ms 检测窗口）');
    }
    const unresolved = frozen.length - resumed.length;
    if (unresolved > 0) header.push(`未记录到恢复: ${unresolved} 次（可能是切歌或退出打断了观测）`);
  }

  header.push('');
  const rendered = lines.slice(-200).reverse().map((line) => {
    try { return formatStallLogLine(JSON.parse(line)); }
    catch (_) { return line; }
  });
  return header.concat(rendered).join('\n') + '\n';
}
function normalizeApiCode(payload) {
  const body = payload && (payload.body || payload);
  return Number((body && body.code) || (body && body.body && body.body.code) || (payload && payload.status) || 0);
}
function normalizeApiMessage(payload) {
  const body = payload && (payload.body || payload);
  return (body && (body.message || body.msg || body.error)) || (body && body.body && (body.body.message || body.body.msg || body.body.error)) || '';
}
function parseCookieString(cookieText) {
  const out = {};
  String(cookieText || '').split(';').forEach(part => {
    const raw = String(part || '').trim();
    if (!raw) return;
    const idx = raw.indexOf('=');
    if (idx <= 0) return;
    const key = raw.slice(0, idx).trim();
    const value = raw.slice(idx + 1).trim();
    if (key) out[key] = value;
  });
  return out;
}
function serializeCookieObject(obj) {
  return Object.keys(obj || {})
    .filter(k => obj[k] != null && String(obj[k]) !== '')
    .map(k => k + '=' + String(obj[k]))
    .join('; ');
}
function qqCookieObject() {
  return parseCookieString(qqCookie);
}
function normalizeQQUin(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  return digits.replace(/^0+/, '') || digits;
}
function qqCookieUin(obj) {
  obj = obj || qqCookieObject();
  const raw = Number(obj.login_type) === 2 ? (obj.wxuin || obj.uin || obj.p_uin) : (obj.uin || obj.qqmusic_uin || obj.wxuin || obj.p_uin);
  return normalizeQQUin(raw);
}
function qqCookieMusicKey(obj) {
  obj = obj || qqCookieObject();
  return obj.qm_keyst || obj.qqmusic_key || obj.music_key || obj.p_skey || obj.skey ||
    obj.psrf_qqaccess_token || obj.psrf_qqrefresh_token || obj.wxrefresh_token || obj.wxskey || '';
}
function qqCookiePlaybackKey(obj) {
  obj = obj || qqCookieObject();
  return obj.qm_keyst || obj.qqmusic_key || obj.music_key || obj.wxskey || '';
}
function decodeQQCookieValue(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const candidates = [raw];
  if (/^(?:[0-9a-fA-F]{2}){2,}$/.test(raw)) {
    try {
      const decodedHex = Buffer.from(raw, 'hex').toString('utf8').trim();
      if (decodedHex && /[^\x20-\x7e]/.test(decodedHex)) candidates.push(decodedHex);
    } catch (e) {}
  }
  const plusSafe = raw.replace(/\+/g, '%20');
  try { candidates.push(decodeURIComponent(plusSafe).trim()); } catch (e) {}
  const percentBytes = [];
  let hasPercentBytes = false;
  for (let i = 0; i < plusSafe.length; i += 1) {
    const ch = plusSafe[i];
    const hex = plusSafe.slice(i + 1, i + 3);
    if (ch === '%' && /^[0-9a-fA-F]{2}$/.test(hex)) {
      percentBytes.push(parseInt(hex, 16));
      hasPercentBytes = true;
      i += 2;
    } else {
      const text = ch === '+' ? ' ' : ch;
      for (const byte of Buffer.from(text, 'utf8')) percentBytes.push(byte);
    }
  }
  if (hasPercentBytes && percentBytes.length) {
    const buf = Buffer.from(percentBytes);
    try { candidates.push(new TextDecoder('gb18030').decode(buf).trim()); } catch (e) {}
    try { candidates.push(buf.toString('utf8').trim()); } catch (e) {}
  }
  for (const item of candidates.slice()) {
    if (!item) continue;
    if (/\\u[0-9a-fA-F]{4}/.test(item)) {
      try { candidates.push(JSON.parse('"' + item.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\\\\u/g, '\\u') + '"').trim()); } catch (e) {}
    }
    if (/[ÃÂ]|[\u00c0-\u00ff][\u0080-\u00bf]/.test(item)) {
      try { candidates.push(Buffer.from(item, 'latin1').toString('utf8').trim()); } catch (e) {}
    }
  }
  function score(text) {
    text = String(text || '').trim();
    if (!text) return 1e9;
    let s = 0;
    s += (text.match(/\uFFFD/g) || []).length * 80;
    s += (text.match(/%[0-9a-fA-F]{2}/g) || []).length * 10;
    s += (text.match(/\\u[0-9a-fA-F]{4}/g) || []).length * 8;
    s += (text.match(/[ÃÂ]/g) || []).length * 34;
    s += (text.match(/[\u0080-\u009f]/g) || []).length * 42;
    s += (text.match(/[\x00-\x08\x0e-\x1f\x7f]/g) || []).length * 50;
    s -= (text.match(/[\u4e00-\u9fff]/g) || []).length * 2;
    return s + Math.min(text.length, 80) * 0.02;
  }
  return candidates
    .filter(Boolean)
    .sort((a, b) => score(a) - score(b))[0]
    .trim();
}
function qqCookieNickname(obj, uin) {
  obj = obj || qqCookieObject();
  uin = normalizeQQUin(uin || qqCookieUin(obj));
  const padded = uin ? '0' + uin : '';
  const keys = [
    uin && ('ptnick_' + uin),
    padded && ('ptnick_' + padded),
    'ptnick',
    'nick',
    'nickname',
    'qq_nickname'
  ].filter(Boolean);
  for (const key of keys) {
    if (obj[key]) {
      const nick = decodeQQCookieValue(obj[key]);
      if (nick) return nick;
    }
  }
  const ptnickKey = Object.keys(obj).find(key => /^ptnick_/i.test(key) && obj[key]);
  return ptnickKey ? decodeQQCookieValue(obj[ptnickKey]) : '';
}
function qqCookieAvatar(obj, uin) {
  obj = obj || qqCookieObject();
  const direct = obj.qqmusic_avatar || obj.avatar || obj.avatarUrl || obj.headpic || '';
  if (direct) return decodeQQCookieValue(direct);
  uin = normalizeQQUin(uin || qqCookieUin(obj));
  return uin ? `https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(uin)}&s=100` : '';
}
function normalizeQQCookieInput(cookieText) {
  const obj = parseCookieString(cookieText);
  if (Number(obj.login_type) === 2 && obj.wxuin && !obj.uin) obj.uin = obj.wxuin;
  if (!obj.uin && (obj.qqmusic_uin || obj.p_uin)) obj.uin = obj.qqmusic_uin || obj.p_uin;
  if (obj.uin) obj.uin = normalizeQQUin(obj.uin);
  return serializeCookieObject(obj);
}
function playbackRestriction(provider, category, message, action, extra) {
  return {
    provider,
    category,
    action: action || '',
    message,
    ...(extra || {}),
  };
}
function classifyNeteasePlaybackRestriction(lastData, loginInfo) {
  const loggedIn = !!(loginInfo && loginInfo.loggedIn);
  const vipReady = !!(loginInfo && (loginInfo.isVip || loginInfo.isSvip || loginInfo.vipLevel === 'vip' || loginInfo.vipLevel === 'svip' || Number(loginInfo.vipType || 0) > 0));
  const fee = Number(lastData && lastData.fee);
  const code = Number(lastData && lastData.code);
  const freeTrial = lastData && lastData.freeTrialInfo;
  if (!loggedIn) {
    return playbackRestriction('netease', 'login_required', '小云需要登录后尝试获取完整播放地址', 'login', { code, fee });
  }
  if (freeTrial) {
    return playbackRestriction('netease', 'trial_only', '小云仅返回试听片段，完整播放需要会员或购买', 'upgrade', { code, fee });
  }
  if (fee === 1) {
    if (vipReady) {
      return playbackRestriction('netease', 'copyright_unavailable', '当前会员状态下仍未取得可播放地址，已尝试在小云内匹配同一录音版本', 'switch_source', { code, fee });
    }
    return playbackRestriction('netease', 'vip_required', '小云歌曲需要 VIP 权限，当前无法获取完整播放地址', 'upgrade', { code, fee });
  }
  if (fee === 4) {
    return playbackRestriction('netease', 'paid_required', '小云歌曲需要单曲、专辑购买或更高权限', 'purchase', { code, fee });
  }
  if (fee === 8) {
    return playbackRestriction('netease', 'copyright_unavailable', '当前小云版本没有返回完整音源，已尝试匹配站内同一录音版本', 'switch_source', { code, fee });
  }
  if (code === 404 || code === 403) {
    return playbackRestriction('netease', 'copyright_unavailable', '小云版权暂不可播，换源或稍后重试会更稳', 'switch_source', { code, fee });
  }
  return playbackRestriction('netease', 'url_unavailable', '小云没有返回可播放地址，可能是版权、会员或地区限制', loggedIn ? 'switch_source' : 'login', { code, fee });
}
function classifyQQPlaybackRestriction(info, session) {
  const hasSession = typeof session === 'object' ? !!session.hasSession : !!session;
  const hasPlaybackKey = typeof session === 'object' ? !!session.hasPlaybackKey : hasSession;
  const rawMsg = String((info && (info.msg || info.tips || info.errmsg || info.message)) || '').trim();
  const code = Number((info && (info.result || info.code || info.errtype)) || 0);
  const lower = rawMsg.toLowerCase();
  if (!hasSession) {
    return playbackRestriction('qq', 'login_required', '小Q需要登录或授权后才能获取播放地址', 'login', { code, rawMessage: rawMsg });
  }
  if (!hasPlaybackKey && code === 104003) {
    return playbackRestriction('qq', 'login_required', '小Q当前只拿到了网页登录状态，还缺少播放授权，请重新打开官方小Q登录窗口完成授权', 'login', { code, rawMessage: rawMsg, missingPlaybackKey: true });
  }
  if (code === 104003) {
    return playbackRestriction('qq', 'copyright_unavailable', '小Q没有给当前版本返回播放地址，通常是版权、会员或官方版本限制，可以换一个搜索结果或切到小云源', 'switch_source', { code, rawMessage: rawMsg });
  }
  if (/vip|会员|付费|购买|数字专辑|专辑|pay/.test(lower + rawMsg)) {
    return playbackRestriction('qq', 'paid_required', '小Q歌曲需要会员、购买或数字专辑权限', 'upgrade', { code, rawMessage: rawMsg });
  }
  if (code && code !== 0) {
    return playbackRestriction('qq', 'copyright_unavailable', rawMsg || '小Q版权暂不可播或仅官方客户端可播', 'switch_source', { code, rawMessage: rawMsg });
  }
  return playbackRestriction('qq', 'url_unavailable', '小Q没有返回播放地址，可能受版权、会员或官方客户端限制', 'switch_source', { code, rawMessage: rawMsg });
}
const NETEASE_QUALITY_CANDIDATES = [
  { level: 'jymaster', br: 1999000, label: '超清母带', svip: true },
  { level: 'hires',    br: 1999000, label: '高清臻音' },
  { level: 'lossless', br: 1411000, label: '无损' },
  { level: 'exhigh',   br: 999000,  label: '极高' },
  { level: 'standard', br: 128000,  label: '标准' },
];
const NETEASE_DIRECT_RESOLVE_BUDGET_MS = 4800;
const NETEASE_SOURCE_MATCH_TOTAL_BUDGET_MS = 8000;
const NETEASE_SOURCE_MATCH_LOOKUP_BUDGET_MS = 4800;
const NETEASE_SONG_URL_TOTAL_BUDGET_MS = 12000;
const QQ_QUALITY_CANDIDATE_TEMPLATES = [
  { prefix: 'RS01', ext: '.flac', level: 'hires', label: 'Hi-Res FLAC' },
  { prefix: 'F000', ext: '.flac', level: 'lossless', label: '无损 FLAC' },
  { prefix: 'M800', ext: '.mp3', level: 'exhigh', label: '320k MP3' },
  { prefix: 'M500', ext: '.mp3', level: 'standard', label: '128k MP3' },
  { prefix: 'C400', ext: '.m4a', level: 'aac', label: 'AAC/M4A' },
];
function normalizeQualityPreference(value) {
  const raw = String(value || '').toLowerCase().trim();
  if (['jymaster', 'master', 'studio', 'svip'].includes(raw)) return 'jymaster';
  if (['hires', 'hi-res', 'highres', 'zhenyin', 'spatial'].includes(raw)) return 'hires';
  if (['lossless', 'flac', 'sq'].includes(raw)) return 'lossless';
  if (['exhigh', 'high', '320', '320k', 'hq'].includes(raw)) return 'exhigh';
  if (['standard', 'normal', '128', '128k', 'std'].includes(raw)) return 'standard';
  return 'hires';
}
function qualityCandidatesFrom(target, candidates) {
  target = normalizeQualityPreference(target);
  let start = candidates.findIndex(item => item.level === target);
  if (start < 0) start = 0;
  return candidates.slice(start);
}
function hasNeteaseSvip(loginInfo) {
  return !!(loginInfo && loginInfo.loggedIn && (loginInfo.vipLevel === 'svip' || loginInfo.isSvip));
}
function mapArtists(raw) {
  return (raw || [])
    .map(a => ({ id: a && a.id, name: (a && a.name) || '' }))
    .filter(a => a.name);
}
function mapSongRecord(s) {
  s = s || {};
  const artists = mapArtists(s.ar || s.artists);
  const album = s.al || s.album || {};
  return {
    provider: 'netease',
    source: 'netease',
    type: 'song',
    id: s.id,
    name: s.name,
    artist: artists.map(a => a.name).join(' / '),
    artists,
    artistId: artists[0] && artists[0].id,
    album: album.name || '',
    albumId: album.id || '',
    // user_record responses vary between account states; preserve every
    // known song/album cover field before falling back to an empty cover.
    cover: s.picUrl || s.cover || s.coverUrl || album.picUrl || album.coverUrl || album.blurPicUrl || '',
    duration: s.dt || s.duration || 0,
    popularity: Number(s.pop || s.popularity || s.score || s.hotScore || 0) || 0,
    searchRank: s.rank === null || s.rank === undefined || s.rank === '' ? null : Number(s.rank),
    fee: s.fee,
  };
}
function mapNeteaseCloudArtists(raw) {
  if (Array.isArray(raw)) {
    return raw.map(artist => {
      if (typeof artist === 'string') return { id: '', name: artist.trim() };
      return { id: artist && artist.id, name: artist && (artist.name || artist.artistName || artist.singer) || '' };
    }).filter(artist => artist.name);
  }
  if (raw && typeof raw === 'object') {
    return mapNeteaseCloudArtists(raw.ar || raw.artists || raw.artist || raw.name || '');
  }
  return String(raw || '')
    .split(/\s*\/\s*|、|,|，|&| feat\.? | ft\.? /i)
    .map(name => ({ id: '', name: name.trim() }))
    .filter(artist => artist.name);
}
function mapNeteaseCloudSong(item) {
  item = item || {};
  const nested = [item.simpleSong, item.song, item.track].find(value => value && typeof value === 'object') || {};
  const nestedAlbum = nested.al || nested.album || {};
  const rawAlbum = item.album || item.albumName || nestedAlbum;
  const albumName = typeof rawAlbum === 'string'
    ? rawAlbum
    : (rawAlbum && (rawAlbum.name || rawAlbum.albumName) || nestedAlbum.name || '');
  const artists = mapNeteaseCloudArtists(item.artists || item.ar || item.artist || item.singer || nested.ar || nested.artists);
  const id = item.songId || item.songid || item.id || nested.id || '';
  const fileName = item.fileName || item.filename || item.name || '';
  const name = item.songName || item.title || (typeof item.song === 'string' ? item.song : '') || nested.name || fileName.replace(/\.[^.]+$/, '') || '未命名歌曲';
  const cover = item.cover || item.coverUrl || item.coverImgUrl || item.picUrl || item.albumPicUrl || nestedAlbum.picUrl || nestedAlbum.coverImgUrl || '';
  const duration = item.duration || item.durationMs || item.dt || nested.dt || 0;
  const base = mapSongRecord({
    ...nested,
    id,
    name,
    ar: artists,
    al: { ...nestedAlbum, id: item.albumId || item.album_id || nestedAlbum.id, name: albumName, picUrl: cover },
    dt: duration,
    fee: item.fee == null ? nested.fee : item.fee,
  });
  return {
    ...base,
    provider: 'netease',
    source: 'netease',
    type: 'song',
    id,
    name,
    artist: artists.map(artist => artist.name).join(' / ') || String(item.artist || item.singer || '未知歌手'),
    artists,
    artistId: artists[0] && artists[0].id,
    album: albumName,
    albumId: item.albumId || item.album_id || nestedAlbum.id || '',
    cover,
    duration,
    cloudSong: true,
    cloudId: String(id || ''),
    cloudSource: 'netease-cloud',
    fileName,
    fileSize: Number(item.fileSize || item.filesize || item.size || 0) || 0,
    bitrate: Number(item.bitrate || item.br || 0) || 0,
    addTime: item.addTime || item.uploadTime || item.createTime || 0,
  };
}
function extractNeteaseCloudRows(body) {
  body = body || {};
  const values = [body.data, body.songs, body.cloudSongs, body.list];
  for (const value of values) {
    if (Array.isArray(value)) return value;
    if (value && Array.isArray(value.data)) return value.data;
    if (value && Array.isArray(value.list)) return value.list;
  }
  return [];
}
function extractNeteaseCloudMetaNumber(body, keys, fallback) {
  const values = [body, body && body.data, body && body.result, body && body.data && body.data.result];
  for (const value of values) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    for (const key of keys) {
      const number = Number(value[key]);
      if (Number.isFinite(number) && number >= 0) return number;
    }
  }
  return Number(fallback) || 0;
}
function extractNeteaseCloudMetaBoolean(body, keys) {
  const values = [body, body && body.data, body && body.result, body && body.data && body.data.result];
  for (const value of values) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    for (const key of keys) {
      if (typeof value[key] === 'boolean') return value[key];
    }
  }
  return null;
}
function extractNeteaseCloudAudioUrl(value, depth) {
  depth = Number(depth) || 0;
  if (depth > 4 || value == null) return '';
  if (Array.isArray(value)) {
    for (const item of value) {
      const url = extractNeteaseCloudAudioUrl(item, depth + 1);
      if (url) return url;
    }
    return '';
  }
  if (typeof value !== 'object') return '';
  for (const key of ['url', 'downloadUrl', 'songUrl', 'audioUrl', 'playUrl', 'mp3Url']) {
    if (/^https?:\/\//i.test(String(value[key] || ''))) return String(value[key]);
  }
  for (const key of ['data', 'result', 'urlInfo', 'song', 'songInfo']) {
    const url = extractNeteaseCloudAudioUrl(value[key], depth + 1);
    if (url) return url;
  }
  return '';
}
function mapDiscoverPlaylist(pl, tag) {
  pl = pl || {};
  const creator = pl.creator || pl.user || {};
  const id = pl.id || pl.resourceId || pl.creativeId;
  return {
    provider: 'netease',
    source: 'netease',
    type: 'playlist',
    id,
    name: pl.name || pl.title || '',
    cover: pl.picUrl || pl.coverImgUrl || pl.coverUrl || pl.uiElement && pl.uiElement.image && pl.uiElement.image.imageUrl || '',
    trackCount: pl.trackCount || pl.songCount || pl.programCount || 0,
    playCount: pl.playCount || pl.playcount || 0,
    creator: creator.nickname || creator.name || '',
    tag: tag || pl.alg || '',
  };
}

function lowSignalText(value) {
  return String(value || '').trim().toLowerCase();
}

function isLowSignalPodcastItem(item) {
  const name = lowSignalText(item && (item.name || item.title || item.radioName));
  const sub = lowSignalText(item && (item.djName || item.category || item.desc || item.sub));
  const text = name + ' ' + sub;
  return /购买播客|付费精品|qzone|空间背景音乐|背景音乐|四只烤翅|试纸烤翅/i.test(text);
}

const QQ_LIKED_PLAYLIST_ID = 'liked';
const QQ_LIKED_DIRID = 201;
const QQ_LIKED_PLAYLIST_NAME = '小Q·我的喜欢';
const QQ_LIKED_PLAYLIST_COVER = 'https://y.gtimg.cn/mediastyle/global/img/cover_like.png';
const QQ_LIKED_AUTH_MESSAGE = '小Q“我的喜欢”需要完整授权。请重新打开官方小Q登录窗口，等待进入播放器页后再关闭。';
const qqLikedPlaylistCoverByUser = new Map();

function qqLikedPlaylistUserKey(info) {
  return String(info && (info.userId || info.uin) || '').trim();
}

function getCachedQQLikedPlaylistCover(info) {
  const key = qqLikedPlaylistUserKey(info);
  return key ? String(qqLikedPlaylistCoverByUser.get(key) || '') : '';
}

function rememberQQLikedPlaylistCover(info, cover) {
  const key = qqLikedPlaylistUserKey(info);
  cover = String(cover || '').trim();
  if (key && cover) qqLikedPlaylistCoverByUser.set(key, cover);
  else if (key) qqLikedPlaylistCoverByUser.delete(key);
  return cover;
}

function clearQQLikedPlaylistCoverCache() {
  qqLikedPlaylistCoverByUser.clear();
}

function isQQLikedPlaylistId(id) {
  const value = String(id || '').trim().toLowerCase();
  return value === QQ_LIKED_PLAYLIST_ID || value === 'qq-liked' || value === String(QQ_LIKED_DIRID);
}

function isQQFavoritePlaylist(pl) {
  if (pl && (isQQLikedPlaylistId(pl.id) || Number(pl.dirid || 0) === QQ_LIKED_DIRID)) return true;
  const name = String(pl && pl.name || pl && pl.diss_name || '').trim();
  const normalizedName = name.replace(/[·•・_\-\s]+/g, '').toLowerCase();
  return [
    '我喜欢',
    '我的喜欢',
    '喜欢的音乐',
    'qq音乐我喜欢',
    'qq音乐我的喜欢',
    'qq音乐喜欢的音乐',
  ].includes(normalizedName);
}

function isQzoneBackgroundPlaylist(pl) {
  const text = String((pl && pl.name || '') + ' ' + (pl && pl.creator || '')).toLowerCase();
  return /qzone|空间|背景音乐/i.test(text);
}
async function requireLogin(res, sendResponse) {
  const info = await getLoginInfo();
  if (!info.loggedIn || !info.userId) {
    (typeof sendResponse === 'function' ? sendResponse : sendJSON)(res, { error: 'LOGIN_REQUIRED', loggedIn: false }, 401);
    return null;
  }
  return info;
}

// ---------- 业务: 搜索 ----------
//   优先用 cloudsearch (新接口, 字段更全, picUrl 更稳定)
//   对于仍然缺失封面的歌曲, 用 song_detail 批量补齐
async function handleSearch(keywords, limit, offset) {
  limit = Math.max(1, Math.min(50, Number(limit) || 20));
  offset = Math.max(0, Number(offset) || 0);
  console.log('[Search]', keywords, 'limit:', limit, 'offset:', offset);
  const result = await cloudsearch({ keywords, limit, offset, cookie: userCookie });
  const songs = result.body && result.body.result && result.body.result.songs ? result.body.result.songs : [];

  let mapped = songs.map(s => {
    return mapSongRecord(s);
  });

  // 兜底: 补齐缺失的封面
  const missing = mapped.filter(s => !s.cover).map(s => s.id);
  if (missing.length) {
    try {
      console.log('[Search] backfilling covers for', missing.length, 'songs');
      const dd = await song_detail({ ids: missing.join(','), cookie: userCookie });
      const songsArr = (dd.body && dd.body.songs) || [];
      const idToPic = {};
      songsArr.forEach(s => {
        const pic = (s.al && s.al.picUrl) || (s.album && s.album.picUrl) || '';
        if (pic) idToPic[s.id] = pic;
      });
      mapped = mapped.map(s => s.cover ? s : { ...s, cover: idToPic[s.id] || '' });
    } catch (e) { console.warn('[Search] backfill failed:', e.message); }
  }

  return mapped;
}

const NETEASE_SOURCE_MATCH_POSITIVE_TTL_MS = 12 * 60 * 60 * 1000;
const NETEASE_SOURCE_MATCH_NEGATIVE_TTL_MS = 5 * 60 * 1000;
const NETEASE_SOURCE_MATCH_MAX_CANDIDATES = 4;
const neteaseSourceMatchCache = new Map();

function neteaseSourceMatchText(value) {
  return String(value || '').normalize('NFKC').toLowerCase()
    .replace(/[（(【\[].*?[）)】\]]/g, '')
    .replace(/[\s·・\-—_.,，。:：'"“”‘’/\\|!?！？]+/g, '');
}
function neteaseSourceMatchDurationMs(value) {
  let duration = Number(value) || 0;
  if (duration > 0 && duration < 10000) duration *= 1000;
  return Math.max(0, duration);
}
function neteaseSourceMatchArtists(song) {
  const list = song && (song.ar || song.artists) || [];
  return (Array.isArray(list) ? list : []).map(artist => ({
    id: String(artist && artist.id || ''),
    name: neteaseSourceMatchText(artist && artist.name || ''),
  })).filter(artist => artist.id || artist.name);
}
function neteaseSourceMatchVersionTokens(song) {
  const aliases = song && (song.alia || song.alias) || [];
  const text = String((song && song.name || '') + ' ' + (Array.isArray(aliases) ? aliases.join(' ') : aliases || '')).toLowerCase();
  const rules = [
    ['live', /\blive\b|现场|演唱会/],
    ['cover', /\bcover\b|翻唱/],
    ['remix', /\bremix\b|\b(?:pop |radio |club |digital dog )?mix\b|mix版/],
    ['remaster', /\bremaster(?:ed)?\b|重制/],
    ['rerecord', /\bre[ -]?record(?:ed|ing)?\b|重录/],
    ['named-version', /taylor['’]?s version|\bversion\b|\bver\.?\b|版本/],
    ['edit', /\bradio edit\b|\bedit\b|剪辑版/],
    ['alternate-cut', /\bstripped\b|\bmono\b|\bstereo\b|\bcommentary\b/],
    ['instrumental', /\binstrumental\b|伴奏|\bkaraoke\b/],
    ['acoustic', /\bacoustic\b|不插电/],
    ['speed', /\bnightcore\b|\bsped up\b|\bslowed(?: and reverb)?\b|加速|慢速|变速/],
    ['dj', /\bdj\b|dj版/],
    ['demo', /\bdemo\b|试听版/],
  ];
  return rules.filter(rule => rule[1].test(text)).map(rule => rule[0]);
}
function neteaseSourceMatchMediaProfiles(song) {
  const profiles = [];
  ['h', 'm', 'l', 'sq', 'hr', 'hMusic', 'mMusic', 'lMusic', 'sqMusic', 'hrMusic'].forEach(key => {
    const item = song && song[key];
    if (!item) return;
    const profile = {
      br: Number(item.br || item.bitrate || 0) || 0,
      size: Number(item.size || 0) || 0,
      duration: Number(item.playTime || item.playtime || item.duration || 0) || 0,
      sr: Number(item.sr || item.sampleRate || 0) || 0,
    };
    if (profile.br || profile.size) profiles.push(profile);
  });
  return profiles;
}
function neteaseSourceMatchFingerprintCount(source, candidate) {
  const sourceProfiles = neteaseSourceMatchMediaProfiles(source);
  const candidateProfiles = neteaseSourceMatchMediaProfiles(candidate);
  let matches = 0;
  sourceProfiles.forEach(left => {
    if (candidateProfiles.some(right =>
      left.br && left.br === right.br &&
      left.size && left.size === right.size &&
      (!left.duration || !right.duration || Math.abs(left.duration - right.duration) <= 10) &&
      (!left.sr || !right.sr || left.sr === right.sr)
    )) matches++;
  });
  return matches;
}
function neteaseSourceMatchArtistSetEqual(sourceArtists, candidateArtists) {
  const sourceIds = [...new Set(sourceArtists.map(artist => artist.id).filter(Boolean))].sort();
  const candidateIds = [...new Set(candidateArtists.map(artist => artist.id).filter(Boolean))].sort();
  if (sourceIds.length && candidateIds.length) {
    return sourceIds.length === candidateIds.length && sourceIds.every((id, index) => id === candidateIds[index]);
  }
  const sourceNames = [...new Set(sourceArtists.map(artist => artist.name).filter(Boolean))].sort();
  const candidateNames = [...new Set(candidateArtists.map(artist => artist.name).filter(Boolean))].sort();
  return sourceNames.length > 0 && sourceNames.length === candidateNames.length && sourceNames.every((name, index) => name === candidateNames[index]);
}
function neteaseSourceMatchCandidateScore(source, candidate) {
  if (!source || !candidate || String(source.id || '') === String(candidate.id || '')) return -1;
  if (neteaseSourceMatchText(source.name) !== neteaseSourceMatchText(candidate.name)) return -1;
  const sourceVersions = neteaseSourceMatchVersionTokens(source);
  const candidateVersions = neteaseSourceMatchVersionTokens(candidate);
  if (sourceVersions.join('|') !== candidateVersions.join('|')) return -1;
  const sourceArtists = neteaseSourceMatchArtists(source);
  const candidateArtists = neteaseSourceMatchArtists(candidate);
  const sourceIds = sourceArtists.map(artist => artist.id).filter(Boolean);
  const candidateIds = candidateArtists.map(artist => artist.id).filter(Boolean);
  const artistIdMatch = sourceIds.length && candidateIds.length && sourceIds.some(id => candidateIds.indexOf(id) >= 0);
  const artistNameMatch = sourceArtists.some(left => candidateArtists.some(right => left.name && right.name && left.name === right.name));
  const artistSetMatch = neteaseSourceMatchArtistSetEqual(sourceArtists, candidateArtists);
  if (!artistIdMatch && !artistNameMatch) return -1;
  const sourceDuration = neteaseSourceMatchDurationMs(source.dt || source.duration);
  const candidateDuration = neteaseSourceMatchDurationMs(candidate.dt || candidate.duration);
  const durationDiff = sourceDuration && candidateDuration ? Math.abs(sourceDuration - candidateDuration) : 0;
  const durationLimit = sourceDuration ? Math.max(1800, sourceDuration * 0.012) : 0;
  if (durationLimit && durationDiff > durationLimit) return -1;
  const fingerprintMatches = neteaseSourceMatchFingerprintCount(source, candidate);
  const officialRecommendation = !!candidate.__officialSourceMatch;
  if (!fingerprintMatches && (!artistSetMatch || !sourceDuration || !candidateDuration || durationDiff > (officialRecommendation ? 1800 : 600))) return -1;
  const privilege = candidate.__privilege || candidate.privilege || {};
  let score = fingerprintMatches * 120;
  if (artistIdMatch) score += 70;
  else if (artistNameMatch) score += 42;
  if (artistSetMatch) score += 18;
  if (officialRecommendation) score += 240;
  if (sourceDuration && candidateDuration) score += Math.max(0, 45 - durationDiff / 100);
  if (Number(privilege.pl || 0) > 0 && String(privilege.plLevel || '').toLowerCase() !== 'none') score += 22;
  score += Math.min(20, Number(candidate.pop || candidate.popularity || candidate.score || 0) / 5 || 0);
  return score;
}
function neteaseSourceMatchCacheKey(id, hints) {
  hints = hints || {};
  return [
    String(id || ''),
    neteaseSourceMatchText(hints.name || hints.title),
    neteaseSourceMatchText(hints.artist),
    Math.round(neteaseSourceMatchDurationMs(hints.duration) / 1000),
  ].join('|');
}
function readNeteaseSourceMatchCache(key) {
  const entry = neteaseSourceMatchCache.get(key);
  if (!entry) return null;
  const ttl = entry.candidates && entry.candidates.length ? NETEASE_SOURCE_MATCH_POSITIVE_TTL_MS : NETEASE_SOURCE_MATCH_NEGATIVE_TTL_MS;
  if (Date.now() - entry.at > ttl) {
    neteaseSourceMatchCache.delete(key);
    return null;
  }
  return entry.candidates;
}
function writeNeteaseSourceMatchCache(key, candidates) {
  neteaseSourceMatchCache.set(key, { at: Date.now(), candidates: candidates || [] });
  while (neteaseSourceMatchCache.size > 256) neteaseSourceMatchCache.delete(neteaseSourceMatchCache.keys().next().value);
}
function neteaseSourceMatchHintArtists(hints) {
  hints = hints || {};
  const ids = String(hints.artistIds || hints.artistId || '').split(',').map(value => value.trim()).filter(Boolean);
  let names = String(hints.artistNames || '').split('\u001f').map(value => value.trim()).filter(Boolean);
  if (!names.length && String(hints.artist || '').trim()) names = [String(hints.artist).trim()];
  const count = Math.max(ids.length, names.length);
  const artists = [];
  for (let index = 0; index < count; index++) {
    const id = ids[index] || '';
    const name = names[index] || (count === 1 ? String(hints.artist || '').trim() : '');
    if (id || name) artists.push({ id, name });
  }
  return artists;
}
function mergeNeteaseSourceMatchSong(detailSong, searchSong, hints) {
  const detail = detailSong || {};
  const searchItem = searchSong || {};
  const merged = { ...searchItem, ...detail };
  const rawDetailArtists = detail.ar || detail.artists || [];
  const rawSearchArtists = searchItem.ar || searchItem.artists || [];
  const detailArtists = (Array.isArray(rawDetailArtists) ? rawDetailArtists : []).filter(artist => artist && (artist.id || String(artist.name || '').trim()));
  const searchArtists = (Array.isArray(rawSearchArtists) ? rawSearchArtists : []).filter(artist => artist && (artist.id || String(artist.name || '').trim()));
  const hintArtists = neteaseSourceMatchHintArtists(hints);
  const artists = (Array.isArray(detailArtists) && detailArtists.length)
    ? detailArtists
    : ((Array.isArray(searchArtists) && searchArtists.length) ? searchArtists : hintArtists);
  const detailAlbum = detail.al || detail.album || {};
  const searchAlbum = searchItem.al || searchItem.album || {};
  const album = { ...searchAlbum, ...detailAlbum };
  album.name = String(detailAlbum.name || '').trim() || String(searchAlbum.name || '').trim() || hints && hints.album || '';
  merged.id = detail.id || searchItem.id || hints && hints.id || '';
  merged.name = String(detail.name || '').trim() || String(searchItem.name || '').trim() || hints && (hints.name || hints.title) || '';
  merged.ar = artists;
  merged.artists = artists;
  merged.al = album;
  merged.album = album;
  merged.dt = detail.dt || detail.duration || searchItem.dt || searchItem.duration || neteaseSourceMatchDurationMs(hints && hints.duration);
  ['h', 'm', 'l', 'sq', 'hr', 'hMusic', 'mMusic', 'lMusic', 'sqMusic', 'hrMusic'].forEach(key => {
    if (!merged[key] && searchItem[key]) merged[key] = searchItem[key];
  });
  return merged;
}
async function findNeteaseSameTrackCandidates(id, hints, lookupDeadline) {
  hints = hints || {};
  const deadline = Number(lookupDeadline) > 0 ? Number(lookupDeadline) : Date.now() + NETEASE_SOURCE_MATCH_LOOKUP_BUDGET_MS;
  const sourceId = String(id || '').trim();
  const title = String(hints.name || hints.title || '').trim();
  const artist = String(hints.artist || '').trim();
  if (!sourceId || !title || !artist) return [];
  const cacheKey = neteaseSourceMatchCacheKey(sourceId, hints);
  const cached = readNeteaseSourceMatchCache(cacheKey);
  if (cached) return cached;
  const query = [title, artist].filter(Boolean).join(' ');
  let searchSongs = [];
  try {
    const searchBudget = Math.min(3000, Math.max(500, deadline - Date.now()));
    const result = await promiseWithTimeout(cloudsearch({ keywords: query, type: 1, limit: 16, cookie: userCookie }), searchBudget, 'NETEASE_SOURCE_SEARCH_TIMEOUT');
    searchSongs = result.body && result.body.result && Array.isArray(result.body.result.songs) ? result.body.result.songs : [];
  } catch (err) {
    console.warn('[NeteaseSourceMatch] search failed:', err.code || err.message);
    return [];
  }
  const searchById = new Map(searchSongs.map(song => [String(song && song.id || ''), song]));
  const detailIds = [sourceId].concat(searchSongs.slice(0, 12).map(song => String(song && song.id || '')).filter(Boolean));
  let detailSongs = [];
  let privileges = [];
  try {
    const detailBudget = Math.min(2000, Math.max(500, deadline - Date.now()));
    const detail = await promiseWithTimeout(song_detail({ ids: [...new Set(detailIds)].join(','), cookie: userCookie }), detailBudget, 'NETEASE_SOURCE_DETAIL_TIMEOUT');
    detailSongs = detail.body && Array.isArray(detail.body.songs) ? detail.body.songs : [];
    privileges = detail.body && Array.isArray(detail.body.privileges) ? detail.body.privileges : [];
  } catch (err) {
    console.warn('[NeteaseSourceMatch] detail failed:', err.code || err.message);
  }
  const privilegeById = new Map(privileges.map(item => [String(item && item.id || ''), item]));
  const detailById = new Map(detailSongs.map(song => [String(song && song.id || ''), song]));
  const sourceDetail = detailById.get(sourceId) || searchById.get(sourceId) || null;
  const officialRecommendationId = String(sourceDetail && sourceDetail.noCopyrightRcmd && sourceDetail.noCopyrightRcmd.songId || '');
  if (officialRecommendationId && !detailById.has(officialRecommendationId) && !searchById.has(officialRecommendationId) && deadline - Date.now() >= 500) {
    try {
      const officialDetail = await promiseWithTimeout(song_detail({ ids: officialRecommendationId, cookie: userCookie }), Math.min(1000, Math.max(500, deadline - Date.now())), 'NETEASE_OFFICIAL_MATCH_DETAIL_TIMEOUT');
      const officialSongs = officialDetail.body && Array.isArray(officialDetail.body.songs) ? officialDetail.body.songs : [];
      const officialPrivileges = officialDetail.body && Array.isArray(officialDetail.body.privileges) ? officialDetail.body.privileges : [];
      officialSongs.forEach(song => detailById.set(String(song && song.id || ''), song));
      officialPrivileges.forEach(item => privilegeById.set(String(item && item.id || ''), item));
    } catch (err) {
      console.warn('[NeteaseSourceMatch] official alternate detail failed:', err.code || err.message);
    }
  }
  const source = mergeNeteaseSourceMatchSong(detailById.get(sourceId), searchById.get(sourceId), {
    ...hints,
    id: sourceId,
    name: title,
    artist,
  });
  const ranked = [];
  const candidateSeeds = searchSongs.slice();
  if (officialRecommendationId && !candidateSeeds.some(song => String(song && song.id || '') === officialRecommendationId)) {
    const officialSeed = detailById.get(officialRecommendationId) || { id: officialRecommendationId, name: title, ar: neteaseSourceMatchHintArtists(hints), dt: neteaseSourceMatchDurationMs(hints.duration) };
    candidateSeeds.unshift(officialSeed);
  }
  candidateSeeds.forEach(searchSong => {
    const candidateId = String(searchSong && searchSong.id || '');
    if (!candidateId || candidateId === sourceId) return;
    const candidate = mergeNeteaseSourceMatchSong(detailById.get(candidateId), searchSong, {});
    candidate.__privilege = privilegeById.get(candidateId) || searchSong.privilege || {};
    candidate.__officialSourceMatch = !!(officialRecommendationId && candidateId === officialRecommendationId);
    const score = neteaseSourceMatchCandidateScore(source, candidate);
    if (score < 0) return;
    ranked.push({
      song: mapSongRecord(candidate),
      score,
      fingerprintMatches: neteaseSourceMatchFingerprintCount(source, candidate),
      officialRecommendation: !!candidate.__officialSourceMatch,
      durationDiff: Math.abs(neteaseSourceMatchDurationMs(source.dt || source.duration) - neteaseSourceMatchDurationMs(candidate.dt || candidate.duration)),
    });
  });
  ranked.sort((a, b) => b.score - a.score || a.durationDiff - b.durationDiff || Number(b.song.popularity || 0) - Number(a.song.popularity || 0));
  const candidates = ranked.slice(0, NETEASE_SOURCE_MATCH_MAX_CANDIDATES);
  writeNeteaseSourceMatchCache(cacheKey, candidates);
  return candidates;
}

async function handleNeteaseAlbumDetail(id, limit) {
  const albumId = String(id || '').trim();
  const num = Math.max(10, Math.min(120, parseInt(limit || '80', 10) || 80));
  if (!albumId) return { provider: 'netease', error: 'MISSING_ALBUM_ID', album: null, songs: [] };
  const result = await album({ id: albumId, cookie: userCookie, timestamp: Date.now() });
  const body = result.body || result || {};
  const info = body.album || body.data && (body.data.album || body.data) || {};
  const rawSongs = Array.isArray(body.songs) ? body.songs : (Array.isArray(info.songs) ? info.songs : []);
  const artists = mapArtists(info.artists || info.ar || []);
  const songs = rawSongs
    .slice(0, num)
    .map(song => mapSongRecord(song))
    .filter(song => song && song.id);
  return {
    provider: 'netease',
    album: {
      provider: 'netease',
      id: info.id || albumId,
      albumId: info.id || albumId,
      name: info.name || '',
      artist: artists.map(a => a.name).join(' / ') || info.artist && info.artist.name || (songs[0] && songs[0].artist) || '',
      artists,
      cover: info.picUrl || info.coverUrl || '',
      releaseDate: info.publishTime || info.publishTime === 0 ? info.publishTime : '',
      trackCount: Number(info.size || info.trackCount || rawSongs.length) || songs.length,
    },
    songs,
    total: Number(info.size || info.trackCount || rawSongs.length) || songs.length,
  };
}

function mapDailyRecommendationSongs(raw) {
  return (Array.isArray(raw) ? raw : [])
    .map(mapSongRecord)
    .filter(song => song && song.id && song.name);
}

async function handleDiscoverHome() {
  const info = await getLoginInfo();
  const loggedIn = !!(info && info.loggedIn);
  if (!loggedIn) {
    return {
      loggedIn: false,
      user: null,
      dailySongs: [],
      dailySongTotal: 0,
      dailySongsComplete: true,
      playlists: [],
      podcasts: [],
      mode: 'starter',
      updatedAt: Date.now(),
    };
  }
  const tasks = [
    personalized({ limit: 8, cookie: userCookie, timestamp: Date.now() }),
    recommend_resource({ cookie: userCookie, timestamp: Date.now() }),
    recommend_songs({ cookie: userCookie, timestamp: Date.now() }),
  ];
  const result = await Promise.allSettled(tasks);

  const personalizedBody = result[0].status === 'fulfilled' && result[0].value && result[0].value.body || {};
  const publicPlaylists = (personalizedBody.result || personalizedBody.data || [])
    .map(pl => mapDiscoverPlaylist(pl, '推荐歌单'))
    .filter(pl => pl.id && pl.name)
    .slice(0, 8);

  let privatePlaylists = [];
  if (result[1].status === 'fulfilled' && result[1].value) {
    const body = result[1].value.body || {};
    const raw = body.recommend || body.data || [];
    privatePlaylists = (Array.isArray(raw) ? raw : [])
      .map(pl => mapDiscoverPlaylist(pl, '私人推荐'))
      .filter(pl => pl.id && pl.name)
      .slice(0, 6);
  }

  let dailySongs = [];
  if (result[2].status === 'fulfilled' && result[2].value) {
    const body = result[2].value.body || {};
    const raw = body.data && (body.data.dailySongs || body.data.recommend) || body.recommend || [];
    dailySongs = mapDailyRecommendationSongs(raw);
  }

  return {
    loggedIn,
    user: loggedIn ? { userId: info.userId, nickname: info.nickname || '', avatar: info.avatar || '' } : null,
    dailySongs,
    dailySongTotal: dailySongs.length,
    dailySongsComplete: true,
    playlists: privatePlaylists.concat(publicPlaylists).slice(0, 10),
    podcasts: [],
    updatedAt: Date.now(),
  };
}

const QQ_MUSICU_URL = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
const QQ_SMARTBOX_URL = 'https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg';
const QQ_HEADERS = {
  Referer: 'https://y.qq.com/',
  'User-Agent': UA,
};
const QQ_VIP_INFO_CACHE_TTL_MS = 2 * 60 * 1000;
const qqVipInfoCache = new Map();

function requestText(targetUrl, opts, body) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method: opts.method || 'GET',
      headers: opts.headers || {},
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (response.statusCode >= 400) {
          const err = new Error('HTTP ' + response.statusCode);
          err.statusCode = response.statusCode;
          err.body = text;
          reject(err);
          return;
        }
        resolve(text);
      });
    });
    req.setTimeout(opts.timeoutMs || 10000, () => req.destroy(new Error('Request timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function requestJson(targetUrl, opts, body) {
  const text = await requestText(targetUrl, opts, body);
  try {
    return JSON.parse(text);
  } catch (e) {
    const err = new Error('Invalid JSON from ' + targetUrl);
    err.cause = e;
    throw err;
  }
}

function clampNumber(value, min, max, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function openMeteoWeatherLabel(code) {
  code = Number(code);
  if (code === 0) return '晴';
  if (code === 1 || code === 2) return '少云';
  if (code === 3) return '阴';
  if (code === 45 || code === 48) return '雾';
  if (code === 51 || code === 53 || code === 55) return '毛毛雨';
  if (code === 56 || code === 57) return '冻雨';
  if (code === 61 || code === 63 || code === 65) return '雨';
  if (code === 66 || code === 67) return '冻雨';
  if (code === 71 || code === 73 || code === 75 || code === 77) return '雪';
  if (code === 80 || code === 81 || code === 82) return '阵雨';
  if (code === 85 || code === 86) return '阵雪';
  if (code === 95 || code === 96 || code === 99) return '雷雨';
  return '天气';
}

function buildWeatherMood(weather, date) {
  const now = date || new Date();
  const hour = now.getHours();
  const code = Number(weather && weather.weatherCode);
  const temp = Number(weather && weather.temperature);
  const apparent = Number(weather && weather.apparentTemperature);
  const rain = Number(weather && weather.precipitation) || 0;
  const humidity = Number(weather && weather.humidity) || 0;
  const wind = Number(weather && weather.windSpeed) || 0;
  const isNight = weather && weather.isDay === 0 || hour < 6 || hour >= 20;
  const isMorning = hour >= 5 && hour < 11;
  const isDusk = hour >= 17 && hour < 20;
  const isRain = rain > 0 || [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99].includes(code);
  const isSnow = [71, 73, 75, 77, 85, 86].includes(code);
  const isCloud = [2, 3, 45, 48].includes(code);
  const isStorm = [95, 96, 99].includes(code);
  const feels = Number.isFinite(apparent) ? apparent : temp;

  let mood = {
    key: 'clear',
    title: '晴朗电台',
    tagline: '让节奏亮一点，像窗边的光',
    energy: 0.62,
    warmth: 0.58,
    focus: 0.48,
    melancholy: 0.24,
    keywords: ['轻快 华语', 'city pop', 'indie pop', 'chill pop', '阳光 歌单'],
  };
  if (isStorm) {
    mood = {
      key: 'storm',
      title: '雷雨电台',
      tagline: '低频更厚，适合把世界关小一点',
      energy: 0.46,
      warmth: 0.34,
      focus: 0.66,
      melancholy: 0.62,
      keywords: ['暗色 R&B', 'trip hop', '夜晚 电子', '氛围 摇滚', '雨夜 歌单'],
    };
  } else if (isRain) {
    mood = {
      key: 'rain',
      title: '雨天电台',
      tagline: '留一点潮湿的空间给旋律',
      energy: 0.38,
      warmth: 0.42,
      focus: 0.64,
      melancholy: 0.66,
      keywords: ['雨天 R&B', 'lofi rainy', '华语 慢歌', 'dream pop', '雨夜 歌单'],
    };
  } else if (isSnow || feels <= 3) {
    mood = {
      key: 'snow',
      title: '冷空气电台',
      tagline: '干净、慢速、带一点冬天的颗粒感',
      energy: 0.34,
      warmth: 0.28,
      focus: 0.72,
      melancholy: 0.54,
      keywords: ['冬天 民谣', 'ambient piano', '日系 冬天', 'indie folk', '安静 歌单'],
    };
  } else if (feels >= 31 || humidity >= 78) {
    mood = {
      key: 'humid',
      title: '闷热电台',
      tagline: '降低密度，留出一点呼吸',
      energy: 0.48,
      warmth: 0.76,
      focus: 0.46,
      melancholy: 0.30,
      keywords: ['夏日 chill', 'bossa nova', 'city pop 夏天', '轻电子', '海边 歌单'],
    };
  } else if (isCloud) {
    mood = {
      key: 'cloudy',
      title: '阴天电台',
      tagline: '不急着明亮，先让声音变软',
      energy: 0.40,
      warmth: 0.46,
      focus: 0.58,
      melancholy: 0.52,
      keywords: ['阴天 华语', 'indie rock mellow', 'neo soul', 'chillhop', '独立 民谣'],
    };
  }

  if (isNight) {
    mood.key += '-night';
    mood.title = mood.key.startsWith('clear') ? '夜色电台' : mood.title.replace('电台', '夜听');
    mood.tagline = '音量放低一点，让夜色参与编曲';
    mood.energy = Math.min(mood.energy, 0.42);
    mood.focus = Math.max(mood.focus, 0.68);
    mood.melancholy = Math.max(mood.melancholy, 0.52);
    mood.keywords = ['夜晚 R&B', 'late night jazz', 'ambient', 'lofi sleep', '夜跑 歌单'].concat(mood.keywords.slice(0, 3));
  } else if (isMorning) {
    mood.title = mood.key.startsWith('rain') ? '雨晨电台' : '早晨电台';
    mood.energy = Math.max(mood.energy, 0.52);
    mood.keywords = ['早晨 通勤', 'morning acoustic', '清晨 indie', '轻快 华语'].concat(mood.keywords.slice(0, 3));
  } else if (isDusk) {
    mood.title = mood.key.startsWith('rain') ? '黄昏雨声' : '黄昏电台';
    mood.melancholy = Math.max(mood.melancholy, 0.48);
    mood.keywords = ['黄昏 city pop', '日落 歌单', '落日飞车', 'soul pop'].concat(mood.keywords.slice(0, 3));
  }

  if (wind >= 28) {
    mood.energy = Math.max(mood.energy, 0.56);
    mood.keywords = ['公路 摇滚', 'windy day playlist'].concat(mood.keywords.slice(0, 4));
  }
  mood.keywords = Array.from(new Set(mood.keywords)).slice(0, 7);
  return mood;
}

async function resolveOpenMeteoLocation(query) {
  const raw = String(query || '').trim();
  if (!raw) return WEATHER_DEFAULT_LOCATION;
  const u = new URL(OPEN_METEO_GEOCODE_URL);
  u.searchParams.set('name', raw);
  u.searchParams.set('count', '1');
  u.searchParams.set('language', 'zh');
  u.searchParams.set('format', 'json');
  const body = await requestJson(u.toString(), { headers: { 'User-Agent': UA } });
  const first = body && Array.isArray(body.results) && body.results[0];
  if (!first) return { ...WEATHER_DEFAULT_LOCATION, query: raw, fallback: true };
  return {
    name: first.name || raw,
    country: first.country || '',
    admin1: first.admin1 || '',
    latitude: first.latitude,
    longitude: first.longitude,
    timezone: first.timezone || 'auto',
  };
}

async function fetchOpenMeteoWeather(params) {
  params = params || {};
  let location;
  const lat = clampNumber(params.lat, -90, 90, NaN);
  const lon = clampNumber(params.lon, -180, 180, NaN);
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    location = {
      name: String(params.city || params.name || '当前位置').trim() || '当前位置',
      country: '',
      latitude: lat,
      longitude: lon,
      timezone: params.timezone || 'auto',
    };
  } else {
    location = await resolveOpenMeteoLocation(params.city || params.q || params.location);
  }
  const u = new URL(OPEN_METEO_FORECAST_URL);
  u.searchParams.set('latitude', String(location.latitude));
  u.searchParams.set('longitude', String(location.longitude));
  u.searchParams.set('current', 'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,rain,showers,snowfall,weather_code,cloud_cover,wind_speed_10m,wind_gusts_10m');
  u.searchParams.set('hourly', 'precipitation_probability,weather_code,temperature_2m');
  u.searchParams.set('forecast_days', '1');
  u.searchParams.set('timezone', location.timezone || 'auto');
  const body = await requestJson(u.toString(), { headers: { 'User-Agent': UA } });
  const cur = body && body.current || {};
  const weather = {
    provider: 'open-meteo',
    location: {
      name: location.name,
      country: location.country || '',
      admin1: location.admin1 || '',
      latitude: location.latitude,
      longitude: location.longitude,
      timezone: body.timezone || location.timezone || '',
      fallback: !!location.fallback,
    },
    label: openMeteoWeatherLabel(cur.weather_code),
    weatherCode: Number(cur.weather_code),
    temperature: Number(cur.temperature_2m),
    apparentTemperature: Number(cur.apparent_temperature),
    humidity: Number(cur.relative_humidity_2m),
    precipitation: Number(cur.precipitation || cur.rain || cur.showers || cur.snowfall || 0),
    cloudCover: Number(cur.cloud_cover),
    windSpeed: Number(cur.wind_speed_10m),
    windGusts: Number(cur.wind_gusts_10m),
    isDay: Number(cur.is_day),
    time: cur.time || '',
    updatedAt: Date.now(),
  };
  weather.mood = buildWeatherMood(weather);
  return weather;
}

async function fetchIpWeatherLocation() {
  if (weatherIpLocationCache && Date.now() - weatherIpLocationCache.at < WEATHER_IP_LOCATION_CACHE_TTL_MS) {
    return weatherIpLocationCache.value;
  }
  const failures = [];
  for (const source of WEATHER_IP_LOCATION_SOURCES) {
    try {
      const body = await requestJson(source.url, {
        headers: { 'User-Agent': UA },
        timeoutMs: WEATHER_IP_LOCATION_TIMEOUT_MS,
      });
      const parsed = source.parse(body);
      const latitude = Number(parsed && parsed.latitude);
      const longitude = Number(parsed && parsed.longitude);
      if (!parsed || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        failures.push(source.provider + ': unusable payload');
        continue;
      }
      const value = {
        provider: source.provider,
        city: parsed.city || WEATHER_DEFAULT_LOCATION.name,
        region: parsed.region || '',
        country: parsed.country || '',
        latitude,
        longitude,
        timezone: parsed.timezone || 'auto',
        ip: parsed.ip || '',
      };
      weatherIpLocationCache = { at: Date.now(), value };
      return value;
    } catch (err) {
      failures.push(source.provider + ': ' + (err && err.message || 'failed'));
    }
  }
  const err = new Error('IP_LOCATION_FAILED');
  err.failures = failures;
  throw err;
}

function weatherRadioSeedQueries(mood) {
  const key = String(mood && mood.key || '');
  if (key.includes('rain') || key.includes('storm')) return ['陈奕迅 阴天快乐', '周杰伦 雨下一整晚', '孙燕姿 遇见', '林宥嘉 说谎', '毛不易 消愁'];
  if (key.includes('snow') || key.includes('cloudy')) return ['陈奕迅 好久不见', '莫文蔚 阴天', '李健 贝加尔湖畔', '朴树 平凡之路', '蔡健雅 达尔文'];
  if (key.includes('humid')) return ['落日飞车 My Jinji', '告五人 爱人错过', '夏日入侵企画 想去海边', '陈绮贞 旅行的意义', '王若琳 Lost in Paradise'];
  if (key.includes('night')) return ['方大同 特别的人', '陶喆 爱很简单', 'Frank Ocean Pink + White', '林忆莲 夜太黑', "Norah Jones Don't Know Why"];
  return ['孙燕姿 天黑黑', '周杰伦 晴天', '五月天 温柔', '陈奕迅 稳稳的幸福', '王菲'];
}

function fallbackWeatherForRadio(params, err) {
  params = params || {};
  const name = String(params.city || params.q || params.location || WEATHER_DEFAULT_LOCATION.name).trim() || WEATHER_DEFAULT_LOCATION.name;
  return {
    provider: 'open-meteo',
    location: {
      name,
      country: '',
      admin1: '',
      latitude: null,
      longitude: null,
      timezone: params.timezone || WEATHER_DEFAULT_LOCATION.timezone,
      fallback: true,
    },
    label: '天气暂不可用',
    weatherCode: null,
    temperature: null,
    apparentTemperature: null,
    humidity: null,
    precipitation: null,
    cloudCover: null,
    windSpeed: null,
    windGusts: null,
    isDay: null,
    time: '',
    updatedAt: Date.now(),
    error: err && err.message || '',
    mood: {
      key: 'fallback',
      title: '临时电台',
      tagline: '天气暂时没有回来，先放一组稳妥的歌',
      energy: 0.54,
      warmth: 0.55,
      focus: 0.55,
      melancholy: 0.35,
      keywords: ['华语 流行', 'indie pop', 'city pop', '轻快 歌单', 'chill pop'],
    },
  };
}

function uniqueSongsByKey(songs) {
  const seen = new Set();
  const out = [];
  (songs || []).forEach(song => {
    const key = String(song && (song.id || song.name + '|' + song.artist) || '').trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(song);
  });
  return out;
}

function tagWeatherPoolSongs(songs, source) {
  return (songs || []).map(song => ({ ...song, weatherSource: source }));
}

async function fetchWeatherPlaylistSongs(playlist, limit) {
  const id = playlist && playlist.id;
  if (!id) return [];
  let rawTracks = [];
  try {
    if (typeof playlist_track_all === 'function') {
      const all = await playlist_track_all({ id, limit: limit || 36, offset: 0, cookie: userCookie, timestamp: Date.now() });
      rawTracks = (all.body && (all.body.songs || all.body.tracks)) || [];
    }
  } catch (e) {
    console.warn('[WeatherRadio] playlist_track_all failed:', playlist && playlist.name, e.message);
  }
  if (!rawTracks.length && typeof playlist_detail === 'function') {
    try {
      const detail = await playlist_detail({ id, s: 0, cookie: userCookie, timestamp: Date.now() });
      const pl = (detail.body && detail.body.playlist) || {};
      rawTracks = pl.tracks || [];
    } catch (e) {
      console.warn('[WeatherRadio] playlist_detail failed:', playlist && playlist.name, e.message);
    }
  }
  return rawTracks.map(mapSongRecord).filter(song => song.id && song.name).slice(0, limit || 36);
}

const NETEASE_PLAYLIST_SYNC_PAGE_SIZE = 200;
const NETEASE_PLAYLIST_SYNC_MAX_PAGES = 80;
const NETEASE_TRACK_SYNC_PAGE_SIZE = 500;
const NETEASE_TRACK_SYNC_MAX_PAGES = 80;
const NETEASE_TRACK_STREAM_PAGE_SIZE = 200;
const NETEASE_PLAYLIST_TRACK_INDEX_TTL_MS = 10 * 60 * 1000;
const NETEASE_PLAYLIST_TRACK_INDEX_MAX_ENTRIES = 8;
const neteasePlaylistTrackIndexCache = new Map();
const neteasePlaylistTrackIndexInflight = new Map();

function mapNeteasePlaylistMeta(pl, fallbackId) {
  pl = pl || {};
  return {
    id: pl.id || fallbackId,
    name: pl.name || '',
    cover: pl.coverImgUrl || pl.cover || '',
    trackCount: pl.trackCount || pl.track_count || 0,
    playCount: pl.playCount || pl.play_count || 0,
    creator: (pl.creator && pl.creator.nickname) || pl.creatorNickname || '',
    subscribed: !!pl.subscribed,
    specialType: pl.specialType || 0,
  };
}

function mergeUniqueNeteasePlaylists(target, incoming, seen) {
  (incoming || []).forEach(pl => {
    const id = String(pl && pl.id || '').trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    target.push(pl);
  });
}

async function fetchAllNeteaseUserPlaylists(uid, maxItems) {
  const playlists = [];
  const seen = new Set();
  let offset = 0;
  let total = 0;
  for (let page = 0; page < NETEASE_PLAYLIST_SYNC_MAX_PAGES; page += 1) {
    const r = await user_playlist({
      uid,
      limit: NETEASE_PLAYLIST_SYNC_PAGE_SIZE,
      offset,
      cookie: userCookie,
      timestamp: Date.now(),
    });
    const body = r.body || r || {};
    const raw = Array.isArray(body.playlist) ? body.playlist : [];
    total = Number(body.total || body.count || total) || total;
    mergeUniqueNeteasePlaylists(playlists, raw, seen);
    if (maxItems && playlists.length >= maxItems) break;
    if (!raw.length || raw.length < NETEASE_PLAYLIST_SYNC_PAGE_SIZE) break;
    if (total && playlists.length >= total) break;
    offset += NETEASE_PLAYLIST_SYNC_PAGE_SIZE;
  }
  return maxItems ? playlists.slice(0, maxItems) : playlists;
}

async function fetchNeteaseUserPlaylistsPage(uid, limit, offset) {
  limit = Math.max(1, Math.min(NETEASE_PLAYLIST_SYNC_PAGE_SIZE, parseInt(limit || '48', 10) || 48));
  offset = Math.max(0, parseInt(offset || '0', 10) || 0);
  const r = await user_playlist({
    uid,
    limit,
    offset,
    cookie: userCookie,
    timestamp: Date.now(),
  });
  const body = r.body || r || {};
  const playlists = Array.isArray(body.playlist) ? body.playlist : [];
  const total = Math.max(Number(body.total || body.count || 0) || 0, offset + playlists.length);
  const nextOffset = offset + playlists.length;
  return {
    playlists,
    total,
    offset,
    limit,
    nextOffset,
    hasMore: total ? nextOffset < total : playlists.length >= limit,
  };
}

function neteaseRawTrackKey(track, fallback) {
  track = track || {};
  const privilege = track.privilege || {};
  const album = track.al || track.album || {};
  return String(
    track.id ||
    track.songId ||
    track.resourceId ||
    privilege.id ||
    ((track.name || '') + '|' + (album.id || album.name || '') + '|' + fallback)
  );
}

function mergeUniqueNeteaseTracks(target, incoming, seen) {
  let added = 0;
  (incoming || []).forEach((track, index) => {
    const key = neteaseRawTrackKey(track, target.length + ':' + index);
    if (!key || seen.has(key)) return;
    seen.add(key);
    target.push(track);
    added += 1;
  });
  return added;
}

async function fetchNeteasePlaylistDetailMeta(id) {
  if (typeof playlist_detail !== 'function') return { playlistMeta: { id, name: '', cover: '', trackCount: 0 }, tracks: [] };
  const detail = await playlist_detail({ id, s: 0, cookie: userCookie, timestamp: Date.now() });
  const pl = (detail.body && detail.body.playlist) || {};
  return { playlistMeta: mapNeteasePlaylistMeta(pl, id), tracks: Array.isArray(pl.tracks) ? pl.tracks : [] };
}

function pruneNeteasePlaylistTrackIndexCache() {
  const now = Date.now();
  for (const [key, entry] of neteasePlaylistTrackIndexCache.entries()) {
    if (!entry || now - entry.updatedAt > NETEASE_PLAYLIST_TRACK_INDEX_TTL_MS) {
      neteasePlaylistTrackIndexCache.delete(key);
    }
  }
  while (neteasePlaylistTrackIndexCache.size > NETEASE_PLAYLIST_TRACK_INDEX_MAX_ENTRIES) {
    const oldestKey = neteasePlaylistTrackIndexCache.keys().next().value;
    if (oldestKey == null) break;
    neteasePlaylistTrackIndexCache.delete(oldestKey);
  }
}

function invalidateNeteasePlaylistTrackIndex(id) {
  const key = String(id || '');
  if (key) neteasePlaylistTrackIndexCache.delete(key);
}

async function fetchNeteasePlaylistTrackIndex(id) {
  const key = String(id || '');
  if (!key || typeof playlist_detail !== 'function') return null;
  pruneNeteasePlaylistTrackIndexCache();
  const cached = neteasePlaylistTrackIndexCache.get(key);
  if (cached && Date.now() - cached.updatedAt <= NETEASE_PLAYLIST_TRACK_INDEX_TTL_MS) {
    neteasePlaylistTrackIndexCache.delete(key);
    neteasePlaylistTrackIndexCache.set(key, cached);
    return cached;
  }
  if (neteasePlaylistTrackIndexInflight.has(key)) return neteasePlaylistTrackIndexInflight.get(key);
  const pending = (async () => {
    const detail = await playlist_detail({ id, s: 0, cookie: userCookie, timestamp: Date.now() });
    const pl = (detail.body && detail.body.playlist) || {};
    const rawIds = Array.isArray(pl.trackIds) && pl.trackIds.length ? pl.trackIds : (pl.tracks || []);
    const trackIds = rawIds.map(item => item && (item.id || item.songId || item.trackId)).filter(Boolean);
    const entry = {
      playlistMeta: mapNeteasePlaylistMeta(pl, id),
      trackIds,
      updatedAt: Date.now(),
    };
    if (!entry.playlistMeta.trackCount) entry.playlistMeta.trackCount = trackIds.length;
    neteasePlaylistTrackIndexCache.set(key, entry);
    pruneNeteasePlaylistTrackIndexCache();
    return entry;
  })().finally(() => {
    neteasePlaylistTrackIndexInflight.delete(key);
  });
  neteasePlaylistTrackIndexInflight.set(key, pending);
  return pending;
}

async function fetchAllNeteasePlaylistTracks(id) {
  let playlistMeta = { id, name: '', cover: '', trackCount: 0 };
  let detailTracks = [];
  try {
    const detail = await fetchNeteasePlaylistDetailMeta(id);
    playlistMeta = detail.playlistMeta || playlistMeta;
    detailTracks = detail.tracks || [];
  } catch (err) {
    console.warn('[PlaylistTracks] playlist_detail meta failed:', err.message);
  }

  const rawTracks = [];
  const seen = new Set();
  const expectedTotal = Number(playlistMeta.trackCount || 0) || 0;

  if (typeof playlist_track_all === 'function') {
    let offset = 0;
    for (let page = 0; page < NETEASE_TRACK_SYNC_MAX_PAGES; page += 1) {
      try {
        const all = await playlist_track_all({
          id,
          limit: NETEASE_TRACK_SYNC_PAGE_SIZE,
          offset,
          cookie: userCookie,
          timestamp: Date.now(),
        });
        const body = all.body || all || {};
        const rows = (body.songs || body.tracks || []);
        const added = mergeUniqueNeteaseTracks(rawTracks, rows, seen);
        if (!rows.length || !added) break;
        if (expectedTotal && rawTracks.length >= expectedTotal) break;
        if (!expectedTotal && rows.length < NETEASE_TRACK_SYNC_PAGE_SIZE) break;
        offset += NETEASE_TRACK_SYNC_PAGE_SIZE;
      } catch (err) {
        console.warn('[PlaylistTracks] playlist_track_all page failed:', id, offset, err.message);
        break;
      }
    }
  }

  if (!rawTracks.length && detailTracks.length) {
    mergeUniqueNeteaseTracks(rawTracks, detailTracks, seen);
  }

  return { playlistMeta, rawTracks };
}

async function fetchNeteasePlaylistTracksPage(id, limit, offset) {
  limit = Math.max(1, Math.min(NETEASE_TRACK_STREAM_PAGE_SIZE, parseInt(limit || '48', 10) || 48));
  offset = Math.max(0, parseInt(offset || '0', 10) || 0);
  let rawTracks = [];
  let playlistMeta = { id, name: '', cover: '', trackCount: 0 };
  let total = 0;
  let requestedCount = 0;
  try {
    const index = await fetchNeteasePlaylistTrackIndex(id);
    if (index && index.trackIds && index.trackIds.length) {
      playlistMeta = index.playlistMeta || playlistMeta;
      total = index.trackIds.length;
      const pageIds = index.trackIds.slice(offset, offset + limit);
      requestedCount = pageIds.length;
      if (pageIds.length) {
        const detail = await song_detail({ ids: pageIds.join(','), cookie: userCookie, timestamp: Date.now() });
        const body = detail.body || detail || {};
        const rows = body.songs || body.tracks || [];
        const byId = new Map(rows.map(track => [String(track && track.id || ''), track]));
        rawTracks = pageIds.map(trackId => byId.get(String(trackId))).filter(Boolean);
      }
    }
  } catch (err) {
    console.warn('[PlaylistTracks] cached track index failed:', id, offset, err.message);
  }
  if (!requestedCount && !rawTracks.length && typeof playlist_track_all === 'function') {
    const page = await playlist_track_all({ id, limit, offset, cookie: userCookie, timestamp: Date.now() });
    const body = page.body || page || {};
    rawTracks = body.songs || body.tracks || [];
    requestedCount = rawTracks.length;
    total = Number(body.total || body.count || body.songCount || body.trackCount || 0) || 0;
  }
  if (!rawTracks.length && !requestedCount && typeof playlist_detail === 'function') {
    try {
      const detail = await fetchNeteasePlaylistDetailMeta(id);
      playlistMeta = detail.playlistMeta || playlistMeta;
      total = Math.max(total, Number(playlistMeta.trackCount || 0) || 0);
      if (!rawTracks.length) rawTracks = (detail.tracks || []).slice(offset, offset + limit);
    } catch (err) {
      console.warn('[PlaylistTracks] paged metadata failed:', id, err.message);
    }
  }
  if (!playlistMeta.trackCount && total) playlistMeta.trackCount = total;
  const nextOffset = offset + Math.max(requestedCount, rawTracks.length);
  return {
    playlistMeta,
    rawTracks,
    total,
    offset,
    limit,
    nextOffset,
    hasMore: total ? nextOffset < total : rawTracks.length >= limit,
  };
}

async function filterLikelyPlayableWeatherSongs(songs) {
  const source = uniqueSongsByKey(songs)
    .filter(song => song && song.name && song.id && !isLowSignalWeatherSong(song))
    .slice(0, 24);
  const playable = [];
  const fallback = source.slice(0, 24);
  for (let i = 0; i < source.length; i += 4) {
    const chunk = source.slice(i, i + 4);
    const settled = await Promise.allSettled(chunk.map(async song => {
      const info = await handleSongUrl(song.id, { loggedIn: !!userCookie }, 'standard');
      return info && info.url ? song : null;
    }));
    settled.forEach((result, idx) => {
      if (result.status === 'fulfilled' && result.value) playable.push(result.value);
      else if (result.status === 'rejected') console.warn('[WeatherRadio] playable probe failed:', chunk[idx] && chunk[idx].name, result.reason && result.reason.message);
    });
    if (playable.length >= 12) break;
  }
  return (playable.length ? playable : fallback).slice(0, 24);
}

function isLowSignalWeatherSong(song) {
  const text = String([
    song && song.name,
    song && song.artist,
    song && song.album,
  ].filter(Boolean).join(' ')).toLowerCase();
  if (!text) return true;
  if (/(^|[\s\-_/（(])ai(?:\s*(歌|歌曲|音乐|cover|翻唱|生成|作曲|演唱|女声|男声)|$|[\s\-_/）)])/i.test(text)) return true;
  if (/suno|udio|人工智能|生成歌曲|ai歌曲|虚拟歌手|测试音频|demo|beat\s*maker/i.test(text)) return true;
  if (/翻自|翻唱|cover|remix|伴奏|纯音乐|钢琴|dj|live\s*版|live版|唯美钢琴|karaoke|instrumental/i.test(text)) return true;
  if (/白噪音|雨声|睡眠|助眠|冥想|疗愈频率|环境音|自然声音|asmr/i.test(text)) return true;
  if (/[（(](r&b|lofi|jazz|dj|edm|trap|remix|伴奏|纯音乐|钢琴|电子|治愈|古风|女声|男声|英文|中文版|抖音|ai)[）)]/i.test(text)) return true;
  if (/^(纯音乐|轻音乐|治愈系|放松|睡眠|雨天|阴天|夜晚|夏日|海边)$/i.test(String(song.name || '').trim())) return true;
  return false;
}

function scoreWeatherSong(song, mood) {
  const text = String((song && song.name || '') + ' ' + (song && song.artist || '') + ' ' + (song && song.album || '')).toLowerCase();
  let score = 0;
  if (song && song.cover) score += 4;
  if (song && song.duration) score += 2;
  if (song && song.weatherSource === 'daily') score += 6;
  if (song && song.weatherSource === 'private') score += 4;
  if (/周杰伦|陈奕迅|孙燕姿|五月天|王菲|陶喆|方大同|林宥嘉|蔡健雅|莫文蔚|李健|毛不易|告五人|落日飞车|陈绮贞|朴树/.test(text)) score += 10;
  const key = String(mood && mood.key || '');
  if (key.includes('rain') && /雨|阴|夜|慢|r&b|soul|陈奕迅|林宥嘉|孙燕姿/.test(text)) score += 5;
  if (key.includes('humid') && /夏|海|city|pop|落日|告五人|方大同|陶喆/.test(text)) score += 5;
  if (key.includes('night') && /夜|moon|jazz|soul|r&b|方大同|陶喆|王菲/.test(text)) score += 5;
  if (key.includes('cloudy') && /阴|民谣|indie|陈绮贞|朴树|李健/.test(text)) score += 5;
  return score;
}

function weatherArtistKey(song) {
  const raw = String(song && song.artist || song && song.name || '').split(/\s*\/\s*|、|,|&/)[0] || '';
  return raw.trim().toLowerCase() || 'unknown';
}

function weatherTitleKey(song) {
  return String(song && song.name || '')
    .toLowerCase()
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[\s._\-·'’"“”「」《》:：/\\|]+/g, '')
    .trim();
}

function uniqueWeatherTitles(sorted) {
  const seen = new Set();
  const out = [];
  (sorted || []).forEach(song => {
    const key = weatherTitleKey(song);
    if (key && seen.has(key)) return;
    if (key) seen.add(key);
    out.push(song);
  });
  return out;
}

function diversifyWeatherSongs(sorted, artistLimit) {
  const primary = [];
  const deferred = [];
  const counts = new Map();
  (sorted || []).forEach(song => {
    const key = weatherArtistKey(song);
    const count = counts.get(key) || 0;
    if (count < artistLimit) {
      primary.push(song);
      counts.set(key, count + 1);
    } else {
      deferred.push(song);
    }
  });
  return primary.length >= 8 ? primary : primary.concat(deferred.slice(0, 8 - primary.length));
}

function orderWeatherSongs(songs, mood) {
  const sorted = uniqueSongsByKey(songs)
    .filter(song => song && song.name && song.id && !isLowSignalWeatherSong(song))
    .sort((a, b) => scoreWeatherSong(b, mood) - scoreWeatherSong(a, mood));
  return diversifyWeatherSongs(uniqueWeatherTitles(sorted), 2);
}

async function buildWeatherRadio(params) {
  let weather;
  try {
    weather = await fetchOpenMeteoWeather(params);
  } catch (e) {
    console.warn('[WeatherRadio] weather provider failed, using fallback radio:', e.message);
    weather = fallbackWeatherForRadio(params, e);
  }
  const queries = weatherRadioSeedQueries(weather.mood);
  let songs = [];
  const settled = await Promise.allSettled(queries.slice(0, 4).map(q => handleSearch(q, 6)));
  settled.forEach(result => {
    if (result.status === 'fulfilled' && Array.isArray(result.value)) songs = songs.concat(result.value);
  });
  if (songs.length < 10 && weather.mood && Array.isArray(weather.mood.keywords)) {
    const more = await Promise.allSettled(weather.mood.keywords.slice(0, 2).map(q => handleSearch(q, 6)));
    more.forEach(result => {
      if (result.status === 'fulfilled' && Array.isArray(result.value)) songs = songs.concat(result.value);
    });
  }
  songs = orderWeatherSongs(songs, weather.mood);
  return {
    ok: true,
    weather,
    radio: {
      title: weather.mood.title,
      subtitle: weather.mood.tagline,
      seedQueries: queries.slice(0, 4),
      songs: songs.slice(0, 18),
      updatedAt: Date.now(),
    },
  };
}

function parseJSONText(text) {
  const raw = String(text || '').trim();
  const json = raw.replace(/^callback\(([\s\S]*)\);?$/, '$1');
  return JSON.parse(json);
}

async function qqMusicRequest(payload, opts) {
  opts = opts || {};
  const body = JSON.stringify(payload);
  const headers = {
    ...QQ_HEADERS,
    'Content-Type': 'application/json;charset=UTF-8',
    'Content-Length': Buffer.byteLength(body),
  };
  if (opts.cookie && qqCookie) headers.Cookie = qqCookie;
  const text = await requestText(QQ_MUSICU_URL, {
    method: 'POST',
    headers,
    timeoutMs: opts.timeoutMs,
  }, body);
  return parseJSONText(text);
}

function qqVipObjectLooksExpired(obj) {
  return qqVipObjectLooksExpiredStrict(obj);
}

function normalizeQQVipPayload(payload, fallback) {
  return normalizeQQVipPayloadStrict(payload, fallback || {});
}

function withQQVipSyncState(info, probeAvailable) {
  info = info || {};
  const authIncomplete = !!(info.loggedIn && !info.playbackKeyReady);
  const membershipUnknown = !!(info.loggedIn && info.membershipKnown !== true);
  const membershipStale = !!(info.loggedIn && (
    authIncomplete
    || membershipUnknown
    || (info.profileUnavailable && !probeAvailable)
  ));
  return {
    ...info,
    membershipStale,
    authorizationIncomplete: authIncomplete,
    vipSyncState: authIncomplete
      ? 'authorization_incomplete'
      : (membershipUnknown ? 'unknown' : (probeAvailable ? 'checked' : (membershipStale ? 'stale' : 'profile'))),
  };
}

function mergeQQVipStatus(info, vip, source) {
  info = info || {};
  const profilePositive = !!(
    info.isVip ||
    info.isSvip ||
    info.vipLevel === 'vip' ||
    info.vipLevel === 'svip' ||
    Number(info.vipType || 0) > 0 ||
    Number(info.svipType || 0) > 0
  );
  const probeKnown = !!(vip && vip.resolved && vip.membershipKnown !== false);
  if (!probeKnown) {
    return withQQVipSyncState({
      ...info,
      vipCheckedAt: Date.now(),
      vipProbeAvailable: false,
      vipSource: info.vipSource || 'profile',
    }, false);
  }
  // A verified positive profile result wins over a stale ordinary response
  // returned by one of QQ's replicated VIP query endpoints.
  if (profilePositive && !vip.isVip) {
    return withQQVipSyncState({
      ...info,
      membershipKnown: true,
      vipCheckedAt: Date.now(),
      vipProbeAvailable: true,
      vipEvidenceConflict: true,
      vipSource: info.vipSource || 'qq-profile-vip',
    }, true);
  }
  if (info.loggedIn && info.playbackKeyReady === false && !vip.isVip) {
    return withQQVipSyncState({
      ...info,
      vipCheckedAt: Date.now(),
      vipProbeAvailable: false,
      vipSource: source || vip.vipSource || info.vipSource || 'qq-vip-probe-untrusted',
    }, false);
  }
  return withQQVipSyncState({
    ...info,
    vipType: vip.vipType || 0,
    svipType: vip.svipType || 0,
    vipLevel: vip.vipLevel || 'none',
    isVip: !!vip.isVip,
    isSvip: !!vip.isSvip,
    vipLabel: vip.vipLabel || (vip.isVip ? 'VIP' : '无VIP'),
    membershipKnown: true,
    expiresAt: Number(vip.expiresAt) || 0,
    vipCheckedAt: Date.now(),
    vipProbeAvailable: true,
    vipSource: source || vip.vipSource || 'qq-vip-probe',
  }, true);
}

async function fetchQQVipStatus(cookieObj, opts) {
  opts = opts || {};
  cookieObj = cookieObj || qqCookieObject();
  const uin = qqCookieUin(cookieObj);
  const musicKey = qqCookieMusicKey(cookieObj);
  if (!uin || !musicKey) return null;
  const cacheKey = qqVipSessionCacheKey(uin, musicKey, cookieObj);
  const cached = cacheKey ? qqVipInfoCache.get(cacheKey) : null;
  if (!opts.force && cached && Date.now() < cached.expiresAt) return cached.value;
  const comm = { uin, format: 'json', ct: 24, cv: 0 };
  if (musicKey) comm.authst = musicKey;
  const probes = [
    {
      source: 'qq-vip-query-v2-list',
      responseKey: 'req_1',
      uin: String(uin),
      body: {
        comm,
        req_1: {
          module: 'userInfo.VipQueryServer',
          method: 'SRFVipQuery_V2',
          param: { uin_list: [String(uin)] },
        },
      },
    },
    {
      source: 'qq-vip-query-v1-list',
      responseKey: 'req_1',
      uin: String(uin),
      body: {
        comm,
        req_1: {
          module: 'userInfo.VipQueryServer',
          method: 'SRFVipQuery',
          param: { uin_list: [String(uin)] },
        },
      },
    },
    {
      source: 'qq-vip-query-v2-single',
      responseKey: 'vip',
      uin: String(uin),
      body: {
        comm,
        vip: {
          module: 'userInfo.VipQueryServer',
          method: 'SRFVipQuery_V2',
          param: { uin: String(uin), uin_list: [String(uin)] },
        },
      },
    },
  ];
  const value = await resolveQQVipFromProbes(probes, async probe => {
    return qqMusicRequest(probe.body, { cookie: true, timeoutMs: 4200 });
  });
  if (value && value.resolved) {
    const ttlMs = qqVipCacheTtlMs(value, {
      positiveTtlMs: QQ_VIP_INFO_CACHE_TTL_MS,
      negativeTtlMs: 30 * 1000,
    });
    if (cacheKey && ttlMs > 0) {
      qqVipInfoCache.set(cacheKey, {
        expiresAt: Date.now() + ttlMs,
        value,
      });
    }
    return value;
  }
  if (opts.force && value && value.errorCount) {
    console.warn('[QQLogin] VIP probe incomplete:', value.errorCount + '/' + probes.length);
  }
  return null;
}

function normalizeQQProfile(body, cookieObj) {
  cookieObj = cookieObj || qqCookieObject();
  const uin = qqCookieUin(cookieObj);
  const data = (body && (body.data || body.profile || body.creator || body.result)) || {};
  const creator = (data.creator || data.user || data.profile || data) || {};
  const vipInfo = data.vipInfo || data.vipinfo || data.vip || creator.vipInfo || creator.vipinfo || {};
  const profileNick = decodeQQCookieValue(creator.nick || creator.nickname || creator.name || creator.hostname || creator.title || '');
  const profileAvatar = creator.headpic || creator.avatar || creator.avatarUrl || creator.logo || '';
  const cookieNick = qqCookieNickname(cookieObj, uin);
  const nick = profileNick || cookieNick || '';
  const avatar = profileAvatar || qqCookieAvatar(cookieObj, uin);
  // Cookie labels may survive a membership downgrade, so only current
  // official profile fields are allowed to become profile membership proof.
  const profileVip = normalizeQQVipPayload({ data, creator, vipInfo }, {});
  return {
    provider: 'qq',
    loggedIn: !!(uin && qqCookieMusicKey(cookieObj)),
    preview: false,
    userId: uin,
    nickname: nick || (uin ? ('小Q ' + uin) : '小Q'),
    avatar,
    vipType: profileVip.vipType || 0,
    svipType: profileVip.svipType || 0,
    vipLevel: profileVip.vipLevel || 'none',
    isVip: !!profileVip.isVip,
    isSvip: !!profileVip.isSvip,
    vipLabel: profileVip.vipLabel || '无VIP',
    membershipKnown: !!profileVip.membershipKnown,
    expiresAt: Number(profileVip.expiresAt) || 0,
    hasCookie: !!qqCookie,
    playbackKeyReady: !!qqCookiePlaybackKey(cookieObj),
    profileSource: profileNick || profileAvatar ? 'qq-profile' : (cookieNick || avatar ? 'cookie' : 'fallback'),
    vipSource: profileVip.resolved ? 'qq-profile-vip' : 'profile',
  };
}

async function getQQLoginInfo(options) {
  options = options || {};
  if (options.forceCookie) refreshQQConfiguredCookieStore(true);
  const cookieObj = qqCookieObject();
  const uin = qqCookieUin(cookieObj);
  const musicKey = qqCookieMusicKey(cookieObj);
  if (!uin || !musicKey) return { provider: 'qq', loggedIn: false, hasCookie: !!qqCookie };
  const fallback = normalizeQQProfile(null, cookieObj);
  const vipProbePromise = fetchQQVipStatus(cookieObj, { force: !!options.forceVip }).catch(e => {
    if (options.forceVip) console.warn('[QQLogin] VIP probe skipped:', e.message);
    return null;
  });
  try {
    const u = new URL('https://c.y.qq.com/rsc/fcgi-bin/fcg_get_profile_homepage.fcg');
    u.searchParams.set('cid', '205360838');
    u.searchParams.set('userid', uin);
    u.searchParams.set('reqfrom', '1');
    u.searchParams.set('g_tk', '5381');
    u.searchParams.set('loginUin', uin);
    u.searchParams.set('hostUin', '0');
    u.searchParams.set('format', 'json');
    u.searchParams.set('inCharset', 'utf8');
    u.searchParams.set('outCharset', 'utf-8');
    u.searchParams.set('notice', '0');
    u.searchParams.set('platform', 'yqq.json');
    u.searchParams.set('needNewCode', '0');
    const text = await requestText(u.toString(), {
      headers: { ...QQ_HEADERS, Cookie: qqCookie },
      timeoutMs: options.forceVip ? 6500 : 10000,
    });
    const body = parseJSONText(text);
    const info = normalizeQQProfile(body, cookieObj);
    const vipProbe = await vipProbePromise;
    if (body && (body.code === 1000 || body.result === 301)) {
      return mergeQQVipStatus({ ...fallback, profileUnavailable: true }, vipProbe, vipProbe && vipProbe.vipSource);
    }
    return mergeQQVipStatus(info, vipProbe, vipProbe && vipProbe.vipSource);
  } catch (e) {
    console.warn('[QQLogin] profile check failed:', e.message);
    const vipProbe = await vipProbePromise;
    return mergeQQVipStatus({ ...fallback, profileUnavailable: true }, vipProbe, vipProbe && vipProbe.vipSource);
  }
}

async function qqGetJSON(targetUrl, params, opts) {
  opts = opts || {};
  const u = new URL(targetUrl);
  Object.keys(params || {}).forEach(k => {
    if (params[k] != null) u.searchParams.set(k, String(params[k]));
  });
  const headers = { ...QQ_HEADERS, ...(opts.headers || {}) };
  if (opts.cookie !== false && qqCookie) headers.Cookie = qqCookie;
  const text = await requestText(u.toString(), { headers });
  return parseJSONText(text);
}

const AUDIO_PROXY_OPEN_RANGE_CHUNK_BYTES = 256 * 1024;
// 1 MiB → 256 KiB。理由不是「块小就不卡」，而是这里是攒满整块再发（下面靠完整块
// 才能重试）：块越大，首字节就越晚。按当时实测的 53 KB/s，1 MiB 要等 19 秒才出声，
// 256 KiB 约 4.8 秒。稳态连续播放靠下面的并行预读，不靠块大小。
// 一块 256 KiB 对无损（约 880 kbps）≈ 2.4 秒音频。
//
// 补记：并行预读上线后聚合吞吐实测 160~260 KB/s，那个 53 KB/s 是串行链路
// 自身造成的（下一块要等上一块发完才开始），不是上游带宽上限。
// 预读深度按「字节预算」推导，不写死块数：块大小是可调参数，写死块数会让
// 两者一改就脱钩（预算不变，连接数却翻倍）。
const AUDIO_PROXY_READ_AHEAD_BYTES = 2 * 1024 * 1024;
// 连接数上限单独钉住：万一块大小调小，预算除下来会开出几十条连接。
const AUDIO_PROXY_READ_AHEAD_MAX_CHUNKS = 8;
const AUDIO_PROXY_READ_AHEAD_CHUNKS = Math.max(1, Math.min(
  AUDIO_PROXY_READ_AHEAD_MAX_CHUNKS,
  Math.floor(AUDIO_PROXY_READ_AHEAD_BYTES / AUDIO_PROXY_OPEN_RANGE_CHUNK_BYTES),
));
// 已实测（stall.jsonl，2026-08-11 15:20 之后）：稳态聚合 160~260 KB/s，
// 换轨瞬间冲到 400~1000 KB/s，远高于无损所需的约 110 KB/s。
// 结论一：CDN 不是按 IP 限速，并行预读有效。
// 结论二：吞吐已不是瓶颈，再加深度是浪费连接——所以深度停在 8，别再往上调。
//
// 注意「稳态 conns=2~3」不是深度没生效，而是窗口滑到前面去了：8 条只在换轨
// （缓存全空）时才同时打满，此时对应的正是那几条 400~1000 KB/s 的采样。
//
// 同期 t>1 的中途冻结从 17 次降到 0 次，这个改动的目标已经达成。
// 剩下的 clock-frozen 全部是 t=0 的起播卡顿，与吞吐无关（见下方 t=0 说明）。
const AUDIO_PROXY_THROUGHPUT_SAMPLE_MS = 10000;
// 只在速率有实质变化时才落盘。stall.jsonl 只保留最后 500 行（STALL_LOG_MAX_LINES），
// 而每 10 秒写一行 = 每小时 360 行：稳态播放不到一小时半就能把 clock-frozen 全挤掉，
// 等于为了加一个诊断，毁掉这个文件本来的用途。参照冻结观测的做法（同一次冻结只报
// 一条），平稳时保持安静，劣化和恢复才出声。
const AUDIO_PROXY_THROUGHPUT_REPORT_DELTA = 0.25;
const audioProxyThroughputSample = { bytes: 0, since: 0, reportedKbps: -1 };
// A stalled CDN Range must give way to a retry before the renderer's media
// clock budget expires. The completed chunk is cached below so a retry or an
// Audio element replacement does not discard a successful upstream fetch.
const AUDIO_PROXY_OPEN_TIMEOUT_MS = 8000;
// 首字节超时从 3.2s 提到 8s：原值对慢 CDN 太紧，一次重试约 9.6s 反而比直接等更慢。
const AUDIO_PROXY_RANGE_BODY_IDLE_TIMEOUT_MS = 5000;
const AUDIO_PROXY_STREAM_IDLE_TIMEOUT_MS = 45000;
const AUDIO_PROXY_RANGE_FETCH_ATTEMPTS = 3;
const AUDIO_PROXY_RANGE_CACHE_TTL_MS = 45000;
const AUDIO_PROXY_RANGE_CACHE_MAX_BYTES = 24 * 1024 * 1024;
const audioProxyRangeCache = new Map();
const audioProxyRangeInFlight = new Map();
let audioProxyRangeCacheBytes = 0;

function normalizeAudioProxyUpstreamRange(range) {
  const raw = String(range || '').trim();
  const match = /^bytes=(\d+)-(\d*)$/i.exec(raw);
  if (!match) return raw;
  const start = Number(match[1]);
  if (!Number.isSafeInteger(start) || start < 0) return raw;
  const requestedEnd = match[2] ? Number(match[2]) : Number.POSITIVE_INFINITY;
  if (match[2] && (!Number.isSafeInteger(requestedEnd) || requestedEnd < start)) return raw;
  const end = Math.min(requestedEnd, start + AUDIO_PROXY_OPEN_RANGE_CHUNK_BYTES - 1);
  if (!Number.isSafeInteger(end)) return raw;
  return `bytes=${start}-${end}`;
}

function parseAudioProxyContentRange(value) {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(String(value || '').trim());
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = match[3] === '*' ? null : Number(match[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) return null;
  if (total != null && (!Number.isSafeInteger(total) || total <= end)) return null;
  return { start, end, total, length: end - start + 1 };
}

function audioProxyContentRangeMatchesRequest(contentRange, requestRange) {
  const response = typeof contentRange === 'string' ? parseAudioProxyContentRange(contentRange) : contentRange;
  const rawRequest = String(requestRange || '').trim();
  const bounded = /^bytes=(\d+)-(\d+)$/i.exec(rawRequest);
  if (bounded) {
    const requestedStart = Number(bounded[1]);
    const requestedEnd = Number(bounded[2]);
    return !!response && response.start === requestedStart && response.end <= requestedEnd;
  }
  const suffix = /^bytes=-(\d+)$/i.exec(rawRequest);
  if (!response || !suffix || !response.total) return false;
  const requestedLength = Number(suffix[1]);
  return Number.isSafeInteger(requestedLength)
    && requestedLength > 0
    && response.end === response.total - 1
    && response.length <= requestedLength;
}

function audioProxyRangeResponseComplete(contentRange, receivedBytes) {
  const parsed = typeof contentRange === 'string' ? parseAudioProxyContentRange(contentRange) : contentRange;
  return !!(parsed && Number(receivedBytes) === parsed.length);
}

function audioProxyHeadersFor(audioUrl, range) {
  const headers = { 'User-Agent': UA, Referer: 'https://music.163.com/', 'Accept-Encoding': 'identity' };
  try {
    const host = new URL(audioUrl).hostname.toLowerCase();
    if (host.includes('qq.com') || host.includes('qpic.cn')) headers.Referer = 'https://y.qq.com/';
        const kugouReferer = kugouAudioReferer(audioUrl);
    if (kugouReferer) headers.Referer = kugouReferer;
  } catch (e) {}
  if (range) headers.Range = range;
  return headers;
}

async function readCompleteAudioProxyRange(upstream, contentRange, lifecycle) {
  const expected = contentRange && Number(contentRange.length);
  if (!upstream || !upstream.body || !Number.isSafeInteger(expected) || expected <= 0) {
    const error = new Error('AUDIO_PROXY_INVALID_RANGE_RESPONSE');
    error.code = 'AUDIO_PROXY_INVALID_RANGE_RESPONSE';
    throw error;
  }
  const reader = upstream.body.getReader();
  lifecycle.reader = reader;
  const chunks = [];
  let received = 0;
  try {
    while (!lifecycle.clientClosed) {
      const part = await readStreamChunkWithTimeout(reader, AUDIO_PROXY_RANGE_BODY_IDLE_TIMEOUT_MS);
      if (part.done) break;
      const chunk = Buffer.from(part.value);
      received += chunk.length;
      if (received > expected) {
        const error = new Error('AUDIO_PROXY_RANGE_OVERFLOW');
        error.code = 'AUDIO_PROXY_RANGE_OVERFLOW';
        throw error;
      }
      chunks.push(chunk);
    }
  } finally {
    if (lifecycle.reader === reader) lifecycle.reader = null;
  }
  if (lifecycle.clientClosed) {
    const error = new Error('AUDIO_PROXY_CLIENT_CLOSED');
    error.code = 'AUDIO_PROXY_CLIENT_CLOSED';
    throw error;
  }
  if (!audioProxyRangeResponseComplete(contentRange, received)) {
    const error = new Error(`AUDIO_PROXY_INCOMPLETE_RANGE: expected ${expected}, received ${received}`);
    error.code = 'AUDIO_PROXY_INCOMPLETE_RANGE';
    error.expectedBytes = expected;
    error.receivedBytes = received;
    throw error;
  }
  return Buffer.concat(chunks, received);
}

async function fetchCompleteAudioProxyRange(audioUrl, headers, lifecycle) {
  let lastError = null;
  for (let attempt = 1; attempt <= AUDIO_PROXY_RANGE_FETCH_ATTEMPTS; attempt++) {
    if (lifecycle.clientClosed) {
      const closed = new Error('AUDIO_PROXY_CLIENT_CLOSED');
      closed.code = 'AUDIO_PROXY_CLIENT_CLOSED';
      throw closed;
    }
    let upstream = null;
    try {
      upstream = await fetchWithTimeout(audioUrl, { headers }, AUDIO_PROXY_OPEN_TIMEOUT_MS);
      if (upstream.status !== 206) return { upstream, buffer: null, contentRange: null };
      const contentRange = parseAudioProxyContentRange(upstream.headers.get('content-range'));
      if (!contentRange || !audioProxyContentRangeMatchesRequest(contentRange, headers.Range) || contentRange.length > AUDIO_PROXY_OPEN_RANGE_CHUNK_BYTES) {
        const invalid = new Error('AUDIO_PROXY_INVALID_RANGE_RESPONSE');
        invalid.code = 'AUDIO_PROXY_INVALID_RANGE_RESPONSE';
        throw invalid;
      }
      const buffer = await readCompleteAudioProxyRange(upstream, contentRange, lifecycle);
      return { upstream, buffer, contentRange };
    } catch (error) {
      lastError = error;
      const reader = lifecycle.reader;
      lifecycle.reader = null;
      if (reader) {
        try { await reader.cancel(); } catch (_) {}
      } else if (upstream && upstream.body) {
        try { await upstream.body.cancel(); } catch (_) {}
      }
      if (lifecycle.clientClosed || (error && error.code === 'AUDIO_PROXY_CLIENT_CLOSED')) throw error;
      if (attempt < AUDIO_PROXY_RANGE_FETCH_ATTEMPTS) {
        console.warn('[Audio] retrying incomplete range', attempt, error && (error.code || error.message));
      }
    }
  }
  throw lastError || new Error('AUDIO_PROXY_RANGE_FAILED');
}

function audioProxyRangeCacheKey(audioUrl, headers) {
  const range = String(headers && headers.Range || '').trim();
  return range && /^bytes=\d+-\d+$/i.test(range) ? String(audioUrl || '') + '\n' + range : '';
}

function deleteAudioProxyRangeCacheEntry(key) {
  const entry = audioProxyRangeCache.get(key);
  if (!entry) return;
  audioProxyRangeCache.delete(key);
  audioProxyRangeCacheBytes = Math.max(0, audioProxyRangeCacheBytes - (Number(entry.bytes) || 0));
}

function readAudioProxyRangeCache(key) {
  if (!key) return null;
  const entry = audioProxyRangeCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    deleteAudioProxyRangeCacheEntry(key);
    return null;
  }
  // Keep recently used ranges warm while the browser replaces or retries its
  // media element during the same playback operation.
  audioProxyRangeCache.delete(key);
  audioProxyRangeCache.set(key, entry);
  return entry.value;
}

function rememberAudioProxyRange(key, value) {
  if (!key || !value || !Buffer.isBuffer(value.buffer) || !value.buffer.length) return;
  deleteAudioProxyRangeCacheEntry(key);
  const entry = {
    value,
    bytes: value.buffer.length,
    expiresAt: Date.now() + AUDIO_PROXY_RANGE_CACHE_TTL_MS,
  };
  audioProxyRangeCache.set(key, entry);
  audioProxyRangeCacheBytes += entry.bytes;
  while (audioProxyRangeCacheBytes > AUDIO_PROXY_RANGE_CACHE_MAX_BYTES && audioProxyRangeCache.size) {
    const oldestKey = audioProxyRangeCache.keys().next().value;
    if (!oldestKey) break;
    deleteAudioProxyRangeCacheEntry(oldestKey);
  }
}

// 聚合吞吐按「窗口内完成字节 / 窗口墙上时间」算，不能把每个请求的耗时相加：
// 预读是并发的，相加会把并行度当成额外速度，正好抹掉这里要测的那个量。
function recordAudioProxyPrefetchBytes(byteLength) {
  const bytes = Number(byteLength) || 0;
  if (bytes <= 0) return;
  const now = Date.now();
  if (!audioProxyThroughputSample.since) audioProxyThroughputSample.since = now;
  audioProxyThroughputSample.bytes += bytes;
  const elapsedMs = now - audioProxyThroughputSample.since;
  if (elapsedMs < AUDIO_PROXY_THROUGHPUT_SAMPLE_MS) return;
  const sampleBytes = audioProxyThroughputSample.bytes;
  audioProxyThroughputSample.bytes = 0;
  audioProxyThroughputSample.since = now;
  const kbps = Math.round((sampleBytes / 1024) / (elapsedMs / 1000));
  const previous = audioProxyThroughputSample.reportedKbps;
  // 首条必报（否则一首歌可能一条都没有）；之后只报变化超过阈值的。
  if (previous >= 0) {
    const baseline = Math.max(previous, 1);
    if (Math.abs(kbps - previous) / baseline < AUDIO_PROXY_THROUGHPUT_REPORT_DELTA) return;
  }
  audioProxyThroughputSample.reportedKbps = kbps;
  appendStallLogEntry({
    reason: 'prefetch-throughput',
    throughputKbps: kbps,
    sampleBytes,
    sampleMs: elapsedMs,
    connections: audioProxyRangeInFlight.size,
  }).catch(() => { /* 诊断写盘失败不影响播放 */ });
}

// 预读窗口：从当前块之后连开 AUDIO_PROXY_READ_AHEAD_CHUNKS 块灌进缓存。
// 客户端每消费一块就再调一次，窗口随播放位置往前滑。fire-and-forget，不阻塞响应。
function scheduleAudioProxyReadAhead(audioUrl, headers, total) {
  const range = String(headers && headers.Range || '').trim();
  const match = /^bytes=(\d+)-(\d*)$/i.exec(range);
  if (!match) return;
  const start = Number(match[1]);
  if (!Number.isSafeInteger(start)) return;
  let end = match[2] ? Number(match[2]) : start + AUDIO_PROXY_OPEN_RANGE_CHUNK_BYTES - 1;
  if (!Number.isSafeInteger(end) || end < start) return;
  const knownTotal = Number.isSafeInteger(Number(total)) && Number(total) > 0 ? Number(total) : 0;
  for (let depth = 0; depth < AUDIO_PROXY_READ_AHEAD_CHUNKS; depth += 1) {
    const nextStart = end + 1;
    // 已知总长时到尾就停：否则每首歌结尾都会白发一个越界 Range，拿回 416，
    // 而非 206 分支不会 cancel 掉 body，等于每首歌漏一个连接。
    if (knownTotal && nextStart >= knownTotal) return;
    // 故意不把 nextEnd 夹到 total-1：浏览器之后发的是 `bytes=nextStart-`，
    // 会被 normalizeAudioProxyUpstreamRange 归一成同样未夹的闭区间，
    // 缓存键必须和它逐字一致才能命中。CDN 自己会把 206 收窄到真实结尾。
    const nextEnd = nextStart + AUDIO_PROXY_OPEN_RANGE_CHUNK_BYTES - 1;
    const nextRange = 'bytes=' + nextStart + '-' + nextEnd;
    const nextKey = audioProxyRangeCacheKey(audioUrl, { Range: nextRange });
    end = nextEnd;
    if (!nextKey || readAudioProxyRangeCache(nextKey) || audioProxyRangeInFlight.has(nextKey)) continue;
    // 必须整份克隆原请求头：User-Agent / Referer / Accept-Encoding 都是 CDN 的
    // 准入条件，只带 Range 会被 403，而且失败是静默的（播放仍走客户端那条路），
    // 等于预读永远不生效还看不出来。
    const prefetchHeaders = Object.assign({}, headers, { Range: nextRange });
    const prefetchLifecycle = { clientClosed: false, responseFinished: false, reader: null };
    const prefetch = fetchCompleteAudioProxyRange(audioUrl, prefetchHeaders, prefetchLifecycle)
      .then(async value => {
        if (value && value.buffer) {
          rememberAudioProxyRange(nextKey, value);
          recordAudioProxyPrefetchBytes(value.buffer.length);
          return value;
        }
        // 忽略 Range 的源会回一个流式 200。预读没有任何消费者，这个 body
        // 必须自己关掉，否则每块预读漏一个连接。
        if (value && value.upstream && value.upstream.body) {
          try { await value.upstream.body.cancel(); } catch (_) {}
        }
        return null;
      })
      // 预读的失败绝不能变成真实请求的 502：真实请求会 await 这个 in-flight
      // promise，这里若 reject 就等于把预读的错误转嫁给播放。返回 null 让它自己重取。
      .catch(() => null)
      .finally(() => { audioProxyRangeInFlight.delete(nextKey); });
    audioProxyRangeInFlight.set(nextKey, prefetch);
  }
}

async function fetchAudioProxyRangeWithCache(audioUrl, headers, lifecycle) {
  const key = audioProxyRangeCacheKey(audioUrl, headers);
  if (!key) return fetchCompleteAudioProxyRange(audioUrl, headers, lifecycle);
  const cached = readAudioProxyRangeCache(key);
  if (cached) {
    // 命中也要推进窗口：命中说明播放位置前移了一块，预读窗口要跟着滑。
    scheduleAudioProxyReadAhead(audioUrl, headers, cached.contentRange && cached.contentRange.total);
    return cached;
  }

  const pending = audioProxyRangeInFlight.get(key);
  if (pending) {
    const shared = await pending;
    // A provider that ignores Range returns a streaming 200 response. It is
    // not safe to let two renderer responses consume that body together.
    return shared && shared.buffer
      ? shared
      : fetchCompleteAudioProxyRange(audioUrl, headers, lifecycle);
  }

  // The shared request deliberately outlives one renderer client. A closed
  // client must not cancel a chunk that a replacement Audio element can use.
  const sharedLifecycle = { clientClosed: false, responseFinished: false, reader: null };
  const sharedPromise = fetchCompleteAudioProxyRange(audioUrl, headers, sharedLifecycle)
    .then(value => {
      if (value && value.buffer) {
        rememberAudioProxyRange(key, value);
        // 这一块拿到后才知道 total，正好用它约束预读不要越过文件结尾。
        scheduleAudioProxyReadAhead(audioUrl, headers, value.contentRange && value.contentRange.total);
      }
      return value;
    })
    .finally(() => { audioProxyRangeInFlight.delete(key); });
  audioProxyRangeInFlight.set(key, sharedPromise);
  return sharedPromise;
}

function sendAudioBuffer(res, buffer, contentType, range) {
  const total = buffer.length;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(String(range || ''));
  if (match) {
    let start = match[1] ? Number(match[1]) : 0;
    let end = match[2] ? Number(match[2]) : total - 1;
    if (!Number.isFinite(start) || start < 0) start = 0;
    if (!Number.isFinite(end) || end >= total) end = total - 1;
    if (start > end || start >= total) {
      res.writeHead(416, { 'Content-Range': 'bytes */' + total });
      res.end();
      return;
    }
    res.writeHead(206, {
      'Content-Type': contentType || 'audio/mp4',
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Range': 'bytes ' + start + '-' + end + '/' + total,
    });
    res.end(buffer.subarray(start, end + 1));
    return;
  }
  res.writeHead(200, {
    'Content-Type': contentType || 'audio/mp4',
    'Access-Control-Allow-Origin': '*',
    'Accept-Ranges': 'bytes',
    'Content-Length': total,
  });
  res.end(buffer);
}

function audioContentTypeForUrl(audioUrl, upstreamType) {
  let pathname = '';
  try { pathname = new URL(audioUrl).pathname.toLowerCase(); } catch (e) {}
  if (/\.flac$/.test(pathname)) return 'audio/flac';
  if (/\.mp3$/.test(pathname)) return 'audio/mpeg';
  if (/\.(m4a|mp4)$/.test(pathname)) return 'audio/mp4';
  if (/\.ogg$/.test(pathname)) return 'audio/ogg';
  if (/\.wav$/.test(pathname)) return 'audio/wav';
  return upstreamType || 'audio/mpeg';
}

function mapQQPlaylist(pl, kind) {
  pl = pl || {};
  const dirid = pl.dirid || pl.dir_id || '';
  const liked = Number(dirid || 0) === QQ_LIKED_DIRID || isQQFavoritePlaylist(pl);
  const id = liked ? QQ_LIKED_PLAYLIST_ID : (pl.dissid || pl.tid || dirid || pl.id || pl.diss_id);
  const rawName = pl.diss_name || pl.name || pl.title || '';
  return {
    provider: 'qq',
    source: 'qq',
    id: id ? String(id) : '',
    dirid: dirid ? String(dirid) : '',
    virtual: liked,
    name: liked ? QQ_LIKED_PLAYLIST_NAME : (decodeQQCookieValue(rawName) || rawName),
    cover: liked ? QQ_LIKED_PLAYLIST_COVER : (pl.diss_cover || pl.logo || pl.picurl || pl.cover || ''),
    trackCount: pl.song_cnt || pl.songnum || pl.total_song_num || pl.song_count || 0,
    playCount: pl.listen_num || pl.visitnum || pl.play_count || 0,
    creator: pl.hostname || pl.nick || pl.creator || '小Q',
    subscribed: kind === 'collect',
    specialType: liked ? 5 : 0,
    requiresPlaybackKey: false,
  };
}

function mapQQPlaylistTrack(raw) {
  raw = raw || {};
  const track = raw.songid || raw.songmid || raw.mid || raw.name ? raw : (raw.track_info || raw.songInfo || raw.songinfo || raw.song || {});
  const album = track.album || {};
  const artists = mapQQArtists(track.singer || track.singers || []);
  const mid = track.mid || track.songmid || raw.mid || raw.songmid || '';
  const albumMid = album.mid || track.albummid || raw.albummid || '';
  return {
    provider: 'qq',
    source: 'qq',
    type: 'qq',
    id: mid || String(track.id || track.songid || raw.id || raw.songid || ''),
    qqId: track.id || track.songid || raw.id || raw.songid || '',
    mid,
    songmid: mid,
    mediaMid: (track.file && track.file.media_mid) || track.strMediaMid || track.media_mid || raw.strMediaMid || '',
    name: track.name || track.songname || raw.songname || '',
    artist: artists.map(a => a.name).join(' / ') || track.singername || raw.singername || '',
    artists,
    artistId: artists[0] && (artists[0].id || artists[0].mid),
    artistMid: artists[0] && artists[0].mid,
    album: album.name || album.title || track.albumname || raw.albumname || '',
    albumMid,
    cover: qqAlbumCover(albumMid, 300),
    duration: (Number(track.interval || raw.interval) || 0) * 1000,
    fee: track.pay && Number(track.pay.pay_play) ? 1 : 0,
    playable: false,
  };
}

const QQ_PLAYLIST_SYNC_PAGE_SIZE = 200;
const QQ_PLAYLIST_SYNC_MAX_PAGES = 25;

async function fetchQQCreatedPlaylists(uin) {
  const out = [];
  for (let page = 0; page < QQ_PLAYLIST_SYNC_MAX_PAGES; page += 1) {
    const sin = page * QQ_PLAYLIST_SYNC_PAGE_SIZE;
    const body = await qqGetJSON('https://c.y.qq.com/rsc/fcgi-bin/fcg_user_created_diss', {
      hostUin: 0,
      hostuin: uin,
      sin,
      size: QQ_PLAYLIST_SYNC_PAGE_SIZE,
      g_tk: 5381,
      loginUin: uin,
      format: 'json',
      inCharset: 'utf8',
      outCharset: 'utf-8',
      notice: 0,
      platform: 'yqq.json',
      needNewCode: 0,
    }, { headers: { Referer: 'https://y.qq.com/portal/profile.html' } });
    const rows = body && body.data && Array.isArray(body.data.disslist) ? body.data.disslist : [];
    out.push.apply(out, rows);
    if (rows.length < QQ_PLAYLIST_SYNC_PAGE_SIZE) break;
  }
  return out;
}

async function fetchQQCollectedPlaylists(uin) {
  const out = [];
  for (let page = 0; page < QQ_PLAYLIST_SYNC_MAX_PAGES; page += 1) {
    const sin = page * QQ_PLAYLIST_SYNC_PAGE_SIZE;
    const body = await qqGetJSON('https://c.y.qq.com/fav/fcgi-bin/fcg_get_profile_order_asset.fcg', {
      ct: 20,
      cid: 205360956,
      userid: uin,
      reqtype: 3,
      sin,
      ein: sin + QQ_PLAYLIST_SYNC_PAGE_SIZE - 1,
    }, { headers: { Referer: 'https://y.qq.com/portal/profile.html' } });
    const rows = body && body.data && Array.isArray(body.data.cdlist) ? body.data.cdlist : [];
    out.push.apply(out, rows);
    if (rows.length < QQ_PLAYLIST_SYNC_PAGE_SIZE) break;
  }
  return out;
}

async function fetchQQLikedPlaylistPage(opts) {
  opts = opts || {};
  const limit = Math.max(1, Math.min(100, parseInt(opts.limit || '48', 10) || 48));
  const offset = Math.max(0, parseInt(opts.offset || '0', 10) || 0);
  const body = await qqMusicRequest({
    comm: { ct: 24, cv: 0 },
    req_0: {
      module: 'music.srfDissInfo.DissInfo',
      method: 'CgiGetDiss',
      param: {
        disstid: 0,
        dirid: QQ_LIKED_DIRID,
        tag: 1,
        song_begin: offset,
        song_num: limit,
        userinfo: 1,
        orderlist: 1,
      },
    },
  }, { cookie: true, timeoutMs: 10000 });
  const block = body && body.req_0;
  const data = block && block.data || {};
  const code = Number(body && body.code) || Number(block && block.code) || Number(data.code) || Number(data.subcode) || 0;
  if (!block || code !== 0) {
    const err = new Error('QQ_LIKED_SYNC_FAILED_' + code);
    err.code = [1000, 10004, 104003, 301, -100008].includes(code)
      ? 'QQ_LIKED_REQUIRES_PLAYBACK_LOGIN'
      : 'QQ_LIKED_SYNC_FAILED';
    err.qqCode = code;
    throw err;
  }
  const rawTracks = Array.isArray(data.songlist) ? data.songlist : [];
  const tracks = rawTracks.map(mapQQPlaylistTrack).filter(song => song.name && (song.mid || song.id));
  const pageSpan = Math.max(Number(data.songlist_size) || 0, rawTracks.length);
  const upstreamTotal = Math.max(0, Number(data.total_song_num) || 0);
  const total = upstreamTotal || offset + pageSpan;
  const nextOffset = offset + pageSpan;
  return {
    tracks,
    total,
    offset,
    limit,
    pageSpan,
    nextOffset,
    hasMore: !!Number(data.hasmore) || nextOffset < total,
    dirinfo: data.dirinfo || {},
  };
}

function buildQQLikedPlaylistCard(info, likedPage, warning) {
  const tracks = likedPage && likedPage.tracks || [];
  const firstTrack = tracks[0] || null;
  const pageOffset = Math.max(0, Number(likedPage && likedPage.offset) || 0);
  if (likedPage && pageOffset === 0) rememberQQLikedPlaylistCover(info, firstTrack && firstTrack.cover);
  const stableCover = getCachedQQLikedPlaylistCover(info);
  const count = Number(likedPage && likedPage.total) || tracks.length || 0;
  return {
    provider: 'qq',
    source: 'qq',
    id: QQ_LIKED_PLAYLIST_ID,
    dirid: String(QQ_LIKED_DIRID),
    virtual: true,
    name: QQ_LIKED_PLAYLIST_NAME,
    cover: stableCover || (pageOffset === 0 && firstTrack && firstTrack.cover) || QQ_LIKED_PLAYLIST_COVER,
    trackCount: count,
    playCount: 0,
    creator: info && (info.nickname || info.userId) || '小Q',
    subscribed: false,
    specialType: 5,
    requiresPlaybackKey: warning === 'QQ_LIKED_REQUIRES_PLAYBACK_LOGIN',
    warning: warning || '',
  };
}

async function getQQLikedPlaylistCard(info) {
  if (!info || !info.playbackKeyReady) {
    return buildQQLikedPlaylistCard(info, null, 'QQ_LIKED_REQUIRES_PLAYBACK_LOGIN');
  }
  try {
    const likedPage = await fetchQQLikedPlaylistPage({ limit: 1, offset: 0 });
    return buildQQLikedPlaylistCard(info, likedPage, '');
  } catch (err) {
    return buildQQLikedPlaylistCard(info, null, err.code || err.message || 'QQ_LIKED_UNAVAILABLE');
  }
}

async function handleQQLikedPlaylistTracks(info, opts) {
  const pageLimit = Math.max(0, Math.min(500, parseInt(opts && opts.limit || '0', 10) || 0));
  const pageOffset = Math.max(0, parseInt(opts && opts.offset || '0', 10) || 0);
  if (!info || !info.playbackKeyReady) {
    return {
      loggedIn: true,
      provider: 'qq',
      playlist: buildQQLikedPlaylistCard(info, null, 'QQ_LIKED_REQUIRES_PLAYBACK_LOGIN'),
      tracks: [],
      error: 'QQ_LIKED_REQUIRES_PLAYBACK_LOGIN',
      message: QQ_LIKED_AUTH_MESSAGE,
      requiresPlaybackKey: true,
    };
  }
  let likedPage = null;
  const coverWarmup = pageOffset > 0 && !getCachedQQLikedPlaylistCover(info)
    ? getQQLikedPlaylistCard(info)
    : null;
  try {
    likedPage = await fetchQQLikedPlaylistPage({ limit: pageLimit || 48, offset: pageOffset });
    if (coverWarmup) await coverWarmup;
  } catch (err) {
    const requiresPlaybackKey = err && err.code === 'QQ_LIKED_REQUIRES_PLAYBACK_LOGIN';
    return {
      loggedIn: true,
      provider: 'qq',
      playlist: buildQQLikedPlaylistCard(info, null, err.code || err.message || 'QQ_LIKED_UNAVAILABLE'),
      tracks: [],
      error: err.code || err.message || 'QQ_LIKED_UNAVAILABLE',
      message: requiresPlaybackKey ? QQ_LIKED_AUTH_MESSAGE : '小Q“我的喜欢”同步失败，请稍后刷新重试。',
      requiresPlaybackKey,
    };
  }
  return {
    loggedIn: true,
    provider: 'qq',
    playlist: buildQQLikedPlaylistCard(info, likedPage, ''),
    tracks: likedPage.tracks,
    total: likedPage.total,
    offset: pageOffset,
    limit: likedPage.limit,
    nextOffset: likedPage.nextOffset,
    hasMore: likedPage.hasMore,
    partial: !!pageLimit,
  };
}

async function handleQQUserPlaylists() {
  const info = await getQQLoginInfo();
  if (!info.loggedIn || !info.userId) return { loggedIn: false, provider: 'qq', playlists: [] };
  const uin = info.userId;
  const createdReq = fetchQQCreatedPlaylists(uin);
  const collectReq = fetchQQCollectedPlaylists(uin);
  const likedReq = getQQLikedPlaylistCard(info);
  const [createdRaw, collectRaw, likedRaw] = await Promise.allSettled([createdReq, collectReq, likedReq]);
  const created = createdRaw.status === 'fulfilled' && Array.isArray(createdRaw.value)
    ? createdRaw.value.map(pl => mapQQPlaylist(pl, 'created')) : [];
  const collected = collectRaw.status === 'fulfilled' && Array.isArray(collectRaw.value)
    ? collectRaw.value.map(pl => mapQQPlaylist(pl, 'collect')) : [];
  const likedCard = likedRaw.status === 'fulfilled' ? likedRaw.value : buildQQLikedPlaylistCard(info, null, 'QQ_LIKED_UNAVAILABLE');
  const seen = new Set();
  const base = created.concat(collected).filter(pl => !isQQFavoritePlaylist(pl));
  base.unshift(likedCard);
  const playlists = base.filter(pl => {
    if (!pl.id || !pl.name || seen.has(pl.id)) return false;
    if (isQzoneBackgroundPlaylist(pl)) return false;
    seen.add(pl.id);
    return true;
  }).sort((a, b) => Number(isQQFavoritePlaylist(b)) - Number(isQQFavoritePlaylist(a)));
  return { loggedIn: true, provider: 'qq', userId: uin, playlists };
}

async function handleQQPlaylistTracks(id, opts) {
  opts = opts || {};
  const info = await getQQLoginInfo();
  if (!info.loggedIn || !info.userId) return { loggedIn: false, provider: 'qq', tracks: [] };
  const pid = String(id || '').trim();
  if (!pid) return { loggedIn: true, provider: 'qq', error: 'Missing QQ playlist id', tracks: [] };
  if (isQQLikedPlaylistId(pid)) return handleQQLikedPlaylistTracks(info, opts);
  const pageLimit = Math.max(0, Math.min(500, parseInt(opts.limit || '0', 10) || 0));
  const pageOffset = Math.max(0, parseInt(opts.offset || '0', 10) || 0);
  const result = await qqGetJSON('https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg', {
    type: 1,
    utf8: 1,
    disstid: pid,
    song_begin: pageOffset,
    song_num: pageLimit || undefined,
    loginUin: info.userId,
    format: 'json',
    inCharset: 'utf8',
    outCharset: 'utf-8',
    notice: 0,
    platform: 'yqq.json',
    needNewCode: 0,
  }, { headers: { Referer: 'https://y.qq.com/n/yqq/playlist' } });
  const detail = result && result.cdlist && result.cdlist[0] ? result.cdlist[0] : {};
  let rawTracks = Array.isArray(detail.songlist) ? detail.songlist : [];
  const totalHint = Number(detail.total_song_num || detail.songnum || detail.song_cnt || detail.song_count || 0) || 0;
  if (pageLimit && rawTracks.length > pageLimit) {
    rawTracks = totalHint && rawTracks.length < totalHint
      ? rawTracks.slice(0, pageLimit)
      : rawTracks.slice(pageOffset, pageOffset + pageLimit);
  }
  const tracks = rawTracks.map(mapQQPlaylistTrack).filter(s => s.name && (s.mid || s.id));
  const total = totalHint || tracks.length;
  const playlist = {
    provider: 'qq',
    id: pid,
    name: detail.dissname || detail.diss_name || detail.name || '',
    cover: detail.logo || detail.diss_cover || '',
    trackCount: total,
  };
  return {
    loggedIn: true,
    provider: 'qq',
    playlist,
    tracks,
    offset: pageOffset,
    limit: pageLimit || tracks.length,
    nextOffset: pageOffset + tracks.length,
    hasMore: pageLimit ? (pageOffset + tracks.length < total || tracks.length >= pageLimit) : false,
    partial: !!pageLimit,
    total,
  };
}

function qqAlbumCover(albumMid, size) {
  if (!albumMid) return '';
  const px = size || 300;
  return 'https://y.qq.com/music/photo_new/T002R' + px + 'x' + px + 'M000' + albumMid + '.jpg?max_age=2592000';
}

function qqSingerAvatar(singerMid, size) {
  if (!singerMid) return '';
  const px = size || 300;
  return 'https://y.qq.com/music/photo_new/T001R' + px + 'x' + px + 'M000' + singerMid + '.jpg?max_age=2592000';
}

function mapQQArtists(raw) {
  return (raw || [])
    .map(a => ({
      id: a && a.id,
      mid: a && a.mid,
      name: (a && (a.name || a.title)) || '',
    }))
    .filter(a => a.name);
}

function mapQQSmartSong(item) {
  item = item || {};
  const mid = item.mid || item.songmid || item.id || '';
  return {
    provider: 'qq',
    source: 'qq',
    type: 'qq',
    id: mid,
    qqId: item.id || item.docid || '',
    mid,
    songmid: mid,
    name: item.name || item.title || '',
    artist: item.singer || '',
    artists: item.singer ? [{ name: item.singer }] : [],
    album: '',
    cover: '',
    duration: 0,
    fee: 0,
    playable: false,
  };
}

function mapQQTrack(track, fallback) {
  track = track || {};
  fallback = fallback || {};
  const album = track.album || {};
  const artists = mapQQArtists(track.singer || []);
  const mid = track.mid || fallback.mid || fallback.songmid || '';
  const albumMid = album.mid || album.pmid || '';
  return {
    provider: 'qq',
    source: 'qq',
    type: 'qq',
    id: mid,
    qqId: track.id || fallback.qqId || fallback.id || '',
    mid,
    songmid: mid,
    mediaMid: track.file && track.file.media_mid,
    name: track.name || track.title || fallback.name || '',
    artist: artists.map(a => a.name).join(' / ') || fallback.artist || '',
    artists: artists.length ? artists : (fallback.artists || []),
    artistId: artists[0] && (artists[0].id || artists[0].mid),
    artistMid: artists[0] && artists[0].mid,
    album: album.name || album.title || fallback.album || '',
    albumMid,
    cover: qqAlbumCover(albumMid, 300) || fallback.cover || '',
    duration: (Number(track.interval) || 0) * 1000,
    fee: track.pay && Number(track.pay.pay_play) ? 1 : 0,
    playable: false,
  };
}

async function qqSmartboxSearch(keywords, limit) {
  const u = new URL(QQ_SMARTBOX_URL);
  u.searchParams.set('format', 'json');
  u.searchParams.set('key', keywords);
  u.searchParams.set('g_tk', '5381');
  u.searchParams.set('loginUin', '0');
  u.searchParams.set('hostUin', '0');
  u.searchParams.set('inCharset', 'utf8');
  u.searchParams.set('outCharset', 'utf-8');
  u.searchParams.set('notice', '0');
  u.searchParams.set('platform', 'yqq.json');
  u.searchParams.set('needNewCode', '0');
  const text = await requestText(u.toString(), { headers: QQ_HEADERS });
  const json = parseJSONText(text);
  const items = json && json.data && json.data.song && json.data.song.itemlist;
  return (Array.isArray(items) ? items : []).slice(0, Math.max(1, Math.min(limit || 6, 10))).map(mapQQSmartSong);
}

function qqSearchSign(text) {
  const hash = crypto.createHash('sha1').update(text).digest('hex');
  const part1 = [23, 14, 6, 36, 16, 40, 7, 19].map(index => hash[index]).join('');
  const part2 = [16, 1, 32, 12, 19, 27, 8, 5].map(index => hash[index]).join('');
  const scramble = [89, 39, 179, 150, 218, 82, 58, 252, 177, 52, 186, 123, 120, 64, 242, 133, 143, 161, 121, 179];
  const bytes = scramble.map((value, index) => value ^ parseInt(hash.slice(index * 2, index * 2 + 2), 16));
  const middle = Buffer.from(bytes).toString('base64').replace(/[\\/+=]/g, '');
  return `zzc${part1}${middle}${part2}`.toLowerCase();
}

async function qqFullSongSearch(keywords, limit, offset) {
  limit = Math.max(1, Math.min(30, Number(limit) || 12));
  offset = Math.max(0, Number(offset) || 0);
  const pageNumber = Math.floor(offset / limit) + 1;
  const payload = {
    comm: {
      ct: '11', cv: '14090508', v: '14090508', tmeAppID: 'qqmusic',
      phonetype: 'EBG-AN10', os_ver: '12', OpenUDID: '0', QIMEI36: '0',
      udid: '0', chid: '0', aid: '0', oaid: '0', taid: '0', tid: '0',
      wid: '0', uid: '0', sid: '0', modeSwitch: '6', teenMode: '0',
      ui_mode: '2', nettype: '1020',
    },
    req: {
      module: 'music.search.SearchCgiService',
      method: 'DoSearchForQQMusicMobile',
      param: {
        search_type: 0,
        searchid: String(Date.now()) + String(Math.random()).slice(2, 8),
        query: keywords,
        page_num: pageNumber,
        num_per_page: limit,
        highlight: 0,
        nqc_flag: 0,
        multi_zhida: 0,
        cat: 2,
        grp: 1,
        sin: offset,
        sem: 0,
      },
    },
  };
  const bodyText = JSON.stringify(payload);
  const json = await requestJson(
    'https://u.y.qq.com/cgi-bin/musics.fcg?sign=' + qqSearchSign(bodyText),
    {
      method: 'POST',
      timeoutMs: 10000,
      headers: {
        'User-Agent': 'QQMusic 14090508(android 12)',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyText),
      },
    },
    bodyText
  );
  const data = json && json.req && json.req.data;
  const body = data && (data.body || data);
  const items = body && (body.item_song || body.song && body.song.list || body.list);
  return (Array.isArray(items) ? items : [])
    .map(item => mapQQTrack(item && (item.track_info || item.songInfo || item.songinfo || item.song) || item, {}))
    .filter(song => song && song.name && (song.mid || song.id));
}

async function qqSongDetail(mid, fallback) {
  if (!mid) return fallback;
  const json = await qqMusicRequest({
    comm: { ct: 24, cv: 0 },
    songinfo: {
      module: 'music.pf_song_detail_svr',
      method: 'get_song_detail_yqq',
      param: { song_mid: mid },
    },
  });
  const data = json && json.songinfo && json.songinfo.data;
  return mapQQTrack(data && data.track_info, fallback);
}

async function handleQQArtistDetail(mid, limit) {
  const singerMid = String(mid || '').trim();
  const num = Math.max(10, Math.min(80, parseInt(limit || '36', 10) || 36));
  if (!singerMid) return { provider: 'qq', error: 'MISSING_SINGER_MID', artist: null, songs: [] };
  const json = await qqMusicRequest({
    comm: { ct: 24, cv: 0 },
    singer: {
      module: 'music.web_singer_info_svr',
      method: 'get_singer_detail_info',
      param: { sort: 5, singermid: singerMid, sin: 0, num },
    },
  }, { cookie: true });
  const block = json && json.singer;
  if (!block || Number(block.code || 0) !== 0) {
    return { provider: 'qq', error: block && (block.message || block.msg || block.code) || 'QQ_ARTIST_DETAIL_FAILED', artist: null, songs: [] };
  }
  const data = block.data || {};
  const info = data.singer_info || data.singerInfo || {};
  const rawSongs = Array.isArray(data.songlist) ? data.songlist : [];
  const songs = rawSongs
    .map(raw => mapQQTrack(raw && (raw.track_info || raw.songInfo || raw.songinfo || raw.song) || raw, {}))
    .filter(song => song && song.name && (song.mid || song.id));
  const matchedSongArtist = songs[0] && (songs[0].artists || []).find(a => a && a.mid === singerMid);
  const artistMid = info.mid || singerMid;
  const artistName = info.name || info.title || (matchedSongArtist && matchedSongArtist.name) || '';
  const totalSong = Number(data.total_song || data.song_count || 0) || songs.length;
  return {
    provider: 'qq',
    artist: {
      provider: 'qq',
      id: info.id || '',
      mid: artistMid,
      name: artistName,
      avatar: info.pic || info.avatar || qqSingerAvatar(artistMid, 300),
      fans: Number(info.fans || 0) || 0,
      musicSize: totalSong,
      albumSize: Number(data.total_album || 0) || 0,
      mvSize: Number(data.total_mv || 0) || 0,
    },
    total: totalSong,
    songs,
  };
}

async function handleQQAlbumDetail(mid, limit) {
  const albumMid = String(mid || '').trim();
  const num = Math.max(10, Math.min(120, parseInt(limit || '80', 10) || 80));
  if (!albumMid) return { provider: 'qq', error: 'MISSING_ALBUM_MID', album: null, songs: [] };
  const body = await qqGetJSON('https://c.y.qq.com/v8/fcg-bin/fcg_v8_album_info_cp.fcg', {
    albummid: albumMid,
    g_tk: 5381,
    loginUin: '0',
    hostUin: '0',
    format: 'json',
    inCharset: 'utf8',
    outCharset: 'utf-8',
    notice: 0,
    platform: 'yqq.json',
    needNewCode: 0,
  }, { headers: { Referer: 'https://y.qq.com/n/ryqq/albumDetail/' + encodeURIComponent(albumMid) } });
  const data = body && body.data || {};
  const rawSongs = Array.isArray(data.list) ? data.list : (Array.isArray(data.songlist) ? data.songlist : []);
  const songs = rawSongs
    .slice(0, num)
    .map(raw => {
      const song = mapQQPlaylistTrack(Object.assign({}, raw, {
        albummid: raw.albummid || albumMid,
        albumname: raw.albumname || data.name || data.title || data.albumname || '',
      }));
      if (song && !song.cover) song.cover = qqAlbumCover(albumMid, 300);
      if (song && !song.albumMid) song.albumMid = albumMid;
      return song;
    })
    .filter(song => song && song.name && (song.mid || song.id));
  const singerName = data.singername || data.singerName || data.singer_name || (songs[0] && songs[0].artist) || '';
  return {
    provider: 'qq',
    album: {
      provider: 'qq',
      mid: albumMid,
      albumMid,
      id: data.id || data.albumid || '',
      name: data.name || data.title || data.albumname || '',
      artist: singerName,
      cover: qqAlbumCover(albumMid, 300),
      releaseDate: data.aDate || data.publictime || data.pub_time || '',
      trackCount: Number(data.total_song_num || data.total || data.songnum || rawSongs.length) || songs.length,
    },
    songs,
    total: Number(data.total_song_num || data.total || data.songnum || rawSongs.length) || songs.length,
  };
}

async function handleQQSearch(keywords, limit, offset) {
  const kw = String(keywords || '').trim();
  if (!kw) return [];
  limit = Math.max(1, Math.min(30, Number(limit) || 12));
  offset = Math.max(0, Number(offset) || 0);
  console.log('[QQSearch]', kw, 'limit:', limit, 'offset:', offset);
  let base = [];
  try {
    base = await qqFullSongSearch(kw, limit, offset);
  } catch (err) {
    console.warn('[QQSearch] full search failed:', err.message);
  }
  if (!base.length && offset === 0) base = await qqSmartboxSearch(kw, limit);
  const detailed = await Promise.all(base.map(async item => {
    try { return await qqSongDetail(item.mid, item); }
    catch (e) {
      console.warn('[QQSearch] detail failed:', item.mid, e.message);
      return item;
    }
  }));
  const seen = new Set();
  return detailed.filter(song => {
    const key = song && (song.mid || song.id || (song.name + '|' + song.artist));
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return !!song.name;
  });
}

function truthyQQPlaybackHint(value) {
  const text = String(value == null ? '' : value).trim().toLowerCase();
  return value === true || text === '1' || text === 'true' || text === 'yes' || text === 'vip';
}

function qqPlaybackMemberHints(hints) {
  hints = hints || {};
  const fee = Number(hints.fee || hints.Fee || 0) || 0;
  const privilege = Number(hints.privilege || hints.Privilege || hints.mediaPrivilege || hints.media_privilege || 0) || 0;
  return !!(
    truthyQQPlaybackHint(hints.vipRequired) ||
    truthyQQPlaybackHint(hints.needVip) ||
    truthyQQPlaybackHint(hints.onlyVipPlayable) ||
    truthyQQPlaybackHint(hints.only_vip_playable) ||
    fee > 0 ||
    privilege >= 9
  );
}

// Keep the complete vkey + media verification path below the renderer's
// 15-second QQ request deadline (6.0s + 6.2s, with ~2.8s response margin).
const QQ_VKEY_REQUEST_TIMEOUT_MS = 6000;
const QQ_AUDIO_PROBE_TOTAL_MS = 6200;
const QQ_AUDIO_PROBE_ATTEMPT_MS = 2000;
const AUDIO_URL_PROBE_BYTES = 8192;
function audioProbeMagic(buffer) {
  if (!buffer || !buffer.length) return '';
  if (buffer.length >= 3 && buffer.subarray(0, 3).toString('ascii') === 'ID3') return 'mp3-id3';
  if (buffer.length >= 4 && buffer.subarray(0, 4).toString('ascii') === 'fLaC') return 'flac';
  if (buffer.length >= 4 && buffer.subarray(0, 4).toString('ascii') === 'OggS') return 'ogg';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WAVE') return 'wave';
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') return 'mp4';
  const scan = Math.min(buffer.length - 1, 2048);
  for (let i = 0; i < scan; i++) {
    if (buffer[i] === 0xff && (buffer[i + 1] & 0xe0) === 0xe0) return 'mpeg-frame';
  }
  return '';
}
async function probePlaybackAudioUrl(audioUrl, timeoutMs) {
  try {
    const probeStartedAt = Date.now();
    const probeBudgetMs = Math.max(800, Number(timeoutMs) || QQ_AUDIO_PROBE_ATTEMPT_MS);
    const resp = await fetchWithTimeout(audioUrl, {
      headers: audioProxyHeadersFor(audioUrl, 'bytes=0-' + (AUDIO_URL_PROBE_BYTES - 1)),
    }, probeBudgetMs);
    const status = Number(resp.status) || 0;
    const contentType = String(resp.headers.get('content-type') || '').toLowerCase();
    const chunks = [];
    let bytes = 0;
    if (resp.body && (status === 200 || status === 206)) {
      const reader = resp.body.getReader();
      const deadline = probeStartedAt + probeBudgetMs;
      try {
        while (bytes < AUDIO_URL_PROBE_BYTES && Date.now() < deadline) {
          const chunk = await readStreamChunkWithTimeout(reader, Math.max(50, deadline - Date.now()));
          if (chunk.done) break;
          const buf = Buffer.from(chunk.value || []);
          if (!buf.length) continue;
          chunks.push(buf);
          bytes += buf.length;
        }
      } finally {
        try { await reader.cancel(); } catch (_) {}
      }
    } else {
      try { if (resp.body && typeof resp.body.cancel === 'function') await resp.body.cancel(); } catch (_) {}
    }
    const sample = chunks.length ? Buffer.concat(chunks, bytes).subarray(0, AUDIO_URL_PROBE_BYTES) : Buffer.alloc(0);
    const magic = audioProbeMagic(sample);
    const contentLooksText = /text\/html|application\/(json|xml)|text\/plain/.test(contentType);
    return {
      ok: (status === 200 || status === 206) && sample.length >= 512 && !contentLooksText && !!magic,
      status,
      bytes: sample.length,
      contentType,
      magic,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      reason: err && err.name === 'AbortError' ? 'timeout' : 'network',
    };
  }
}
async function probeQQAudioUrl(audioUrl, timeoutMs) {
  return probePlaybackAudioUrl(audioUrl, timeoutMs || QQ_AUDIO_PROBE_ATTEMPT_MS);
}

async function handleQQSongUrl(mid, mediaMid, qualityPreference, playbackHints) {
  const songmid = String(mid || '').trim();
  if (!songmid) return { provider: 'qq', url: '', error: 'MISSING_MID', message: 'Missing QQ song mid' };
  const guid = String(10000000 + Math.floor(Math.random() * 90000000));
  const cookieObj = qqCookieObject();
  const uin = qqCookieUin(cookieObj) || '0';
  const musicKey = qqCookieMusicKey(cookieObj);
  const playbackKey = qqCookiePlaybackKey(cookieObj);
  const fileMediaMid = String(mediaMid || '').trim();
  const requestedQuality = normalizeQualityPreference(qualityPreference);
  const memberTrackHint = qqPlaybackMemberHints(playbackHints);
  const hasQQPlaybackSession = !!(uin && uin !== '0' && musicKey);
  const mediaIds = [];
  if (fileMediaMid) mediaIds.push(fileMediaMid);
  if (songmid && !mediaIds.includes(songmid)) mediaIds.push(songmid);
  const fileCandidates = mediaIds.flatMap(mediaId =>
    qualityCandidatesFrom(requestedQuality, QQ_QUALITY_CANDIDATE_TEMPLATES)
      .map(item => ({ ...item, mediaId, filename: item.prefix + mediaId + item.ext }))
  );
  const filenames = fileCandidates.map(item => item.filename);
  const param = {
    guid,
    songmid: filenames.length ? filenames.map(() => songmid) : [songmid],
    songtype: filenames.length ? filenames.map(() => 0) : [0],
    uin,
    loginflag: 1,
    platform: '20',
  };
  if (filenames.length) param.filename = filenames;
  const comm = { uin, format: 'json', ct: musicKey ? 19 : 24, cv: 0 };
  if (musicKey) comm.authst = musicKey;
  const json = await qqMusicRequest({
    comm,
    req_0: {
      module: 'vkey.GetVkeyServer',
      method: 'CgiGetVkey',
      param,
    },
  }, { cookie: true, timeoutMs: QQ_VKEY_REQUEST_TIMEOUT_MS });
  const data = json && json.req_0 && json.req_0.data;
  const infos = (data && Array.isArray(data.midurlinfo)) ? data.midurlinfo : [];
  const purlInfos = infos.filter(item => item && item.purl);
  const sips = (data && Array.isArray(data.sip) && data.sip.length ? data.sip : ['https://ws.stream.qqmusic.qq.com/']).filter(Boolean);
  const probeDeadline = Date.now() + QQ_AUDIO_PROBE_TOTAL_MS;
  const probeFailures = [];
  let playableInfo = null;
  let playableUrl = '';
  for (let infoIndex = 0; infoIndex < purlInfos.length && !playableUrl; infoIndex++) {
    const candidateInfo = purlInfos[infoIndex];
    for (let sipIndex = 0; sipIndex < sips.length && !playableUrl; sipIndex++) {
      const remainingMs = probeDeadline - Date.now();
      if (remainingMs < 300) break;
      const candidateUrl = String(sips[sipIndex] || '') + String(candidateInfo.purl || '');
      const probe = await probeQQAudioUrl(candidateUrl, Math.min(QQ_AUDIO_PROBE_ATTEMPT_MS, remainingMs));
      if (probe.ok) {
        playableInfo = candidateInfo;
        playableUrl = candidateUrl;
        break;
      }
      const probeMeta = fileCandidates.find(item => item.filename === candidateInfo.filename) || {};
      probeFailures.push((probeMeta.label || candidateInfo.filename || 'unknown') + ':' + (probe.status || probe.reason || 'failed'));
    }
  }
  const info = playableInfo || purlInfos[0] || infos[0];
  if (playableUrl && playableInfo) {
    const info = playableInfo;
    const fileMeta = fileCandidates.find(item => item.filename === info.filename) || {};
    return {
      provider: 'qq',
      url: playableUrl,
      trial: false,
      playable: true,
      playbackReady: true,
      loggedIn: hasQQPlaybackSession,
      userId: hasQQPlaybackSession ? uin : '',
      playbackKeyReady: !!(uin && playbackKey),
      vipRequired: memberTrackHint,
      level: fileMeta.level || info.filename || '',
      quality: fileMeta.label || info.filename || '',
      filename: info.filename || '',
      probeFailures: probeFailures.slice(0, 12),
      requestedQuality,
    };
  }
  const restriction = classifyQQPlaybackRestriction(info, {
    hasSession: !!(uin && musicKey),
    hasPlaybackKey: !!(uin && playbackKey),
  });
  return {
    provider: 'qq',
    url: '',
    playable: false,
    error: 'QQ_URL_UNAVAILABLE',
    loggedIn: hasQQPlaybackSession,
    playbackKeyReady: !!(uin && playbackKey),
    userId: hasQQPlaybackSession ? uin : '',
    vipRequired: memberTrackHint,
    restriction,
    reason: restriction.category,
    message: restriction.message,
    qqCode: info && (info.result || info.code || info.errtype),
    rawMessage: info && (info.msg || info.tips || info.errmsg || ''),
    tried: fileCandidates.map(item => item.label + ' · ' + item.filename),
    probeFailures: probeFailures.slice(0, 12),
    requestedQuality,
  };
}

function mapQQComment(raw) {
  raw = raw || {};
  const user = raw.user || raw.uin || {};
  const nickname = raw.nick || raw.nickname || raw.encrypt_uin || user.nick || user.nickname || user.name || '小Q用户';
  const avatar = raw.avatarurl || raw.avatar || user.avatarurl || user.avatar || '';
  const timeRaw = Number(raw.time || raw.commenttime || raw.createTime || 0) || 0;
  return {
    id: raw.commentid || raw.commentId || raw.id || '',
    content: raw.rootcommentcontent || raw.content || raw.comment || '',
    likedCount: Number(raw.praisenum || raw.praise_num || raw.likedCount || 0) || 0,
    time: timeRaw && timeRaw < 10000000000 ? timeRaw * 1000 : timeRaw,
    user: {
      id: raw.encrypt_uin || raw.uin || user.uin || '',
      nickname,
      avatar,
    },
  };
}

async function handleQQSongComments(id, mid, limit, offset) {
  let topid = String(id || '').replace(/\D/g, '');
  if (!topid && mid) {
    try {
      const detail = await qqSongDetail(mid, { mid });
      topid = String((detail && (detail.qqId || detail.id)) || '').replace(/\D/g, '');
    } catch (e) {
      console.warn('[QQComments] detail fallback failed:', e.message);
    }
  }
  if (!topid) return { provider: 'qq', error: 'Missing QQ song id', comments: [] };
  const page = Math.max(0, Math.floor((offset || 0) / Math.max(1, limit || 20)));
  const uin = qqCookieUin() || '0';
  const body = await qqGetJSON('https://c.y.qq.com/base/fcgi-bin/fcg_global_comment_h5.fcg', {
    g_tk: '5381',
    loginUin: uin,
    hostUin: '0',
    format: 'json',
    inCharset: 'utf8',
    outCharset: 'utf-8',
    notice: '0',
    platform: 'yqq.json',
    needNewCode: '0',
    cid: '205360772',
    reqtype: '2',
    biztype: '1',
    topid,
    cmd: '8',
    needmusiccrit: '0',
    pagenum: String(page),
    pagesize: String(limit || 20),
  }, { headers: { Referer: 'https://y.qq.com/n/ryqq/songDetail/' + encodeURIComponent(mid || topid) } });
  const hotList = body && body.hot_comment && body.hot_comment.commentlist;
  const normalList = body && body.comment && body.comment.commentlist;
  const raw = (offset === 0 && Array.isArray(hotList) && hotList.length) ? hotList : (normalList || []);
  const comments = (raw || []).map(mapQQComment).filter(c => c.content);
  const total = Number(body && body.comment && (body.comment.commenttotal || body.comment.comment_total)) || comments.length;
  return { provider: 'qq', id: topid, total, comments, hot: !!(offset === 0 && Array.isArray(hotList) && hotList.length) };
}

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ');
}

function decodeQQLyricText(text) {
  let raw = decodeHtmlEntities(String(text || '').trim());
  if (!raw) return '';
  const compact = raw.replace(/\s+/g, '');
  const looksBase64 = compact.length >= 8 && compact.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(compact);
  if (looksBase64 && !/^\s*\[/.test(raw)) {
    try {
      const decoded = Buffer.from(compact, 'base64').toString('utf8').replace(/^\uFEFF/, '');
      if (decoded && (decoded.includes('[') || /[\u4e00-\u9fa5]/.test(decoded))) raw = decoded;
    } catch (e) {
      console.warn('[QQLyric] base64 decode failed:', e.message);
    }
  }
  return decodeHtmlEntities(raw).replace(/\r\n/g, '\n').trim();
}

function normalizeQQSongId(id) {
  const n = String(id || '').replace(/\D/g, '');
  return n ? Number(n) : 0;
}

async function handleQQLyric(mid, id) {
  const songMID = String(mid || '').trim();
  const songID = normalizeQQSongId(id);
  if (!songMID && !songID) return { provider: 'qq', error: 'Missing QQ song mid or id', lyric: '' };

  let lyricText = '';
  let transText = '';
  let qrcText = '';
  let romaText = '';
  let source = 'qq-musicu';

  try {
    const param = {};
    if (songMID) param.songMID = songMID;
    if (songID) param.songID = songID;
    const json = await qqMusicRequest({
      comm: { ct: 24, cv: 0 },
      lyric: {
        module: 'music.musichallSong.PlayLyricInfo',
        method: 'GetPlayLyricInfo',
        param,
      },
    }, { cookie: true });
    const data = json && json.lyric && json.lyric.data;
    lyricText = decodeQQLyricText(data && data.lyric);
    transText = decodeQQLyricText(data && data.trans);
    qrcText = decodeQQLyricText(data && data.qrc);
    romaText = decodeQQLyricText(data && data.roma);
  } catch (e) {
    console.warn('[QQLyric] musicu failed:', e.message);
  }

  if (!lyricText && songMID) {
    try {
      const body = await qqGetJSON('https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg', {
        songmid: songMID,
        songtype: '0',
        format: 'json',
        nobase64: '1',
        g_tk: '5381',
        loginUin: qqCookieUin() || '0',
        hostUin: '0',
        inCharset: 'utf8',
        outCharset: 'utf-8',
        notice: '0',
        platform: 'yqq.json',
        needNewCode: '0',
      }, { headers: { Referer: 'https://y.qq.com/portal/player.html' } });
      lyricText = decodeQQLyricText(body && body.lyric);
      transText = decodeQQLyricText(body && (body.trans || body.tlyric)) || transText;
      source = 'qq-legacy';
    } catch (e) {
      console.warn('[QQLyric] legacy failed:', e.message);
    }
  }

  return {
    provider: 'qq',
    id: songID || '',
    mid: songMID,
    lyric: lyricText,
    tlyric: transText,
    yrc: '',
    qrc: qrcText,
    roma: romaText,
    source: lyricText ? source : 'qq-empty',
  };
}

function mapPodcastRadio(r) {
  r = r || {};
  const dj = r.dj || r.djSimple || r.djUser || r.creator || {};
  const id = r.id || r.rid || r.radioId;
  return {
    id,
    rid: id,
    name: r.name || r.radioName || '',
    cover: r.picUrl || r.picURL || r.coverUrl || r.coverImgUrl || r.avatarUrl || '',
    desc: r.desc || r.description || r.rcmdText || '',
    djName: dj.nickname || r.djName || r.nickname || '',
    category: r.category || r.categoryName || '',
    programCount: r.programCount || r.programNum || r.programCnt || 0,
    subCount: r.subCount || r.subedCount || r.subscriberCount || 0,
  };
}

function mapPodcastProgram(p, fallbackRadio) {
  p = p || {};
  const mainSong = p.mainSong || p.song || p.mainTrack || {};
  const radio = p.radio || fallbackRadio || {};
  const mappedRadio = mapPodcastRadio(radio);
  const artists = mapArtists(mainSong.ar || mainSong.artists || []);
  const album = mainSong.al || mainSong.album || {};
  const dj = p.dj || radio.dj || {};
  const playableId = mainSong.id || p.mainSongId || p.songId;
  return {
    type: 'podcast',
    source: 'podcast',
    id: playableId,
    programId: p.id || p.programId,
    radioId: mappedRadio.id,
    name: p.name || mainSong.name || '',
    artist: mappedRadio.name || dj.nickname || artists.map(a => a.name).join(' / ') || mappedRadio.djName || '',
    artists,
    artistId: artists[0] && artists[0].id,
    album: mappedRadio.name || album.name || 'Podcast',
    cover: p.coverUrl || p.cover || p.blurCoverUrl || mappedRadio.cover || album.picUrl || '',
    duration: p.duration || mainSong.dt || mainSong.duration || 0,
    fee: mainSong.fee,
    djName: mappedRadio.djName || dj.nickname || '',
    radioName: mappedRadio.name || '',
    desc: p.description || p.desc || '',
    createTime: p.createTime || 0,
    serialNum: p.serialNum || p.serial || 0,
  };
}

function firstArrayFrom(obj, keys) {
  obj = obj || {};
  for (const key of keys) {
    const value = obj[key];
    if (Array.isArray(value)) return value;
    if (value && Array.isArray(value.list)) return value.list;
    if (value && Array.isArray(value.data)) return value.data;
    if (value && Array.isArray(value.resources)) return value.resources;
  }
  return [];
}

function mapPodcastVoice(v) {
  v = v || {};
  const raw = v.resource || v.voice || v.data || v.program || v;
  const mainSong = raw.mainSong || raw.song || raw.track || {};
  const radio = raw.radio || raw.djRadio || raw.voiceList || raw.podcast || {};
  const playableId = raw.trackId || raw.songId || raw.mainSongId || mainSong.id || raw.id;
  return {
    type: 'podcast',
    source: 'podcast',
    sourceType: 'podcast-voice',
    id: playableId,
    programId: raw.programId || raw.voiceId || raw.id,
    radioId: radio.id || radio.radioId || radio.voiceListId || raw.radioId || raw.voiceListId,
    name: raw.name || raw.songName || raw.title || mainSong.name || '',
    artist: (radio.name || radio.radioName || radio.voiceListName || raw.podcastName || raw.djName || 'Voice'),
    album: radio.name || radio.radioName || raw.podcastName || 'Podcast',
    cover: raw.coverUrl || raw.cover || raw.picUrl || raw.coverImgUrl || radio.picUrl || radio.coverUrl || '',
    duration: raw.duration || raw.durationMs || mainSong.dt || mainSong.duration || 0,
    djName: raw.djName || (radio.dj && radio.dj.nickname) || '',
    radioName: radio.name || radio.radioName || raw.podcastName || '',
    desc: raw.desc || raw.description || '',
  };
}

function mapPodcastCollectionRadio(r, key) {
  const radio = mapPodcastRadio(r);
  return {
    ...radio,
    type: 'podcast-radio',
    sourceType: 'podcast-radio',
    collectionKey: key || '',
    radioId: radio.id,
    name: radio.name,
    artist: radio.djName || radio.category || 'Podcast',
    album: radio.category || 'Podcast',
  };
}

function podcastCollectionMeta(key, items) {
  const meta = {
    collect: { key: 'collect', title: '收藏播客', sub: '你收藏的播客', itemType: 'radio' },
    created: { key: 'created', title: '创建播客', sub: '你创建的播客', itemType: 'radio' },
    liked: { key: 'liked', title: '喜欢的声音', sub: '收藏或最近喜欢的声音', itemType: 'voice' },
  }[key] || { key, title: key, sub: '', itemType: 'radio' };
  const first = (items || [])[0] || {};
  return {
    ...meta,
    count: (items || []).length,
    cover: first.cover || first.picUrl || first.coverUrl || '',
  };
}

async function fetchMyPodcastItems(key, info, limit, offset) {
  limit = Math.max(8, Math.min(60, Number(limit) || 30));
  offset = Math.max(0, Number(offset) || 0);
  if (key === 'collect') {
    const r = await dj_sublist({ limit, offset, cookie: userCookie, timestamp: Date.now() });
    const raw = firstArrayFrom(r.body, ['djRadios', 'djradios', 'radios', 'data']);
    return { itemType: 'radio', items: raw.map(x => mapPodcastCollectionRadio(x, key)).filter(x => x.id) };
  }
  if (key === 'created') {
    const r = await user_audio({ uid: info.userId, cookie: userCookie, timestamp: Date.now() });
    const raw = firstArrayFrom(r.body, ['data', 'djRadios', 'djradios', 'radios']);
    return { itemType: 'radio', items: raw.map(x => mapPodcastCollectionRadio(x, key)).filter(x => x.id) };
  }
  if (key === 'paid') {
    const r = await dj_paygift({ limit, offset, cookie: userCookie, timestamp: Date.now() });
    const raw = firstArrayFrom(r.body, ['data', 'djRadios', 'djradios', 'radios']);
    return { itemType: 'radio', items: raw.map(x => mapPodcastCollectionRadio(x, key)).filter(x => x.id) };
  }
  if (key === 'liked') {
    let raw = [];
    try {
      const sati = await sati_resource_sub_list({ cookie: userCookie, timestamp: Date.now() });
      raw = firstArrayFrom(sati.body, ['data', 'resources', 'list']);
    } catch (e) {
      console.warn('[MyPodcastLiked] sati sub list failed:', e.message);
    }
    if (!raw.length) {
      try {
        const recent = await record_recent_voice({ limit, cookie: userCookie, timestamp: Date.now() });
        raw = firstArrayFrom(recent.body, ['data', 'list', 'resources']);
      } catch (e) {
        console.warn('[MyPodcastLiked] recent voice fallback failed:', e.message);
      }
    }
    return { itemType: 'voice', items: raw.map(mapPodcastVoice).filter(x => x.id && x.name) };
  }
  return { itemType: 'radio', items: [] };
}

// ---------- 业务: 取歌曲URL (探测试听) ----------
//   返回 { url, trial, level, br }
//   trial=true 表示这是试听片段 (freeTrialInfo 非空)
async function resolveNeteaseDirectSongUrl(id, loginInfo, qualityPreference) {
  console.log('[SongUrl] id:', id, 'logged-in:', !!userCookie);
  const resolveDeadline = Date.now() + NETEASE_DIRECT_RESOLVE_BUDGET_MS;
  const requestedQuality = normalizeQualityPreference(qualityPreference);
  const svipReady = hasNeteaseSvip(loginInfo);
  const qualities = qualityCandidatesFrom(requestedQuality, NETEASE_QUALITY_CANDIDATES)
    .filter(q => !q.svip || svipReady);

  let trialFallback = null; // 兜底: 即使是试听也要能播
  let lastData = null;
  let lastError = null;
  const probeFailures = [];
  const probeCache = new Map();

  for (const q of qualities) {
    if (resolveDeadline - Date.now() < 500) break;
    try {
      // 优先用 v1 接口 (支持更高音质 level 字段)
      let result;
      try {
        result = await promiseWithTimeout(
          song_url_v1({ id, level: q.level, cookie: userCookie }),
          Math.min(2600, Math.max(500, resolveDeadline - Date.now())),
          'NETEASE_DIRECT_URL_TIMEOUT'
        );
      } catch (e) {
        lastError = e;
        if (resolveDeadline - Date.now() < 500) throw e;
        result = await promiseWithTimeout(
          song_url({ id, br: q.br, cookie: userCookie }),
          Math.min(2200, Math.max(500, resolveDeadline - Date.now())),
          'NETEASE_LEGACY_URL_TIMEOUT'
        );
      }
      const d = result.body && result.body.data && result.body.data[0];
      if (d) lastData = d;
      const url = d && d.url;
      const freeTrial = d && d.freeTrialInfo;
      console.log('[SongUrl]', q.level, '->', url ? 'OK' : 'no url', freeTrial ? '(TRIAL)' : '');
      let probe = null;
      if (url) {
        probe = probeCache.get(url);
        if (!probe) {
          probe = await probePlaybackAudioUrl(url, Math.min(2500, Math.max(600, resolveDeadline - Date.now())));
          probeCache.set(url, probe);
        }
        if (!probe.ok || !probe.magic) {
          probeFailures.push(q.level + ':' + (probe.status || probe.reason || 'invalid-audio'));
          continue;
        }
      }
      if (url && !freeTrial && probe && probe.ok) {
        return {
          provider: 'netease',
          source: 'netease',
          url,
          trial: false,
          playable: true,
          level: q.level,
          quality: q.label,
          br: d.br,
          requestedQuality,
          probeStatus: probe.status,
          probeBytes: probe.bytes,
          probeMagic: probe.magic,
        };
      }
      if (url && freeTrial && probe && probe.ok && !trialFallback) {
        trialFallback = {
          provider: 'netease',
          source: 'netease',
          url,
          trial: true,
          playable: true,
          level: q.level,
          quality: q.label,
          br: d.br,
          requestedQuality,
          trialInfo: freeTrial,
          restriction: classifyNeteasePlaybackRestriction(d, loginInfo),
          probeStatus: probe.status,
          probeBytes: probe.bytes,
          probeMagic: probe.magic,
        };
      }
    } catch (err) {
      lastError = err;
      console.log('[SongUrl]', q.level, 'failed:', err.message);
    }
  }
  if (trialFallback) return trialFallback;
  const restriction = classifyNeteasePlaybackRestriction(lastData, loginInfo);
  return {
    provider: 'netease',
    source: 'netease',
    url: null,
    trial: false,
    playable: false,
    reason: restriction.category,
    message: restriction.message,
    restriction,
    lastCode: lastData && lastData.code,
    fee: lastData && lastData.fee,
    error: lastError && lastError.message,
    probeFailures: probeFailures.slice(0, 12),
    requestedQuality,
  };
}

async function resolveNeteaseSameTrackPlayback(id, loginInfo, qualityPreference, matchHints, requestDeadline) {
  const ownDeadline = Date.now() + NETEASE_SOURCE_MATCH_TOTAL_BUDGET_MS;
  const deadline = Number(requestDeadline) > 0 ? Math.min(ownDeadline, Number(requestDeadline)) : ownDeadline;
  let candidates = [];
  try {
    const lookupBudget = Math.min(NETEASE_SOURCE_MATCH_LOOKUP_BUDGET_MS, Math.max(500, deadline - Date.now()));
    candidates = await promiseWithTimeout(
      findNeteaseSameTrackCandidates(id, matchHints, Date.now() + lookupBudget),
      lookupBudget,
      'NETEASE_SOURCE_MATCH_LOOKUP_TIMEOUT'
    );
  } catch (err) {
    console.warn('[NeteaseSourceMatch] lookup failed:', err.code || err.message);
    return null;
  }
  const excludedIds = new Set(String(matchHints && matchHints.excludeIds || '')
    .split(',')
    .map(value => String(value || '').trim())
    .filter(Boolean));
  const attemptedIds = [...excludedIds];
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    const candidateId = String(candidate && candidate.song && candidate.song.id || '');
    if (!candidateId || excludedIds.has(candidateId)) continue;
    attemptedIds.push(candidateId);
    try {
      const remainingMs = deadline - Date.now();
      if (remainingMs < 800) break;
      const playback = await promiseWithTimeout(
        resolveNeteaseDirectSongUrl(candidate.song.id, loginInfo, qualityPreference),
        Math.min(NETEASE_DIRECT_RESOLVE_BUDGET_MS, remainingMs),
        'NETEASE_SOURCE_MATCH_PLAYBACK_TIMEOUT'
      );
      if (!playback || !playback.url || playback.trial) continue;
      return { candidate, playback, triedIds: attemptedIds.slice() };
    } catch (err) {
      console.warn('[NeteaseSourceMatch] candidate failed:', candidate.song && candidate.song.id, err.code || err.message);
    }
  }
  return null;
}

async function handleSongUrl(id, loginInfo, qualityPreference, matchHints) {
  const hints = matchHints || {};
  const requestDeadline = Date.now() + NETEASE_SONG_URL_TOTAL_BUDGET_MS;
  let direct = null;
  if (!hints.skipDirect) {
    try {
      direct = await promiseWithTimeout(
        resolveNeteaseDirectSongUrl(id, loginInfo, qualityPreference),
        Math.min(NETEASE_DIRECT_RESOLVE_BUDGET_MS + 300, Math.max(500, requestDeadline - Date.now())),
        'NETEASE_DIRECT_RESOLVE_TIMEOUT'
      );
    } catch (err) {
      const restriction = playbackRestriction('netease', 'url_unavailable', '小云音源请求超时，已继续尝试站内同一录音版本', 'retry', { code: err.code || 'NETEASE_DIRECT_RESOLVE_TIMEOUT' });
      direct = {
        provider: 'netease',
        source: 'netease',
        url: null,
        trial: false,
        playable: false,
        reason: restriction.category,
        message: restriction.message,
        restriction,
        error: err.code || err.message,
      };
    }
  } else {
    const restriction = playbackRestriction('netease', 'url_unavailable', '正在继续尝试小云站内的其它同曲版本', 'retry', { code: 'NETEASE_DIRECT_SKIPPED_AFTER_MATCH_FAILURE' });
    direct = {
      provider: 'netease',
      source: 'netease',
      url: null,
      trial: false,
      playable: false,
      reason: restriction.category,
      message: restriction.message,
      restriction,
      error: 'NETEASE_DIRECT_SKIPPED_AFTER_MATCH_FAILURE',
    };
  }
  if (direct && direct.url && !direct.trial) return direct;
  const sourceMatchAttempted = !!(String(hints.name || hints.title || '').trim() && String(hints.artist || '').trim());
  const matched = await resolveNeteaseSameTrackPlayback(id, loginInfo, qualityPreference, hints, requestDeadline);
  if (!matched) return { ...direct, sourceMatchAttempted };
  return {
    ...matched.playback,
    provider: 'netease',
    source: 'netease-same-track',
    sourceMatch: true,
    matchKind: matched.candidate.fingerprintMatches > 0
      ? 'netease_same_recording'
      : (matched.candidate.officialRecommendation ? 'netease_official_alternate' : 'netease_same_track_metadata'),
    matchedFromId: String(id || ''),
    requestedSongId: String(id || ''),
    resolvedNeteaseId: String(matched.candidate.song.id || ''),
    resolvedSongId: String(matched.candidate.song.id || ''),
    matchedSong: matched.candidate.song,
    matchScore: Math.round(matched.candidate.score || 0),
    fingerprintMatches: matched.candidate.fingerprintMatches || 0,
    sourceMatchTriedIds: matched.triedIds || [String(matched.candidate.song.id || '')],
    originalRestriction: direct && direct.restriction || null,
  };
}

async function handleNeteaseCloudSongUrl(id, loginInfo, qualityPreference) {
  id = String(id || '').trim();
  if (!id) return { provider: 'netease', source: 'netease-cloud', playable: false, error: 'MISSING_CLOUD_SONG_ID' };
  if (!loginInfo || !loginInfo.loggedIn || !userCookie) {
    return {
      provider: 'netease',
      source: 'netease-cloud',
      playable: false,
      error: 'NETEASE_CLOUD_LOGIN_REQUIRED',
      message: '网易云音乐云盘需要登录后播放',
    };
  }
  const result = await enhancedNeteaseCloudDownload({ id, cookie: userCookie, timestamp: Date.now() });
  const body = result && (result.body || result) || {};
  const url = extractNeteaseCloudAudioUrl(body);
  const payload = body && body.data && typeof body.data === 'object' && !Array.isArray(body.data)
    ? body.data
    : body;
  if (!url) {
    return {
      provider: 'netease',
      source: 'netease-cloud',
      cloudSong: true,
      cloudId: id,
      playable: false,
      error: 'NETEASE_CLOUD_URL_UNAVAILABLE',
      message: '网易云音乐云盘没有返回可播放地址',
      code: body && body.code,
      requestedQuality: qualityPreference || '',
    };
  }
  return {
    provider: 'netease',
    source: 'netease-cloud',
    cloudSong: true,
    cloudId: id,
    url,
    playable: true,
    trial: false,
    level: payload && (payload.level || payload.type || '') || '',
    quality: payload && (payload.quality || payload.br || '') || '',
    br: payload && (payload.br || payload.bitrate || 0) || 0,
    size: payload && (payload.size || payload.fileSize || 0) || 0,
    requestedQuality: qualityPreference || '',
  };
}

// ---------- 业务: 登录态/用户信息 ----------
function readCookieFromResponse(resp) {
  const candidates = [
    resp && resp.cookie,
    resp && resp.body && resp.body.cookie,
    resp && resp.body && resp.body.data && resp.body.data.cookie,
    resp && resp.body && resp.body.data && resp.body.data.cookies,
  ];
  for (const candidate of candidates) {
    const cookie = normalizeCookieHeader(candidate);
    if (cookie) return cookie;
  }
  return '';
}
function firstPositiveNumberFrom(objects, keys) {
  for (const obj of objects) {
    if (!obj || typeof obj !== 'object') continue;
    for (const key of keys) {
      const value = Number(obj[key]);
      if (Number.isFinite(value) && value > 0) return value;
    }
  }
  return 0;
}
function collectStringValues(value, out, depth) {
  if (depth > 4 || value == null) return out;
  if (typeof value === 'string') {
    if (value) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach(item => collectStringValues(item, out, depth + 1));
    return out;
  }
  if (typeof value === 'object') {
    Object.keys(value).forEach(key => collectStringValues(value[key], out, depth + 1));
  }
  return out;
}
function collectVipStringValues(value, out, depth) {
  if (depth > 4 || value == null) return out;
  if (Array.isArray(value)) {
    value.forEach(item => collectVipStringValues(item, out, depth + 1));
    return out;
  }
  if (typeof value !== 'object') return out;
  Object.keys(value).forEach(key => {
    const child = value[key];
    if (/vip|svip|member|associator|privilege|right|level|package|label|title|type/i.test(key)) {
      collectStringValues(child, out, depth + 1);
    } else if (child && typeof child === 'object') {
      collectVipStringValues(child, out, depth + 1);
    }
  });
  return out;
}
const neteaseVipInfoCache = new Map();
function activeNeteaseVipPackage(pkg) {
  if (!pkg || typeof pkg !== 'object') return false;
  const expire = Number(pkg.expireTime || pkg.expire_time || pkg.expire || pkg.endTime || 0) || 0;
  if (expire && expire < Date.now()) return false;
  return firstPositiveNumberFrom([pkg], ['vipLevel', 'vip_level', 'level', 'vipType', 'vip_type', 'vipCode', 'vip_code', 'status']) > 0;
}
async function fetchNeteaseVipInfo(userId) {
  userId = String(userId || '').trim();
  if (!userId || !userCookie) return null;
  const cached = neteaseVipInfoCache.get(userId);
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.value;
  let body = null;
  try {
    const r = await vip_info_v2({ uid: userId, cookie: userCookie, timestamp: Date.now() });
    body = r && r.body ? r.body : r;
  } catch (e) {
    try {
      const r = await vip_info({ uid: userId, cookie: userCookie, timestamp: Date.now() });
      body = r && r.body ? r.body : r;
    } catch (err) {
      console.warn('[Login] vip_info failed:', err.message);
    }
  }
  if (body) neteaseVipInfoCache.set(userId, { at: Date.now(), value: body });
  return body;
}
function normalizeNeteaseVip(profile, account, extra) {
  profile = profile || {};
  account = account || {};
  extra = extra || {};
  const vipInfo = profile.vipInfo || profile.vipinfo || account.vipInfo || account.vipinfo || extra.vipInfo || extra.vipinfo || {};
  const vipExtra = extra.vipExtra || extra.vip_info || extra.vipInfoV2 || {};
  const vipData = vipExtra.data || vipExtra;
  const objects = [account, profile, vipInfo, extra, vipData];
  const vipType = firstPositiveNumberFrom(objects, [
    'vipType', 'vip_type', 'viptype', 'musicVipType', 'music_vip_type',
    'musicVipLevel', 'music_vip_level', 'redVipLevel', 'red_vip_level',
    'blackVipLevel', 'black_vip_level', 'luxuryVipLevel', 'luxury_vip_level',
  ]);
  const text = collectVipStringValues({ account, profile, vipInfo, extra, vipData }, [], 0).join(' ').toLowerCase();
  const redplus = vipData.redplus || vipData.redPlus || vipInfo.redplus || vipInfo.redPlus || extra.redplus || extra.redPlus;
  const associator = vipData.associator || vipInfo.associator || extra.associator;
  const musicPackage = vipData.musicPackage || vipData.music_package || vipInfo.musicPackage || vipInfo.music_package || extra.musicPackage || extra.music_package;
  const svipType = firstPositiveNumberFrom(objects, [
    'svipType', 'svip_type', 'superVipLevel', 'super_vip_level', 'superVipType', 'super_vip_type',
  ]);
  const svipFlag = objects.some(obj => obj && (
    obj.isSvip === true || obj.is_svip === true || obj.svip === true ||
    Number(obj.isSvip || obj.is_svip || obj.svip || obj.svipType || obj.svip_type || obj.superVipLevel || obj.super_vip_level || 0) > 0
  )) || /svip|supervip|super_vip|黑胶svip|超级会员/.test(text);
  const vipFlag = objects.some(obj => obj && (
    obj.isVip === true || obj.is_vip === true || obj.vip === true ||
    Number(obj.isVip || obj.is_vip || obj.vip || obj.vipFlag || obj.vipflag || 0) > 0
  )) || /vip|黑胶|会员/.test(text);
  const svipResolved = svipFlag || svipType > 0 || activeNeteaseVipPackage(redplus);
  const vipResolved = vipFlag || activeNeteaseVipPackage(associator) || activeNeteaseVipPackage(musicPackage);
  const isSvip = svipResolved;
  const isVip = isSvip || vipResolved || vipType > 0;
  const vipLevel = isSvip ? 'svip' : (isVip ? 'vip' : 'none');
  return {
    vipType,
    vipLevel,
    isVip,
    isSvip,
    vipLabel: vipLevel === 'svip' ? 'SVIP' : (vipLevel === 'vip' ? 'VIP' : '无VIP'),
  };
}
function normalizeLoginInfo(profile, account, extra) {
  profile = profile || {};
  account = account || {};
  const userId = profile.userId || profile.user_id || profile.id || account.userId || account.id || '';
  if (!(userId || userId === 0)) return { loggedIn: false };
  const vip = normalizeNeteaseVip(profile, account, extra);
  return {
    loggedIn: true,
    userId,
    nickname: profile.nickname || profile.userName || '小云用户',
    avatar: profile.avatarUrl || profile.avatar || '',
    ...vip,
  };
}
async function enrichNeteaseLoginInfo(info, profile, account, extra) {
  if (!info || !info.loggedIn || !info.userId) return info;
  let vipExtra = null;
  try {
    vipExtra = await promiseWithTimeout(fetchNeteaseVipInfo(info.userId), 1800, 'NETEASE_VIP_INFO_TIMEOUT');
  } catch (err) {
    console.warn('[Login] vip info timeout:', err.code || err.message);
  }
  if (!vipExtra) return info;
  const vip = normalizeNeteaseVip(profile, account, { ...(extra || {}), vipExtra });
  return { ...info, ...vip };
}
function isNeteaseAuthInvalidPayload(payload) {
  const code = normalizeApiCode(payload);
  if (code === 301 || code === 401) return true;
  const msg = normalizeApiMessage(payload);
  return /未登录|需要登录|请先登录|login/i.test(msg) && code >= 300;
}
async function fetchNeteaseLoginInfo() {
  if (!userCookie) return { loggedIn: false, vipType: 0, vipLevel: 'none', isVip: false, isSvip: false, vipLabel: '无VIP' };

  // login_status 对二维码 cookie 的资料刷新通常更及时；失败时再降级到 user_account。
  try {
    const st = await promiseWithTimeout(login_status({ cookie: userCookie, timestamp: Date.now() }), 2400, 'NETEASE_LOGIN_STATUS_TIMEOUT');
    const body = st.body || {};
    const data = body.data || body;
    const profile = data.profile || body.profile;
    const account = data.account || body.account;
    const info = normalizeLoginInfo(profile, account, data);
    if (info.loggedIn) return await enrichNeteaseLoginInfo(info, profile, account, data);
  } catch (e) {
    console.warn('[Login] login_status failed:', e.message);
  }

  try {
    const acc = await promiseWithTimeout(user_account({ cookie: userCookie, timestamp: Date.now() }), 2400, 'NETEASE_ACCOUNT_STATUS_TIMEOUT');
    const body = acc.body || {};
    const info = normalizeLoginInfo(body.profile, body.account, body);
    if (info.loggedIn) return await enrichNeteaseLoginInfo(info, body.profile, body.account, body);
    if (isNeteaseAuthInvalidPayload(acc)) saveCookie('');
    return { loggedIn: false, hasCookie: !!userCookie, vipType: 0, vipLevel: 'none', isVip: false, isSvip: false, vipLabel: '无VIP' };
  } catch (e) {
    console.warn('[Login] account check failed:', e.message);
    return { loggedIn: false, hasCookie: !!userCookie, vipType: 0, vipLevel: 'none', isVip: false, isSvip: false, vipLabel: '无VIP' };
  }
}
const NETEASE_LOGIN_INFO_CACHE_TTL_MS = 30 * 1000;
let neteaseLoginInfoCache = { cookie: '', at: 0, value: null, promise: null };
function clearNeteaseLoginInfoCache() {
  neteaseLoginInfoCache = { cookie: '', at: 0, value: null, promise: null };
}
async function getLoginInfo() {
  if (!userCookie) return { loggedIn: false, vipType: 0, vipLevel: 'none', isVip: false, isSvip: false, vipLabel: '无VIP' };
  const cookieKey = userCookie;
  if (neteaseLoginInfoCache.cookie === cookieKey && neteaseLoginInfoCache.value && Date.now() - neteaseLoginInfoCache.at < NETEASE_LOGIN_INFO_CACHE_TTL_MS) {
    return neteaseLoginInfoCache.value;
  }
  if (neteaseLoginInfoCache.cookie === cookieKey && neteaseLoginInfoCache.promise) return neteaseLoginInfoCache.promise;
  const request = fetchNeteaseLoginInfo().then(info => {
    if (userCookie === cookieKey) {
      neteaseLoginInfoCache.cookie = cookieKey;
      neteaseLoginInfoCache.at = Date.now();
      neteaseLoginInfoCache.value = info;
    }
    return info;
  }).finally(() => {
    if (neteaseLoginInfoCache.cookie === cookieKey) neteaseLoginInfoCache.promise = null;
  });
  neteaseLoginInfoCache.cookie = cookieKey;
  neteaseLoginInfoCache.promise = request;
  return request;
}
async function getPlaybackLoginInfo() {
  try {
    return await promiseWithTimeout(getLoginInfo(), 800, 'NETEASE_PLAYBACK_LOGIN_INFO_TIMEOUT');
  } catch (err) {
    const stale = neteaseLoginInfoCache.cookie === userCookie && neteaseLoginInfoCache.value;
    if (stale) return stale;
    return { loggedIn: !!userCookie, hasCookie: !!userCookie, vipType: 0, vipLevel: 'none', isVip: false, isSvip: false, vipLabel: '无VIP', statusPending: true };
  }
}

function normalizeListenReportProvider(value) {
  value = String(value || '').trim().toLowerCase();
    return value === 'netease' || value === 'cloud' || value === 'song' ? 'netease' : '';
}

function listenReportSongId(provider, song) {
  song = song && typeof song === 'object' ? song : {};
  if (provider === 'qq') return String(song.qqId || song.mid || song.mediaMid || song.id || '');
  if (provider === 'kugou') return String(song.hash || song.mixSongId || song.providerSongId || song.id || '');
      return String(song.id || song.providerSongId || '');
}

function validateListenReport(body) {
  body = body && typeof body === 'object' ? body : {};
  const song = body.song && typeof body.song === 'object' ? body.song : {};
  const provider = normalizeListenReportProvider(
    body.provider || song.provider || song.source || song.sourceKey || song.type || song.resolvedPlaybackProvider
  );
  const songId = listenReportSongId(provider, song);
  const sessionId = String(body.sessionId || '').trim().slice(0, 160);
  const listenMs = Math.max(0, Math.min(12 * 60 * 60 * 1000, Math.round(Number(body.listenMs) || 0)));
  const durationMs = Math.max(0, Math.min(12 * 60 * 60 * 1000, Math.round(Number(body.durationMs) || 0)));
  const cappedListenMs = durationMs > 0 ? Math.min(listenMs, durationMs + 2500) : listenMs;
  const requiredMs = durationMs > 0
    ? (durationMs <= 30000 ? durationMs * 0.8 : Math.min(30000, durationMs * 0.5))
    : 30000;
  const eligible = !!(
    provider &&
    songId &&
    sessionId.length >= 8 &&
    cappedListenMs >= Math.max(5000, requiredMs) &&
    song.type !== 'local' &&
    song.type !== 'podcast' &&
    song.source !== 'podcast' &&
    !song.trial
  );
  return {
    provider,
    song,
    songId,
    sessionId,
    listenMs: cappedListenMs,
    durationMs,
    requiredMs: Math.ceil(requiredMs),
    eligible,
    context: body.context && typeof body.context === 'object' ? body.context : {},
  };
}

function resolveNeteaseListenSourceId(report) {
  report = report && typeof report === 'object' ? report : {};
  const context = report.context && typeof report.context === 'object' ? report.context : {};
  const song = report.song && typeof report.song === 'object' ? report.song : {};
  const album = song.album && typeof song.album === 'object' ? song.album : {};
  const candidates = [
    context.playlistId,
    context.sourceId,
    context.id,
    song.albumId,
    song.album_id,
    album.id,
  ];
  for (const candidate of candidates) {
    const value = String(candidate == null ? '' : candidate).trim();
    if (/^\d+$/.test(value) && value !== '0') return value;
  }
  const songId = String(report.songId || song.id || '').trim();
  return /^\d+$/.test(songId) && songId !== '0' ? songId : '0';
}

async function handlePlatformListenReport(body) {
  const report = validateListenReport(body);
  const base = {
    provider: report.provider || 'unknown',
    songId: report.songId,
    sessionId: report.sessionId,
    listenMs: report.listenMs,
    durationMs: report.durationMs,
    eligible: report.eligible,
    localRecorded: true,
    platformSubmitted: false,
    historySynced: false,
    accountDurationSync: 'unsupported',
  };
  if (!report.eligible) {
    return Object.assign(base, {
      accepted: false,
      reason: 'LISTEN_REPORT_NOT_ELIGIBLE',
      requiredMs: report.requiredMs,
    });
  }

  let credential = '';
  if (report.provider === 'netease') credential = userCookie;
    const journalKey = listenSyncJournalKey(report.provider, credential, report.sessionId);
  const previous = listenSyncJournal.entries[journalKey];
  if (previous) {
    return Object.assign(base, previous, {
      accepted: true,
      duplicate: true,
      platformSubmitted: true,
    });
  }

  if (report.provider === 'netease') {
    const info = await getLoginInfo();
    if (!info.loggedIn || !userCookie) {
      return Object.assign(base, { accepted: true, reason: 'NETEASE_LOGIN_REQUIRED' });
    }
    const sourceId = resolveNeteaseListenSourceId(report);
    const listenSeconds = Math.max(1, Math.floor(report.listenMs / 1000));
    const result = await enhancedNeteaseScrobble({
      id: report.songId,
      sourceid: sourceId,
      time: listenSeconds,
      cookie: userCookie,
      timestamp: Date.now(),
    });
    const code = normalizeApiCode(result);
    const resultBody = result && (result.body || result) || {};
    const details = resultBody.details && typeof resultBody.details === 'object' ? resultBody.details : {};
    const startplayCode = details.startplay ? normalizeApiCode(details.startplay) : 0;
    const playCode = details.play ? normalizeApiCode(details.play) : 0;
    if (code !== 200 || startplayCode !== 200 || playCode !== 200) {
      const err = new Error(normalizeApiMessage(result) || 'NETEASE_SCROBBLE_FAILED');
      err.code = 'NETEASE_SCROBBLE_FAILED';
      err.statusCode = code || playCode || startplayCode;
      err.reportCodes = { code, startplayCode, playCode };
      throw err;
    }
    const submitted = Object.assign(base, {
      accepted: true,
      platformSubmitted: true,
      accountDurationSync: 'submitted_unverified',
      platformCode: code,
      reporter: 'enhanced-eapi',
      startplayCode,
      playCode,
      sourceId,
      listenSeconds,
    });
    rememberListenSyncSubmission(journalKey, submitted);
    console.log('[ListenReport] netease submitted', {
      songId: report.songId,
      sourceId,
      listenSeconds,
      code,
      startplayCode,
      playCode,
    });
    return submitted;
  }

  return Object.assign(base, {
    accepted: true,
    reason: 'PLATFORM_DURATION_WRITE_UNAVAILABLE',
  });
}

// ====================================================================
//  HTTP Server
// ====================================================================
// 局域网遥控只需要遥控页面和 /api/remote/*。把可达面收在这个白名单里，
// 这样以后为了遥控把 MINERADIO_HOST 放开到 0.0.0.0 时，其余 74 个端点
// （本地音乐流、听歌数据、平台账号）仍然只有本机可达。
const REMOTE_PUBLIC_PATHS = new Set(['/remote.html', '/favicon.ico']);
function pathAllowedForRemoteOrigin(pn) {
  if (REMOTE_PUBLIC_PATHS.has(pn)) return true;
  return pn.startsWith('/api/remote/') || pn.startsWith('/remote-assets/');
}
async function handleHttpRequest(req, res) {
  refreshConfiguredCookieStores(false);
  const url = new URL(req.url, 'http://localhost:' + PORT);
  const pn = url.pathname;

  // 遥控监听器上的请求一律按外部来源处理，即使源地址是回环。
  // 它绑在 0.0.0.0 上，本机进程没有理由走它 —— 强制降权比按源地址判定更严。
  const treatAsRemote = req.socket && req.socket.__mineradioRemoteListener === true;
  if ((treatAsRemote || !requestIsLoopback(req)) && !pathAllowedForRemoteOrigin(pn)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('Forbidden: non-loopback origin');
    return;
  }
  // 管理面（配对码/状态上报/撤销）自己还会再查一次回环，这里把遥控监听器
  // 上的请求提前标记成非回环，避免它们绕过那一层。
  if (treatAsRemote) req.__mineradioForceRemote = true;

  // 去掉 CORS 通配头只挡住了跨站「读」—— 恶意页面照样能发出 POST/GET 触发副作用
  // （登出、顶替登录 cookie、改设置），只是读不到响应。所以这里对所有非遥控路径
  // 统一查一次来源：浏览器发起跨站请求必带 Origin，原生客户端和回归测试不带，
  // requestHasTrustedLocalOrigin 正是按这条线区分的。遥控路径走 token 鉴权，
  // 且它的合法来源是遥控端口而不是主端口，必须排除在外。
  if (!pathAllowedForRemoteOrigin(pn) && !requestHasTrustedLocalOrigin(req)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('Forbidden: cross-site origin');
    return;
  }

  if (pn === '/api/local-media') {
    const id = String(url.searchParams.get('id') || '');
    const target = localMediaIndex.get(id);
    if (!target || (req.method !== 'GET' && req.method !== 'HEAD')) {
      res.writeHead(target ? 405 : 404);
      res.end(target ? 'Method not allowed' : 'Not found');
      return;
    }
    await streamRegisteredLocalMedia(req, res, target);
    return;
  }

  // ---------- 局域网遥控 ----------
  // 配对：局域网可达（这是准入入口），但限速与废码逻辑在 pairRemoteDevice 里。
  if (pn === '/api/remote/pair') {
    if (req.method !== 'POST') {
      sendPrivateJSON(res, { ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);
      return;
    }
    if (!requireJSONRequest(req, res)) return;
    try {
      const result = await pairRemoteDevice(await readRequestBody(req), req);
      sendPrivateJSON(res, result, result.ok ? 200 : 401);
    } catch (err) {
      console.error('[RemotePair]', err);
      sendPrivateJSON(res, { ok: false, error: 'PAIRING_FAILED' }, 500);
    }
    return;
  }

  // 状态读取：局域网可达，必须持有 token。
  if (pn === '/api/remote/state') {
    if (req.method !== 'GET') {
      sendPrivateJSON(res, { ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);
      return;
    }
    try {
      const device = await authorizeRemoteRequest(req, url);
      if (!device) {
        sendPrivateJSON(res, { ok: false, error: 'REMOTE_TOKEN_REQUIRED' }, 401);
        return;
      }
      sendPrivateJSON(res, readRemoteState());
    } catch (err) {
      console.error('[RemoteState]', err);
      sendPrivateJSON(res, { ok: false, error: 'REMOTE_STATE_FAILED' }, 500);
    }
    return;
  }

  // 封面：局域网可达，必须持有 token。手机拿不到平台图床地址，只拿这个相对地址。
  if (pn === '/api/remote/cover') {
    try {
      const device = await authorizeRemoteRequest(req, url);
      if (!device) {
        sendPrivateJSON(res, { ok: false, error: 'REMOTE_TOKEN_REQUIRED' }, 401);
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendPrivateJSON(res, { ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);
        return;
      }
      await serveRemoteCover(req, res);
    } catch (err) {
      console.error('[RemoteCover]', err);
      if (!res.headersSent) { res.writeHead(500); res.end(); }
    }
    return;
  }

  // 命令下发：局域网可达，必须持有 token，命令走白名单。
  if (pn === '/api/remote/command') {
    if (req.method !== 'POST') {
      sendPrivateJSON(res, { ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);
      return;
    }
    if (!requireJSONRequest(req, res)) return;
    try {
      const device = await authorizeRemoteRequest(req, url);
      if (!device) {
        sendPrivateJSON(res, { ok: false, error: 'REMOTE_TOKEN_REQUIRED' }, 401);
        return;
      }
      const result = dispatchRemoteCommand(await readRequestBody(req));
      sendPrivateJSON(res, result, result.ok ? 200 : (result.error === 'REMOTE_SINK_UNAVAILABLE' ? 503 : 400));
    } catch (err) {
      console.error('[RemoteCommand]', err);
      sendPrivateJSON(res, { ok: false, error: 'REMOTE_COMMAND_FAILED' }, 500);
    }
    return;
  }

  // 以下三个是管理面，只服务本机：配对码、状态上报、撤销设备。
  // 放在 /api/remote/* 命名空间下，所以必须逐个再挡一次回环。
  if (pn === '/api/remote/pairing') {
    if (!requireTrustedLocalManagementRequest(req, res)) return;
    if (req.method !== 'GET' && req.method !== 'POST') {
      sendPrivateJSON(res, { ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);
      return;
    }
    if (req.method === 'POST' && !requireJSONRequest(req, res)) return;
    try {
      await loadRemoteTokens();
      // POST = 用户主动换码；GET 会在没有可用码时补码，以保证屏幕上的二维码可用。
      if (req.method === 'POST') rotateRemotePairingCode('requested');
      const codeState = readRemotePairingCodeState();
      sendPrivateJSON(res, {
        ok: true,
        code: codeState.code,
        hasCode: codeState.hasCode,
        expiresInMs: codeState.expiresInMs,
        locked: remoteAuth.failures >= REMOTE_PAIRING_MAX_FAILURES,
        remainingAttempts: Math.max(0, REMOTE_PAIRING_MAX_FAILURES - remoteAuth.failures),
        lastLockoutAt: remoteAuth.lastLockoutAt || 0,
        // 手机要连的是遥控监听器的端口，不是主端口（主端口只绑回环）。
        // 监听器没起时回落到主端口，仅用于展示；此时 lanReachable 为 false。
        port: remoteListenerStatus().port || mainBoundPort(),
        mainPort: mainBoundPort(),
        listener: remoteListenerStatus(),
        lanAddresses: await listRemoteLanAddresses(),
        boundHost: HOST,
        // 两条路都算可达：显式把主端口绑到 0.0.0.0（调试用），或遥控监听器已起。
        lanReachable: HOST === '0.0.0.0' || remoteListenerStatus().running,
        pairedDevices: Array.from(remoteAuth.tokens.values()).map((entry) => ({
          label: entry.label, pairedAt: entry.pairedAt, lastSeenAt: entry.lastSeenAt,
        })),
      });
    } catch (err) {
      console.error('[RemotePairing]', err);
      sendPrivateJSON(res, { ok: false, error: 'PAIRING_INFO_FAILED' }, 500);
    }
    return;
  }

  if (pn === '/api/remote/state-push') {
    if (!requireTrustedLocalManagementRequest(req, res)) return;
    if (req.method !== 'POST') {
      sendPrivateJSON(res, { ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);
      return;
    }
    if (!requireJSONRequest(req, res)) return;
    try {
      storeRemoteState(await readRequestBody(req));
      sendPrivateJSON(res, { ok: true });
    } catch (err) {
      console.error('[RemoteStatePush]', err);
      sendPrivateJSON(res, { ok: false, error: 'REMOTE_STATE_PUSH_FAILED' }, 500);
    }
    return;
  }

  // 起停遥控监听器。只服务本机：否则手机自己就能把入口关掉或打开。
  if (pn === '/api/remote/listener') {
    if (!requireTrustedLocalManagementRequest(req, res)) return;
    try {
      if (req.method === 'GET') {
        sendPrivateJSON(res, Object.assign({ ok: true }, remoteListenerStatus()));
        return;
      }
      if (req.method !== 'POST') {
        sendPrivateJSON(res, { ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);
        return;
      }
      if (!requireJSONRequest(req, res)) return;
      const body = await readRequestBody(req);
      const status = await setRemoteListenerEnabled(body && body.enabled === true);
      sendPrivateJSON(res, Object.assign({ ok: true }, status));
    } catch (err) {
      console.error('[RemoteListener]', err);
      sendPrivateJSON(res, { ok: false, error: err.code || err.message || 'REMOTE_LISTENER_FAILED' }, 500);
    }
    return;
  }

  if (pn === '/api/remote/revoke') {
    if (!requireTrustedLocalManagementRequest(req, res)) return;
    if (req.method !== 'POST') {
      sendPrivateJSON(res, { ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);
      return;
    }
    if (!requireJSONRequest(req, res)) return;
    try {
      sendPrivateJSON(res, await revokeRemoteTokens());
    } catch (err) {
      console.error('[RemoteRevoke]', err);
      sendPrivateJSON(res, { ok: false, error: 'REMOTE_REVOKE_FAILED' }, 500);
    }
    return;
  }

  // 诊断端点只服务本机。即便 MINERADIO_HOST 被放开到局域网，也不对外暴露。
  if (pn === '/api/diag/stall-log') {
    if (!requireTrustedLocalManagementRequest(req, res)) return;
    try {
      if (req.method === 'POST') {
        if (!requireJSONRequest(req, res)) return;
        const body = await readRequestBody(req);
        const entry = await appendStallLogEntry(body);
        sendPrivateJSON(res, { accepted: true, file: STALL_LOG_FILE, entry });
        return;
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        sendText(res, await readStallLogReport());
        return;
      }
      sendPrivateJSON(res, { error: 'METHOD_NOT_ALLOWED' }, 405);
    } catch (err) {
      console.error('[StallLog]', err);
      sendPrivateJSON(res, { accepted: false, error: err.code || err.message }, 500);
    }
    return;
  }

  if (pn === '/api/app/version') {
    sendJSON(res, {
      name: APP_PACKAGE.name || 'mineradio',
      productName: APP_PACKAGE.productName || 'Mineradio',
      version: APP_VERSION,
      update: {
        provider: UPDATE_CONFIG.provider,
        configured: UPDATE_CONFIG.configured,
        owner: UPDATE_CONFIG.owner,
        repo: UPDATE_CONFIG.repo,
        preview: UPDATE_CONFIG.preview,
        manifestOverride: !!UPDATE_CONFIG.manifest,
      },
    });
    return;
  }

  if (pn === '/api/platform/capabilities') {
    sendJSON(res, {
      netease: {
        playlists: true, likeRead: true, likeWrite: true, albumRead: true,
        albumCollect: true, commentsRead: true, commentsWrite: true,
        listenReport: 'experimental-unverified',
      },
      qq: {
        playlists: true, likeRead: true, likeWrite: false, albumRead: true,
        albumCollect: false, commentsRead: true, commentsWrite: false,
        listenReport: false,
      },
      kugou: {
        playlists: true, likeRead: true, likeWrite: true, albumRead: false,
        albumCollect: false, commentsRead: false, commentsWrite: false,
        listenReport: false,
      },
    });
    return;
  }

  if (pn === '/api/listen/report') {
    try {
      if (req.method !== 'POST') {
        sendJSON(res, { accepted: false, error: 'METHOD_NOT_ALLOWED' }, 405);
        return;
      }
      const body = await readRequestBody(req);
      sendJSON(res, await handlePlatformListenReport(body));
    } catch (err) {
      console.error('[ListenReport]', err);
      sendJSON(res, {
        accepted: false,
        platformSubmitted: false,
        error: err.code || err.message,
        message: err.message,
      }, Number(err.statusCode) === 401 ? 401 : 502);
    }
    return;
  }

  if (pn === '/api/listen/total') {
    try {
      const provider = normalizeListenReportProvider(url.searchParams.get('provider') || 'netease');
      if (provider !== 'netease') {
        sendJSON(res, { provider, supported: false, accountDurationSync: 'unsupported' });
        return;
      }
      const info = await requireLogin(res);
      if (!info) return;
      const result = await listen_data_total({ cookie: userCookie, timestamp: Date.now() });
      sendJSON(res, {
        provider: 'netease',
        supported: true,
        readOnly: true,
        body: result.body || result,
      });
    } catch (err) {
      console.error('[ListenTotal]', err);
      sendJSON(res, { provider: 'netease', supported: true, error: err.message }, 500);
    }
    return;
  }

  if (pn === '/api/listen/ranking') {
    try {
      const info = await requireLogin(res);
      if (!info) return;
      const type = String(url.searchParams.get('type') || 'week') === 'all' ? 0 : 1;
      const result = await user_record({ uid: info.userId, type, cookie: userCookie, timestamp: Date.now() });
      const body = result.body || result;
      const rows = (type === 0 ? body.allData : body.weekData) || [];
      const songs = rows.map((item, index) => ({
        ...mapSongRecord(item.song || {}),
        rank: index + 1,
        playCount: Number(item.playCount) || 0,
        score: Number(item.score) || 0,
      })).filter(item => item.id);
      sendJSON(res, {
        loggedIn: true,
        type: type === 0 ? 'all' : 'week',
        songs,
        code: normalizeApiCode(result) || 200,
      });
    } catch (err) {
      console.error('[ListenRanking]', err);
      sendJSON(res, { error: err.message }, 500);
    }
    return;
  }

  if (pn === '/api/update/latest') {
    try {
      sendJSON(res, await fetchLatestUpdateInfo());
    } catch (err) {
      sendJSON(res, {
        ...localUpdateFallback(err.message || 'Update check failed', { configured: UPDATE_CONFIG.configured }),
        error: err.message || 'Update check failed',
      });
    }
    return;
  }

  if (pn === '/api/update/download') {
    try {
      const info = await fetchLatestUpdateInfo();
      const job = startUpdateDownloadJob(info);
      sendJSON(res, job, job.ok ? 200 : 400);
    } catch (err) {
      console.error('[UpdateDownload]', err);
      sendJSON(res, { ok: false, error: err.message || 'UPDATE_DOWNLOAD_START_FAILED' }, 500);
    }
    return;
  }

  if (pn === '/api/update/download/status') {
    const id = url.searchParams.get('id') || '';
    const job = id
      ? updateDownloadJobs.get(id)
      : Array.from(updateDownloadJobs.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
    sendJSON(res, publicUpdateJob(job), job ? 200 : 404);
    return;
  }

  if (pn === '/api/update/patch') {
    try {
      const info = await fetchLatestUpdateInfo();
      const job = startUpdatePatchJob(info);
      sendJSON(res, job, job.ok ? 200 : 400);
    } catch (err) {
      console.error('[UpdatePatch]', err);
      sendJSON(res, { ok: false, error: err.message || 'UPDATE_PATCH_START_FAILED' }, 500);
    }
    return;
  }

  if (pn === '/api/update/patch/status') {
    const id = url.searchParams.get('id') || '';
    const job = id
      ? updateDownloadJobs.get(id)
      : Array.from(updateDownloadJobs.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).find(item => item.mode === 'patch');
    sendJSON(res, publicUpdateJob(job), job ? 200 : 404);
    return;
  }

  if (pn === '/api/beatmap/cache/status') {
    const info = beatCacheRootInfo();
    sendJSON(res, {
      enabled: info.allowed && info.available,
      dir: info.dir,
      drive: info.drive,
      reason: !info.allowed ? 'C_DRIVE_DISABLED' : (!info.available ? 'TARGET_DRIVE_UNAVAILABLE' : ''),
      mode: info.allowed && info.available ? 'disk' : 'memory-only',
    });
    return;
  }

  if (pn === '/api/beatmap/cache') {
    if (req.method === 'GET') {
      const key = url.searchParams.get('key') || '';
      try {
        const entry = await readBeatMapCache(key);
        sendJSON(res, entry
          ? { ok: true, hit: true, key: entry.key || key, map: entry.map, meta: entry.meta || {}, savedAt: entry.savedAt || 0 }
          : { ok: true, hit: false, key });
      } catch (err) {
        const info = err.info || beatCacheRootInfo();
        sendJSON(res, {
          ok: false,
          hit: false,
          enabled: false,
          mode: 'memory-only',
          key,
          reason: err.code || err.message || 'BEAT_CACHE_READ_FAILED',
          dir: info.dir,
        });
      }
      return;
    }

    if (req.method === 'POST') {
      try {
        const body = await readRequestBody(req);
        sendJSON(res, await writeBeatMapCache(body));
      } catch (err) {
        const info = err.info || beatCacheRootInfo();
        sendJSON(res, {
          ok: false,
          enabled: false,
          mode: 'memory-only',
          reason: err.code || err.message || 'BEAT_CACHE_WRITE_FAILED',
          dir: info.dir,
        });
      }
      return;
    }

    sendJSON(res, { ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);
    return;
  }

  if (pn === '/api/discover/home') {
    try {
      sendJSON(res, await handleDiscoverHome());
    } catch (err) {
      console.error('[DiscoverHome]', err);
      sendJSON(res, { error: err.message, loggedIn: false, dailySongs: [], playlists: [], podcasts: [] }, 500);
    }
    return;
  }

  if (pn === '/api/weather/radio') {
    try {
      const data = await buildWeatherRadio({
        city: url.searchParams.get('city') || url.searchParams.get('q') || '',
        lat: url.searchParams.get('lat'),
        lon: url.searchParams.get('lon'),
        timezone: url.searchParams.get('timezone') || '',
      });
      sendJSON(res, data);
    } catch (err) {
      console.error('[WeatherRadio]', err);
      sendJSON(res, {
        ok: false,
        error: err.message,
        weather: null,
        radio: { title: '天气电台', subtitle: '天气暂时没有回来，可以先听今日推荐。', seedQueries: [], songs: [] },
      }, 500);
    }
    return;
  }

  if (pn === '/api/weather/ip-location') {
    try {
      sendJSON(res, { ok: true, location: await fetchIpWeatherLocation() });
    } catch (err) {
      console.error('[WeatherIpLocation]', err.failures || err);
      sendJSON(res, {
        ok: false,
        error: err.message,
        failures: err.failures || [],
        location: null,
      }, 500);
    }
    return;
  }

  // ---------- 搜索 ----------
  if (pn === '/api/search') {
    try {
      const kw    = url.searchParams.get('keywords') || '';
      const limit = Math.max(1, Math.min(50, parseInt(url.searchParams.get('limit') || '20', 10) || 20));
      const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
      const songs = await handleSearch(kw, limit, offset);
      sendJSON(res, { songs, offset, limit, nextOffset: offset + songs.length, hasMore: songs.length >= limit });
    } catch (err) { console.error('[Search]', err); sendJSON(res, { error: err.message, songs: [] }, 500); }
    return;
  }

  if (pn === '/api/qq/search') {
    try {
      const kw = url.searchParams.get('keywords') || '';
      const limit = Math.max(4, Math.min(30, parseInt(url.searchParams.get('limit') || '12', 10) || 12));
      const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
      const songs = await handleQQSearch(kw, limit, offset);
      sendJSON(res, { provider: 'qq', songs, offset, limit, nextOffset: offset + songs.length, hasMore: songs.length >= limit });
    } catch (err) {
      console.error('[QQSearch]', err);
      sendJSON(res, { provider: 'qq', error: err.message, songs: [] }, 500);
    }
    return;
  }

  if (pn === '/api/kugou/search') {
    try {
      const kw = url.searchParams.get('keywords') || '';
      const limit = Math.max(4, Math.min(20, parseInt(url.searchParams.get('limit') || '12', 10) || 12));
      const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
      const songs = await handleKugouSearch(kw, limit, kugouCookie, offset);
      sendJSON(res, { provider: 'kugou', songs, offset, limit, nextOffset: offset + songs.length, hasMore: songs.length >= limit });
    } catch (err) {
      console.error('[KugouSearch]', err);
      sendJSON(res, { provider: 'kugou', error: err.message, songs: [] }, 500);
    }
    return;
  }

  if (pn === '/api/kugou/recommendations') {
    try {
      const limit = Math.max(4, Math.min(20, parseInt(url.searchParams.get('limit') || '12', 10) || 12));
      sendJSON(res, await handleKugouGuessLike(kugouCookie, limit));
    } catch (err) {
      console.error('[KugouRecommendations]', err);
      sendJSON(res, { provider: 'kugou', error: err.message, songs: [] }, 500);
    }
    return;
  }

  if (pn === '/api/kugou/song/url') {
    try {
      const info = await handleKugouSongUrl({
        hash: url.searchParams.get('hash') || url.searchParams.get('id') || '',
        albumId: url.searchParams.get('albumId') || url.searchParams.get('album_id') || '',
        albumAudioId: url.searchParams.get('albumAudioId') || url.searchParams.get('album_audio_id') || url.searchParams.get('mixSongId') || '',
        mixSongId: url.searchParams.get('mixSongId') || url.searchParams.get('albumAudioId') || url.searchParams.get('album_audio_id') || '',
        hqHash: url.searchParams.get('hqHash') || url.searchParams.get('hq_hash') || '',
        sqHash: url.searchParams.get('sqHash') || url.searchParams.get('sq_hash') || '',
        resHash: url.searchParams.get('resHash') || url.searchParams.get('res_hash') || '',
        quality: url.searchParams.get('quality') || '',
        vipRequired: url.searchParams.get('vipRequired') || '',
        needVip: url.searchParams.get('needVip') || url.searchParams.get('need_vip') || '',
        onlyVipPlayable: url.searchParams.get('onlyVipPlayable') || url.searchParams.get('only_vip_playable') || '',
        privilege: url.searchParams.get('privilege') || url.searchParams.get('mediaPrivilege') || url.searchParams.get('media_privilege') || '',
        fee: url.searchParams.get('fee') || '',
      }, kugouCookie);
      sendJSON(res, info);
    } catch (err) {
      console.error('[KugouSongUrl]', err);
      sendJSON(res, { provider: 'kugou', url: '', playable: false, error: err.message }, 500);
    }
    return;
  }

  if (pn === '/api/kugou/lyric') {
    try {
      const hash = url.searchParams.get('hash') || url.searchParams.get('id') || '';
      const albumAudioId = url.searchParams.get('albumAudioId') || url.searchParams.get('album_audio_id') || '';
      const duration = url.searchParams.get('duration') || '';
      if (!hash) { sendJSON(res, { provider: 'kugou', error: 'Missing Kugou hash', lyric: '' }, 400); return; }
      const data = await handleKugouLyric(hash, albumAudioId, duration);
      sendJSON(res, data);
    } catch (err) {
      console.error('[KugouLyric]', err);
      sendJSON(res, { provider: 'kugou', error: err.message, lyric: '' }, 500);
    }
    return;
  }

  if (pn === '/api/kugou/login/status') {
    try {
      sendJSON(res, await getKugouLoginInfo(kugouCookie));
    } catch (err) {
      console.error('[KugouLoginStatus]', err);
      sendJSON(res, { provider: 'kugou', loggedIn: false, error: err.message }, 500);
    }
    return;
  }

  if (pn === '/api/kugou/login/cookie') {
    try {
      const body = await readRequestBody(req);
      const raw = body.cookie || body.data || body.text || '';
      const normalized = normalizeKugouCookieInput(raw);
      const auth = extractKugouAuth(normalized);
      if (!auth.loggedIn && !parseCookieString(normalized).kg_mid) {
        sendJSON(res, { provider: 'kugou', loggedIn: false, error: 'INVALID_KUGOU_COOKIE', message: '小狗 cookie 无效或缺少登录标识' }, 400);
        return;
      }
      saveKugouCookie(normalized);
      const info = await getKugouLoginInfo(kugouCookie);
      sendJSON(res, { ...info, saved: true, partial: auth.loggedIn && !auth.playbackReady });
    } catch (err) {
      console.error('[KugouLoginCookie]', err);
      sendJSON(res, { provider: 'kugou', loggedIn: false, error: err.message }, 500);
    }
    return;
  }

  if (pn === '/api/kugou/logout') {
    saveKugouCookie('');
    sendJSON(res, { provider: 'kugou', loggedIn: false, ok: true });
    return;
  }

  if (pn === '/api/kugou/user/playlists') {
    try {
      sendJSON(res, await handleKugouUserPlaylists(kugouCookie));
    } catch (err) {
      console.error('[KugouUserPlaylists]', err);
      sendJSON(res, { provider: 'kugou', loggedIn: false, error: err.message, playlists: [] }, 500);
    }
    return;
  }

  if (pn === '/api/kugou/playlist/tracks') {
    try {
      const id = url.searchParams.get('id') || url.searchParams.get('global_collection_id') || '';
      const paged = url.searchParams.has('limit') || url.searchParams.has('offset');
      const limit = Math.max(10, Math.min(50, parseInt(url.searchParams.get('limit') || '50', 10) || 50));
      const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
      sendJSON(res, await handleKugouPlaylistTracks(id, kugouCookie, paged ? { limit, offset, paged: true } : {}));
    } catch (err) {
      console.error('[KugouPlaylistTracks]', err);
      sendJSON(res, { provider: 'kugou', error: err.message, tracks: [] }, 500);
    }
    return;
  }

  if (pn === '/api/kugou/song/like/check') {
    try {
      if (!kugouCookieHasPlayback(kugouCookie)) {
        sendJSON(res, { provider: 'kugou', loggedIn: false, liked: {}, error: 'KUGOU_AUTH_REQUIRED' });
        return;
      }
      const hashes = url.searchParams.get('hashes') || url.searchParams.get('hash') || '';
      sendJSON(res, await handleKugouLikeCheck({ hashes }, kugouCookie));
    } catch (err) {
      console.error('[KugouLikeCheck]', err);
      sendJSON(res, { provider: 'kugou', liked: {}, error: err.message }, 500);
    }
    return;
  }

  if (pn === '/api/kugou/song/like') {
    try {
      if (!kugouCookieHasPlayback(kugouCookie)) {
        sendJSON(res, { provider: 'kugou', success: false, error: 'KUGOU_AUTH_REQUIRED' }, 401);
        return;
      }
      const body = req.method === 'POST' ? await readRequestBody(req) : {};
      const song = body.song || {};
      const like = String(body.like != null ? body.like : (url.searchParams.get('like') || 'true')) !== 'false';
      sendJSON(res, await handleKugouLikeToggle(song, like, kugouCookie));
    } catch (err) {
      console.error('[KugouLike]', err);
      sendJSON(res, { provider: 'kugou', success: false, error: err.message }, 500);
    }
    return;
  }

  if (pn === '/api/kugou/playlist/add-song') {
    try {
      if (!kugouCookieHasPlayback(kugouCookie)) {
        sendJSON(res, { provider: 'kugou', success: false, error: 'KUGOU_AUTH_REQUIRED' }, 401);
        return;
      }
      const body = req.method === 'POST' ? await readRequestBody(req) : {};
      const pid = body.pid || url.searchParams.get('pid') || '';
      const song = body.song || body;
      if (!pid) { sendJSON(res, { provider: 'kugou', success: false, error: 'Missing playlist id' }, 400); return; }
      sendJSON(res, await handleKugouPlaylistAddSong(pid, song, kugouCookie));
    } catch (err) {
      console.error('[KugouPlaylistAddSong]', err);
      sendJSON(res, { provider: 'kugou', success: false, error: err.message }, 500);
    }
    return;
  }

  if (pn === '/api/qq/song/url') {
    try {
      const mid = url.searchParams.get('mid') || url.searchParams.get('id') || '';
      const mediaMid = url.searchParams.get('mediaMid') || url.searchParams.get('media_mid') || '';
      const quality = url.searchParams.get('quality') || '';
      const playbackHints = {
        vipRequired: url.searchParams.get('vipRequired') || '',
        needVip: url.searchParams.get('needVip') || url.searchParams.get('need_vip') || '',
        onlyVipPlayable: url.searchParams.get('onlyVipPlayable') || url.searchParams.get('only_vip_playable') || '',
        privilege: url.searchParams.get('privilege') || url.searchParams.get('mediaPrivilege') || url.searchParams.get('media_privilege') || '',
        fee: url.searchParams.get('fee') || ''
      };
      const info = await handleQQSongUrl(mid, mediaMid, quality, playbackHints);
      sendJSON(res, info);
    } catch (err) {
      console.error('[QQSongUrl]', err);
      sendJSON(res, { provider: 'qq', url: '', playable: false, error: err.message }, 500);
    }
    return;
  }

  if (pn === '/api/qq/lyric') {
    try {
      const mid = url.searchParams.get('mid') || url.searchParams.get('songmid') || '';
      const id = url.searchParams.get('id') || url.searchParams.get('qqId') || '';
      if (!mid && !id) { sendJSON(res, { provider: 'qq', error: 'Missing QQ song mid or id', lyric: '' }, 400); return; }
      const data = await handleQQLyric(mid, id);
      sendJSON(res, data);
    } catch (err) {
      console.error('[QQLyric]', err);
      sendJSON(res, { provider: 'qq', error: err.message, lyric: '' }, 500);
    }
    return;
  }

  // ---------- 歌曲URL ----------
  if (pn === '/api/qq/login/status') {
    try {
      const forceVip = /^(1|true|yes)$/i.test(String(url.searchParams.get('forceVip') || url.searchParams.get('force') || ''));
      const info = await getQQLoginInfo({ forceVip, forceCookie: forceVip });
      sendJSON(res, info);
    } catch (err) {
      console.error('[QQLoginStatus]', err);
      sendJSON(res, { provider: 'qq', loggedIn: false, error: err.message }, 500);
    }
    return;
  }

  if (pn === '/api/qq/login/cookie') {
    try {
      const body = await readRequestBody(req);
      const raw = body.cookie || body.data || body.text || '';
      const normalized = normalizeQQCookieInput(raw);
      const obj = parseCookieString(normalized);
      if (!qqCookieUin(obj) || !qqCookieMusicKey(obj)) {
        sendJSON(res, { provider: 'qq', loggedIn: false, error: 'INVALID_QQ_COOKIE', message: '小Q cookie 缺少 uin 或有效登录票据' }, 400);
        return;
      }
      saveQQCookie(normalized);
      const info = await getQQLoginInfo({ forceVip: true, forceCookie: true });
      sendJSON(res, { ...info, saved: true });
    } catch (err) {
      console.error('[QQLoginCookie]', err);
      sendJSON(res, { provider: 'qq', loggedIn: false, error: err.message }, 500);
    }
    return;
  }

  if (pn === '/api/qq/logout') {
    saveQQCookie('');
    sendJSON(res, { provider: 'qq', ok: true, loggedIn: false });
    return;
  }

  if (pn === '/api/qq/user/playlists') {
    try {
      const data = await handleQQUserPlaylists();
      sendJSON(res, data);
    } catch (err) {
      console.error('[QQUserPlaylists]', err);
      sendJSON(res, { provider: 'qq', loggedIn: false, error: err.message, playlists: [] }, 500);
    }
    return;
  }

  if (pn === '/api/qq/playlist/tracks') {
    try {
      const id = url.searchParams.get('id') || url.searchParams.get('disstid') || '';
      const data = await handleQQPlaylistTracks(id, {
        limit: url.searchParams.get('limit') || '',
        offset: url.searchParams.get('offset') || '0',
      });
      sendJSON(res, data);
    } catch (err) {
      console.error('[QQPlaylistTracks]', err);
      sendJSON(res, { provider: 'qq', error: err.message, tracks: [] }, 500);
    }
    return;
  }

  if (pn === '/api/qq/artist/detail') {
    try {
      const mid = url.searchParams.get('mid') || url.searchParams.get('singermid') || '';
      const limit = Math.max(10, Math.min(80, parseInt(url.searchParams.get('limit') || '36', 10) || 36));
      if (!mid) {
        sendJSON(res, { provider: 'qq', error: 'MISSING_SINGER_MID', artist: null, songs: [] }, 400);
        return;
      }
      const data = await handleQQArtistDetail(mid, limit);
      sendJSON(res, data);
    } catch (err) {
      console.error('[QQArtistDetail]', err);
      sendJSON(res, { provider: 'qq', error: err.message, artist: null, songs: [] }, 500);
    }
    return;
  }

  if (pn === '/api/qq/album/detail') {
    try {
      const mid = url.searchParams.get('mid') || url.searchParams.get('albummid') || url.searchParams.get('albumMid') || '';
      const limit = Math.max(10, Math.min(120, parseInt(url.searchParams.get('limit') || '80', 10) || 80));
      if (!mid) {
        sendJSON(res, { provider: 'qq', error: 'MISSING_ALBUM_MID', album: null, songs: [] }, 400);
        return;
      }
      sendJSON(res, await handleQQAlbumDetail(mid, limit));
    } catch (err) {
      console.error('[QQAlbumDetail]', err);
      sendJSON(res, { provider: 'qq', error: err.message, album: null, songs: [] }, 500);
    }
    return;
  }

  if (pn === '/api/qq/song/comments') {
    try {
      const id = url.searchParams.get('id') || url.searchParams.get('qqId') || '';
      const mid = url.searchParams.get('mid') || url.searchParams.get('songmid') || '';
      const limit = Math.max(6, Math.min(50, parseInt(url.searchParams.get('limit') || '20', 10) || 20));
      const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
      const data = await handleQQSongComments(id, mid, limit, offset);
      sendJSON(res, data);
    } catch (err) {
      console.error('[QQSongComments]', err);
      sendJSON(res, { provider: 'qq', error: err.message, comments: [] }, 500);
    }
    return;
  }

  if (pn === '/api/podcast/search') {
    try {
      const kw = String(url.searchParams.get('keywords') || '').trim();
      const limit = Math.max(6, Math.min(30, parseInt(url.searchParams.get('limit') || '18', 10) || 18));
      if (!kw) { sendJSON(res, { podcasts: [] }); return; }
      const r = await cloudsearch({ keywords: kw, type: 1009, limit, cookie: userCookie, timestamp: Date.now() });
      const result = (r.body && r.body.result) || {};
      const raw = result.djRadios || result.djradios || result.radios || [];
      const podcasts = raw.map(mapPodcastRadio).filter(p => p.id);
      sendJSON(res, { podcasts, total: result.djRadiosCount || result.djradiosCount || podcasts.length });
    } catch (err) {
      console.error('[PodcastSearch]', err);
      sendJSON(res, { error: err.message, podcasts: [] }, 500);
    }
    return;
  }

  if (pn === '/api/podcast/hot') {
    try {
      const limit = Math.max(6, Math.min(30, parseInt(url.searchParams.get('limit') || '18', 10) || 18));
      const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
      const r = await dj_hot({ limit, offset, cookie: userCookie, timestamp: Date.now() });
      const body = r.body || {};
      const raw = body.djRadios || body.djradios || body.radios || body.data || [];
      const podcasts = (Array.isArray(raw) ? raw : []).map(mapPodcastRadio).filter(p => p.id);
      sendJSON(res, { podcasts, more: !!body.hasMore });
    } catch (err) {
      console.error('[PodcastHot]', err);
      sendJSON(res, { error: err.message, podcasts: [] }, 500);
    }
    return;
  }

  if (pn === '/api/podcast/detail') {
    try {
      const rid = url.searchParams.get('id') || url.searchParams.get('rid');
      if (!rid) { sendJSON(res, { error: 'Missing podcast id' }, 400); return; }
      const r = await dj_detail({ rid, cookie: userCookie, timestamp: Date.now() });
      const body = r.body || {};
      const radio = mapPodcastRadio(body.data || body.djRadio || body.radio || body);
      sendJSON(res, { podcast: radio });
    } catch (err) {
      console.error('[PodcastDetail]', err);
      sendJSON(res, { error: err.message }, 500);
    }
    return;
  }

  if (pn === '/api/podcast/programs') {
    try {
      const rid = url.searchParams.get('id') || url.searchParams.get('rid');
      if (!rid) { sendJSON(res, { error: 'Missing podcast id', programs: [] }, 400); return; }
      const limit = Math.max(10, Math.min(60, parseInt(url.searchParams.get('limit') || '30', 10) || 30));
      const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
      const r = await dj_program({ rid, limit, offset, asc: false, cookie: userCookie, timestamp: Date.now() });
      const body = r.body || {};
      const raw = body.programs || (body.data && (body.data.list || body.data.programs)) || [];
      const radio = raw[0] && raw[0].radio ? mapPodcastRadio(raw[0].radio) : { id: rid, rid };
      const programs = (Array.isArray(raw) ? raw : [])
        .map(p => mapPodcastProgram(p, radio))
        .filter(p => p.id && p.name);
      sendJSON(res, { radio, programs, more: !!body.more, total: body.count || programs.length });
    } catch (err) {
      console.error('[PodcastPrograms]', err);
      sendJSON(res, { error: err.message, programs: [] }, 500);
    }
    return;
  }

  if (pn === '/api/podcast/my') {
    try {
      const info = await getLoginInfo();
      if (!info.loggedIn || !info.userId) {
        const empty = ['collect', 'created', 'liked'].map(k => podcastCollectionMeta(k, []));
        sendJSON(res, { loggedIn: false, collections: empty });
        return;
      }
      const keys = ['collect', 'created', 'liked'];
      const collections = await Promise.all(keys.map(async key => {
        try {
          const data = await fetchMyPodcastItems(key, info, 12, 0);
          return podcastCollectionMeta(key, data.items || []);
        } catch (e) {
          console.warn('[MyPodcast]', key, e.message);
          return podcastCollectionMeta(key, []);
        }
      }));
      sendJSON(res, { loggedIn: true, collections });
    } catch (err) {
      console.error('[MyPodcast]', err);
      sendJSON(res, { error: err.message, collections: [] }, 500);
    }
    return;
  }

  if (pn === '/api/podcast/my/items') {
    try {
      const info = await getLoginInfo();
      if (!info.loggedIn || !info.userId) { sendJSON(res, { loggedIn: false, items: [] }); return; }
      const key = String(url.searchParams.get('key') || 'collect');
      const limit = parseInt(url.searchParams.get('limit') || '48', 10) || 48;
      const offset = parseInt(url.searchParams.get('offset') || '0', 10) || 0;
      const data = await fetchMyPodcastItems(key, info, limit, offset);
      sendJSON(res, { loggedIn: true, key, ...podcastCollectionMeta(key, data.items || []), itemType: data.itemType, items: data.items || [] });
    } catch (err) {
      console.error('[MyPodcastItems]', err);
      sendJSON(res, { error: err.message, items: [] }, 500);
    }
    return;
  }

  if (pn === '/api/album/detail') {
    try {
      const id = url.searchParams.get('id') || url.searchParams.get('albumId') || '';
      const limit = Math.max(10, Math.min(120, parseInt(url.searchParams.get('limit') || '80', 10) || 80));
      if (!id) {
        sendJSON(res, { provider: 'netease', error: 'Missing album id', album: null, songs: [] }, 400);
        return;
      }
      sendJSON(res, await handleNeteaseAlbumDetail(id, limit));
    } catch (err) {
      console.error('[AlbumDetail]', err);
      sendJSON(res, { provider: 'netease', error: err.message, album: null, songs: [] }, 500);
    }
    return;
  }

  if (pn === '/api/album/subscribe') {
    try {
      const info = await requireLogin(res);
      if (!info) return;
      const body = req.method === 'POST' ? await readRequestBody(req) : {};
      const id = body.id || body.albumId || url.searchParams.get('id') || '';
      const subscribed = String(body.subscribed != null ? body.subscribed : (url.searchParams.get('subscribed') || 'true')) !== 'false';
      if (!id) { sendJSON(res, { success: false, error: 'Missing album id' }, 400); return; }
      const result = await album_sub({ id, t: subscribed ? 1 : 0, cookie: userCookie, timestamp: Date.now() });
      const code = normalizeApiCode(result);
      sendJSON(res, { provider: 'netease', id, subscribed, success: code === 200, code, body: result.body || result });
    } catch (err) {
      console.error('[AlbumSubscribe]', err);
      sendJSON(res, { provider: 'netease', success: false, error: err.message }, 500);
    }
    return;
  }

  if (pn === '/api/album/subscribe/check') {
    try {
      const info = await requireLogin(res);
      if (!info) return;
      const ids = String(url.searchParams.get('ids') || url.searchParams.get('id') || '')
        .split(',').map(value => value.trim()).filter(Boolean);
      if (!ids.length) { sendJSON(res, { provider: 'netease', subscribed: {} }); return; }
      const wanted = new Set(ids);
      const found = new Set();
      let offset = 0;
      for (let page = 0; page < 8 && found.size < wanted.size; page++) {
        const result = await album_sublist({ limit: 50, offset, cookie: userCookie, timestamp: Date.now() });
        const body = result.body || result || {};
        const rows = Array.isArray(body.data) ? body.data : (body.albums || []);
        rows.forEach(item => {
          const id = String(item && item.id || '');
          if (wanted.has(id)) found.add(id);
        });
        if (!body.hasMore || rows.length < 50) break;
        offset += rows.length;
      }
      const subscribed = {};
      ids.forEach(id => { subscribed[id] = found.has(id); });
      sendJSON(res, { provider: 'netease', ids, subscribed });
    } catch (err) {
      console.error('[AlbumSubscribeCheck]', err);
      sendJSON(res, { provider: 'netease', subscribed: {}, error: err.message }, 500);
    }
    return;
  }

  if (pn === '/api/playlist/subscribe') {
    try {
      const info = await requireLogin(res);
      if (!info) return;
      const body = req.method === 'POST' ? await readRequestBody(req) : {};
      const id = body.id || body.playlistId || url.searchParams.get('id') || '';
      const subscribed = String(body.subscribed != null ? body.subscribed : (url.searchParams.get('subscribed') || 'true')) !== 'false';
      if (!id) { sendJSON(res, { success: false, error: 'Missing playlist id' }, 400); return; }
      const result = await playlist_subscribe({ id, t: subscribed ? 1 : 0, cookie: userCookie, timestamp: Date.now() });
      const code = normalizeApiCode(result);
      sendJSON(res, { provider: 'netease', id, subscribed, success: code === 200, code, body: result.body || result });
    } catch (err) {
      console.error('[PlaylistSubscribe]', err);
      sendJSON(res, { provider: 'netease', success: false, error: err.message }, 500);
    }
    return;
  }

  if (pn === '/api/song/url') {
    const cloudPlaybackRequested = /^(1|true|yes)$/i.test(String(
      url.searchParams.get('cloud') || url.searchParams.get('cloudSong') || ''
    ));
    try {
      const sid = url.searchParams.get('id');
      const quality = url.searchParams.get('quality') || '';
      const matchHints = {
        name: url.searchParams.get('name') || '',
        artist: url.searchParams.get('artist') || '',
        artistId: url.searchParams.get('artistId') || '',
        artistIds: url.searchParams.get('artistIds') || '',
        artistNames: url.searchParams.get('artistNames') || '',
        album: url.searchParams.get('album') || '',
        duration: url.searchParams.get('duration') || '',
        excludeIds: url.searchParams.get('excludeIds') || '',
        skipDirect: url.searchParams.get('skipDirect') === '1',
      };
      const loginInfo = await getPlaybackLoginInfo();
      const info = cloudPlaybackRequested
        ? await handleNeteaseCloudSongUrl(sid, loginInfo, quality)
        : await handleSongUrl(sid, loginInfo, quality, matchHints);
      (cloudPlaybackRequested ? sendPrivateJSON : sendJSON)(res, {
        ...info,
        loggedIn: loginInfo.loggedIn,
        vipType: loginInfo.vipType || 0,
        vipLevel: loginInfo.vipLevel || 'none',
        isVip: !!loginInfo.isVip,
        isSvip: !!loginInfo.isSvip,
        vipLabel: loginInfo.vipLabel || '无VIP',
      });
    } catch (err) {
      console.error('[SongUrl]', err);
      (cloudPlaybackRequested ? sendPrivateJSON : sendJSON)(res, { error: err.message }, 500);
    }
    return;
  }

  if (pn === '/api/login/cookie') {
    try {
      const body = await readRequestBody(req);
      const raw = body.cookie || body.data || body.text || '';
      const normalized = normalizeCookieHeader(raw);
      const obj = parseCookieString(normalized);
      if (!obj.MUSIC_U) {
        sendJSON(res, { loggedIn: false, error: 'INVALID_NETEASE_COOKIE', message: '小云 cookie 缺少 MUSIC_U' }, 400);
        return;
      }
      saveCookie(normalized);
      let info = await getLoginInfo();
      if (!info.loggedIn && userCookie) {
        info = {
          loggedIn: true,
          pendingProfile: true,
          nickname: '小云用户',
          avatar: '',
          vipType: 0,
          vipLevel: 'none',
          isVip: false,
          isSvip: false,
          vipLabel: '无VIP',
        };
      }
      sendJSON(res, { ...info, saved: true, hasCookie: !!userCookie });
    } catch (err) {
      console.error('[LoginCookie]', err);
      sendJSON(res, { loggedIn: false, error: err.message }, 500);
    }
    return;
  }

  // ---------- 登录: QR Key ----------
  // ---------- 播客 DJ 长音频后端离线锁拍 ----------
  if (pn === '/api/podcast/dj-beatmap') {
    try {
      const audioUrl = url.searchParams.get('url');
      const durationSec = Math.max(0, Number(url.searchParams.get('duration') || 0) || 0);
      if (!audioUrl || !/^https?:\/\//i.test(audioUrl)) {
        sendJSON(res, { error: 'Invalid audio url' }, 400);
        return;
      }
      console.log('[PodcastDjBeatmap] start', Math.round(durationSec || 0) + 's');
      const started = Date.now();
      const introSec = Math.max(0, Number(url.searchParams.get('intro') || 0) || 0);
      const map = introSec
        ? await analyzePodcastDjIntro(audioUrl, { durationSec, introSec, userAgent: UA })
        : await analyzePodcastDjStream(audioUrl, { durationSec, userAgent: UA });
      console.log('[PodcastDjBeatmap] done beats:', map.visualBeatCount || 0, 'ms:', Date.now() - started, 'decode:', map.decode || {});
      sendJSON(res, { ok: true, map });
    } catch (err) {
      console.error('[PodcastDjBeatmap]', err);
      sendJSON(res, { ok: false, error: err.message || String(err) }, 500);
    }
    return;
  }

  if (pn === '/api/login/qr/key') {
    try {
      const r = await login_qr_key({ timestamp: Date.now() });
      const key = r.body && r.body.data && r.body.data.unikey;
      sendJSON(res, { key });
    } catch (err) { sendJSON(res, { error: err.message }, 500); }
    return;
  }

  // ---------- 登录: QR 二维码图片 ----------
  if (pn === '/api/login/qr/create') {
    try {
      const key = url.searchParams.get('key');
      const r = await login_qr_create({ key, qrimg: true, timestamp: Date.now() });
      const d = r.body && r.body.data;
      sendJSON(res, { img: d && d.qrimg, url: d && d.qrurl });
    } catch (err) { sendJSON(res, { error: err.message }, 500); }
    return;
  }

  // ---------- 登录: 轮询扫码状态 ----------
  if (pn === '/api/login/qr/check') {
    try {
      const key = url.searchParams.get('key');
      let r = await login_qr_check({ key, noCookie: true, timestamp: Date.now() });
      let body = r.body || {};
      let code = Number(body.code || r.code);
      let msg  = body.message || r.message || '';
      let cookie = readCookieFromResponse(r);
      if (code === 803 && !cookie) {
        try {
          const retry = await login_qr_check({ key, timestamp: Date.now() });
          const retryCookie = readCookieFromResponse(retry);
          if (retryCookie) {
            r = retry;
            body = retry.body || body;
            code = Number(body.code || retry.code || code);
            msg = body.message || retry.message || msg;
            cookie = retryCookie;
          }
        } catch (retryErr) {
          console.warn('[Login] qr cookie retry failed:', retryErr.message);
        }
      }
      // 803 = 授权成功, 802 = 已扫待确认, 801 = 等待扫码, 800 = 二维码过期
      if (code === 803) {
        if (cookie) saveCookie(cookie);
        let info = await getLoginInfo();
        if (!info.loggedIn) {
          const profile = body.profile || (body.data && body.data.profile) || {};
          const account = body.account || (body.data && body.data.account);
          const extra = body.data || body;
          info = normalizeLoginInfo(profile, account, extra);
          if (info.loggedIn) info = await enrichNeteaseLoginInfo(info, profile, account, extra);
        }
        if (!info.loggedIn && cookie) {
          info = {
            loggedIn: true,
            pendingProfile: true,
            nickname: (body.nickname || (body.profile && body.profile.nickname) || '小云用户'),
            avatar: body.avatarUrl || (body.profile && body.profile.avatarUrl) || '',
            vipType: 0,
            vipLevel: 'none',
            isVip: false,
            isSvip: false,
            vipLabel: '无VIP',
          };
        }
        sendJSON(res, { code, message: msg, ...info, hasCookie: !!cookie });
        return;
      }
      sendJSON(res, { code, message: msg, nickname: body.nickname, avatar: body.avatarUrl });
    } catch (err) { sendJSON(res, { error: err.message }, 500); }
    return;
  }

  // ---------- 登录态查询 ----------
  if (pn === '/api/login/status') {
    const info = await getLoginInfo();
    sendJSON(res, info);
    return;
  }

  // ---------- 登出 ----------
  if (pn === '/api/logout') {
    try { await logout({ cookie: userCookie }); } catch (e) {}
    saveCookie('');
    sendJSON(res, { ok: true });
    return;
  }

  // ---------- 用户歌单 ----------
  if (pn === '/api/user/playlists') {
    try {
      const info = await getLoginInfo();
      if (!info.loggedIn || !info.userId) { sendJSON(res, { loggedIn: false, playlists: [] }); return; }
      const requestedLimit = Math.max(0, parseInt(url.searchParams.get('limit') || '0', 10) || 0);
      const requestedOffset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
      if (requestedLimit || requestedOffset || url.searchParams.has('paged')) {
        const pageData = await fetchNeteaseUserPlaylistsPage(info.userId, requestedLimit || 48, requestedOffset);
        const pageList = pageData.playlists.map(pl => mapNeteasePlaylistMeta(pl, pl && pl.id));
        sendJSON(res, {
          loggedIn: true,
          userId: info.userId,
          playlists: pageList,
          total: pageData.total,
          offset: pageData.offset,
          limit: pageData.limit,
          nextOffset: pageData.nextOffset,
          hasMore: pageData.hasMore,
          partial: true,
        });
        return;
      }
      const rawPlaylists = await fetchAllNeteaseUserPlaylists(info.userId, requestedLimit);
      const list = rawPlaylists.map(pl => mapNeteasePlaylistMeta(pl, pl && pl.id));
      sendJSON(res, { loggedIn: true, userId: info.userId, playlists: list });
    } catch (err) {
      console.error('[UserPlaylists]', err);
      sendJSON(res, { error: err.message, loggedIn: false, playlists: [] }, 500);
    }
    return;
  }

  // ---------- 网易云音乐云盘 ----------
  if (pn === '/api/user/cloud') {
    try {
      const info = await requireLogin(res, sendPrivateJSON);
      if (!info) return;
      const limit = Math.max(1, Math.min(100, parseInt(url.searchParams.get('limit') || '48', 10) || 48));
      const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
      const result = await user_cloud({ limit, offset, cookie: userCookie, timestamp: Date.now() });
      const body = result && (result.body || result) || {};
      const rawRows = extractNeteaseCloudRows(body);
      const songs = rawRows.map(mapNeteaseCloudSong).filter(song => song.id && song.name);
      const total = Math.max(
        extractNeteaseCloudMetaNumber(body, ['total', 'count', 'songCount', 'totalCount'], 0),
        offset + rawRows.length
      );
      const nextOffset = offset + rawRows.length;
      const explicitHasMore = extractNeteaseCloudMetaBoolean(body, ['hasMore', 'more']);
      const hasMore = explicitHasMore == null ? (total ? nextOffset < total : rawRows.length >= limit) : explicitHasMore;
      sendPrivateJSON(res, {
        provider: 'netease',
        cloud: true,
        loggedIn: true,
        userId: info.userId,
        songs,
        tracks: songs,
        total,
        offset,
        limit,
        nextOffset,
        hasMore,
        partial: true,
      });
    } catch (err) {
      console.error('[NeteaseCloud]', err);
      sendPrivateJSON(res, { provider: 'netease', cloud: true, error: err.message, songs: [], tracks: [] }, 500);
    }
    return;
  }

  if (pn === '/api/user/cloud/detail') {
    try {
      const info = await requireLogin(res, sendPrivateJSON);
      if (!info) return;
      const ids = String(url.searchParams.get('ids') || url.searchParams.get('id') || '')
        .split(',').map(value => value.trim()).filter(Boolean).slice(0, 100);
      if (!ids.length) {
        sendPrivateJSON(res, { provider: 'netease', cloud: true, error: 'Missing cloud song id', songs: [] }, 400);
        return;
      }
      const result = await user_cloud_detail({ id: ids.join(','), cookie: userCookie, timestamp: Date.now() });
      const body = result && (result.body || result) || {};
      const songs = extractNeteaseCloudRows(body).map(mapNeteaseCloudSong).filter(song => song.id);
      sendPrivateJSON(res, { provider: 'netease', cloud: true, loggedIn: true, userId: info.userId, ids, songs, total: songs.length });
    } catch (err) {
      console.error('[NeteaseCloudDetail]', err);
      sendPrivateJSON(res, { provider: 'netease', cloud: true, error: err.message, songs: [] }, 500);
    }
    return;
  }

  // ---------- 红心状态 ----------
  if (pn === '/api/song/like/check') {
    try {
      const info = await requireLogin(res);
      if (!info) return;
      const ids = String(url.searchParams.get('ids') || url.searchParams.get('id') || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
      if (!ids.length) { sendJSON(res, { error: 'Missing song id', liked: {}, ids: [] }, 400); return; }
      let likedIds = [];
      try {
        if (typeof song_like_check === 'function') {
          const checked = await song_like_check({ ids: JSON.stringify(ids.map(Number).filter(Boolean)), cookie: userCookie, timestamp: Date.now() });
          const data = (checked.body && (checked.body.data || checked.body.ids)) || checked.body || {};
          if (Array.isArray(data)) likedIds = data.map(String);
          else if (data && typeof data === 'object') {
            ids.forEach(id => {
              if (data[id] || data[String(id)] || data[Number(id)]) likedIds.push(String(id));
            });
          }
        }
      } catch (e) {
        console.warn('[LikeCheck] direct check failed:', e.message);
      }
      if (!likedIds.length) {
        const r = await likelist({ uid: info.userId, cookie: userCookie, timestamp: Date.now() });
        likedIds = ((r.body && r.body.ids) || []).map(String);
      }
      const set = new Set(likedIds);
      const liked = {};
      ids.forEach(id => { liked[id] = set.has(String(id)); });
      sendJSON(res, { loggedIn: true, ids, liked });
    } catch (err) {
      console.error('[LikeCheck]', err);
      sendJSON(res, { error: err.message }, 500);
    }
    return;
  }

  // ---------- 红心/取消红心 ----------
  if (pn === '/api/song/like') {
    try {
      const info = await requireLogin(res);
      if (!info) return;
      const body = req.method === 'POST' ? await readRequestBody(req) : {};
      const id = body.id || url.searchParams.get('id');
      const nextLike = String(body.like != null ? body.like : (url.searchParams.get('like') || 'true')) !== 'false';
      if (!id) { sendJSON(res, { error: 'Missing song id' }, 400); return; }
      const r = await like_song({ id, like: String(nextLike), cookie: userCookie, timestamp: Date.now() });
      const code = (r.body && r.body.code) || r.code || 200;
      sendJSON(res, { loggedIn: true, id, liked: nextLike, code, body: r.body || r });
    } catch (err) {
      console.error('[Like]', err);
      sendJSON(res, { error: err.message }, 500);
    }
    return;
  }

  // ---------- 创建歌单 ----------
  if (pn === '/api/playlist/create') {
    try {
      const info = await requireLogin(res);
      if (!info) return;
      const body = req.method === 'POST' ? await readRequestBody(req) : {};
      const name = String(body.name || url.searchParams.get('name') || '').trim();
      const privacy = String(body.privacy || url.searchParams.get('privacy') || '0');
      if (!name) { sendJSON(res, { error: 'Missing playlist name' }, 400); return; }
      const r = await playlist_create({ name, privacy, cookie: userCookie, timestamp: Date.now() });
      const created = (r.body && (r.body.playlist || r.body.data)) || {};
      sendJSON(res, { loggedIn: true, playlist: created, body: r.body || r });
    } catch (err) {
      console.error('[PlaylistCreate]', err);
      sendJSON(res, { error: err.message }, 500);
    }
    return;
  }

  // ---------- 收藏歌曲到歌单 ----------
  if (pn === '/api/playlist/add-song') {
    try {
      const info = await requireLogin(res);
      if (!info) return;
      const body = req.method === 'POST' ? await readRequestBody(req) : {};
      const pid = body.pid || url.searchParams.get('pid');
      const id = body.id || body.ids || url.searchParams.get('id') || url.searchParams.get('ids');
      if (!pid || !id) { sendJSON(res, { error: 'Missing playlist id or song id' }, 400); return; }
      const attempts = [];
      let finalBody = null;
      let finalCode = 0;
      let finalMessage = '';
      let success = false;

      const primary = await playlist_tracks({ op: 'add', pid, tracks: String(id), cookie: userCookie, timestamp: Date.now() });
      finalBody = primary.body || primary;
      finalCode = normalizeApiCode(primary);
      finalMessage = normalizeApiMessage(primary);
      success = finalCode === 200 && !(finalBody && finalBody.error);
      attempts.push({ api: 'playlist_tracks', code: finalCode, message: finalMessage, body: finalBody });

      if (!success && typeof playlist_track_add === 'function') {
        try {
          const fallback = await playlist_track_add({ pid, ids: String(id), cookie: userCookie, timestamp: Date.now() });
          finalBody = fallback.body || fallback;
          finalCode = normalizeApiCode(fallback);
          finalMessage = normalizeApiMessage(fallback);
          success = finalCode === 200 && !(finalBody && finalBody.error);
          attempts.push({ api: 'playlist_track_add', code: finalCode, message: finalMessage, body: finalBody });
        } catch (fallbackErr) {
          const errBody = fallbackErr.body || fallbackErr.response || {};
          finalBody = errBody;
          finalCode = normalizeApiCode(errBody);
          finalMessage = normalizeApiMessage(errBody) || fallbackErr.message || '';
          attempts.push({ api: 'playlist_track_add', code: finalCode, message: finalMessage, body: errBody });
        }
      }

      if (!success) {
        sendJSON(res, { loggedIn: true, pid, id, success: false, code: finalCode, error: finalMessage || 'PLAYLIST_ADD_FAILED', attempts }, finalCode === 401 ? 401 : 409);
        return;
      }
      invalidateNeteasePlaylistTrackIndex(pid);
      sendJSON(res, { loggedIn: true, pid, id, success: true, code: finalCode, body: finalBody, attempts });
    } catch (err) {
      console.error('[PlaylistAddSong]', err);
      sendJSON(res, { error: err.message }, 500);
    }
    return;
  }

  // ---------- 歌词 ----------
  function lyricNodeText(body, key) {
    return body && body[key] && typeof body[key].lyric === 'string' ? body[key].lyric : '';
  }

  function lyricBodyHasPrimary(body) {
    return !!(lyricNodeText(body, 'lrc') || lyricNodeText(body, 'yrc'));
  }

  function lyricBodyHasTranslation(body) {
    return !!(lyricNodeText(body, 'tlyric') || lyricNodeText(body, 'ytlrc'));
  }

  function mergeLyricBodies(primary, fallback) {
    const merged = Object.assign({}, fallback || {}, primary || {});
    ['lrc', 'tlyric', 'yrc', 'ytlrc', 'romalrc', 'yromalrc', 'klyric'].forEach((key) => {
      if (!lyricNodeText(merged, key) && fallback && fallback[key]) merged[key] = fallback[key];
    });
    return merged;
  }

  if (pn === '/api/cloud/lyric') {
    try {
      const info = await requireLogin(res, sendPrivateJSON);
      if (!info) return;
      const id = url.searchParams.get('id') || url.searchParams.get('sid') || '';
      if (!id) { sendPrivateJSON(res, { provider: 'netease', source: 'netease-cloud', error: 'Missing cloud song id', lyric: '' }, 400); return; }
      const result = await enhancedNeteaseCloudLyricGet({ uid: info.userId, sid: id, cookie: userCookie, timestamp: Date.now() });
      const body = result && (result.body || result) || {};
      const nodes = [body, body.data, body.result].filter(value => value && typeof value === 'object');
      const readLyric = (keys) => {
        for (const node of nodes) {
          for (const key of keys) {
            const value = node[key];
            if (typeof value === 'string' && value.trim()) return value;
            if (value && typeof value === 'object' && typeof value.lyric === 'string' && value.lyric.trim()) return value.lyric;
          }
        }
        return '';
      };
      sendPrivateJSON(res, {
        provider: 'netease',
        source: 'netease-cloud',
        cloudSong: true,
        cloudId: id,
        lyric: readLyric(['lyric', 'lrc', 'lyrics']),
        tlyric: readLyric(['tlyric', 'translation']),
        yrc: readLyric(['yrc']),
        ytlrc: readLyric(['ytlrc']),
      });
    } catch (err) {
      console.error('[NeteaseCloudLyric]', err);
      sendPrivateJSON(res, { provider: 'netease', source: 'netease-cloud', error: err.message, lyric: '' }, 500);
    }
    return;
  }

  if (pn === '/api/lyric') {
    try {
      const id = url.searchParams.get('id');
      if (!id) { sendJSON(res, { error: 'Missing song id', lyric: '' }, 400); return; }
      let body = {};
      let source = 'lyric';
      try {
        if (typeof lyric_new === 'function') {
          const nr = await lyric_new({ id, cookie: userCookie, timestamp: Date.now() });
          body = nr.body || {};
          source = 'lyric_new';
        }
      } catch (errNew) {
        console.warn('[LyricNew]', errNew.message);
      }
      if (!lyricBodyHasPrimary(body) || !lyricBodyHasTranslation(body)) {
        const r = await lyric({ id, cookie: userCookie, timestamp: Date.now() });
        body = mergeLyricBodies(body, r.body || {});
        source = source === 'lyric_new' ? 'lyric_new+lyric' : 'lyric';
      }
      sendJSON(res, {
        lyric: (body.lrc && body.lrc.lyric) || '',
        tlyric: (body.tlyric && body.tlyric.lyric) || '',
        yrc: (body.yrc && body.yrc.lyric) || '',
        ytlrc: (body.ytlrc && body.ytlrc.lyric) || '',
        romalrc: (body.romalrc && body.romalrc.lyric) || '',
        yromalrc: (body.yromalrc && body.yromalrc.lyric) || '',
        source,
      });
    } catch (err) {
      console.error('[Lyric]', err);
      sendJSON(res, { error: err.message, lyric: '' }, 500);
    }
    return;
  }

  // ---------- 歌曲评论 ----------
  if (pn === '/api/song/comments') {
    try {
      const requestBody = req.method === 'POST' ? await readRequestBody(req) : {};
      const id = requestBody.id || url.searchParams.get('id');
      if (req.method === 'POST') {
        const info = await requireLogin(res);
        if (!info) return;
        const content = String(requestBody.content || requestBody.text || '').trim();
        if (!id || !content) { sendJSON(res, { created: false, error: 'Missing song id or comment content' }, 400); return; }
        const result = await comment({
          t: requestBody.replyTo ? 2 : 1,
          type: 0,
          id,
          commentId: requestBody.replyTo || '',
          content,
          cookie: userCookie,
          timestamp: Date.now(),
        });
        const code = normalizeApiCode(result);
        sendJSON(res, { provider: 'netease', id, created: code === 200, success: code === 200, code, body: result.body || result });
        return;
      }
      const limit = Math.max(6, Math.min(50, parseInt(url.searchParams.get('limit') || '20', 10) || 20));
      const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
      if (!id) { sendJSON(res, { error: 'Missing song id', comments: [] }, 400); return; }
      const r = await comment_music({ id, limit, offset, cookie: userCookie, timestamp: Date.now() });
      const body = r.body || r || {};
      const raw = body.hotComments && offset === 0 ? body.hotComments : (body.comments || []);
      const comments = (raw || []).map(c => ({
        id: c.commentId,
        content: c.content || '',
        likedCount: c.likedCount || 0,
        time: c.time || 0,
        user: c.user ? { id: c.user.userId, nickname: c.user.nickname || '', avatar: c.user.avatarUrl || '' } : null,
      })).filter(c => c.content);
      sendJSON(res, { id, total: body.total || 0, comments, hot: !!(body.hotComments && offset === 0), body });
    } catch (err) {
      console.error('[SongComments]', err);
      sendJSON(res, { error: err.message, comments: [] }, 500);
    }
    return;
  }

  if (pn === '/api/song/comments/like') {
    try {
      const info = await requireLogin(res);
      if (!info) return;
      const body = req.method === 'POST' ? await readRequestBody(req) : {};
      const id = body.id || url.searchParams.get('id') || '';
      const cid = body.commentId || body.cid || url.searchParams.get('commentId') || '';
      const liked = String(body.liked != null ? body.liked : (url.searchParams.get('liked') || 'true')) !== 'false';
      if (!id || !cid) { sendJSON(res, { success: false, error: 'Missing song id or comment id' }, 400); return; }
      const result = await comment_like({ type: 0, id, cid, t: liked ? 1 : 0, cookie: userCookie, timestamp: Date.now() });
      const code = normalizeApiCode(result);
      sendJSON(res, { provider: 'netease', id, commentId: cid, liked, success: code === 200, code, body: result.body || result });
    } catch (err) {
      console.error('[SongCommentLike]', err);
      sendJSON(res, { provider: 'netease', success: false, error: err.message }, 500);
    }
    return;
  }

  // ---------- 歌手主页 / 热门歌曲 ----------
  if (pn === '/api/artist/detail') {
    try {
      const id = url.searchParams.get('id');
      const limit = Math.max(10, Math.min(80, parseInt(url.searchParams.get('limit') || '30', 10) || 30));
      if (!id) { sendJSON(res, { error: 'Missing artist id', songs: [] }, 400); return; }
      let detailBody = {};
      try {
        const detail = await artist_detail({ id, cookie: userCookie, timestamp: Date.now() });
        detailBody = detail.body || detail || {};
      } catch (e) {
        console.warn('[ArtistDetail] detail failed:', e.message);
      }
      let rawSongs = [];
      try {
        const list = await artist_songs({ id, order: 'hot', limit, offset: 0, cookie: userCookie, timestamp: Date.now() });
        const b = list.body || list || {};
        rawSongs = (b.songs || (b.data && b.data.songs) || []);
      } catch (e) {
        console.warn('[ArtistSongs] hot failed:', e.message);
      }
      if (!rawSongs.length) {
        const top = await artist_top_song({ id, cookie: userCookie, timestamp: Date.now() });
        const b = top.body || top || {};
        rawSongs = b.songs || [];
      }
      const artist = detailBody.artist || (detailBody.data && (detailBody.data.artist || detailBody.data)) || {};
      const songs = rawSongs.map(mapSongRecord).filter(s => s.id).slice(0, limit);
      sendJSON(res, {
        id,
        artist: {
          id: artist.id || id,
          name: artist.name || artist.artistName || '',
          avatar: artist.avatar || artist.cover || artist.picUrl || artist.img1v1Url || '',
          brief: artist.briefDesc || artist.description || artist.desc || '',
          musicSize: artist.musicSize || artist.songSize || 0,
          albumSize: artist.albumSize || 0,
        },
        songs,
        body: detailBody,
      });
    } catch (err) {
      console.error('[ArtistDetail]', err);
      sendJSON(res, { error: err.message, songs: [] }, 500);
    }
    return;
  }

  // ---------- 歌单曲目详情 ----------
  if (pn === '/api/playlist/tracks') {
    try {
      const id = url.searchParams.get('id');
      if (!id) { sendJSON(res, { error: 'Missing playlist id', tracks: [] }, 400); return; }

      const pageLimit = parseInt(url.searchParams.get('limit') || '0', 10) || 0;
      const pageOffset = parseInt(url.searchParams.get('offset') || '0', 10) || 0;
      if (pageLimit || pageOffset) {
        const pageData = await fetchNeteasePlaylistTracksPage(id, pageLimit || 48, pageOffset);
        const pageTracks = (pageData.rawTracks || []).map(mapSongRecord).filter(t => t.id);
        sendJSON(res, {
          playlist: pageData.playlistMeta || { id, name: '', cover: '', trackCount: 0 },
          tracks: pageTracks,
          offset: pageData.offset,
          limit: pageData.limit,
          nextOffset: pageData.nextOffset,
          hasMore: pageData.hasMore,
          total: pageData.total || Number(pageData.playlistMeta && pageData.playlistMeta.trackCount) || 0,
          partial: true,
        });
        return;
      }

      const syncedData = await fetchAllNeteasePlaylistTracks(id);
      const syncedPlaylistMeta = syncedData.playlistMeta || { id, name: '', cover: '', trackCount: 0 };
      const syncedRawTracks = syncedData.rawTracks || [];
      const syncedTracks = syncedRawTracks.map(mapSongRecord).filter(t => t.id);
      if (!syncedPlaylistMeta.trackCount) syncedPlaylistMeta.trackCount = syncedTracks.length;
      sendJSON(res, { playlist: syncedPlaylistMeta, tracks: syncedTracks });
      return;

    } catch (err) {
      console.error('[PlaylistTracks]', err);
      sendJSON(res, { error: err.message, tracks: [] }, 500);
    }
    return;
  }

  // ---------- 封面代理 (带 CORS 头, 给 canvas 提取像素用) ----------
  if (pn === '/api/cover') {
    try {
      const coverUrl = url.searchParams.get('url');
      // URL 校验: 必须是 http(s) 开头, 否则直接 404 (不要让 fetch 抛错)
      if (!coverUrl || !/^https?:\/\//i.test(coverUrl)) {
        res.writeHead(400, { 'Access-Control-Allow-Origin': '*' });
        res.end('Invalid cover url');
        return;
      }
      const resp = await fetch(coverUrl, { headers: { 'User-Agent': UA, 'Referer': 'https://music.163.com/' } });
      const ct  = resp.headers.get('content-type') || 'image/jpeg';
      const cl  = resp.headers.get('content-length');
      const hdr = {
        'Content-Type': ct,
        'Access-Control-Allow-Origin': '*',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'Cache-Control': 'public, max-age=86400',
      };
      if (cl) hdr['Content-Length'] = cl;
      res.writeHead(resp.status, hdr);
      const reader = resp.body.getReader();
      while (true) { const c = await reader.read(); if (c.done) break; res.write(c.value); }
      res.end();
    } catch (err) { console.error('[Cover]', err); res.writeHead(500); res.end(); }
    return;
  }

  // ---------- 音乐下载接口 ----------
  if (pn === '/api/download') {
    try {
      const body = req.method === 'POST' ? await readRequestBody(req) : {};
      const songs = Array.isArray(body.songs) ? body.songs : (body.song ? [body.song] : []);
      if (!songs.length) { sendJSON(res, { ok: false, error: 'NO_SONGS' }, 400); return; }
      const batchId = 'batch-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
      const jobs = songs.map(song => enqueueMusicDownload(song, {
        quality: body.quality || 'hires',
        playlistName: body.playlistName || '',
        batchId,
      }));
      sendJSON(res, { ok: true, batchId, jobs: jobs.map(publicMusicJob), dir: getMusicDownloadDir() });
    } catch (error) {
      console.error('[MusicDownload]', error);
      sendJSON(res, { ok: false, error: error && error.message || 'DOWNLOAD_START_FAILED' }, 500);
    }
    return;
  }

  if (pn === '/api/download/status') {
    const batchId = url.searchParams.get('batch') || '';
    const jobId = url.searchParams.get('id') || '';
    if (jobId) {
      const job = musicDownloadJobs.get(jobId);
      sendJSON(res, job ? publicMusicJob(job) : { error: 'NOT_FOUND' }, job ? 200 : 404);
    } else {
      const jobs = Array.from(musicDownloadJobs.values())
        .filter(job => !batchId || job.batchId === batchId)
        .slice(-100)
        .map(publicMusicJob);
      sendJSON(res, { batchId, jobs, dir: getMusicDownloadDir() });
    }
    return;
  }

  if (pn === '/api/download/cancel') {
    try {
      const body = req.method === 'POST' ? await readRequestBody(req) : {};
      const id = body.id || url.searchParams.get('id') || '';
      const batchId = body.batchId || body.batch || '';
      let cancelled = 0;
      for (const job of musicDownloadJobs.values()) {
        if ((id && job.id !== id) || (!id && batchId && job.batchId !== batchId)) continue;
        if (job.status === 'queued' || job.status === 'resolving') {
          job.status = 'cancelled';
          job.message = '已取消';
          job.updatedAt = Date.now();
          cancelled += 1;
        }
        if (id) break;
      }
      sendJSON(res, { ok: true, cancelled });
    } catch (error) {
      sendJSON(res, { ok: false, error: error && error.message || 'DOWNLOAD_CANCEL_FAILED' }, 500);
    }
    return;
  }

  if (pn === '/api/download/dir') {
    sendJSON(res, { dir: getMusicDownloadDir() });
    return;
  }

  // ---------- 音频代理 (支持 Range) ----------
  if (pn === '/api/audio') {
    try {
      const audioUrl = url.searchParams.get('url');
      if (!audioUrl) { res.writeHead(400); res.end('Missing url'); return; }
      const range = req.headers.range || '';
      const upstreamRange = normalizeAudioProxyUpstreamRange(range);
      const hdr = audioProxyHeadersFor(audioUrl, upstreamRange);
      const lifecycle = { clientClosed: false, responseFinished: false, reader: null };
      const closeUpstream = () => {
        if (lifecycle.responseFinished) return;
        lifecycle.clientClosed = true;
        const reader = lifecycle.reader;
        lifecycle.reader = null;
        if (reader) {
          try { Promise.resolve(reader.cancel()).catch(() => {}); } catch (_) {}
        }
      };
      const finishUpstream = () => { lifecycle.responseFinished = true; };
      res.once('finish', finishUpstream);
      res.once('close', closeUpstream);
      try {
        const fetched = await fetchAudioProxyRangeWithCache(audioUrl, hdr, lifecycle);
        const up = fetched.upstream;
        if (lifecycle.clientClosed) {
          if (fetched && !fetched.buffer && up && up.body) {
            try { await up.body.cancel(); } catch (_) {}
          }
          return;
        }
        const out = {
          'Content-Type': audioContentTypeForUrl(audioUrl, up.headers.get('content-type')),
          'Access-Control-Allow-Origin': '*',
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store',
        };
        const cr = up.headers.get('content-range'); if (cr) out['Content-Range'] = cr;
        if (fetched.buffer) out['Content-Length'] = String(fetched.buffer.length);
        res.writeHead(up.status, out);
        if (fetched.buffer) {
          res.end(fetched.buffer);
          return;
        }
        if (!up.body) { res.end(); return; }
        const reader = up.body.getReader();
        lifecycle.reader = reader;
        try {
          while (!lifecycle.clientClosed) {
            const c = await readStreamChunkWithTimeout(reader, AUDIO_PROXY_STREAM_IDLE_TIMEOUT_MS);
            if (c.done) break;
            if (!res.write(c.value)) {
              await new Promise((resolve) => {
                let settled = false;
                const done = () => {
                  if (settled) return;
                  settled = true;
                  res.removeListener('drain', done);
                  res.removeListener('close', done);
                  res.removeListener('error', done);
                  resolve();
                };
                res.once('drain', done);
                res.once('close', done);
                res.once('error', done);
                if (res.writableEnded || res.destroyed) done();
              });
            }
          }
        } finally {
          lifecycle.reader = null;
          if (lifecycle.clientClosed) {
            try { await reader.cancel(); } catch (_) {}
          }
        }
        if (lifecycle.clientClosed) return;
        res.end();
      } finally {
        res.removeListener('close', closeUpstream);
        res.removeListener('finish', finishUpstream);
      }
    } catch (err) {
      console.error('[Audio]', err && (err.code || err.name || err.message || 'AUDIO_PROXY_FAILED'));
      if (res.headersSent) {
        try { res.destroy(); } catch (_) {}
      } else {
        res.writeHead(err && err.name === 'AbortError' ? 504 : 502, { 'Cache-Control': 'no-store' });
        res.end();
      }
    }
    return;
  }

  // ---------- 静态资源 ----------
  if (pn === '/js/index-modules-bundle.js') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Cache-Control': 'no-store' });
      res.end('Method not allowed');
      return;
    }
    await serveIndexModulesBundle(res);
    return;
  }

  if (pn === '/favicon.ico') {
    serveStatic(res, path.join(__dirname, 'build', 'icon.ico'));
    return;
  }

  let filePath = pn === '/' ? '/index.html' : pn;
  filePath = path.join(__dirname, 'public', filePath);
  serveStatic(res, filePath);
}

const server = http.createServer(handleHttpRequest);

server.listen(PORT, HOST, () => {
  console.log('======================================================');
  console.log(' 粒子音乐可视化 v2  →  http://localhost:' + PORT);
  console.log(' 登录态: ' + (userCookie ? '已登录(cookie已加载)' : '未登录'));
  console.log('======================================================');
});

// ====================================================================
//  遥控监听器（第二监听器）
// ====================================================================
// 主端口永远只绑回环。要让手机连上，不去重绑主端口（那会断开正在播放的音频流，
// 因为 /api/audio 是长连接的流式代理），而是另起一个只服务遥控白名单的监听器。
// 开关关闭即销毁，所以「默认不可达」这件事不依赖用户记得设环境变量。
const REMOTE_LISTENER_PORT_SPAN = 12;
let remoteListener = null;
let remoteListenerPort = 0;
let remoteListenerStarting = null;
let remoteListenerLifecycle = Promise.resolve();

// PORT 是「请求的」端口，不是实际绑定的：PORT=0 时由系统分配，两者不同。
// 遥控端口以主端口为基准往上找，所以这里必须取实际值。
function mainBoundPort() {
  try {
    const address = server.address();
    if (address && address.port) return address.port;
  } catch (_) {}
  return Number(PORT) || 0;
}

function remoteListenerStatus() {
  return {
    running: !!(remoteListener && remoteListener.listening),
    port: remoteListener && remoteListener.listening ? remoteListenerPort : 0,
  };
}

function tryListenRemote(port) {
  return new Promise((resolve, reject) => {
    const listener = http.createServer(handleHttpRequest);
    // 标记在 socket 上而不是 server 上：handleHttpRequest 只拿得到 req。
    listener.on('connection', (socket) => { socket.__mineradioRemoteListener = true; });
    const onError = (err) => {
      listener.removeListener('listening', onListening);
      try { listener.close(); } catch (_) {}
      reject(err);
    };
    const onListening = () => {
      listener.removeListener('error', onError);
      resolve(listener);
    };
    listener.once('error', onError);
    listener.once('listening', onListening);
    listener.listen(port, '0.0.0.0');
  });
}

// 端口是浏览器 origin 的一部分。优先复用持久化端口，避免关闭或重启后换端口，
// 导致手机看不到旧 origin 下 localStorage 里的 token 而被迫重新配对。
async function startRemoteListener() {
  if (remoteListener && remoteListener.listening) return remoteListenerStatus();
  if (remoteListenerStarting) return remoteListenerStarting;
  remoteListenerStarting = (async () => {
    await loadRemoteTokens();
    // 端口 0 或异常值时退到一个固定高位端口，别去撞 1..1024 那些特权端口。
    const bound = mainBoundPort();
    const base = bound > 1024 ? bound + 1 : 39900;
    const candidates = [];
    const addCandidate = (value) => {
      const candidate = normalizeRemoteListenerPort(value);
      if (candidate && candidate !== bound && !candidates.includes(candidate)) candidates.push(candidate);
    };
    addCandidate(remoteAuth.preferredPort);
    for (let offset = 0; offset < REMOTE_LISTENER_PORT_SPAN; offset += 1) {
      addCandidate(base + offset);
    }
    let lastError = null;
    for (const candidate of candidates) {
      try {
        remoteListener = await tryListenRemote(candidate);
        remoteListenerPort = candidate;
        if (remoteAuth.preferredPort !== candidate) {
          remoteAuth.preferredPort = candidate;
          await saveRemoteTokens();
        }
        console.log('[Remote] listener started on 0.0.0.0:' + candidate);
        return remoteListenerStatus();
      } catch (err) {
        lastError = err;
        if (err && (err.code === 'EADDRINUSE' || err.code === 'EACCES')) continue;
        throw err;
      }
    }
    throw lastError || new Error('REMOTE_LISTENER_NO_FREE_PORT');
  })().finally(() => { remoteListenerStarting = null; });
  return remoteListenerStarting;
}

function stopRemoteListener() {
  return new Promise((resolve) => {
    if (!remoteListener) { remoteListenerPort = 0; resolve(remoteListenerStatus()); return; }
    const listener = remoteListener;
    remoteListener = null;
    remoteListenerPort = 0;
    try {
      listener.close(() => resolve(remoteListenerStatus()));
      // close() 只停止接受新连接，已建立的连接（遥控页面的轮询）会把它吊住，
      // 所以主动断开，否则关开关后端口迟迟不释放。
      if (typeof listener.closeAllConnections === 'function') listener.closeAllConnections();
    } catch (_) {
      resolve(remoteListenerStatus());
    }
    setTimeout(() => resolve(remoteListenerStatus()), 1500);
  });
}

// HTTP 请求可能来自快速连续开关，不能让 start/stop 并发改同一组 server 句柄。
// 串行后最终状态严格服从请求顺序，旧的 start 完成后会立刻执行排队中的 stop。
function setRemoteListenerEnabled(enabled) {
  const applyState = () => enabled === true ? startRemoteListener() : stopRemoteListener();
  const operation = remoteListenerLifecycle.then(applyState, applyState);
  remoteListenerLifecycle = operation.catch(() => {});
  return operation;
}

server.clearAllLoginCredentials = clearAllRuntimeLoginCredentials;
server.registerLocalMediaPath = registerLocalMediaPath;
server.flushListenSyncJournal = flushListenSyncJournalSync;
// 由 main.js 注入把遥控命令转成 IPC 的通路。server.js 自身不依赖 electron，
// 未注入时 /api/remote/command 明确回 503。
server.setRemoteCommandSink = setRemoteCommandSink;

module.exports = server;
