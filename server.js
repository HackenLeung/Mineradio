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
  logout,
  user_account,
  user_playlist,
  comment_music,
  artist_detail,
  artist_top_song,
  artist_songs,
  like: like_song,
  likelist,
  song_like_check,
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
} = require('NeteaseCloudMusicApi');
const { scrobble } = require('@neteasecloudmusicapienhanced/api');
const http = require('http');
const https = require('https');
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const tls = require('tls');
const { once } = require('events');
const { fileURLToPath } = require('url');
const { execFileSync } = require('child_process');
const QRCode = require('qrcode');
const { analyzePodcastDjStream, analyzePodcastDjIntro } = require('./dj-analyzer');
const platformPlaylistImport = require('./platform-playlist-import');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const COOKIE_FILE = process.env.COOKIE_FILE || path.join(__dirname, '.cookie');
const KUGOU_COOKIE_FILE = process.env.KUGOU_COOKIE_FILE || path.join(__dirname, '.kugou-cookie');
const UPDATE_WORK_DIR = process.env.MINERADIO_UPDATE_DIR || path.join(__dirname, 'updates');
const UPDATE_DOWNLOAD_DIR = process.env.MINERADIO_UPDATE_DOWNLOAD_DIR || path.join(UPDATE_WORK_DIR, 'downloads');
const MUSIC_DOWNLOAD_DIR = process.env.MINERADIO_DOWNLOAD_DIR || path.join(__dirname, 'downloads');
const UPDATE_PATCH_BACKUP_DIR = process.env.MINERADIO_PATCH_BACKUP_DIR || path.join(UPDATE_WORK_DIR, 'backups', 'patches');
const BEATMAP_CACHE_DIR = process.env.MINERADIO_BEAT_CACHE_DIR || 'D:\\MineradioCache\\beatmaps';
const APP_PACKAGE = readPackageInfo();
const APP_VERSION = process.env.MINERADIO_VERSION || APP_PACKAGE.version || '0.9.11';
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
const WEATHER_IP_LOCATION_URL = 'http://ip-api.com/json/';
const WEATHER_DEFAULT_LOCATION = {
  name: '上海',
  country: 'China',
  latitude: 31.2304,
  longitude: 121.4737,
  timezone: 'Asia/Shanghai',
};

const updateDownloadJobs = new Map();

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
  '.gif':  'image/gif',
  '.mp4':  'video/mp4',
  '.m4v':  'video/mp4',
  '.webm': 'video/webm',
  '.mov':  'video/quicktime',
  '.ico':  'image/x-icon',
  '.svg':  'image/svg+xml',
  '.mp3':  'audio/mpeg',
  '.flac': 'audio/flac',
  '.wav':  'audio/wav',
  '.ogg':  'audio/ogg',
  '.opus': 'audio/ogg',
  '.m4a':  'audio/mp4',
  '.aac':  'audio/aac',
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
let userCookie = '';
try { if (fs.existsSync(COOKIE_FILE)) userCookie = fs.readFileSync(COOKIE_FILE, 'utf8').trim(); }
catch (e) { userCookie = ''; }
function saveCookie(c) {
  userCookie = normalizeCookieHeader(c) || rawCookieFallback(c);
  try { fs.writeFileSync(COOKIE_FILE, userCookie); } catch (e) {}
}

let kugouCookie = '';
try { if (fs.existsSync(KUGOU_COOKIE_FILE)) kugouCookie = fs.readFileSync(KUGOU_COOKIE_FILE, 'utf8').trim(); }
catch (e) { kugouCookie = ''; }
function saveKugouCookie(c) {
  kugouCookie = normalizeCookieHeader(c) || rawCookieFallback(c);
  kugouVipProbeCache = { userId: '', checkedAt: 0, info: null };
  try { fs.writeFileSync(KUGOU_COOKIE_FILE, kugouCookie); } catch (e) {}
}

// ---------- 工具 ----------
function serveStatic(res, filePath) {
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
}
function sendJSON(res, data, status) {
  res.writeHead(status || 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
  });
  res.end(JSON.stringify(data));
}

const wallpaperMediaIndex = new Map();
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
function streamRegisteredLocalMedia(req, res, target) {
  let stat;
  try {
    stat = fs.statSync(target);
  } catch (_err) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
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
function steamRegistryRoots() {
  if (process.platform !== 'win32') return [];
  const roots = new Set();
  const queries = [
    ['HKCU\\Software\\Valve\\Steam', 'SteamPath'],
    ['HKCU\\Software\\Valve\\Steam', 'SteamExe'],
    ['HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'],
    ['HKLM\\SOFTWARE\\Valve\\Steam', 'InstallPath'],
  ];
  queries.forEach(([key, value]) => {
    try {
      const output = execFileSync('reg.exe', ['query', key, '/v', value], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 2500,
      });
      const match = output.match(new RegExp(`${value}\\s+REG_\\w+\\s+(.+)$`, 'mi'));
      if (!match) return;
      let found = match[1].trim().replace(/\//g, '\\');
      if (/steam\.exe$/i.test(found)) found = path.dirname(found);
      if (found) roots.add(found);
    } catch (_error) {}
  });
  return [...roots];
}
function steamLibraryRoots() {
  const roots = new Set([
    'C:\\Program Files\\Steam',
    'C:\\Program Files (x86)\\Steam',
    'D:\\SteamLibrary',
    'E:\\SteamLibrary',
    'F:\\SteamLibrary',
  ]);
  [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramW6432]
    .filter(Boolean)
    .forEach(base => roots.add(path.join(base, 'Steam')));
  steamRegistryRoots().forEach(root => roots.add(root));
  for (let code = 67; code <= 90; code++) {
    const drive = String.fromCharCode(code) + ':\\';
    roots.add(path.join(drive, 'Steam'));
    roots.add(path.join(drive, 'SteamLibrary'));
    roots.add(path.join(drive, 'Program Files', 'Steam'));
    roots.add(path.join(drive, 'Program Files (x86)', 'Steam'));
    roots.add(path.join(drive, 'Games', 'Steam'));
    roots.add(path.join(drive, 'Games', 'SteamLibrary'));
  }
  for (const root of [...roots]) {
    [
      path.join(root, 'steamapps', 'libraryfolders.vdf'),
      path.join(root, 'config', 'libraryfolders.vdf'),
    ].forEach(vdf => {
      try {
        const text = fs.readFileSync(vdf, 'utf8').replace(/^\uFEFF/, '');
        for (const match of text.matchAll(/"path"\s+"([^"]+)"/gi)) {
          const found = match[1].replace(/\\\\/g, '\\').trim();
          if (/^[a-z]:\\/i.test(found)) roots.add(found);
        }
        for (const match of text.matchAll(/"\d+"\s+"([a-z]:\\{1,2}[^"]+)"/gi)) {
          const found = match[1].replace(/\\\\/g, '\\').trim();
          if (/^[a-z]:\\/i.test(found)) roots.add(found);
        }
      } catch (_err) {}
    });
  }
  return [...roots].filter(root => fs.existsSync(root));
}
function firstExistingWallpaperFile(dir, candidates) {
  const root = path.resolve(dir) + path.sep;
  for (const value of candidates) {
    if (!value) continue;
    const target = path.resolve(dir, String(value));
    try {
      if (target.startsWith(root) && fs.statSync(target).isFile()) return target;
    } catch (_error) {}
  }
  return '';
}
function compatibleWallpaperMedia(dir, project) {
  const supported = new Map([
    ['.mp4', 'video'], ['.webm', 'video'], ['.mov', 'video'], ['.m4v', 'video'],
    ['.jpg', 'image'], ['.jpeg', 'image'], ['.png', 'image'], ['.webp', 'image'], ['.gif', 'image'],
  ]);
  const direct = firstExistingWallpaperFile(dir, [project && project.file]);
  if (direct && supported.has(path.extname(direct).toLowerCase())) {
    return { file: direct, mediaType: supported.get(path.extname(direct).toLowerCase()) };
  }
  const candidates = [];
  const stack = [dir];
  let visited = 0;
  while (stack.length && visited < 5000) {
    const current = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (_error) { continue; }
    for (const entry of entries) {
      if (++visited > 5000) break;
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) { stack.push(target); continue; }
      if (!entry.isFile() || /^preview\./i.test(entry.name)) continue;
      const mediaType = supported.get(path.extname(entry.name).toLowerCase());
      if (!mediaType || (mediaType === 'image' && current !== dir)) continue;
      let size = 0;
      try { size = fs.statSync(target).size; } catch (_error) {}
      candidates.push({ file: target, mediaType, size });
    }
  }
  candidates.sort((a, b) => a.mediaType !== b.mediaType ? (a.mediaType === 'video' ? -1 : 1) : b.size - a.size);
  return candidates[0] || { file: '', mediaType: '' };
}
function bestWallpaperPreview(dir, project) {
  const preferred = firstExistingWallpaperFile(dir, [
    project && project.preview,
    project && project.cover,
    project && project.poster,
    'preview.jpg', 'preview.png', 'preview.jpeg', 'preview.webp',
    'cover.jpg', 'cover.png', 'poster.jpg', 'poster.png',
  ]);
  const candidates = [];
  if (preferred) {
    try { candidates.push({ file: preferred, size: fs.statSync(preferred).size, priority: 2 }); } catch (_error) {}
  }
  const stack = [dir];
  let visited = 0;
  while (stack.length && visited < 3000) {
    const current = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (_error) { continue; }
    for (const entry of entries) {
      if (++visited > 3000) break;
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) { stack.push(target); continue; }
      if (!entry.isFile() || !/^(?:preview|cover|poster|thumbnail)[^/]*\.(?:jpe?g|png|webp)$/i.test(entry.name)) continue;
      try { candidates.push({ file: target, size: fs.statSync(target).size, priority: current === dir ? 2 : 1 }); } catch (_error) {}
    }
  }
  candidates.sort((a, b) => b.priority - a.priority || b.size - a.size);
  return candidates[0] && candidates[0].file || '';
}
function wallpaperContentFingerprint(file) {
  if (!file) return '';
  try {
    const stat = fs.statSync(file);
    const length = Math.min(stat.size, 128 * 1024);
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buffer, 0, length, 0); } finally { fs.closeSync(fd); }
    return crypto.createHash('sha1').update(String(stat.size)).update(buffer).digest('hex');
  } catch (_error) {
    return '';
  }
}
function scanWallpaperEngineLibrary() {
  wallpaperMediaIndex.clear();
  const results = [];
  const projectRoots = [];
  steamLibraryRoots().forEach(root => {
    projectRoots.push(path.join(root, 'steamapps', 'workshop', 'content', '431960'));
    projectRoots.push(path.join(root, 'steamapps', 'common', 'wallpaper_engine', 'projects', 'myprojects'));
  });
  const seen = new Set();
  const seenContent = new Set();
  projectRoots.forEach(root => {
    if (!fs.existsSync(root)) return;
    let dirs = [];
    try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => path.join(root, entry.name)); } catch (_err) {}
    dirs.forEach(dir => {
      const projectPath = path.join(dir, 'project.json');
      if (!fs.existsSync(projectPath)) return;
      try {
        const project = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
        const type = String(project.type || '').toLowerCase();
        const compatible = compatibleWallpaperMedia(dir, project);
        const media = compatible.file;
        const preview = bestWallpaperPreview(dir, project);
        if (!media && !preview) return;
        const fingerprint = crypto.createHash('sha1').update(projectPath).digest('hex').slice(0, 18);
        const contentFingerprint = wallpaperContentFingerprint(media || preview);
        if (seen.has(fingerprint) || (contentFingerprint && seenContent.has(contentFingerprint))) return;
        seen.add(fingerprint);
        if (contentFingerprint) seenContent.add(contentFingerprint);
        if (media) wallpaperMediaIndex.set(fingerprint + ':media', media);
        if (preview) wallpaperMediaIndex.set(fingerprint + ':preview', preview);
        results.push({
          id: fingerprint,
          title: String(project.title || path.basename(dir)).slice(0, 160),
          type: media ? compatible.mediaType : type || 'scene',
          projectType: type || '',
          mediaType: compatible.mediaType || '',
          playable: !!media,
          dynamic: !!media && compatible.mediaType === 'video',
          hasPreview: !!preview,
          dedupeKey: contentFingerprint || fingerprint,
        });
      } catch (_err) {}
    });
  });
  return results.sort((a, b) => Number(b.playable) - Number(a.playable) || a.title.localeCompare(b.title, 'zh-CN'));
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
function beatCacheRootInfo() {
  const dir = path.resolve(BEATMAP_CACHE_DIR);
  const root = path.parse(dir).root;
  const drive = root ? root.replace(/[\\\/]+$/, '').toUpperCase() : '';
  const allowed = !!root && !/^C:$/i.test(drive);
  const available = allowed && fs.existsSync(root);
  return { dir, root, drive, allowed, available };
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
  fs.mkdirSync(info.dir, { recursive: true });
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
function readBeatMapCache(key) {
  const file = safeBeatMapCacheFile(key);
  if (!file || !fs.existsSync(file)) return null;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return raw && raw.map ? raw : null;
}
function writeBeatMapCache(body) {
  const payload = compactBeatMapCachePayload(body);
  if (!payload) return { ok: false, error: 'INVALID_BEATMAP_CACHE_PAYLOAD' };
  const file = safeBeatMapCacheFile(payload.key);
  if (!file) return { ok: false, error: 'INVALID_BEATMAP_CACHE_KEY' };
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload));
  fs.renameSync(tmp, file);
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
  const raw = song.artist || song.artists || song.singer || song.author_name || '';
  if (Array.isArray(raw)) {
    return raw.map(a => (a && (a.name || a)) || '').filter(Boolean).join(' / ');
  }
  return String(raw || '');
}

