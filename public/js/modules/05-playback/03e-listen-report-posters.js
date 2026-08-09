'use strict';

function listenReportPosterImageSrc(value, size) {
  var source = String(value || '').trim();
  if (!source) return '';
  try {
    if (typeof coverUrlWithSize === 'function') source = coverUrlWithSize(source, size || 900);
    if (typeof coverProxySrc === 'function') return coverProxySrc(source) || source;
  } catch (_) { }
  return source;
}

function listenReportLoadPosterImage(value, size) {
  var source = listenReportPosterImageSrc(value, size);
  if (!source || typeof Image !== 'function') return Promise.resolve(null);
  return new Promise(function (resolve) {
    var settled = false;
    var image = new Image();
    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      image.onload = null;
      image.onerror = null;
      resolve(null);
    }, 6000);
    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    }
    image.decoding = 'async';
    image.onload = function () { finish(image); };
    image.onerror = function () { finish(null); };
    image.src = source;
  });
}

function listenReportPosterAssetKey(report) {
  var songs = (report.songs || []).slice(0, 10).map(function (item) {
    return [item.key, item.cover, item.localKey, item.localPath].join(':');
  }).join('|');
  var artists = (report.artists || []).slice(0, 5).map(function (item) {
    return [item.name, item.id, item.mid, item.avatar].join(':');
  }).join('|');
  return [report.mode, report.period, songs, artists].join('::');
}

