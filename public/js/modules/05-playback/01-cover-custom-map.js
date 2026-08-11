function isTypingTarget(target) {
  if (!target) return false;
  var tag = String(target.tagName || '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return !!(target.isContentEditable || (target.closest && target.closest('[contenteditable="true"]')));
}
function readCustomCoverMap() {
  try {
    var raw = localStorage.getItem(CUSTOM_COVER_STORE_KEY);
    var parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    return {};
  }
}
var customCoverHydrationPromise = null;
function hydrateCustomCoverMapFromDisk() {
  if (customCoverHydrationPromise) return customCoverHydrationPromise;
  if (!window.desktopWindow || typeof window.desktopWindow.getCustomCovers !== 'function') return Promise.resolve(customCoverMap || {});
  customCoverHydrationPromise = window.desktopWindow.getCustomCovers().then(function (result) {
    if (!result || !result.ok || !result.payload || typeof result.payload !== 'object') return customCoverMap || {};
    customCoverMap = Object.assign({}, result.payload, customCoverMap || {});
    try { localStorage.setItem(CUSTOM_COVER_STORE_KEY, JSON.stringify(customCoverMap)); } catch (e) { }
    (Array.isArray(playQueue) ? playQueue : []).forEach(hydrateCustomCover);
    (Array.isArray(localLibrarySongs) ? localLibrarySongs : []).forEach(hydrateCustomCover);
    if (currentLocalSong) hydrateCustomCover(currentLocalSong);
    if (typeof safeRenderQueuePanel === 'function') safeRenderQueuePanel('custom-cover-restore');
    if (typeof renderLocalLibraryDetailState === 'function') renderLocalLibraryDetailState();
    if (typeof window.desktopWindow.setCustomCovers === 'function') {
      window.desktopWindow.setCustomCovers(customCoverMap).catch(function () { });
    }
    return customCoverMap;
  }).catch(function (error) {
    console.warn('custom cover restore failed:', error);
    return customCoverMap || {};
  });
  return customCoverHydrationPromise;
}
function saveCustomCoverMap() {
  var saved = false;
  try {
    localStorage.setItem(CUSTOM_COVER_STORE_KEY, JSON.stringify(customCoverMap || {}));
    saved = true;
  } catch (e) {
    console.warn('custom cover save failed:', e);
  }
  if (window.desktopWindow && typeof window.desktopWindow.setCustomCovers === 'function') {
    window.desktopWindow.setCustomCovers(customCoverMap || {}).catch(function (error) {
      console.warn('custom cover disk save failed:', error);
    });
    saved = true;
  }
  return saved;
}
hydrateCustomCoverMapFromDisk();
function isInlineCoverSrc(src) {
  return typeof src === 'string' && (/^data:image\//i.test(src) || /^blob:/i.test(src));
}
function isProxyableCoverUrl(url) {
  return /^https?:\/\//i.test(String(url || ''));
}
// 各家搜索结果里 pic/al.pic 这类字段有时是纯数字图片 ID 而不是地址（网易就是这样，
// 酷狗的 pic 才是真地址）。数字 ID 一旦当成 src，浏览器会按相对路径解析成
// http://localhost:3000/109951168971888100，刷一屏 404。封面链路统一在这里收口：
// 不是内联图、不是 http(s)、也不带路径分隔符的值，一律当没有封面。
function isUsableCoverSrc(src) {
  var value = String(src == null ? '' : src).trim();
  if (!value) return false;
  if (isInlineCoverSrc(value) || isProxyableCoverUrl(value)) return true;
  return value.indexOf('/') >= 0 || value.indexOf('\\') >= 0;
}
// 不能用 `a || b || c`：坏值也是真值，会挡住后面本来能用的字段。
function firstUsableCoverSrc(values) {
  for (var i = 0; i < (values || []).length; i++) {
    if (isUsableCoverSrc(values[i])) return String(values[i]).trim();
  }
  return '';
}
function coverProxySrc(url, cacheBust) {
  if (!url) return '';
  if (isInlineCoverSrc(url)) return url;
  if (!isProxyableCoverUrl(url)) return '';
  return '/api/cover?url=' + encodeURIComponent(url) + (cacheBust ? '&v=' + Date.now() : '');
}
function coverUrlWithSize(url, size) {
  if (url && !isUsableCoverSrc(url)) return '';
  if (!url || isInlineCoverSrc(url) || !/^https?:\/\//i.test(url)) return url || '';
  if (!size) return url;
  var param = 'param=' + size + 'y' + size;
  if (/[?&]param=\d+y\d+/i.test(url)) return url.replace(/([?&])param=\d+y\d+/i, '$1' + param);
  return url + (url.indexOf('?') >= 0 ? '&' : '?') + param;
}
function songCustomCoverKey(song) {
  if (!song) return '';
  if (song.customCoverKey) return String(song.customCoverKey);
  if (song.provider === 'qq' || song.source === 'qq' || song.type === 'qq') return 'qq:' + (song.mid || song.songmid || song.id || (song.name + '|' + song.artist));
  if (song.provider === 'kugou' || song.source === 'kugou' || song.type === 'kugou' || song.hash || song.audioHash) return 'kugou:' + (song.hash || song.fileHash || song.audioHash || song.id || (song.name + '|' + song.artist));
  if (song.cloudSong || song.cloudSource === 'netease-cloud') return 'netease-cloud:' + (song.cloudId || song.id || (song.name + '|' + song.artist));
  if (song.localKey) return 'local:' + song.localKey;
  if (song.type === 'podcast' && song.programId) return 'podcast:' + song.programId;
  if (song.id != null && song.id !== '') return 'id:' + song.id;
  var title = String(song.name || song.title || '').trim();
  var artist = String(song.artist || '').trim();
  return (title || artist) ? ('meta:' + (title + '|' + artist).slice(0, 220)) : '';
}
function getCustomCoverForSong(song) {
  if (!song) return '';
  if (song.customCover) return song.customCover;
  var key = songCustomCoverKey(song);
  return key && customCoverMap[key] ? customCoverMap[key] : '';
}
function clearCustomCoverForSong(song) {
  if (!song) return false;
  var key = songCustomCoverKey(song);
  var hadCover = !!(song.customCover || (key && customCoverMap[key]));
  if (key && customCoverMap[key]) {
    delete customCoverMap[key];
    saveCustomCoverMap();
  }
  // 同一首歌可能同时躺在队列、内存库和文件夹列表里，重复清理无害，不必去重。
  function clearTarget(target) {
    if (!target) return;
    if (target === song || (key && songCustomCoverKey(target) === key)) delete target.customCover;
  }
  clearTarget(song);
  (Array.isArray(playQueue) ? playQueue : []).forEach(clearTarget);
  (Array.isArray(localLibrarySongs) ? localLibrarySongs : []).forEach(clearTarget);
  (Array.isArray(localFolderPlaylists) ? localFolderPlaylists : []).forEach(function (folder) {
    (folder && Array.isArray(folder.songs) ? folder.songs : []).forEach(clearTarget);
  });
  clearTarget(currentLocalSong);
  return hadCover;
}
function hydrateCustomCover(song) {
  if (!song) return song;
  var custom = getCustomCoverForSong(song);
  if (custom) song.customCover = custom;
  return song;
}
function songCoverSrc(song, size) {
  var custom = getCustomCoverForSong(song);
  if (custom) return custom;
  if (song && (song.type === 'local' || song.source === 'local' || song.localKey) && typeof localLibraryCover === 'function') {
    var localCover = localLibraryCover(song);
    if (localCover) return coverUrlWithSize(localCover, size);
  }
  if (song && (song.cloudSong || song.cloudSource === 'netease-cloud')
    && typeof cloudLyricRematchCoverForSong === 'function') {
    var rematchedCover = cloudLyricRematchCoverForSong(song);
    if (rematchedCover) return coverUrlWithSize(rematchedCover, size);
    var cloudRematch = typeof cloudLyricRematchForSong === 'function' ? cloudLyricRematchForSong(song) : null;
    if (cloudRematch && typeof cloudLyricRematchOriginalCoverForSong === 'function') {
      var originalCloudCover = cloudLyricRematchOriginalCoverForSong(song);
      if (Object.prototype.hasOwnProperty.call(cloudRematch, 'originalCover')) {
        if (originalCloudCover) return coverUrlWithSize(originalCloudCover, size);
      }
    }
  }
  // 逐个字段筛可用值：坏值（纯数字图片 ID）也是真值，用 `||` 会挡住后面能用的字段。
  var cover = song ? firstUsableCoverSrc([
    song.cover, song.picUrl, song.albumCover, song.coverUrl, song.albumPicUrl
  ]) : '';
  return cover ? coverUrlWithSize(cover, size) : '';
}
function cssImageUrl(url) {
  return String(url || '').replace(/\\/g, '\\\\').replace(/"/g, '%22');
}
function setHomeArt(id, url, size) {
  var el = document.getElementById(id);
  if (!el) return;
  var src = url ? coverUrlWithSize(url, size || 260) : '';
  el.style.backgroundImage = src ? 'url("' + cssImageUrl(src) + '")' : '';
  el.classList.toggle('has-cover', !!src);
  el.classList.toggle('home-skeleton', !src && homeDiscoverState.loading);
}
function compactHomeCount(n) {
  n = Number(n) || 0;
  if (n >= 100000000) return (n / 100000000).toFixed(1).replace(/\.0$/, '') + '亿';
  if (n >= 10000) return Math.round(n / 10000) + '万';
  return n ? String(n) : '';
}