function musicDownloadFilename(song, audioUrl) {
  const artist = musicDownloadSanitizeFilename(musicDownloadArtistText(song));
  const name = musicDownloadSanitizeFilename(song.name || song.title || '');
  const ext = musicDownloadExtForUrl(audioUrl);
  const base = artist && artist !== '未知' ? `${artist} - ${name}` : name;
  return base + ext;
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
  if (song.type === 'local' || song.source === 'local' || song.localUrl || song.localPath) return 'local';
  if (song.provider === 'kugou' || song.source === 'kugou' || song.type === 'kugou'
    || song.hash || song.albumAudioId || song.album_audio_id) return 'kugou';
  return 'netease';
}

async function resolveMusicDownloadUrl(song, quality) {
  const provider = musicDownloadProviderKey(song);
  if (provider === 'local') {
    return { url: null, error: '本地歌曲无需下载', trial: false };
  }
  if (provider === 'kugou') {
    const hash = song.hash || song.id || '';
    const albumAudioId = song.albumAudioId || song.album_audio_id || '';
    const albumId = song.albumId || song.album_id || '';
    let qualityHashes = null;
    try { qualityHashes = song.qualityHashes || song.quality_hashes || null; } catch (_) {}
    const data = await handleKugouSongUrl(hash, albumAudioId, albumId, quality, qualityHashes);
    if (!data || !data.url || !data.playable) return { url: null, error: data && data.message || '无法获取小狗播放地址', trial: false };
    return { url: data.url, error: '', trial: !!data.trial };
  }
  // netease
  const loginInfo = await getLoginInfo();
  const data = await handleSongUrl(song.id, loginInfo, quality);
  if (!data || !data.url) return { url: null, error: data && data.message || '无法获取播放地址', trial: !!data.trial };
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
    if (!resolved.url) {
      job.status = 'skipped';
      job.error = resolved.error || '无法获取下载地址';
      job.message = job.error;
      job.updatedAt = Date.now();
      return;
    }
    if (resolved.trial) {
      job.status = 'skipped';
      job.error = resolved.error || '仅试听，跳过';
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

    const hdr = audioProxyHeadersFor(resolved.url, '');
    const resp = await fetch(resolved.url, { headers: hdr });
    if (!resp.ok) throw new Error('下载失败 HTTP ' + resp.status);

    const totalHeader = parseInt(resp.headers.get('content-length') || '0', 10) || 0;
    job.total = totalHeader;
    job.received = 0;
    job.progress = 0;
    job.speedBps = 0;
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
        if (job.total > 0) {
          job.progress = Math.max(1, Math.min(99, Math.round((job.received / job.total) * 100)));
        } else {
          job.progress = Math.max(1, Math.min(88, Math.round(Math.log10(Math.max(1, job.received / 1024) + 1) * 24)));
        }
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
  } catch (e) {
    job.status = 'error';
    job.error = e.message || 'DOWNLOAD_FAILED';
    job.message = '下载失败: ' + (e.message || '');
    job.updatedAt = Date.now();
    const tmpPath = (job.filePath || '') + '.download';
    try { if (tmpPath && fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
  }
}

function drainMusicDownloadQueue() {
  while (musicDownloadActive < MUSIC_DOWNLOAD_CONCURRENCY && musicDownloadQueue.length > 0) {
    const job = musicDownloadQueue.shift();
    if (job.status === 'cancelled') continue;
    musicDownloadActive++;
    executeMusicDownload(job).finally(() => {
      musicDownloadActive--;
      drainMusicDownloadQueue();
    });
  }
}

const MUSIC_DOWNLOAD_JOB_LIMIT = 300;
function pruneMusicDownloadJobs() {
  if (musicDownloadJobs.size <= MUSIC_DOWNLOAD_JOB_LIMIT) return;
  // 删除最旧的已结束任务 (done/error/skipped/cancelled)，保留进行中的
  const finished = [];
  for (const job of musicDownloadJobs.values()) {
    if (job.status === 'done' || job.status === 'error' || job.status === 'skipped' || job.status === 'cancelled') {
      finished.push(job);
    }
  }
  finished.sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
  let removable = musicDownloadJobs.size - MUSIC_DOWNLOAD_JOB_LIMIT;
  for (const job of finished) {
    if (removable <= 0) break;
    musicDownloadJobs.delete(job.id);
    removable--;
  }
}

function enqueueMusicDownload(song, opts) {
  opts = opts || {};
  pruneMusicDownloadJobs();
  const id = 'dl-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  const provider = musicDownloadProviderKey(song);
  const job = {
    id,
    songId: String(song.id || song.hash || ''),
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
  musicDownloadJobs.set(id, job);
  musicDownloadQueue.push(job);
  drainMusicDownloadQueue();
  return job;
}

function getMusicDownloadDir() {
  // 动态读取环境变量，桌面版改目录后无需重启即可生效
  return process.env.MINERADIO_DOWNLOAD_DIR || MUSIC_DOWNLOAD_DIR;
}
// ========== /音乐下载引擎 ==========

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
function readRequestBody(req) {
  return new Promise(resolve => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 8 * 1024 * 1024) req.destroy();
    });
    req.on('end', () => {
      if (!raw) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); }
      catch (e) {
        const params = new URLSearchParams(raw);
        const out = {};
        params.forEach((v, k) => { out[k] = v; });
        resolve(out);
      }
    });
    req.on('error', () => resolve({}));
  });
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
function kugouCookieObject() {
  return parseCookieString(kugouCookie);
}

function kugouCookieUserId(obj) {
  obj = obj || kugouCookieObject();
  return String(obj.userid || obj.user_id || obj.uid || obj.KugooID || obj.kugou_id || obj.kugouid || obj.kg_uid || '').replace(/\D/g, '');
}

function kugouCookieToken(obj) {
  obj = obj || kugouCookieObject();
  return obj.token || obj.user_token || obj.access_token || obj.key || obj.KuGoo || obj.t || '';
}

function kugouCookieNickname(obj) {
  obj = obj || kugouCookieObject();
  try {
    return decodeURIComponent(obj.nickname || obj.nick || obj.username || obj.user_name || obj.uname || '').trim();
  } catch (_) {
    return obj.nickname || obj.nick || obj.username || obj.user_name || obj.uname || '';
  }
}

function kugouCookieAvatar(obj) {
  obj = obj || kugouCookieObject();
  const raw = obj.avatar || obj.pic || obj.img || obj.icon || obj.headpic || obj.head_img || obj.headimg || obj.user_pic || obj.userpic || '';
  try {
    return decodeURIComponent(raw).trim();
  } catch (_) {
    return String(raw || '').trim();
  }
}

function kugouCookieVipType(obj) {
  obj = obj || kugouCookieObject();
  const raw = obj.vipType || obj.vip_type || obj.viptype || obj.isvip || obj.is_vip || obj.vip || 0;
  return Number(raw) || 0;
}

function normalizeKugouCookieInput(cookieText) {
  return normalizeCookieHeader(cookieText) || rawCookieFallback(cookieText);
}

function getKugouLoginInfo() {
  const obj = kugouCookieObject();
  const userId = kugouCookieUserId(obj);
  const token = kugouCookieToken(obj);
  const loggedIn = !!(userId && token);
  const vipType = loggedIn ? kugouCookieVipType(obj) : 0;
  const isVip = vipType > 0 || String(obj.vip || obj.is_vip || obj.isvip || '').toLowerCase() === 'true';
  return {
    provider: 'kugou',
    loggedIn,
    hasCookie: !!kugouCookie,
    userId,
    nickname: loggedIn ? (kugouCookieNickname(obj) || '小狗用户') : '小狗',
    avatar: loggedIn ? kugouCookieAvatar(obj) : '',
    vipType,
    vipLevel: isVip ? 'vip' : 'none',
    isVip,
    isSvip: false,
    vipLabel: isVip ? 'Kugou VIP' : '无 VIP',
    playbackKeyReady: loggedIn,
    preview: !loggedIn,
    message: loggedIn ? '已保存小狗网页登录会话' : '未登录小狗'
  };
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
    return playbackRestriction('netease', 'vip_required', '小云歌曲需要 VIP 权限，当前无法获取完整播放地址', 'upgrade', { code, fee });
  }
  if (fee === 4 || fee === 8) {
    return playbackRestriction('netease', 'paid_required', '小云歌曲需要单曲、专辑购买或更高权限', 'purchase', { code, fee });
  }
  if (code === 404 || code === 403) {
    return playbackRestriction('netease', 'copyright_unavailable', '小云版权暂不可播，换源或稍后重试会更稳', 'switch_source', { code, fee });
  }
  return playbackRestriction('netease', 'url_unavailable', '小云没有返回可播放地址，可能是版权、会员或地区限制', loggedIn ? 'switch_source' : 'login', { code, fee });
}
const NETEASE_QUALITY_CANDIDATES = [
  { level: 'jymaster', br: 1999000, label: '超清母带', svip: true },
  { level: 'hires',    br: 1999000, label: '高清臻音' },
  { level: 'lossless', br: 1411000, label: '无损' },
  { level: 'exhigh',   br: 999000,  label: '极高' },
  { level: 'standard', br: 128000,  label: '标准' },
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
  return !!(loginInfo && loginInfo.loggedIn && (loginInfo.vipLevel === 'svip' || loginInfo.isSvip || Number(loginInfo.vipType || 0) >= 10));
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
    cover: album.picUrl || album.coverUrl || '',
    duration: s.dt || s.duration || 0,
    fee: s.fee,
  };
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

function isQzoneBackgroundPlaylist(pl) {
  const text = String((pl && pl.name || '') + ' ' + (pl && pl.creator || '')).toLowerCase();
  return /qzone|空间|背景音乐/i.test(text);
}
async function requireLogin(res) {
  const info = await getLoginInfo();
  if (!info.loggedIn || !info.userId) {
    sendJSON(res, { error: 'LOGIN_REQUIRED', loggedIn: false }, 401);
    return null;
  }
  return info;
}