function listenReportNormalizeArtistName(value) {
  return String(value || '').trim().toLocaleLowerCase()
    .replace(/[\s·・,，、/\\|&＋+_-]+/g, '')
    .replace(/[()（）\[\]【】"'“”‘’]/g, '');
}

function listenReportArtistNamesMatch(expected, actual) {
  var left = listenReportNormalizeArtistName(expected);
  var right = listenReportNormalizeArtistName(actual);
  return !!left && left === right;
}

function listenReportArtistRefFromSongs(item, report) {
  var name = item && item.name || '';
  var songs = report && Array.isArray(report.songs) ? report.songs : [];
  for (var songIndex = 0; songIndex < songs.length; songIndex++) {
    var song = songs[songIndex] || {};
    var refs = Array.isArray(song.artistRefs) ? song.artistRefs : [];
    for (var refIndex = 0; refIndex < refs.length; refIndex++) {
      var ref = refs[refIndex] || {};
      if (listenReportArtistNamesMatch(name, ref.name)) {
        return {
          name: ref.name || name,
          id: ref.id || '',
          mid: ref.mid || '',
          provider: ref.provider || song.provider || '',
          avatar: ref.avatar || '',
        };
      }
    }
    var names = String(song.artist || '').split(/\s*\/\s*|\s*,\s*|、|&/);
    if (names.some(function (candidate) { return listenReportArtistNamesMatch(name, candidate); })) {
      return { name: name, id: '', mid: '', provider: song.provider || '', avatar: '' };
    }
  }
  return null;
}

function listenReportArtistRefFromSearch(result, name, provider) {
  var songs = result && Array.isArray(result.songs) ? result.songs : [];
  for (var songIndex = 0; songIndex < songs.length; songIndex++) {
    var song = songs[songIndex] || {};
    var refs = Array.isArray(song.artists) ? song.artists : [];
    for (var refIndex = 0; refIndex < refs.length; refIndex++) {
      var ref = refs[refIndex] || {};
      if (!listenReportArtistNamesMatch(name, ref.name)) continue;
      return {
        name: ref.name || name,
        id: ref.id || song.artistId || '',
        mid: ref.mid || song.artistMid || '',
        provider: provider,
        avatar: ref.avatar || ref.cover || ref.picUrl || ref.img1v1Url || '',
      };
    }
    if (listenReportArtistNamesMatch(name, String(song.artist || '').split(/\s*\/\s*|\s*,\s*|、|&/)[0])) {
      return {
        name: name,
        id: song.artistId || '',
        mid: song.artistMid || song.singerMid || '',
        provider: provider,
        avatar: '',
      };
    }
  }
  return null;
}

async function listenReportSearchArtistRef(name, preferredProvider) {
  if (typeof apiJson !== 'function' || !name) return null;
  var providers = /qq|小q/.test(String(preferredProvider || '').toLowerCase()) ? ['qq', 'netease'] : ['netease', 'qq'];
  for (var index = 0; index < providers.length; index++) {
    var provider = providers[index];
    var endpoint = provider === 'qq'
      ? '/api/qq/search?keywords=' + encodeURIComponent(name) + '&limit=8'
      : '/api/search?keywords=' + encodeURIComponent(name) + '&limit=10';
    try {
      var result = await apiJson(endpoint, { timeoutMs: 5000 });
      var ref = listenReportArtistRefFromSearch(result, name, provider);
      if (ref && (ref.id || ref.mid || ref.avatar)) return ref;
    } catch (_) { }
  }
  return null;
}

async function listenReportResolveArtistAvatar(item, report) {
  item = item || {};
  if (item.avatar) return item.avatar;
  var related = listenReportArtistRefFromSongs(item, report) || {};
  var provider = String(item.provider || related.provider || '').toLowerCase();
  var id = String(item.id || related.id || '').trim();
  var mid = String(item.mid || related.mid || '').trim();
  if (related.avatar) return related.avatar;
  var cacheKey = [provider, id, mid, item.name || ''].join(':');
  var cache = listenReportViewState.artistAvatarCache || (listenReportViewState.artistAvatarCache = {});
  var failureCache = listenReportViewState.artistAvatarFailureCache || (listenReportViewState.artistAvatarFailureCache = {});
  if (cache[cacheKey]) return cache[cacheKey];
  if (Object.prototype.hasOwnProperty.call(cache, cacheKey)) delete cache[cacheKey];
  if (Math.max(0, Number(failureCache[cacheKey]) || 0) > Date.now()) return '';
  if (!id && !mid) {
    var searched = await listenReportSearchArtistRef(item.name, provider);
    if (searched) {
      provider = String(searched.provider || provider).toLowerCase();
      id = String(searched.id || '').trim();
      mid = String(searched.mid || '').trim();
      if (searched.avatar) {
        cache[cacheKey] = searched.avatar;
        delete failureCache[cacheKey];
        return searched.avatar;
      }
    }
  }
  var endpoint = '';
  if (mid && /qq|小q/.test(provider)) endpoint = '/api/qq/artist/detail?mid=' + encodeURIComponent(mid) + '&limit=10';
  else if (id && (/netease|cloud|网易|小云/.test(provider) || /^\d+$/.test(id))) endpoint = '/api/artist/detail?id=' + encodeURIComponent(id) + '&limit=10';
  if (!endpoint || typeof apiJson !== 'function') {
    failureCache[cacheKey] = Date.now() + 30000;
    return '';
  }
  try {
    var result = await apiJson(endpoint, { timeoutMs: 5000 });
    var returnedArtist = result && result.artist || {};
    var avatar = !returnedArtist.name || listenReportArtistNamesMatch(item.name, returnedArtist.name)
      ? returnedArtist.avatar || ''
      : '';
    if (avatar) {
      cache[cacheKey] = String(avatar);
      delete failureCache[cacheKey];
      return cache[cacheKey];
    }
    failureCache[cacheKey] = Date.now() + 30000;
    return '';
  } catch (_) {
    failureCache[cacheKey] = Date.now() + 30000;
    return '';
  }
}

async function hydrateListenReportArtistImages(rows, report) {
  await Promise.all((Array.isArray(rows) ? rows : []).map(async function (entry) {
    if (!entry || !entry.art || !entry.item) return;
    var avatar = await listenReportResolveArtistAvatar(entry.item, report);
    if (!avatar || !entry.art.isConnected) return;
    var image = document.createElement('img');
    image.alt = '';
    image.loading = 'lazy';
    image.decoding = 'async';
    image.addEventListener('load', function () {
      if (entry.art.isConnected) {
        entry.art.replaceChildren(image);
        entry.art.classList.add('has-image');
      }
    }, { once: true });
    image.addEventListener('error', function () { image.remove(); }, { once: true });
    image.src = listenReportPosterImageSrc(avatar, 240);
    entry.art.appendChild(image);
  }));
}

async function prepareListenReportPosterAssets(report) {
  var assetKey = listenReportPosterAssetKey(report);
  if (listenReportViewState.previewAssets && listenReportViewState.previewAssetKey === assetKey) {
    return listenReportViewState.previewAssets;
  }
  var songItems = (report.songs || []).slice(0, 10);
  var artistItems = (report.artists || []).slice(0, 5);
  var songImages = await Promise.all(songItems.map(function (item) {
    return listenReportLoadPosterImage(listenReportCover(item), 1000);
  }));
  var artistImages = await Promise.all(artistItems.map(async function (item, index) {
    var avatar = await listenReportResolveArtistAvatar(item, report);
    var image = avatar ? await listenReportLoadPosterImage(avatar, 1000) : null;
    if (image) return image;
    return null;
  }));
  var assets = { songImages: songImages, artistImages: artistImages };
  listenReportViewState.previewAssetKey = assetKey;
  listenReportViewState.previewAssets = assets;
  return assets;
}

function listenReportPosterDrawImage(ctx, image, x, y, width, height) {
  if (!image) return false;
  var sourceWidth = Number(image.naturalWidth || image.width) || 1;
  var sourceHeight = Number(image.naturalHeight || image.height) || 1;
  var sourceRatio = sourceWidth / sourceHeight;
  var targetRatio = width / height;
  var sx = 0;
  var sy = 0;
  var sw = sourceWidth;
  var sh = sourceHeight;
  if (sourceRatio > targetRatio) {
    sw = sourceHeight * targetRatio;
    sx = (sourceWidth - sw) / 2;
  } else {
    sh = sourceWidth / targetRatio;
    sy = (sourceHeight - sh) / 2;
  }
  ctx.drawImage(image, sx, sy, sw, sh, x, y, width, height);
  return true;
}

function listenReportPosterPlaceholder(ctx, x, y, width, height, index) {
  var palettes = [
    ['#ff5f57', '#7d2743'],
    ['#d8ff46', '#315f55'],
    ['#73a7ff', '#42346c'],
    ['#ff9d4d', '#6b3246'],
    ['#75eed6', '#153e50'],
  ];
  var colors = palettes[index % palettes.length];
  var gradient = ctx.createLinearGradient(x, y, x + width, y + height);
  gradient.addColorStop(0, colors[0]);
  gradient.addColorStop(1, colors[1]);
  ctx.fillStyle = gradient;
  ctx.fillRect(x, y, width, height);
}

function listenReportPosterDrawTile(ctx, image, item, rank, kind, x, y, width, height, options) {
  options = options || {};
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, width, height);
  ctx.clip();
  if (!listenReportPosterDrawImage(ctx, image, x, y, width, height)) {
    listenReportPosterPlaceholder(ctx, x, y, width, height, rank - 1);
  }
  var shade = ctx.createLinearGradient(x, y, x, y + height);
  shade.addColorStop(0, options.topShade || 'rgba(0,0,0,.04)');
  shade.addColorStop(.48, 'rgba(0,0,0,.03)');
  shade.addColorStop(1, options.bottomShade || 'rgba(0,0,0,.82)');
  ctx.fillStyle = shade;
  ctx.fillRect(x, y, width, height);
  ctx.restore();
  ctx.strokeStyle = options.stroke || 'rgba(255,255,255,.18)';
  ctx.lineWidth = options.lineWidth || 2;
  ctx.strokeRect(x, y, width, height);
  ctx.fillStyle = options.labelColor || '#fff';
  ctx.font = '800 ' + (width < 380 ? 17 : 20) + 'px "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.fillText((kind === 'artist' ? 'ARTIST ' : 'TRACK ') + String(rank).padStart(2, '0'), x + 22, y + height - 70);
  ctx.font = '750 ' + (width < 380 ? 24 : 30) + 'px "Segoe UI", "Microsoft YaHei", sans-serif';
  listenReportCanvasText(ctx, item && (item.name || item.artist) || '未知', x + 22, y + height - 30, width - 44);
}

function renderListenReportCoverGridPoster(report, assets) {
  var canvas = document.createElement('canvas');
  canvas.width = 1080;
  canvas.height = 1920;
  var ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0a0b0d';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  var songs = report.songs || [];
  var artists = report.artists || [];
  var songImages = assets && assets.songImages || [];
  var artistImages = assets && assets.artistImages || [];
  var entries = [
    { item: songs[0], image: songImages[0], rank: 1, kind: 'track', box: [0, 0, 660, 760] },
    { item: artists[0], image: artistImages[0], rank: 1, kind: 'artist', box: [660, 0, 420, 440] },
    { item: songs[1], image: songImages[1], rank: 2, kind: 'track', box: [660, 440, 420, 320] },
    { item: songs[2], image: songImages[2], rank: 3, kind: 'track', box: [0, 760, 420, 440] },
    { item: artists[1], image: artistImages[1], rank: 2, kind: 'artist', box: [420, 760, 300, 440] },
    { item: songs[3], image: songImages[3], rank: 4, kind: 'track', box: [720, 760, 360, 440] },
    { item: songs[4], image: songImages[4], rank: 5, kind: 'track', box: [0, 1200, 540, 360] },
    { item: artists[2], image: artistImages[2], rank: 3, kind: 'artist', box: [540, 1200, 540, 360] },
    { item: songs[5], image: songImages[5], rank: 6, kind: 'track', box: [0, 1560, 360, 360] },
    { item: artists[3], image: artistImages[3], rank: 4, kind: 'artist', box: [360, 1560, 360, 360] },
    { item: songs[6], image: songImages[6], rank: 7, kind: 'track', box: [720, 1560, 360, 360] },
  ].filter(function (entry) { return !!entry.item; });
  entries.forEach(function (entry) {
    listenReportPosterDrawTile(ctx, entry.image, entry.item, entry.rank, entry.kind, entry.box[0], entry.box[1], entry.box[2], entry.box[3]);
  });

  var header = ctx.createLinearGradient(0, 0, 0, 150);
  header.addColorStop(0, 'rgba(0,0,0,.76)');
  header.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = header;
  ctx.fillRect(0, 0, 1080, 170);
  ctx.fillStyle = '#fff';
  ctx.font = '800 25px "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.fillText('MINERADIO / COVER RANK', 42, 64);
  ctx.textAlign = 'right';
  ctx.font = '700 21px "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.fillText(listenReportPeriodLabel(report.mode, report.period), 1038, 64);
  ctx.textAlign = 'left';

  ctx.fillStyle = 'rgba(0,0,0,.66)';
  ctx.fillRect(38, 332, 584, 244);
  ctx.fillStyle = '#d8ff46';
  ctx.font = '800 19px "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.fillText('THIS IS YOUR SOUND', 66, 382);
  ctx.fillStyle = '#fff';
  ctx.font = '850 50px "Segoe UI", "Microsoft YaHei", sans-serif';
  listenReportCanvasText(ctx, listenReportDuration(report.totalListenMs), 66, 478, 520);
  ctx.font = '650 19px "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.fillText(report.songs.length + ' 首歌  /  ' + Object.keys(report.days).length + ' 天', 66, 530);
  return canvas;
}

function renderListenReportCoverSlicesPoster(report, assets) {
  var canvas = document.createElement('canvas');
  canvas.width = 1080;
  canvas.height = 1920;
  var ctx = canvas.getContext('2d');
  var songs = report.songs || [];
  var songImages = assets && assets.songImages || [];
  ctx.fillStyle = '#0a0b0d';
  ctx.fillRect(0, 0, 1080, 1920);
  var heroShade = ctx.createLinearGradient(0, 0, 1080, 320);
  heroShade.addColorStop(0, '#182b38');
  heroShade.addColorStop(.56, '#21131d');
  heroShade.addColorStop(1, '#080a0d');
  ctx.fillStyle = heroShade;
  ctx.fillRect(0, 0, 1080, 320);
  ctx.fillStyle = '#d8ff46';
  ctx.fillRect(0, 0, 18, 320);
  ctx.fillStyle = '#fff';
  ctx.font = '850 24px "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.fillText('MINERADIO', 58, 54);
  ctx.textAlign = 'right';
  ctx.font = '700 19px "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.fillText(listenReportPeriodLabel(report.mode, report.period), 1024, 54);
  ctx.textAlign = 'left';
  ctx.fillStyle = '#d8ff46';
  ctx.font = '850 18px "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.fillText('TOTAL LISTENING', 58, 116);
  ctx.fillStyle = '#fff';
  ctx.font = '900 52px "Segoe UI", "Microsoft YaHei", sans-serif';
  listenReportCanvasText(ctx, listenReportDuration(report.totalListenMs), 58, 182, 650);
  ctx.fillStyle = 'rgba(255,255,255,.62)';
  ctx.font = '650 19px "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.fillText(report.songs.length + ' 首歌  /  ' + Object.keys(report.days).length + ' 天', 58, 230);
  ctx.fillStyle = '#d8ff46';
  ctx.fillRect(820, 134, 204, 58);
  ctx.fillStyle = '#080a0b';
  ctx.font = '800 18px "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(report.songs.length + ' TRACKS', 922, 170);
  ctx.textAlign = 'left';

  songs.slice(0, 5).forEach(function (item, index) {
    var y = 320 + index * 320;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, y, 1080, 320);
    ctx.clip();
    if (!listenReportPosterDrawImage(ctx, songImages[index], 0, y, 1080, 320)) listenReportPosterPlaceholder(ctx, 0, y, 1080, 320, index);
    var sliceShade = ctx.createLinearGradient(260, y, 1040, y);
    sliceShade.addColorStop(0, 'rgba(6,7,9,.08)');
    sliceShade.addColorStop(.56, 'rgba(6,7,9,.72)');
    sliceShade.addColorStop(1, 'rgba(6,7,9,.94)');
    ctx.fillStyle = sliceShade;
    ctx.fillRect(0, y, 1080, 320);
    ctx.restore();
    ctx.fillStyle = index % 3 === 0 ? '#ff5f57' : index % 3 === 1 ? '#d8ff46' : '#73a7ff';
    ctx.fillRect(0, y, 14, 320);
    ctx.fillStyle = '#fff';
    ctx.font = '900 50px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.fillText(String(index + 1).padStart(2, '0'), 44, y + 144);
    ctx.font = '780 28px "Segoe UI", "Microsoft YaHei", sans-serif';
    listenReportCanvasText(ctx, item.name || '未知歌曲', 176, y + 142, 650);
    ctx.fillStyle = 'rgba(255,255,255,.66)';
    ctx.font = '600 19px "Segoe UI", "Microsoft YaHei", sans-serif';
    listenReportCanvasText(ctx, item.artist || '未知歌手', 176, y + 182, 620);
    ctx.fillStyle = '#fff';
    ctx.font = '700 19px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(listenReportCompactDuration(item.listenMs), 1032, y + 162);
    ctx.textAlign = 'left';
  });
  return canvas;
}