// ---------- 业务: 搜索 ----------
//   优先用 cloudsearch (新接口, 字段更全, picUrl 更稳定)
//   对于仍然缺失封面的歌曲, 用 song_detail 批量补齐
async function handleSearch(keywords, limit) {
  console.log('[Search]', keywords, 'limit:', limit);
  const result = await cloudsearch({ keywords, limit, cookie: userCookie });
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

async function handleDiscoverHome() {
  const info = await getLoginInfo();
  const loggedIn = !!(info && info.loggedIn);
  if (!loggedIn) {
    return {
      loggedIn: false,
      user: null,
      dailySongs: [],
      playlists: [],
      podcasts: [],
      mode: 'starter',
      updatedAt: Date.now(),
    };
  }
  const tasks = [
    personalized({ limit: 8, cookie: userCookie, timestamp: Date.now() }),
    dj_hot({ limit: 6, offset: 0, cookie: userCookie, timestamp: Date.now() }),
    recommend_resource({ cookie: userCookie, timestamp: Date.now() }),
    recommend_songs({ cookie: userCookie, timestamp: Date.now() }),
  ];
  const result = await Promise.allSettled(tasks);

  const personalizedBody = result[0].status === 'fulfilled' && result[0].value && result[0].value.body || {};
  const publicPlaylists = (personalizedBody.result || personalizedBody.data || [])
    .map(pl => mapDiscoverPlaylist(pl, '推荐歌单'))
    .filter(pl => pl.id && pl.name)
    .slice(0, 8);

  const podcastBody = result[1].status === 'fulfilled' && result[1].value && result[1].value.body || {};
  const podcastRaw = podcastBody.djRadios || podcastBody.djradios || podcastBody.radios || podcastBody.data || [];
  const podcasts = (Array.isArray(podcastRaw) ? podcastRaw : [])
    .map(mapPodcastRadio)
    .filter(p => p.id && !isLowSignalPodcastItem(p))
    .slice(0, 6);

  let privatePlaylists = [];
  if (result[2].status === 'fulfilled' && result[2].value) {
    const body = result[2].value.body || {};
    const raw = body.recommend || body.data || [];
    privatePlaylists = (Array.isArray(raw) ? raw : [])
      .map(pl => mapDiscoverPlaylist(pl, '私人推荐'))
      .filter(pl => pl.id && pl.name)
      .slice(0, 6);
  }

  let dailySongs = [];
  if (result[3].status === 'fulfilled' && result[3].value) {
    const body = result[3].value.body || {};
    const raw = body.data && (body.data.dailySongs || body.data.recommend) || body.recommend || [];
    dailySongs = (Array.isArray(raw) ? raw : [])
      .map(mapSongRecord)
      .filter(song => song.id && song.name)
      .slice(0, 50);
  }

  return {
    loggedIn,
    user: loggedIn ? { userId: info.userId, nickname: info.nickname || '', avatar: info.avatar || '' } : null,
    dailySongs,
    playlists: privatePlaylists.concat(publicPlaylists).slice(0, 10),
    podcasts,
    updatedAt: Date.now(),
  };
}

const KUGOU_GATEWAY_URL = 'https://gateway.kugou.com';
const KUGOU_LOGIN_BASE_URL = 'https://login-user.kugou.com';
const KUGOU_USER_SERVICE_URL = 'https://userservice.kugou.com';
const KUGOU_APPID = '3116';
const KUGOU_CLIENTVER = '11440';
const KUGOU_QR_APPID = '1001';
const KUGOU_QR_SRC_APPID = '2919';
const KUGOU_ANDROID_SIGN_KEY = 'LnT6xpN3khm36zse0QzvmgTZ3waWdRSA';
const KUGOU_WEB_SIGN_KEY = 'NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt';
const KUGOU_PLAY_KEY_SALT = 'kgcloudv2';
const KUGOU_RSA_PUBLIC_KEY = [
  '-----BEGIN PUBLIC KEY-----',
  'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDECi0Np2UR87scwrvTr72L6oO01rBbbBPriSDFPxr3Z5syug0O24QyQO8bg27+0+4kBzTBTBOZ/WWU0WryL1JSXRTXLgFVxtzIY41Pe7lPOgsfTCn5kZcvKhYKJesKnnJDNr5/abvTGf+rHG3YRwsCHcQ08/q6ifSioBszvb3QiwIDAQAB',
  '-----END PUBLIC KEY-----',
].join('\n');
const KUGOU_ANDROID_UA = 'Android15-1070-11440-46-0-DiscoveryDRADProtocol-wifi';
const KUGOU_DEFAULT_MID = crypto.createHash('md5').update((process.env.COMPUTERNAME || 'mineradio') + ':kugou').digest('hex');
let kugouVipProbeCache = { userId: '', checkedAt: 0, info: null };

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
    req.setTimeout(10000, () => req.destroy(new Error('Request timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function requestBuffer(targetUrl, opts, body) {
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
        const buf = Buffer.concat(chunks);
        if (response.statusCode >= 400) {
          const err = new Error('HTTP ' + response.statusCode);
          err.statusCode = response.statusCode;
          err.body = buf.toString('utf8');
          reject(err);
          return;
        }
        resolve(buf);
      });
    });
    req.setTimeout(10000, () => req.destroy(new Error('Request timeout')));
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

function finiteApiNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
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
  u.searchParams.set('forecast_days', '1');
  u.searchParams.set('timezone', location.timezone || 'auto');
  const body = await requestJson(u.toString(), { headers: { 'User-Agent': UA } });
  const cur = body && body.current || {};
  const temperature = finiteApiNumber(cur.temperature_2m);
  if (temperature === null) throw new Error('WEATHER_DATA_UNAVAILABLE');
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
    weatherCode: finiteApiNumber(cur.weather_code),
    temperature,
    apparentTemperature: finiteApiNumber(cur.apparent_temperature),
    humidity: finiteApiNumber(cur.relative_humidity_2m),
    precipitation: finiteApiNumber(cur.precipitation || cur.rain || cur.showers || cur.snowfall || 0),
    cloudCover: finiteApiNumber(cur.cloud_cover),
    windSpeed: finiteApiNumber(cur.wind_speed_10m),
    windGusts: finiteApiNumber(cur.wind_gusts_10m),
    isDay: finiteApiNumber(cur.is_day),
    time: cur.time || '',
    updatedAt: Date.now(),
  };
  return weather;
}

async function fetchIpWeatherLocation() {
  const u = new URL(WEATHER_IP_LOCATION_URL);
  u.searchParams.set('fields', 'status,message,country,regionName,city,lat,lon,timezone,query');
  u.searchParams.set('lang', 'zh-CN');
  const body = await requestJson(u.toString(), { headers: { 'User-Agent': UA } });
  if (!body || body.status !== 'success' || !Number.isFinite(Number(body.lat)) || !Number.isFinite(Number(body.lon))) {
    const err = new Error(body && body.message || 'IP_LOCATION_FAILED');
    err.body = body;
    throw err;
  }
  return {
    provider: 'ip-api',
    city: body.city || WEATHER_DEFAULT_LOCATION.name,
    region: body.regionName || '',
    country: body.country || '',
    latitude: Number(body.lat),
    longitude: Number(body.lon),
    timezone: body.timezone || 'auto',
    ip: body.query || '',
  };
}

function parseJSONText(text) {
  const raw = String(text || '').trim();
  const json = raw.replace(/^callback\(([\s\S]*)\);?$/, '$1');
  return JSON.parse(json);
}

function audioProxyHeadersFor(audioUrl, range) {
  const headers = { 'User-Agent': UA, Referer: 'https://music.163.com/' };
  try {
    const host = new URL(audioUrl).hostname.toLowerCase();
    if (host.includes('kugou') || host.includes('kgimg') || host.includes('kuwo')) {
      headers.Referer = 'https://www.kugou.com/';
      if (kugouCookie) headers.Cookie = kugouCookieHeader();
    } else if (userCookie) {
      headers.Cookie = userCookie;
    }
  } catch (e) {}
  if (range) headers.Range = range;
  return headers;
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

function kugouMd5(text) {
  return crypto.createHash('md5').update(String(text || '')).digest('hex');
}

function kugouSigVal(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function kugouAndroidSignature(params, dataString) {
  const body = Object.keys(params || {})
    .sort()
    .map(k => k + '=' + kugouSigVal(params[k]))
    .join('');
  return kugouMd5(KUGOU_ANDROID_SIGN_KEY + body + (dataString || '') + KUGOU_ANDROID_SIGN_KEY);
}

function kugouWebSignature(params) {
  const body = Object.keys(params || {})
    .sort()
    .map(k => k + '=' + (params[k] == null ? '' : params[k]))
    .join('');
  return kugouMd5(KUGOU_WEB_SIGN_KEY + body + KUGOU_WEB_SIGN_KEY);
}

function kugouRandomString(length, lower) {
  const chars = '1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let out = '';
  for (let i = 0; i < (length || 16); i++) out += chars[Math.floor(Math.random() * chars.length)];
  return lower ? out.toLowerCase() : out;
}

function kugouCalculateMid(seed) {
  const hex = crypto.createHash('md5').update(String(seed || '')).digest('hex');
  try {
    return BigInt('0x' + hex).toString(10);
  } catch (_) {
    return KUGOU_DEFAULT_MID;
  }
}

function kugouInitDevice(obj) {
  obj = Object.assign({}, obj || {});
  const guid = obj.KUGOU_API_GUID || crypto.randomUUID();
  obj.KUGOU_API_GUID = guid;
  obj.KUGOU_API_MID = obj.KUGOU_API_MID || kugouCalculateMid(guid);
  obj.KUGOU_API_MAC = obj.KUGOU_API_MAC || kugouRandomString(12);
  obj.KUGOU_API_DEV = obj.KUGOU_API_DEV || kugouRandomString(16);
  return obj;
}

function saveKugouAuth(obj) {
  const auth = kugouInitDevice(obj || {});
  kugouVipProbeCache = { userId: '', checkedAt: 0, info: null };
  saveKugouCookie(serializeCookieObject(auth));
  return auth;
}

function kugouCookieMid(obj) {
  obj = obj || kugouCookieObject();
  return obj.KUGOU_API_MID || obj.mid || obj.kg_mid || obj.KG_MID || KUGOU_DEFAULT_MID;
}

function kugouCookieDfid(obj) {
  obj = obj || kugouCookieObject();
  return obj.dfid || obj.DFID || '-';
}

function kugouCookieHeader() {
  const obj = kugouCookieObject();
  const allow = [
    'userid',
    'user_id',
    'uid',
    'token',
    'user_token',
    'access_token',
    'KugooID',
    'KuGoo',
    'dfid',
    'DFID',
    'mid',
    'kg_mid',
    'KG_MID',
    'KUGOU_API_MID',
    'KUGOU_API_GUID',
    'KUGOU_API_MAC',
    'KUGOU_API_DEV',
  ];
  return allow
    .filter(key => obj[key] != null && String(obj[key]) !== '')
    .map(key => key + '=' + encodeURIComponent(String(obj[key])))
    .join('; ');
}

function kugouCloudlistCookieHeader(obj) {
  obj = obj || kugouCookieObject();
  const pairs = [
    ['userid', kugouCookieUserId(obj)],
    ['token', kugouCookieToken(obj)],
    ['KUGOU_API_MID', kugouCookieMid(obj)],
  ];
  return pairs
    .filter(([, value]) => value != null && String(value) !== '')
    .map(([key, value]) => key + '=' + encodeURIComponent(String(value)))
    .join('; ');
}

async function kugouGatewayRequest(pathname, options) {
  options = options || {};
  const obj = kugouCookieObject();
  const clienttime = String(Math.floor(Date.now() / 1000));
  const params = Object.assign({
    dfid: kugouCookieDfid(obj),
    mid: kugouCookieMid(obj),
    uuid: '-',
    appid: KUGOU_APPID,
    clientver: KUGOU_CLIENTVER,
    clienttime,
  }, options.params || {});
  const token = kugouCookieToken(obj);
  const userId = kugouCookieUserId(obj);
  if (token && !params.token) params.token = token;
  if (userId && userId !== '0' && !params.userid) params.userid = userId;

  const method = String(options.method || 'GET').toUpperCase();
  const hasBody = options.data !== undefined && options.data !== null;
  const dataString = hasBody ? (typeof options.data === 'string' ? options.data : JSON.stringify(options.data)) : '';
  const signType = options.encryptType === 'web' ? 'web' : 'android';
  if (!options.notSignature && !params.signature) {
    params.signature = signType === 'web' ? kugouWebSignature(params) : kugouAndroidSignature(params, dataString);
  }

  const u = new URL(pathname, options.baseURL || KUGOU_GATEWAY_URL);
  Object.keys(params).forEach(k => {
    if (params[k] !== undefined && params[k] !== null) u.searchParams.set(k, String(params[k]));
  });
  const cookie = kugouCookieHeader();
  const headers = Object.assign({
    'User-Agent': KUGOU_ANDROID_UA,
    'kg-rc': '1',
    'kg-thash': '5d816a0',
    'kg-rec': '1',
    'kg-rf': 'B9EDA08A64250DEFFBCADDEE00F8F25F',
    dfid: kugouCookieDfid(obj),
    mid: kugouCookieMid(obj),
    clienttime,
  }, options.headers || {});
  if (cookie) headers.Cookie = cookie;
  if (hasBody && typeof options.data !== 'string') headers['Content-Type'] = 'application/json';
  if (options.responseType === 'buffer') {
    return requestBuffer(u.toString(), { method, headers }, hasBody ? dataString : null);
  }
  const text = await requestText(u.toString(), { method, headers }, hasBody ? dataString : null);
  return parseJSONText(text);
}

async function kugouCloudlistRequest(pathname, params, data) {
  const obj = kugouCookieObject();
  const clienttime = String(Math.floor(Date.now() / 1000));
  const token = kugouCookieToken(obj);
  const userId = kugouCookieUserId(obj);
  const finalParams = Object.assign({
    dfid: kugouCookieDfid(obj),
    mid: kugouCookieMid(obj),
    uuid: '-',
    appid: KUGOU_APPID,
    clientver: KUGOU_CLIENTVER,
    clienttime,
    userid: userId,
    token,
  }, params || {});
  const dataString = data ? JSON.stringify(data) : '';
  finalParams.signature = kugouAndroidSignature(finalParams, dataString);
  const u = new URL(pathname, KUGOU_GATEWAY_URL);
  Object.keys(finalParams).forEach(k => {
    if (finalParams[k] !== undefined && finalParams[k] !== null) u.searchParams.set(k, String(finalParams[k]));
  });
  const headers = {
    'User-Agent': KUGOU_ANDROID_UA,
    'x-router': 'cloudlist.service.kugou.com',
    'kg-rc': '1',
    'kg-thash': '5d816a0',
    'kg-rec': '1',
    'kg-rf': 'B9EDA08A64250DEFFBCADDEE00F8F25F',
    dfid: kugouCookieDfid(obj),
    mid: kugouCookieMid(obj),
    clienttime,
    'Content-Type': 'application/json',
    Cookie: 'userid=' + encodeURIComponent(String(userId || '')) +
      '; token=' + encodeURIComponent(String(token || '')) +
      '; KUGOU_API_MID=' + encodeURIComponent(String(kugouCookieMid(obj) || '')),
  };
  const text = await requestText(u.toString(), { method: dataString ? 'POST' : 'GET', headers }, dataString);
  return parseJSONText(text);
}

function kugouSafeGet(obj, pathKeys, fallback) {
  let cur = obj;
  for (const key of pathKeys || []) {
    if (!cur || typeof cur !== 'object' || !(key in cur)) return fallback;
    cur = cur[key];
  }
  return cur == null ? fallback : cur;
}

function kugouDeepFind(obj, names) {
  const wanted = new Set((names || []).map(name => String(name).toLowerCase()));
  const seen = new Set();
  function walk(value) {
    if (!value || typeof value !== 'object' || seen.has(value)) return '';
    seen.add(value);
    for (const key of Object.keys(value)) {
      if (wanted.has(String(key).toLowerCase()) && value[key] != null && String(value[key]) !== '') {
        return value[key];
      }
    }
    for (const key of Object.keys(value)) {
      const found = walk(value[key]);
      if (found != null && String(found) !== '') return found;
    }
    return '';
  }
  return walk(obj);
}

async function handleKugouLoginQrKey() {
  const device = saveKugouAuth(kugouCookieObject());
  const qrcodeText = 'https://h5.kugou.com/apps/loginQRCode/html/index.html?appid=' + KUGOU_APPID + '&';
  const data = await kugouGatewayRequest('/v2/qrcode', {
    baseURL: KUGOU_LOGIN_BASE_URL,
    encryptType: 'web',
    params: {
      appid: KUGOU_QR_APPID,
      type: 1,
      plat: 4,
      qrcode_txt: qrcodeText,
      srcappid: KUGOU_QR_SRC_APPID,
    },
    headers: {
      'User-Agent': UA,
      'x-router': 'login-user.kugou.com',
    },
  });
  const key = kugouSafeGet(data, ['data', 'qrcode'], '') || data.qrcode || data.key || '';
  if (!key) {
    const err = new Error((data && (data.error_msg || data.message || data.msg)) || 'KUGOU_QR_KEY_FAILED');
    err.body = data;
    throw err;
  }
  const loginUrl = 'https://h5.kugou.com/apps/loginQRCode/html/index.html?qrcode=' + encodeURIComponent(key);
  const img = await QRCode.toDataURL(loginUrl, { margin: 1, width: 220, errorCorrectionLevel: 'M' });
  return {
    provider: 'kugou',
    key,
    qrcode: key,
    url: loginUrl,
    img,
    deviceId: device.KUGOU_API_GUID,
  };
}

async function kugouRegisterDevice(auth) {
  auth = kugouInitDevice(auth || kugouCookieObject());
  const dataMap = {
    availableRamSize: 4983533568,
    availableRomSize: 48114719,
    availableSDSize: 48114717,
    basebandVer: '',
    batteryLevel: 100,
    batteryStatus: 3,
    brand: 'Redmi',
    buildSerial: 'unknown',
    device: 'marble',
    imei: auth.KUGOU_API_GUID,
    imsi: '',
    manufacturer: 'Xiaomi',
    uuid: auth.KUGOU_API_GUID,
    accelerometerValue: '',
    gravity: false,
    gravityValue: '',
    gyroscope: false,
    gyroscopeValue: '',
    light: false,
    lightValue: '',
    magnetic: false,
    magneticValue: '',
    orientation: false,
    orientationValue: '',
    pressure: false,
    pressureValue: '',
    step_counter: false,
    step_counterValue: '',
    temperature: false,
    temperatureValue: '',
    accelerometer: false,
  };
  const aesKey = kugouRandomString(6, true);
  const digest = kugouMd5(aesKey);
  const key = Buffer.from(digest.slice(0, 16), 'utf8');
  const iv = Buffer.from(digest.slice(16, 32), 'utf8');
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(dataMap), 'utf8'), cipher.final()]).toString('base64');
  const pRaw = JSON.stringify({ aes: aesKey, uid: auth.userid || 0, token: auth.token || '' });
  const p = crypto.publicEncrypt({
    key: KUGOU_RSA_PUBLIC_KEY,
    padding: crypto.constants.RSA_PKCS1_PADDING,
  }, Buffer.from(pRaw)).toString('hex');
  const buf = await kugouGatewayRequest('/risk/v2/r_register_dev', {
    baseURL: KUGOU_USER_SERVICE_URL,
    method: 'POST',
    encryptType: 'android',
    responseType: 'buffer',
    params: { part: 1, platid: 1, p },
    data: encrypted,
    headers: { 'x-router': 'userservice.kugou.com' },
  });
  let result = null;
  const plain = buf.toString('utf8');
  try {
    result = plain.trim().startsWith('{') ? JSON.parse(plain) : null;
  } catch (_) {
    result = null;
  }
  if (!result) {
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
    const decrypted = Buffer.concat([decipher.update(buf), decipher.final()]).toString('utf8');
    result = JSON.parse(decrypted);
  }
  const dfid = kugouSafeGet(result, ['data', 'dfid'], '');
  if (dfid) auth.dfid = dfid;
  return result;
}

async function handleKugouLoginQrCheck(key) {
  const qr = String(key || '').trim();
  if (!qr) return { provider: 'kugou', code: 800, status: 0, message: 'Missing Kugou QR key' };
  const data = await kugouGatewayRequest('/v2/get_userinfo_qrcode', {
    baseURL: KUGOU_LOGIN_BASE_URL,
    encryptType: 'web',
    params: {
      plat: 4,
      appid: KUGOU_APPID,
      srcappid: KUGOU_QR_SRC_APPID,
      qrcode: qr,
    },
    headers: {
      'User-Agent': UA,
      'x-router': 'login-user.kugou.com',
    },
  });
  const status = Number(kugouSafeGet(data, ['data', 'status'], data.status || kugouDeepFind(data, ['status']) || 0)) || 0;
  const token = String(kugouSafeGet(data, ['data', 'token'], '') ||
    kugouDeepFind(data, ['token', 'user_token', 'access_token', 'key']) ||
    data.token || '').trim();
  const userId = String(kugouSafeGet(data, ['data', 'userid'], '') ||
    kugouDeepFind(data, ['userid', 'user_id', 'uid', 'kugooid', 'kugouid']) ||
    data.userid || '').replace(/\D/g, '');
  const nickname = String(kugouSafeGet(data, ['data', 'nickname'], '') ||
    kugouSafeGet(data, ['data', 'username'], '') ||
    kugouDeepFind(data, ['nickname', 'nick', 'username', 'user_name', 'uname']) ||
    '').trim();
  const avatar = String(kugouSafeGet(data, ['data', 'pic'], '') ||
    kugouSafeGet(data, ['data', 'avatar'], '') ||
    kugouSafeGet(data, ['data', 'img'], '') ||
    kugouSafeGet(data, ['data', 'user_pic'], '') ||
    kugouDeepFind(data, ['avatar', 'pic', 'img', 'icon', 'headpic', 'head_img', 'headimg', 'user_pic', 'userpic']) ||
    data.pic || data.avatar || data.img || '').trim();
  const vipType = Number(kugouSafeGet(data, ['data', 'vip_type'], 0) ||
    kugouSafeGet(data, ['data', 'vipType'], 0) ||
    kugouSafeGet(data, ['data', 'viptype'], 0) ||
    kugouDeepFind(data, ['vip_type', 'vipType', 'viptype', 'isvip', 'is_vip', 'vip']) ||
    data.vip_type || data.vipType || data.viptype || 0) || 0;
  if (!(token && userId)) {
    if (status !== 4) {
      const code = status === 2 ? 802 : (status === 3 ? 800 : 801);
      return { provider: 'kugou', loggedIn: false, code, status, rawStatus: status, message: data && (data.message || data.msg || data.error_msg) || '' };
    }
  }
  if (!token || !userId) {
    return { provider: 'kugou', loggedIn: false, code: 803, status, error: 'KUGOU_TOKEN_MISSING', message: 'Kugou login confirmed but token was not returned' };
  }
  const auth = saveKugouAuth(Object.assign({}, kugouCookieObject(), {
    token,
    userid: userId,
    nickname,
    avatar,
    vipType,
  }));
  try {
    await kugouRegisterDevice(auth);
    saveKugouAuth(auth);
  } catch (e) {
    console.warn('[KugouRegisterDevice]', e.message);
  }
  return Object.assign({}, await getKugouLoginInfoFresh(), {
    code: 803,
    status,
    saved: true,
    rawStatus: status,
  });
}

function asArrayDeep(value, keys) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  for (const key of keys) {
    if (Array.isArray(value[key])) return value[key];
  }
  for (const key of Object.keys(value)) {
    if (value[key] && typeof value[key] === 'object') {
      const found = asArrayDeep(value[key], keys);
      if (found.length) return found;
    }
  }
  return [];
}

function mapKugouPlaylist(raw) {
  raw = raw || {};
  const id = raw.listid || raw.list_id || raw.global_collection_id || raw.specialid || raw.id || raw.mixsongid || '';
  const name = raw.name || raw.listname || raw.list_name || raw.specialname || raw.title || raw.collection_name || '';
  const cover = raw.pic || raw.img || raw.cover || raw.sizable_cover || raw.list_pic || raw.avatar || '';
  return {
    provider: 'kugou',
    source: 'kugou',
    type: 'kugou',
    id: String(id || ''),
    name: String(name || '小狗歌单'),
    cover: String(cover || '').replace(/\{size\}/g, '240'),
    trackCount: Number(raw.count || raw.song_count || raw.total || raw.file_count || raw.songcount || 0) || 0,
    creator: raw.username || raw.nickname || raw.user_name || '小狗',
  };
}