function renderListenReportArtistSpotlightPoster(report, assets) {
  var canvas = document.createElement('canvas');
  canvas.width = 1080;
  canvas.height = 1920;
  var ctx = canvas.getContext('2d');
  var artists = report.artists || [];
  var songs = report.songs || [];
  var artistImages = assets && assets.artistImages || [];
  var topArtist = artists[0] || null;
  var heroImage = artistImages[0];
  ctx.fillStyle = '#121113';
  ctx.fillRect(0, 0, 1080, 1920);
  if (!listenReportPosterDrawImage(ctx, heroImage, 0, 0, 1080, 1230)) listenReportPosterPlaceholder(ctx, 0, 0, 1080, 1230, 4);
  var heroShade = ctx.createLinearGradient(0, 0, 0, 1230);
  heroShade.addColorStop(0, 'rgba(4,4,5,.12)');
  heroShade.addColorStop(.46, 'rgba(4,4,5,.20)');
  heroShade.addColorStop(1, 'rgba(4,4,5,.92)');
  ctx.fillStyle = heroShade;
  ctx.fillRect(0, 0, 1080, 1230);
  ctx.fillStyle = '#ff5f57';
  ctx.fillRect(0, 0, 1080, 16);
  ctx.fillStyle = '#fff';
  ctx.font = '850 26px "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.fillText('MINERADIO / YOUR HEADLINER', 54, 74);
  ctx.textAlign = 'right';
  ctx.font = '700 21px "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.fillText(listenReportPeriodLabel(report.mode, report.period), 1026, 74);
  ctx.textAlign = 'left';

  if (topArtist) {
    ctx.fillStyle = '#ff5f57';
    ctx.font = '900 23px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.fillText('TOP ARTIST / 01', 54, 570);
    ctx.fillStyle = '#fff';
    ctx.font = '900 92px "Segoe UI", "Microsoft YaHei", sans-serif';
    listenReportCanvasText(ctx, topArtist.name || '未知歌手', 48, 682, 970);
    ctx.fillStyle = 'rgba(255,255,255,.72)';
    ctx.font = '700 26px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.fillText(listenReportCompactDuration(topArtist.listenMs), 54, 728);
  }

  ctx.fillStyle = 'rgba(8,8,10,.70)';
  listenReportCanvasRoundRect(ctx, 54, 805, 520, 300, 8);
  ctx.fill();
  ctx.fillStyle = '#d8ff46';
  ctx.font = '850 18px "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.fillText('TOP TRACKS', 84, 852);
  songs.slice(0, 4).forEach(function (item, index) {
    var y = 903 + index * 50;
    ctx.fillStyle = index === 0 ? '#ff5f57' : 'rgba(255,255,255,.48)';
    ctx.font = '800 17px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.fillText(String(index + 1).padStart(2, '0'), 84, y);
    ctx.fillStyle = '#fff';
    ctx.font = '700 20px "Segoe UI", "Microsoft YaHei", sans-serif';
    listenReportCanvasText(ctx, item.name || '未知歌曲', 130, y, 300);
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(255,255,255,.62)';
    ctx.font = '600 16px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.fillText(listenReportCompactDuration(item.listenMs), 544, y);
    ctx.textAlign = 'left';
  });
  ctx.fillStyle = '#d8ff46';
  ctx.fillRect(612, 805, 414, 132);
  ctx.fillStyle = '#0b0c0e';
  ctx.font = '900 32px "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.fillText(listenReportDuration(report.totalListenMs), 642, 866);
  ctx.font = '750 17px "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.fillText('TOTAL LISTENING', 644, 904);
  ctx.fillStyle = '#73a7ff';
  ctx.fillRect(612, 953, 198, 152);
  ctx.fillStyle = '#0b0c0e';
  ctx.font = '900 46px "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.fillText(String(report.songs.length), 640, 1021);
  ctx.font = '750 16px "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.fillText('TRACKS', 640, 1061);
  ctx.fillStyle = '#ff5f57';
  ctx.fillRect(828, 953, 198, 152);
  ctx.fillStyle = '#0b0c0e';
  ctx.font = '900 46px "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.fillText(String(Object.keys(report.days).length), 856, 1021);
  ctx.font = '750 16px "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.fillText('DAYS', 856, 1061);

  for (var tileIndex = 0; tileIndex < 4; tileIndex++) {
    var artistIndex = tileIndex + 1;
    var item = artists[artistIndex];
    if (!item) continue;
    var image = artistImages[artistIndex];
    var tileX = tileIndex % 2 * 540;
    var tileY = 1230 + Math.floor(tileIndex / 2) * 345;
    listenReportPosterDrawTile(ctx, image, item, artistIndex + 1, 'artist', tileX, tileY, 540, 345, {
      bottomShade: 'rgba(0,0,0,.78)',
      labelColor: tileIndex % 2 ? '#d8ff46' : '#fff',
    });
  }
  return canvas;
}

function renderModernListenReportPoster(report, template, assets) {
  var selected = listenReportPosterTemplate(template);
  if (selected === 'particle') return renderListenReportCoverSlicesPoster(report, assets);
  if (selected === 'glass') return renderListenReportArtistSpotlightPoster(report, assets);
  return renderListenReportCoverGridPoster(report, assets);
}