function cleanKugouTrackText(value) {
  return String(value || '')
    .replace(/\.(mp3|flac|m4a|aac|ogg|wav)$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSimpleTitleForCompare(value) {
  return cleanKugouTrackText(value).toLowerCase().replace(/\s+/g, '');
}

function mapKugouTrack(raw) {
  raw = raw || {};
  const trans = raw.trans_param || raw.transParam || {};
  const hash = raw.hash || raw.Hash || raw.file_hash || raw.FileHash || raw.audio_hash ||
    raw['320hash'] || raw['128hash'] || raw.sqhash || raw.SQFileHash || raw.HQFileHash ||
    trans.ogg_320_hash || trans.ogg_128_hash || '';
  const qualityHashes = {
    standard: raw['128hash'] || raw.hash || raw.Hash || raw.file_hash || raw.FileHash || trans.ogg_128_hash || '',
    exhigh: raw['320hash'] || raw.HQFileHash || trans.ogg_320_hash || raw.hash || raw.Hash || raw.file_hash || '',
    lossless: raw.sqhash || raw.SQFileHash || raw.flac_hash || raw.hash || raw.Hash || raw.file_hash || '',
    hires: raw.hrhash || raw.high_hash || raw.sqhash || raw.SQFileHash || raw.hash || raw.Hash || raw.file_hash || '',
    jymaster: raw.masterhash || raw.jymaster_hash || raw.hrhash || raw.sqhash || raw.SQFileHash || raw.hash || raw.Hash || raw.file_hash || '',
  };
  const albumAudioId = raw.album_audio_id || raw.albumAudioId || raw.audio_id || raw.audioid || raw.Audioid || raw.mixsongid || raw.MixSongID || raw.songid || raw.id || raw.ID || '';
  const mixSongId = raw.mixsongid || raw.MixSongID || raw.mix_song_id || raw.ID || '';
  const filename = cleanKugouTrackText(raw.filename || raw.FileName || '');
  let name = cleanKugouTrackText(raw.songname || raw.song_name || raw.SongName || raw.name || raw.title || '');
  let artist = cleanKugouTrackText(raw.singername || raw.singer_name || raw.SingerName || raw.author_name || raw.singer || raw.artist || '');
  if (!artist && Array.isArray(raw.singerinfo) && raw.singerinfo[0]) {
    artist = raw.singerinfo.map(item => item && cleanKugouTrackText(item.name)).filter(Boolean).join(' / ');
  }
  if (filename) {
    const parts = String(filename).split(' - ');
    if (parts.length >= 2) {
      const filenameArtist = cleanKugouTrackText(parts.shift());
      const titleFromFilename = cleanKugouTrackText(parts.join(' - '));
      artist = artist || filenameArtist;
      if (!name || normalizeSimpleTitleForCompare(name) === normalizeSimpleTitleForCompare(filename)) name = titleFromFilename;
    } else {
      name = name || filename;
    }
  }
  if (name && artist && String(name).includes(' - ')) {
    const parts = String(name).split(' - ');
    const maybeArtist = cleanKugouTrackText(parts.shift());
    const maybeTitle = cleanKugouTrackText(parts.join(' - '));
    if (maybeTitle && normalizeSimpleTitleForCompare(maybeArtist) === normalizeSimpleTitleForCompare(artist)) {
      name = maybeTitle;
    }
  }
  if (name && !artist && String(name).includes(' - ')) {
    const parts = String(name).split(' - ');
    const maybeArtist = cleanKugouTrackText(parts.shift());
    const maybeTitle = cleanKugouTrackText(parts.join(' - '));
    if (maybeArtist && maybeTitle) {
      artist = maybeArtist;
      name = maybeTitle;
    }
  }
  const albumInfo = raw.albuminfo || raw.albumInfo || {};
  const album = raw.album_name || raw.albumname || raw.AlbumName || raw.album || albumInfo.name || '';
  const albumId = raw.album_id || raw.albumid || raw.AlbumID || raw.albumId || '';
  const cover = raw.pic || raw.img || raw.image || raw.Image || raw.AlbumImage || raw.cover || raw.sizable_cover || trans.union_cover || '';
  const durationMs = Number(raw.timelength || raw.time_length || raw.timelen || raw.duration || raw.Duration || raw.interval) || 0;
  const fsort = Number(raw.fsort || raw.sort || raw.position || raw.pos || 0) || 0;
  return {
    provider: 'kugou',
    source: 'kugou',
    type: 'kugou',
    id: String(hash || albumAudioId || name),
    hash: String(hash || ''),
    qualityHashes,
    albumAudioId: String(albumAudioId || ''),
    mixSongId: String(mixSongId || ''),
    albumId: String(albumId || ''),
    name: cleanKugouTrackText(name).replace(/\s*-\s*$/, ''),
    artist: String(artist || ''),
    artists: artist ? [{ name: String(artist) }] : [],
    album: String(album || ''),
    cover: String(cover || '').replace(/\{size\}/g, '300'),
    duration: durationMs * (durationMs > 1000 ? 1 : 1000),
    fee: Number(raw.privilege || raw.Privilege || raw.media_privilege || raw.media_pay_type || raw.pay_type || raw.PayType || 0) || 0,
    vipRequired: Number(trans.musicpack_advance || 0) > 0,
    fsort,
    position: fsort,
    sort: fsort,
    playable: !!hash,
  };
}

async function handleKugouSearch(keywords, limit) {
  const keyword = String(keywords || '').trim();
  if (!keyword) return [];
  const size = Math.max(4, Math.min(30, Number(limit) || 12));
  const url = new URL('https://songsearch.kugou.com/song_search_v2');
  url.searchParams.set('keyword', keyword);
  url.searchParams.set('page', '1');
  url.searchParams.set('pagesize', String(size));
  url.searchParams.set('platform', 'WebFilter');
  url.searchParams.set('filter', '2');
  url.searchParams.set('iscorrection', '1');
  url.searchParams.set('privilege_filter', '0');
  const data = await requestJson(url.toString(), {
    headers: { Referer: 'https://www.kugou.com/', 'User-Agent': UA },
  });
  const rawSongs = data && data.data && Array.isArray(data.data.lists) ? data.data.lists : [];
  return rawSongs.map(mapKugouTrack).filter(song => song.name && (song.hash || song.albumAudioId)).slice(0, size);
}

function kugouHashForQuality(hash, qualityPreference, qualityHashes) {
  const requested = normalizeQualityPreference(qualityPreference);
  const hashes = qualityHashes && typeof qualityHashes === 'object' ? qualityHashes : {};
  const orderMap = {
    jymaster: ['jymaster', 'hires', 'lossless', 'exhigh', 'standard'],
    hires: ['hires', 'lossless', 'exhigh', 'standard'],
    lossless: ['lossless', 'exhigh', 'standard'],
    exhigh: ['exhigh', 'standard'],
    standard: ['standard'],
  };
  const order = orderMap[requested] || orderMap.hires;
  for (const key of order) {
    const candidate = String(hashes[key] || '').trim();
    if (candidate) return { hash: candidate, level: key };
  }
  return { hash: String(hash || '').trim(), level: requested };
}

function kugouHashCandidatesForQuality(hash, qualityPreference, qualityHashes) {
  const requested = normalizeQualityPreference(qualityPreference);
  const hashes = qualityHashes && typeof qualityHashes === 'object' ? qualityHashes : {};
  const orderMap = {
    jymaster: ['jymaster', 'hires', 'lossless', 'exhigh', 'standard'],
    hires: ['hires', 'lossless', 'exhigh', 'standard'],
    lossless: ['lossless', 'exhigh', 'standard'],
    exhigh: ['exhigh', 'standard'],
    standard: ['standard'],
  };
  const order = orderMap[requested] || orderMap.hires;
  const seen = new Set();
  const out = [];
  for (const level of order) {
    const candidate = String(hashes[level] || '').trim();
    if (!candidate || seen.has(candidate.toUpperCase())) continue;
    seen.add(candidate.toUpperCase());
    out.push({ hash: candidate, level });
  }
  const fallback = String(hash || '').trim();
  if (fallback && !seen.has(fallback.toUpperCase())) out.push({ hash: fallback, level: requested });
  return out.length ? out : [{ hash: fallback, level: requested }];
}

function sortKugouCloudTracks(rawTracks) {
  return (rawTracks || []).slice().sort((a, b) => {
    const af = Number(a && (a.fsort || a.sort || a.position || a.pos || 0)) || 0;
    const bf = Number(b && (b.fsort || b.sort || b.position || b.pos || 0)) || 0;
    if (af || bf) return af - bf;
    const ac = Number(a && (a.collecttime || a.collect_time || 0)) || 0;
    const bc = Number(b && (b.collecttime || b.collect_time || 0)) || 0;
    return ac - bc;
  });
}

async function handleKugouUserPlaylists() {
  const info = await getKugouLoginInfoFresh();
  if (!info.loggedIn || !info.userId) return { loggedIn: false, provider: 'kugou', playlists: [] };
  const data = await kugouGatewayRequest('/v7/get_all_list', {
    method: 'POST',
    params: {
      total_ver: 979,
      type: 2,
      page: 1,
      pagesize: 200,
      userid: info.userId,
      token: kugouCookieToken(),
    },
    data: {
      total_ver: 979,
      type: 2,
      page: 1,
      pagesize: 200,
      userid: Number(info.userId) || info.userId,
      token: kugouCookieToken(),
    },
    headers: { 'x-router': 'cloudlist.service.kugou.com' },
  });
  const rawLists = asArrayDeep(data, ['lists', 'list', 'info', 'data', 'listinfo', 'collection_list', 'playlist']);
  const seen = new Set();
  const playlists = rawLists.map(mapKugouPlaylist).filter(pl => {
    if (!pl.id || seen.has(pl.id)) return false;
    seen.add(pl.id);
    return true;
  });
  return { ...info, loggedIn: true, provider: 'kugou', userId: info.userId, playlists, rawStatus: data && (data.status || data.errcode || data.error_code) };
}

async function handleKugouPlaylistTracks(id) {
  const info = getKugouLoginInfo();
  if (!info.loggedIn) return { loggedIn: false, provider: 'kugou', tracks: [] };
  const pid = String(id || '').trim();
  if (!pid) return { loggedIn: true, provider: 'kugou', error: 'Missing Kugou playlist id', tracks: [] };
  let detail = null;
  let rawTracks = [];
  try {
    const pageSize = 200;
    let page = 1;
    let total = 0;
    do {
      detail = await kugouCloudlistRequest('/v4/get_list_all_file',
        { listid: pid, page, pagesize: pageSize },
        { listid: pid, page, pagesize: pageSize, area_code: 1, show_relate_goods: 0, allplatform: 1, show_cover: 1, type: 0, userid: Number(info.userId) || info.userId, token: kugouCookieToken() });
      if (!detail || Number(detail.status) === 0 || Number(detail.error_code || detail.errcode) > 0) {
        throw new Error('KUGOU_CLOUDLIST_DETAIL_FAILED');
      }
      const pageTracks = asArrayDeep(detail, ['songs', 'songlist', 'list', 'info', 'files', 'data']);
      rawTracks = rawTracks.concat(pageTracks);
      total = Number(detail && detail.data && (detail.data.count || detail.data.total)) || rawTracks.length;
      if (!pageTracks.length || rawTracks.length >= total) break;
      page++;
    } while (page <= 10);
  } catch (err) {
    detail = await kugouGatewayRequest('/pubsongs/v2/get_other_list_file_nofilt', {
      params: { id: pid, global_collection_id: pid, page: 1, pagesize: 500, area_code: 1, plat: 1, type: 1, mode: 1, personal_switch: 1, extend_fields: 'abtags,hot_cmt,popularization' },
      headers: { 'x-router': 'pubsongscdn.kugou.com' },
    });
    rawTracks = asArrayDeep(detail, ['songs', 'songlist', 'list', 'info', 'files', 'data']);
  }
  const tracks = sortKugouCloudTracks(rawTracks).map(mapKugouTrack).filter(s => s.name && (s.hash || s.id));
  return {
    loggedIn: true,
    provider: 'kugou',
    playlist: { provider: 'kugou', id: pid, name: '', trackCount: tracks.length },
    tracks,
  };
}

async function kugouTrackercdnPlayUrl(hash, options) {
  options = options || {};
  const h = String(hash || '').trim().toUpperCase();
  const obj = kugouCookieObject();
  const userId = kugouCookieUserId(obj);
  const token = kugouCookieToken(obj);
  const mid = kugouCookieMid(obj);
  const appid = KUGOU_APPID;
  const params = {
    cmd: '26',
    hash: h,
    behavior: 'play',
    appid,
    pid: '2',
    mid,
    userid: userId || '0',
    version: KUGOU_CLIENTVER,
    vipType: String(options.vipType || kugouCookieVipType(obj) || 0),
    token: token || '0',
    key: kugouMd5(h + KUGOU_PLAY_KEY_SALT + appid + mid + (userId || '0')),
  };
  if (options.albumAudioId) params.album_audio_id = String(options.albumAudioId);
  if (options.albumId) params.album_id = String(options.albumId);
  const u = new URL('/i/v2/', 'https://trackercdn.kugou.com');
  Object.keys(params).forEach(k => {
    if (params[k] !== undefined && params[k] !== null && String(params[k]) !== '') u.searchParams.set(k, String(params[k]));
  });
  const text = await requestText(u.toString(), {
    headers: {
      'User-Agent': KUGOU_ANDROID_UA,
      Cookie: kugouCloudlistCookieHeader(obj),
    },
  });
  const cleanText = String(text || '')
    .replace('<!--KG_TAG_RES_START-->', '')
    .replace('<!--KG_TAG_RES_END-->', '')
    .trim();
  return parseJSONText(cleanText);
}

function kugouPlayableUrlFromResponse(json) {
  const data = json && (json.data || json);
  const rawUrl = data && (data.play_url || data.play_backup_url || data.url || data.src || data.backup_url);
  const url = Array.isArray(rawUrl) ? rawUrl[0] : rawUrl;
  const backupUrl = data && (Array.isArray(data.backup_url) ? data.backup_url[0] : data.backup_url);
  return url || backupUrl || '';
}

function decodeKugouLyricContent(raw) {
  raw = String(raw || '').trim();
  if (!raw) return '';
  const compact = raw.replace(/\s+/g, '');
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(compact) && compact.length >= 8) {
    try {
      const decoded = Buffer.from(compact, 'base64').toString('utf8').replace(/^\uFEFF/, '');
      if (decoded && (decoded.includes('[') || /[\u4e00-\u9fa5]/.test(decoded))) return decoded.replace(/\r\n/g, '\n').trim();
    } catch (_) {}
  }
  return raw.replace(/\r\n/g, '\n').trim();
}

async function handleKugouLyric(hash, duration) {
  const h = String(hash || '').trim().toUpperCase();
  if (!h) return { provider: 'kugou', error: 'Missing Kugou hash', lyric: '' };
  const searchUrl = new URL('http://lyrics.kugou.com/search');
  searchUrl.searchParams.set('ver', '1');
  searchUrl.searchParams.set('man', 'yes');
  searchUrl.searchParams.set('client', 'pc');
  searchUrl.searchParams.set('hash', h);
  const dur = Number(duration || 0) || 0;
  if (dur > 0) searchUrl.searchParams.set('duration', String(Math.round(dur > 1000 ? dur : dur * 1000)));
  const search = parseJSONText(await requestText(searchUrl.toString(), { headers: { 'User-Agent': UA } }));
  const candidates = Array.isArray(search && search.candidates) ? search.candidates : [];
  const first = candidates[0];
  if (!first || !first.id || !first.accesskey) {
    return { provider: 'kugou', lyric: '', tlyric: '', yrc: '', source: 'kugou-empty' };
  }
  const downloadUrl = new URL('http://lyrics.kugou.com/download');
  downloadUrl.searchParams.set('ver', '1');
  downloadUrl.searchParams.set('client', 'pc');
  downloadUrl.searchParams.set('id', String(first.id));
  downloadUrl.searchParams.set('accesskey', String(first.accesskey));
  downloadUrl.searchParams.set('fmt', 'lrc');
  downloadUrl.searchParams.set('charset', 'utf8');
  const body = parseJSONText(await requestText(downloadUrl.toString(), { headers: { 'User-Agent': UA } }));
  const lyricText = decodeKugouLyricContent(body && body.content);
  return {
    provider: 'kugou',
    hash: h,
    lyric: lyricText,
    tlyric: '',
    yrc: '',
    source: lyricText ? 'kugou-lyrics' : 'kugou-empty',
  };
}

async function getKugouLoginInfoFresh() {
  const info = getKugouLoginInfo();
  if (!info.loggedIn || info.isVip) return info;
  const now = Date.now();
  if (kugouVipProbeCache.userId === info.userId && kugouVipProbeCache.info && now - kugouVipProbeCache.checkedAt < 5 * 60 * 1000) {
    return Object.assign({}, info, kugouVipProbeCache.info);
  }
  try {
    const detail = await kugouCloudlistRequest('/v4/get_list_all_file',
      { listid: '2', page: 1, pagesize: 1 },
      { listid: '2', page: 1, pagesize: 1, area_code: 1, show_relate_goods: 0, allplatform: 1, show_cover: 1, type: 0, userid: Number(info.userId) || info.userId, token: kugouCookieToken() });
    const first = asArrayDeep(detail, ['songs', 'songlist', 'list', 'info', 'files', 'data'])[0] || {};
    const hash = first.hash || first.Hash || first.file_hash || '';
    const probe = hash ? await kugouTrackercdnPlayUrl(hash, {
      albumId: first.album_id || first.albumid || '',
      albumAudioId: first.album_audio_id || first.audio_id || first.mixsongid || '',
      vipType: 1,
    }) : null;
    const playbackReady = !!kugouPlayableUrlFromResponse(probe);
    const probeInfo = playbackReady ? {
      vipType: Math.max(1, Number(info.vipType || 0)),
      vipLevel: 'vip',
      isVip: true,
      isSvip: false,
      vipLabel: 'Kugou VIP',
      playbackKeyReady: true,
    } : { playbackKeyReady: false };
    kugouVipProbeCache = { userId: info.userId, checkedAt: now, info: probeInfo };
    return Object.assign({}, info, probeInfo);
  } catch (_) {
    kugouVipProbeCache = { userId: info.userId, checkedAt: now, info: { playbackKeyReady: false } };
    return info;
  }
}

async function handleKugouSongUrl(hash, albumAudioId, albumId, qualityPreference, qualityHashes) {
  const h = String(hash || '').trim();
  if (!h) return { provider: 'kugou', url: '', playable: false, error: 'Missing Kugou hash' };
  const loginInfo = getKugouLoginInfo();
  const candidates = kugouHashCandidatesForQuality(h, qualityPreference, qualityHashes);
  let selected = candidates[0] || { hash: h, level: normalizeQualityPreference(qualityPreference) };
  let json = null;
  let playableUrl = '';
  const tried = [];
  for (const candidate of candidates) {
    selected = candidate;
    json = await kugouTrackercdnPlayUrl(candidate.hash || h, { albumAudioId, albumId, vipType: loginInfo.vipType });
    const code = json && (json.error_code || json.errcode || json.status);
    tried.push({ level: candidate.level, hash: candidate.hash || h, code });
    playableUrl = kugouPlayableUrlFromResponse(json);
    if (playableUrl) break;
  }
  const data = json && (json.data || json);
  const code = json && (json.error_code || json.errcode || json.status);
  const restriction = playableUrl ? null : playbackRestriction('kugou',
    loginInfo.loggedIn ? 'paid_required' : 'login_required',
    loginInfo.loggedIn ? '小狗没有返回当前账号可播放地址，可能需要会员、购买或官方客户端权限' : '小狗歌曲需要登录后获取播放地址',
    loginInfo.loggedIn ? 'upgrade' : 'login',
    { code, rawMessage: json && (json.error || json.errmsg || json.message || '') });
  return {
    provider: 'kugou',
    url: playableUrl,
    playable: !!playableUrl,
    loggedIn: !!loginInfo.loggedIn,
    vipType: loginInfo.vipType || 0,
    vipLevel: loginInfo.vipLevel || 'none',
    level: selected.level || (data && (data.audio_name || data.quality || data.bitRate || data.bitrate || '')),
    quality: data && (data.fileName || data.songName || data.extName || ''),
    requestedQuality: normalizeQualityPreference(qualityPreference),
    resolvedHash: selected.hash || h,
    fallbackUsed: !!(playableUrl && selected.level !== normalizeQualityPreference(qualityPreference)),
    triedQualities: tried,
    trial: false,
    message: playableUrl ? '' : restriction.message,
    reason: playableUrl ? '' : restriction.category,
    restriction,
    kugouCode: code,
  };
}

async function handleKugouListenUpload(mxid, playedAt, playCount) {
  const info = getKugouLoginInfo();
  if (!info.loggedIn || !info.userId) return { provider: 'kugou', loggedIn: false, error: 'LOGIN_REQUIRED' };
  const songId = String(mxid || '').replace(/\D/g, '');
  if (!songId) return { provider: 'kugou', loggedIn: true, error: 'Missing Kugou mxid' };
  const obj = kugouCookieObject();
  const token = kugouCookieToken(obj);
  const userId = kugouCookieUserId(obj);
  let cloudPlayCount = 0;
  try {
    const history = await handleKugouListenHistory();
    const rows = history && history.body && history.body.data && history.body.data.songs || [];
    const current = rows.find(item => String(item && item.mxid || '') === songId);
    cloudPlayCount = Number(current && current.pc) || 0;
  } catch (_) {}
  const payload = {
    songs: [{
      mxid: Number(songId),
      op: 1,
      ot: Math.max(1, Math.round(Number(playedAt) || Math.floor(Date.now() / 1000))),
      pc: Math.max(1, cloudPlayCount + 1, Number(playCount) || 0),
    }],
    token,
    userid: Number(userId) || userId,
  };
  const data = await kugouGatewayRequest('/playhistory/v1/upload_songs', {
    method: 'POST',
    params: { plat: 3 },
    data: payload,
  });
  const code = data && (data.status || data.error_code || data.errcode || data.code);
  return { provider: 'kugou', loggedIn: true, success: code === 1 || code === 0 || code === 200, mxid: songId, code, body: data };
}

async function handleKugouListenHistory() {
  const info = getKugouLoginInfo();
  if (!info.loggedIn || !info.userId) return { provider: 'kugou', loggedIn: false, error: 'LOGIN_REQUIRED' };
  const obj = kugouCookieObject();
  const data = await kugouGatewayRequest('/playhistory/v1/get_songs', {
    method: 'POST',
    params: { plat: 3 },
    data: { userid: Number(kugouCookieUserId(obj)) || kugouCookieUserId(obj), token: kugouCookieToken(obj), page: 1, pagesize: 100 },
  });
  return { provider: 'kugou', loggedIn: true, body: data };
}

function normalizeKugouListenHistory(result) {
  const data = result && result.body && result.body.data || {};
  const songs = (data.songs || []).map(item => {
    const info = item.info || {};
    return {
      provider: 'kugou',
      source: 'kugou',
      type: 'kugou',
      id: String(item.mxid || info.mixsongid || ''),
      albumAudioId: String(item.mxid || info.mixsongid || ''),
      mixSongId: String(item.mxid || info.mixsongid || ''),
      hash: info.hash || '',
      albumId: info.album_id || info.albuminfo && info.albuminfo.id || '',
      name: info.name || '未知歌曲',
      artist: info.singername || '',
      cover: String(info.cover || '').replace('{size}', '240'),
      duration: Number(info.timelen) || 0,
      playCount: Number(item.pc) || 0,
      playedAt: (Number(item.ot) || 0) * 1000,
    };
  }).filter(item => item.id && item.name !== '未知歌曲').sort((a, b) => (b.playCount - a.playCount) || (b.playedAt - a.playedAt));
  return { provider: 'kugou', loggedIn: true, success: true, songs, hasMore: !!data.has_more };
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
async function handleSongUrl(id, loginInfo, qualityPreference) {
  console.log('[SongUrl] id:', id, 'logged-in:', !!userCookie);
  const requestedQuality = normalizeQualityPreference(qualityPreference);
  const svipReady = hasNeteaseSvip(loginInfo);
  const qualities = qualityCandidatesFrom(requestedQuality, NETEASE_QUALITY_CANDIDATES)
    .filter(q => !q.svip || svipReady);

  let trialFallback = null; // 兜底: 即使是试听也要能播
  let lastData = null;
  let lastError = null;

  for (const q of qualities) {
    try {
      // 优先用 v1 接口 (支持更高音质 level 字段)
      let result;
      try {
        result = await song_url_v1({ id, level: q.level, cookie: userCookie });
      } catch (e) {
        result = await song_url({ id, br: q.br, cookie: userCookie });
      }
      const d = result.body && result.body.data && result.body.data[0];
      if (d) lastData = d;
      const url = d && d.url;
      const freeTrial = d && d.freeTrialInfo;
      console.log('[SongUrl]', q.level, '->', url ? 'OK' : 'no url', freeTrial ? '(TRIAL)' : '');
      if (url && !freeTrial) {
        return { url, trial: false, playable: true, level: q.level, quality: q.label, br: d.br, requestedQuality };
      }
      if (url && freeTrial && !trialFallback) {
        trialFallback = {
          url,
          trial: true,
          playable: true,
          level: q.level,
          quality: q.label,
          br: d.br,
          requestedQuality,
          trialInfo: freeTrial,
          restriction: classifyNeteasePlaybackRestriction(d, loginInfo),
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
    url: null,
    trial: false,
    playable: false,
    reason: restriction.category,
    message: restriction.message,
    restriction,
    lastCode: lastData && lastData.code,
    fee: lastData && lastData.fee,
    error: lastError && lastError.message,
    requestedQuality,
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
function normalizeNeteaseVip(profile, account, extra) {
  profile = profile || {};
  account = account || {};
  extra = extra || {};
  const vipInfo = profile.vipInfo || profile.vipinfo || account.vipInfo || account.vipinfo || extra.vipInfo || extra.vipinfo || {};
  const objects = [account, profile, vipInfo, extra];
  const vipType = firstPositiveNumberFrom(objects, [
    'vipType', 'vip_type', 'viptype', 'musicVipType', 'music_vip_type',
    'musicVipLevel', 'music_vip_level', 'redVipLevel', 'red_vip_level',
    'blackVipLevel', 'black_vip_level', 'luxuryVipLevel', 'luxury_vip_level',
    'svipType', 'svip_type',
  ]);
  const text = collectVipStringValues({ account, profile, vipInfo, extra }, [], 0).join(' ').toLowerCase();
  const svipFlag = objects.some(obj => obj && (
    obj.isSvip === true || obj.is_svip === true || obj.svip === true ||
    Number(obj.isSvip || obj.is_svip || obj.svip || obj.svipType || obj.svip_type || 0) > 0
  )) || /svip|supervip|super_vip|blackvip|black_vip|黑胶svip|超级会员/.test(text);
  const vipFlag = objects.some(obj => obj && (
    obj.isVip === true || obj.is_vip === true || obj.vip === true ||
    Number(obj.isVip || obj.is_vip || obj.vip || obj.vipFlag || obj.vipflag || 0) > 0
  )) || /vip|黑胶|会员/.test(text);
  const isSvip = svipFlag || vipType >= 10;
  const isVip = isSvip || vipFlag || vipType > 0;
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
function isNeteaseAuthInvalidPayload(payload) {
  const code = normalizeApiCode(payload);
  if (code === 301 || code === 401) return true;
  const msg = normalizeApiMessage(payload);
  return /未登录|需要登录|请先登录|login/i.test(msg) && code >= 300;
}
async function getLoginInfo() {
  if (!userCookie) return { loggedIn: false, vipType: 0, vipLevel: 'none', isVip: false, isSvip: false, vipLabel: '无VIP' };

  // login_status 对二维码 cookie 的资料刷新通常更及时；失败时再降级到 user_account。
  try {
    const st = await login_status({ cookie: userCookie, timestamp: Date.now() });
    const body = st.body || {};
    const data = body.data || body;
    const info = normalizeLoginInfo(data.profile || body.profile, data.account || body.account, data);
    if (info.loggedIn) return info;
  } catch (e) {
    console.warn('[Login] login_status failed:', e.message);
  }

  try {
    const acc = await user_account({ cookie: userCookie, timestamp: Date.now() });
    const body = acc.body || {};
    const info = normalizeLoginInfo(body.profile, body.account, body);
    if (info.loggedIn) return info;
    if (isNeteaseAuthInvalidPayload(acc)) saveCookie('');
    return { loggedIn: false, hasCookie: !!userCookie, vipType: 0, vipLevel: 'none', isVip: false, isSvip: false, vipLabel: '无VIP' };
  } catch (e) {
    console.warn('[Login] account check failed:', e.message);
    return { loggedIn: false, hasCookie: !!userCookie, vipType: 0, vipLevel: 'none', isVip: false, isSvip: false, vipLabel: '无VIP' };
  }
}

// ====================================================================
//  HTTP Server
// ====================================================================
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:' + PORT);
  const pn = url.pathname;

  if (pn === '/api/wallpaper/list') {
    const wallpapers = scanWallpaperEngineLibrary();
    sendJSON(res, { ok: true, wallpapers, count: wallpapers.length });
    return;
  }

  if (pn === '/api/wallpaper/media') {
    if (!wallpaperMediaIndex.size) scanWallpaperEngineLibrary();
    const id = String(url.searchParams.get('id') || '');
    const kind = url.searchParams.get('kind') === 'media' ? 'media' : 'preview';
    const target = wallpaperMediaIndex.get(id + ':' + kind);
    if (!target) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    try {
      const stat = fs.statSync(target);
      let start = 0;
      let end = stat.size - 1;
      let status = 200;
      const match = /^bytes=(\d*)-(\d*)$/i.exec(req.headers.range || '');
      if (match) {
        start = match[1] ? Math.max(0, Number(match[1])) : 0;
        end = match[2] ? Math.min(end, Number(match[2])) : end;
        status = 206;
      }
      const headers = {
        'Content-Type': MIME[path.extname(target).toLowerCase()] || (kind === 'media' ? 'application/octet-stream' : 'image/jpeg'),
        'Content-Length': String(end - start + 1),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, max-age=3600',
      };
      if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
      res.writeHead(status, headers);
      fs.createReadStream(target, { start, end }).pipe(res);
    } catch (_err) {
      res.writeHead(500);
      res.end('Wallpaper read failed');
    }
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
    streamRegisteredLocalMedia(req, res, target);
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
        const entry = readBeatMapCache(key);
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
        sendJSON(res, writeBeatMapCache(body));
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

  if (pn === '/api/platform-playlist/import') {
    if (req.method !== 'POST') {
      sendJSON(res, { ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);
      return;
    }
    try {
      const body = await readRequestBody(req);
      sendJSON(res, await platformPlaylistImport.importPlaylist(body.input, body.source));
    } catch (err) {
      console.error('[PlatformPlaylistImport]', err);
      sendJSON(res, { ok: false, error: err.message || 'PLAYLIST_IMPORT_FAILED' }, 400);
    }
    return;
  }

  if (pn === '/api/weather/current') {
    try {
      const weather = await fetchOpenMeteoWeather({
        city: url.searchParams.get('city') || url.searchParams.get('q') || '',
        lat: url.searchParams.get('lat'),
        lon: url.searchParams.get('lon'),
        timezone: url.searchParams.get('timezone') || '',
      });
      sendJSON(res, { ok: true, weather });
    } catch (err) {
      console.error('[CurrentWeather]', err);
      sendJSON(res, { ok: false, error: err.message, weather: null }, 500);
    }
    return;
  }

  if (pn === '/api/weather/ip-location') {
    try {
      sendJSON(res, { ok: true, location: await fetchIpWeatherLocation() });
    } catch (err) {
      console.error('[WeatherIpLocation]', err);
      sendJSON(res, { ok: false, error: err.message, location: null }, 500);
    }
    return;
  }

  // ---------- 搜索 ----------
  if (pn === '/api/search') {
    try {
      const kw    = url.searchParams.get('keywords') || '';
      const limit = parseInt(url.searchParams.get('limit') || '20');
      const songs = await handleSearch(kw, limit);
      sendJSON(res, { songs });
    } catch (err) { console.error('[Search]', err); sendJSON(res, { error: err.message, songs: [] }, 500); }
    return;
  }

  if (pn === '/api/kugou/search') {
    try {
      const kw = url.searchParams.get('keywords') || '';
      const limit = Math.max(4, Math.min(30, parseInt(url.searchParams.get('limit') || '12', 10) || 12));
      const songs = await handleKugouSearch(kw, limit);
      sendJSON(res, { provider: 'kugou', songs });
    } catch (err) {
      console.error('[KugouSearch]', err);
      sendJSON(res, { provider: 'kugou', error: err.message, songs: [] }, 500);
    }
    return;
  }

  // ---------- 歌曲URL ----------
  if (pn === '/api/kugou/login/status') {
    try {
      sendJSON(res, await getKugouLoginInfoFresh());
    } catch (err) {
      console.error('[KugouLoginStatus]', err);
      sendJSON(res, { provider: 'kugou', loggedIn: false, error: err.message }, 500);
    }
    return;
  }

  if (pn === '/api/kugou/login/qr/key') {
    try {
      const data = await handleKugouLoginQrKey();
      sendJSON(res, data);
    } catch (err) {
      console.error('[KugouLoginQrKey]', err);
      sendJSON(res, { provider: 'kugou', error: err.message, loggedIn: false }, 500);
    }
    return;
  }

  if (pn === '/api/kugou/login/qr/check') {
    try {
      const key = url.searchParams.get('key') || url.searchParams.get('qrcode') || '';
      const data = await handleKugouLoginQrCheck(key);
      sendJSON(res, data);
    } catch (err) {
      console.error('[KugouLoginQrCheck]', err);
      sendJSON(res, { provider: 'kugou', error: err.message, loggedIn: false, code: 500 }, 500);
    }
    return;
  }

  if (pn === '/api/kugou/login/cookie') {
    try {
      const body = await readRequestBody(req);
      const raw = body.cookie || body.data || body.text || '';
      const normalized = normalizeKugouCookieInput(raw);
      if (!normalized) {
        sendJSON(res, { provider: 'kugou', loggedIn: false, error: 'INVALID_KUGOU_COOKIE', message: '小狗 cookie 为空' }, 400);
        return;
      }
      saveKugouCookie(normalized);
      const info = await getKugouLoginInfoFresh();
      if (!info.loggedIn) {
        saveKugouCookie('');
        sendJSON(res, {
          provider: 'kugou',
          loggedIn: false,
          error: 'KUGOU_LOGIN_REQUIRED',
          message: '小狗登录未完成，请扫码或输入账号后再同步',
        }, 400);
        return;
      }
      sendJSON(res, { ...info, saved: true });
    } catch (err) {
      console.error('[KugouLoginCookie]', err);
      sendJSON(res, { provider: 'kugou', loggedIn: false, error: err.message }, 500);
    }
    return;
  }

  if (pn === '/api/kugou/logout') {
    saveKugouCookie('');
    sendJSON(res, { provider: 'kugou', ok: true, loggedIn: false });
    return;
  }

  if (pn === '/api/kugou/user/playlists') {
    try {
      const data = await handleKugouUserPlaylists();
      sendJSON(res, data);
    } catch (err) {
      console.error('[KugouUserPlaylists]', err);
      sendJSON(res, { provider: 'kugou', loggedIn: false, error: err.message, playlists: [] }, 500);
    }
    return;
  }

  if (pn === '/api/kugou/playlist/tracks') {
    try {
      const id = url.searchParams.get('id') || url.searchParams.get('listid') || '';
      const data = await handleKugouPlaylistTracks(id);
      sendJSON(res, data);
    } catch (err) {
      console.error('[KugouPlaylistTracks]', err);
      sendJSON(res, { provider: 'kugou', error: err.message, tracks: [] }, 500);
    }
    return;
  }

  if (pn === '/api/kugou/song/url') {
    try {
      const hash = url.searchParams.get('hash') || url.searchParams.get('id') || '';
      const albumAudioId = url.searchParams.get('albumAudioId') || url.searchParams.get('album_audio_id') || '';
      const albumId = url.searchParams.get('albumId') || url.searchParams.get('album_id') || '';
      const quality = url.searchParams.get('quality') || '';
      let qualityHashes = null;
      try {
        const rawQualityHashes = url.searchParams.get('qualityHashes') || '';
        qualityHashes = rawQualityHashes ? JSON.parse(rawQualityHashes) : null;
      } catch (_) {
        qualityHashes = null;
      }
      const data = await handleKugouSongUrl(hash, albumAudioId, albumId, quality, qualityHashes);
      sendJSON(res, data);
    } catch (err) {
      console.error('[KugouSongUrl]', err);
      sendJSON(res, { provider: 'kugou', url: '', playable: false, error: err.message }, 500);
    }
    return;
  }

  if (pn === '/api/kugou/listen/upload') {
    try {
      const body = req.method === 'POST' ? await readRequestBody(req) : {};
      const mxid = body.mxid || body.albumAudioId || body.album_audio_id || url.searchParams.get('mxid') || url.searchParams.get('albumAudioId') || url.searchParams.get('album_audio_id') || '';
      const playedAt = body.ot || body.playedAt || url.searchParams.get('ot') || url.searchParams.get('playedAt') || Math.floor(Date.now() / 1000);
      const data = await handleKugouListenUpload(mxid, playedAt, 1);
      sendJSON(res, data, data && data.loggedIn === false ? 401 : 200);
    } catch (err) {
      console.error('[KugouListenUpload]', err);
      sendJSON(res, { provider: 'kugou', error: err.message }, 500);
    }
    return;
  }

  if (pn === '/api/kugou/listen/history') {
    try {
      const data = await handleKugouListenHistory();
      sendJSON(res, data && data.loggedIn === false ? data : normalizeKugouListenHistory(data), data && data.loggedIn === false ? 401 : 200);
    } catch (err) {
      console.error('[KugouListenHistory]', err);
      sendJSON(res, { provider: 'kugou', error: err.message }, 500);
    }
    return;
  }

  if (pn === '/api/kugou/lyric') {
    try {
      const hash = url.searchParams.get('hash') || url.searchParams.get('id') || '';
      const duration = url.searchParams.get('duration') || url.searchParams.get('timelength') || '';
      const data = await handleKugouLyric(hash, duration);
      sendJSON(res, data);
    } catch (err) {
      console.error('[KugouLyric]', err);
      sendJSON(res, { provider: 'kugou', error: err.message, lyric: '' }, 500);
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
      const limit = parseInt(url.searchParams.get('limit') || '36', 10) || 36;
      const offset = parseInt(url.searchParams.get('offset') || '0', 10) || 0;
      const data = await fetchMyPodcastItems(key, info, limit, offset);
      sendJSON(res, { loggedIn: true, key, ...podcastCollectionMeta(key, data.items || []), itemType: data.itemType, items: data.items || [] });
    } catch (err) {
      console.error('[MyPodcastItems]', err);
      sendJSON(res, { error: err.message, items: [] }, 500);
    }
    return;
  }

  if (pn === '/api/song/url') {
    try {
      const sid = url.searchParams.get('id');
      const quality = url.searchParams.get('quality') || '';
      const loginInfo = await getLoginInfo();
      const info = await handleSongUrl(sid, loginInfo, quality);
      sendJSON(res, {
        ...info,
        loggedIn: loginInfo.loggedIn,
        vipType: loginInfo.vipType || 0,
        vipLevel: loginInfo.vipLevel || 'none',
        isVip: !!loginInfo.isVip,
        isSvip: !!loginInfo.isSvip,
        vipLabel: loginInfo.vipLabel || '无VIP',
      });
    } catch (err) { console.error('[SongUrl]', err); sendJSON(res, { error: err.message }, 500); }
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
          info = normalizeLoginInfo(profile, body.account || (body.data && body.data.account), body.data || body);
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

  // ---------- 网易云听歌排行上报 ----------
  if (pn === '/api/listen/scrobble') {
    try {
      const info = await requireLogin(res);
      if (!info) return;
      const body = req.method === 'POST' ? await readRequestBody(req) : {};
      const id = String(body.id || url.searchParams.get('id') || '').trim();
      const sourceid = String(body.sourceid || body.sourceId || url.searchParams.get('sourceid') || url.searchParams.get('sourceId') || id).trim();
      const time = Math.max(1, Math.min(24 * 60 * 60, Math.round(Number(body.time || url.searchParams.get('time')) || 0)));
      if (!id || !/^\d+$/.test(id)) { sendJSON(res, { error: 'Missing song id' }, 400); return; }
      if (!time) { sendJSON(res, { error: 'Missing listen time' }, 400); return; }
      const r = await scrobble({ id, sourceid: sourceid || id, time, cookie: userCookie, timestamp: Date.now() });
      const code = normalizeApiCode(r);
      const bodyOut = r.body || r;
      sendJSON(res, { loggedIn: true, success: code === 200, id, sourceid: sourceid || id, time, code, body: bodyOut }, code === 401 ? 401 : 200);
    } catch (err) {
      console.error('[Scrobble]', err);
      sendJSON(res, { error: err.message }, 500);
    }
    return;
  }

  // ---------- 网易云听歌排行 ----------
  if (pn === '/api/listen/ranking') {
    try {
      const info = await requireLogin(res);
      if (!info) return;
      const type = String(url.searchParams.get('type') || 'week') === 'all' ? 0 : 1;
      const r = await user_record({ uid: info.userId, type, cookie: userCookie, timestamp: Date.now() });
      const body = r.body || r;
      const rows = (type === 0 ? body.allData : body.weekData) || [];
      const songs = rows.map((item, index) => ({
        ...mapSongRecord(item.song || {}),
        rank: index + 1,
        playCount: Number(item.playCount) || 0,
        score: Number(item.score) || 0,
      })).filter(item => item.id);
      sendJSON(res, { loggedIn: true, type: type === 0 ? 'all' : 'week', songs, code: normalizeApiCode(r) || 200 });
    } catch (err) {
      console.error('[ListenRanking]', err);
      sendJSON(res, { error: err.message }, 500);
    }
    return;
  }

  // ---------- 用户歌单 ----------
  if (pn === '/api/user/playlists') {
    try {
      const info = await getLoginInfo();
      if (!info.loggedIn || !info.userId) { sendJSON(res, { loggedIn: false, playlists: [] }); return; }
      const limit = Math.max(12, Math.min(100, parseInt(url.searchParams.get('limit') || '60', 10) || 60));
      const r = await user_playlist({ uid: info.userId, limit, cookie: userCookie, timestamp: Date.now() });
      const list = ((r.body && r.body.playlist) || []).map(pl => ({
        id: pl.id,
        name: pl.name,
        cover: pl.coverImgUrl || '',
        trackCount: pl.trackCount || 0,
        playCount: pl.playCount || 0,
        creator: (pl.creator && pl.creator.nickname) || '',
        subscribed: !!pl.subscribed,
        specialType: pl.specialType || 0,
      }));
      sendJSON(res, { loggedIn: true, userId: info.userId, playlists: list });
    } catch (err) {
      console.error('[UserPlaylists]', err);
      sendJSON(res, { error: err.message, loggedIn: false, playlists: [] }, 500);
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
      sendJSON(res, { loggedIn: true, pid, id, success: true, code: finalCode, body: finalBody, attempts });
    } catch (err) {
      console.error('[PlaylistAddSong]', err);
      sendJSON(res, { error: err.message }, 500);
    }
    return;
  }

  // ---------- 歌词 ----------
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
      if (!((body.lrc && body.lrc.lyric) || (body.yrc && body.yrc.lyric))) {
        const r = await lyric({ id, cookie: userCookie, timestamp: Date.now() });
        body = r.body || body || {};
        source = 'lyric';
      }
      sendJSON(res, {
        lyric: (body.lrc && body.lrc.lyric) || '',
        tlyric: (body.tlyric && body.tlyric.lyric) || '',
        yrc: (body.yrc && body.yrc.lyric) || '',
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
      const id = url.searchParams.get('id');
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

      let playlistMeta = { id, name: '', cover: '', trackCount: 0 };
      let rawTracks = [];

      // 新版本 NeteaseCloudMusicApi 通常提供 playlist_track_all；旧版本退回 playlist_detail。
      if (typeof playlist_track_all === 'function') {
        try {
          const all = await playlist_track_all({ id, limit: 500, offset: 0, cookie: userCookie, timestamp: Date.now() });
          rawTracks = (all.body && (all.body.songs || all.body.tracks)) || [];
        } catch (err) {
          console.warn('[PlaylistTracks] playlist_track_all failed, fallback to detail:', err.message);
        }
      }

      if (!rawTracks.length && typeof playlist_detail === 'function') {
        const detail = await playlist_detail({ id, s: 0, cookie: userCookie, timestamp: Date.now() });
        const pl = (detail.body && detail.body.playlist) || {};
        playlistMeta = { id: pl.id || id, name: pl.name || '', cover: pl.coverImgUrl || '', trackCount: pl.trackCount || 0 };
        rawTracks = pl.tracks || [];
      }

      const tracks = rawTracks.map(mapSongRecord).filter(t => t.id);

      if (!playlistMeta.trackCount) playlistMeta.trackCount = tracks.length;
      sendJSON(res, { playlist: playlistMeta, tracks });
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
      const quality = body.quality || 'hires';
      const playlistName = body.playlistName || '';
      const batchId = 'batch-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
      const jobs = songs.map(song => enqueueMusicDownload(song, { quality, playlistName, batchId }));
      sendJSON(res, { ok: true, batchId, jobs: jobs.map(publicMusicJob), dir: getMusicDownloadDir() });
    } catch (err) {
      console.error('[MusicDownload]', err);
      sendJSON(res, { ok: false, error: err.message || 'DOWNLOAD_START_FAILED' }, 500);
    }
    return;
  }

  if (pn === '/api/download/status') {
    const batchId = url.searchParams.get('batch') || '';
    const jobId = url.searchParams.get('id') || '';
    if (jobId) {
      const job = musicDownloadJobs.get(jobId);
      sendJSON(res, job ? publicMusicJob(job) : { error: 'NOT_FOUND' }, job ? 200 : 404);
    } else if (batchId) {
      const jobs = [];
      for (const job of musicDownloadJobs.values()) {
        if (job.batchId === batchId) jobs.push(publicMusicJob(job));
      }
      sendJSON(res, { batchId, jobs, dir: getMusicDownloadDir() });
    } else {
      const jobs = [];
      for (const job of musicDownloadJobs.values()) jobs.push(publicMusicJob(job));
      sendJSON(res, { jobs: jobs.slice(-100), dir: getMusicDownloadDir() });
    }
    return;
  }

  if (pn === '/api/download/cancel') {
    try {
      const body = req.method === 'POST' ? await readRequestBody(req) : {};
      const id = body.id || url.searchParams.get('id') || '';
      const batchId = body.batchId || body.batch || '';
      let cancelled = 0;
      if (id) {
        const job = musicDownloadJobs.get(id);
        if (job && (job.status === 'queued' || job.status === 'resolving')) {
          job.status = 'cancelled'; job.message = '已取消'; job.updatedAt = Date.now(); cancelled++;
        }
      } else if (batchId) {
        for (const job of musicDownloadJobs.values()) {
          if (job.batchId === batchId && (job.status === 'queued' || job.status === 'resolving')) {
            job.status = 'cancelled'; job.message = '已取消'; job.updatedAt = Date.now(); cancelled++;
          }
        }
      }
      sendJSON(res, { ok: true, cancelled });
    } catch (err) { sendJSON(res, { ok: false, error: err.message }, 500); }
    return;
  }

  if (pn === '/api/download/dir') {
    sendJSON(res, { dir: getMusicDownloadDir() });
    return;
  }

  // ---------- 音频代理 (支持 Range) ----------
  if (pn === '/api/audio') {
    const controller = new AbortController();
    let streamTimer = null;
    let clientClosed = false;
    const clearStreamTimeout = () => {
      if (streamTimer) clearTimeout(streamTimer);
      streamTimer = null;
    };
    // Only time out while actively waiting on the upstream body.
    // Waiting for browser drain is normal backpressure and must not abort
    // an otherwise healthy media stream.
    const armStreamTimeout = (ms = 45000) => {
      clearStreamTimeout();
      streamTimer = setTimeout(() => {
        if (!controller.signal.aborted) controller.abort(new Error('Audio upstream timeout'));
      }, ms);
    };
    const stopAudioProxy = () => {
      clientClosed = true;
      clearStreamTimeout();
      if (!controller.signal.aborted) controller.abort();
    };
    res.once('close', stopAudioProxy);
    try {
      const audioUrl = url.searchParams.get('url');
      if (!audioUrl) { res.writeHead(400); res.end('Missing url'); return; }
      const range = req.headers.range || '';
      const hdr = audioProxyHeadersFor(audioUrl, range);
      armStreamTimeout(20000);
      const up = await fetch(audioUrl, { headers: hdr, signal: controller.signal });
      if (!up.ok && up.status !== 206) throw new Error('Audio upstream HTTP ' + up.status);
      const out = {
        'Content-Type': audioContentTypeForUrl(audioUrl, up.headers.get('content-type')),
        'Access-Control-Allow-Origin': '*',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      };
      // Do not forward the upstream Content-Length while streaming. If the
      // provider closes early, Chromium permanently poisons the media element
      // with ERR_CONTENT_LENGTH_MISMATCH before the player can recover.
      const cr = up.headers.get('content-range');  if (cr) out['Content-Range']  = cr;
      res.writeHead(up.status, out);
      const reader = up.body.getReader();
      while (true) {
        if (clientClosed || res.writableEnded || res.destroyed) break;
        armStreamTimeout();
        const c = await reader.read();
        if (c.done) break;
        clearStreamTimeout();
        if (!res.write(c.value)) {
          await new Promise(resolve => {
            const done = () => {
              res.off('drain', done);
              res.off('close', done);
              resolve();
            };
            res.once('drain', done);
            res.once('close', done);
          });
          if (clientClosed || res.writableEnded || res.destroyed) break;
        }
      }
      clearStreamTimeout();
      if (!res.writableEnded && !res.destroyed) res.end();
    } catch (err) {
      clearStreamTimeout();
      if (!clientClosed) console.error('[Audio]', err);
      if (!res.headersSent) { res.writeHead(502); res.end(); }
      else if (!res.destroyed) res.destroy(err);
    }
    return;
  }

  // ---------- 静态资源 ----------
  if (pn === '/favicon.ico') {
    serveStatic(res, path.join(__dirname, 'build', 'icon.ico'));
    return;
  }

  let filePath = pn === '/' ? '/index.html' : pn;
  filePath = path.join(__dirname, 'public', filePath);
  serveStatic(res, filePath);
});

server.listen(PORT, HOST, () => {
  console.log('======================================================');
  console.log(' 粒子音乐可视化 v2  →  http://localhost:' + PORT);
  console.log(' 登录态: ' + (userCookie ? '已登录(cookie已加载)' : '未登录'));
  console.log('======================================================');
});

module.exports = server;
server.registerLocalMediaPath = registerLocalMediaPath;
