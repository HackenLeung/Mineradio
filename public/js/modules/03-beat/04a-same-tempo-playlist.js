var SAME_TEMPO_INDEX_STORE_KEY = 'mineradio-same-tempo-index-v2';
var sameTempoState = {
  token: 0,
  active: false,
  seedSong: null,
  seedBpm: 0,
  count: 15,
  scope: 'all',
  mode: 'setup',
  results: []
};

function readSameTempoIndex() {
  try {
    var value = JSON.parse(localStorage.getItem(SAME_TEMPO_INDEX_STORE_KEY) || '{}');
    return value && typeof value === 'object' ? value : {};
  } catch (_) { return {}; }
}
var sameTempoIndex = readSameTempoIndex();

function saveSameTempoIndex() {
  try {
    var keys = Object.keys(sameTempoIndex).sort(function (a, b) {
      return Number(sameTempoIndex[b] && sameTempoIndex[b].updatedAt) - Number(sameTempoIndex[a] && sameTempoIndex[a].updatedAt);
    }).slice(0, 5000);
    var payload = {};
    keys.forEach(function (key) { payload[key] = sameTempoIndex[key]; });
    localStorage.setItem(SAME_TEMPO_INDEX_STORE_KEY, JSON.stringify(payload));
  } catch (_) { }
}

function sameTempoSongKey(song) {
  return typeof beatMapSongKey === 'function' ? String(beatMapSongKey(song) || '') : '';
}

function normalizeSameTempoBpm(value) {
  value = Number(value) || 0;
  if (!(value > 0)) return 0;
  while (value < 70) value *= 2;
  while (value > 190) value /= 2;
  return Math.round(value * 10) / 10;
}

function bpmFromBeatMap(map) {
  if (!map) return 0;
  var step = Number(map.gridStep) || 0;
  if (step > 0) return normalizeSameTempoBpm(60 / step);
  var beats = map.cameraBeats || map.beats || map.kicks || [];
  var times = beats.map(function (beat) { return Number(typeof beat === 'number' ? beat : beat && beat.time); }).filter(isFinite).slice(0, 240);
  if (times.length < 4) return 0;
  var gaps = [];
  for (var i = 1; i < times.length; i++) {
    var gap = times[i] - times[i - 1];
    if (gap > 0.22 && gap < 1.8) gaps.push(gap);
  }
  if (!gaps.length) return 0;
  gaps.sort(function (a, b) { return a - b; });
  return normalizeSameTempoBpm(60 / gaps[Math.floor(gaps.length / 2)]);
}

function beatMapEnergyScore(map) {
  if (!map) return -1;
  var beats = map.cameraBeats || map.beats || map.kicks || [];
  if (!beats.length) return -1;
  var sum = 0;
  var count = 0;
  beats.forEach(function (beat) {
    if (typeof beat === 'number') return;
    var value = Number(beat && (beat.impact != null ? beat.impact : beat.strength));
    if (!isFinite(value)) return;
    sum += Math.max(0, Math.min(1, value));
    count++;
  });
  var average = count ? sum / count : 0.45;
  var duration = Math.max(1, Number(map.duration) || 1);
  var density = Math.max(0, Math.min(1, beats.length / duration / 2.5));
  return Math.max(0, Math.min(1, average * 0.72 + density * 0.28));
}

function sameTempoMapForSong(song) {
  var key = sameTempoSongKey(song);
  if (key && beatMapCache && beatMapCache[key]) return beatMapCache[key];
  if (song && song.localKey && localBeatMapCache && localBeatMapCache[song.localKey]) {
    return localBeatMapCache[song.localKey].mr || localBeatMapCache[song.localKey].dj || null;
  }
  if (currentIdx >= 0 && playQueue[currentIdx] && sameTempoSongKey(playQueue[currentIdx]) === key && currentBeatMap) return currentBeatMap;
  return null;
}

function cacheSameTempoMap(song, map) {
  var key = sameTempoSongKey(song);
  var bpm = bpmFromBeatMap(map);
  if (!key || !(bpm > 0)) return 0;
  sameTempoIndex[key] = { bpm: bpm, energy: beatMapEnergyScore(map), updatedAt: Date.now() };
  saveSameTempoIndex();
  return bpm;
}

function getCachedSongBpm(song) {
  var key = sameTempoSongKey(song);
  var indexed = key && sameTempoIndex[key];
  if (indexed && Number(indexed.bpm) > 0) return Number(indexed.bpm);
  var map = sameTempoMapForSong(song);
  return map ? cacheSameTempoMap(song, map) : 0;
}

function getCachedSongEnergy(song) {
  var key = sameTempoSongKey(song);
  var indexed = key && sameTempoIndex[key];
  if (indexed && Number(indexed.energy) >= 0) return Number(indexed.energy);
  var map = sameTempoMapForSong(song);
  if (!map) return -1;
  cacheSameTempoMap(song, map);
  return Number(sameTempoIndex[key] && sameTempoIndex[key].energy);
}

async function loadSameTempoDiskMap(song) {
  if (!song || typeof readBeatDiskCache !== 'function') return null;
  if (song.localKey && typeof localBeatDiskKey === 'function') {
    return await readBeatDiskCache(localBeatDiskKey(song.localKey, 'mr'))
      || await readBeatDiskCache(localBeatDiskKey(song.localKey, 'dj'));
  }
  var key = sameTempoSongKey(song);
  return key ? readBeatDiskCache(key) : null;
}

async function ensureSongBpm(song, options) {
  options = options || {};
  var cached = getCachedSongBpm(song);
  if (cached > 0) return cached;
  var diskMap = await loadSameTempoDiskMap(song);
  if (diskMap) return cacheSameTempoMap(song, diskMap);
  if (!options.allowAnalyze || beatMapBusy || localBeatAnalysis.active) return 0;
  var url = '';
  if (song && (song.type === 'local' || song.source === 'local' || song.localUrl)) {
    if (typeof ensureFreshLocalPlaybackUrl === 'function') await ensureFreshLocalPlaybackUrl(song);
    url = song.localUrl || '';
  } else if (typeof fetchBeatPrefetchAudioUrl === 'function') {
    url = await fetchBeatPrefetchAudioUrl(song);
  }
  if (!url) return 0;
  var token = beatMapToken;
  var map = await analyzeAudioBeats(url, Number(song.duration) || 0, token, { background: true, prefetch: true, song: song });
  if (!map || token !== beatMapToken) return 0;
  var bpm = cacheSameTempoMap(song, map);
  var diskKey = song.localKey && typeof localBeatDiskKey === 'function' ? localBeatDiskKey(song.localKey, 'mr') : sameTempoSongKey(song);
  if (diskKey && typeof writeBeatDiskCache === 'function') writeBeatDiskCache(diskKey, map, song, 'same-tempo');
  return bpm;
}

function sameTempoCandidatePool(seed) {
  var source = Array.isArray(localLibrarySongs) ? localLibrarySongs : [];
  if (sameTempoState.scope === 'folder' && seed && seed.localFolderPath) {
    source = source.filter(function (song) { return song && song.localFolderPath === seed.localFolderPath; });
  }
  var seen = {};
  return source.filter(function (song) {
    var key = sameTempoSongKey(song);
    if (!key || seen[key]) return false;
    seen[key] = true;
    return true;
  });
}

function sameTempoBpmDistance(a, b) {
  a = Number(a) || 0;
  b = Number(b) || 0;
  if (!(a > 0) || !(b > 0)) return 32;
  return Math.min(Math.abs(a - b), Math.abs(a * 2 - b), Math.abs(a / 2 - b));
}

function matchSameTempoSongs(seedBpm, candidates, count, seed) {
  var seedKey = sameTempoSongKey(seed);
  var pool = candidates.map(function (song) {
    var bpm = getCachedSongBpm(song);
    if (!(bpm > 0) || sameTempoSongKey(song) === seedKey) return null;
    return { song: song, bpm: bpm, energy: getCachedSongEnergy(song), delta: sameTempoBpmDistance(bpm, seedBpm) };
  }).filter(Boolean);
  var energyValues = pool.filter(function (item) { return item.energy >= 0; }).map(function (item) { return item.energy; });
  var fallbackEnergy = energyValues.length ? energyValues.reduce(function (a, b) { return a + b; }, 0) / energyValues.length : 0.5;
  pool.forEach(function (item) { if (!(item.energy >= 0)) item.energy = fallbackEnergy; });
  var seedEnergy = getCachedSongEnergy(seed);
  if (!(seedEnergy >= 0)) seedEnergy = fallbackEnergy;
  var ordered = [{ song: seed, bpm: seedBpm, energy: seedEnergy, delta: 0, isSeed: true }];
  var remaining = pool.slice();
  var picks = Math.min(Math.max(0, Number(count) - 1), remaining.length);
  var maximumEnergy = remaining.length ? Math.max.apply(null, remaining.map(function (item) { return item.energy; })) : seedEnergy;
  var previousEnergy = seedEnergy;
  var previousBpm = seedBpm;
  for (var step = 0; step < picks; step++) {
    var target = seedEnergy + (maximumEnergy - seedEnergy) * (picks > 1 ? step / (picks - 1) : 0);
    var bestIndex = 0;
    var bestCost = Infinity;
    for (var index = 0; index < remaining.length; index++) {
      var candidate = remaining[index];
      var energyCost = Math.abs(candidate.energy - target);
      var dropPenalty = candidate.energy < previousEnergy - 0.02 ? (previousEnergy - candidate.energy) * 0.5 : 0;
      var tempoCost = sameTempoBpmDistance(candidate.bpm, previousBpm) * 0.0125;
      var seedCost = candidate.delta * 0.00625;
      var cost = energyCost + dropPenalty + tempoCost + seedCost;
      if (cost < bestCost) { bestCost = cost; bestIndex = index; }
    }
    var picked = remaining.splice(bestIndex, 1)[0];
    ordered.push(picked);
    previousEnergy = picked.energy;
    previousBpm = picked.bpm;
  }
  return ordered;
}

function setSameTempoStatus(text, tone) {
  var element = document.getElementById('same-tempo-status');
  if (!element) return;
  element.textContent = text || '';
  element.classList.toggle('warn', tone === 'warn');
  element.classList.toggle('fail', tone === 'fail');
}

function renderSameTempoResults() {
  var list = document.getElementById('same-tempo-list');
  if (!list) return;
  list.innerHTML = (sameTempoState.results || []).map(function (item, index) {
    var song = item.song || {};
    var cover = typeof songCoverSrc === 'function' ? songCoverSrc(song, 80) : (song.cover || '');
    return '<div class="same-tempo-item">' + (cover ? '<img src="' + escHtml(cover) + '" alt="">' : '<span class="same-tempo-cover"></span>') +
      '<span class="same-tempo-copy"><strong>' + escHtml((index + 1) + '. ' + (song.name || '本地歌曲')) + '</strong><small>' + escHtml(song.artist || '本地文件') + '</small></span>' +
      '<span class="same-tempo-bpm">' + Math.round(item.bpm || 0) + ' BPM</span></div>';
  }).join('') || '<div class="same-tempo-empty">暂无可用节奏缓存</div>';
}

function updateSameTempoModal() {
  ['10', '15', '20'].forEach(function (count) {
    var button = document.getElementById('same-tempo-count-' + count);
    if (button) button.classList.toggle('active', Number(count) === sameTempoState.count);
  });
  ['all', 'folder'].forEach(function (scope) {
    var button = document.getElementById('same-tempo-scope-' + scope);
    if (button) button.classList.toggle('active', scope === sameTempoState.scope);
  });
  var primary = document.getElementById('same-tempo-primary-btn');
  var queue = document.getElementById('same-tempo-queue-btn');
  if (primary) {
    primary.disabled = sameTempoState.active;
    primary.textContent = sameTempoState.active ? '生成中...' : (sameTempoState.mode === 'result' ? '替换队列并播放' : '开始生成');
    primary.onclick = sameTempoState.mode === 'result' ? function () { applySameTempoPlaylist(true); } : startSameTempoGeneration;
  }
  if (queue) queue.hidden = sameTempoState.mode !== 'result' || !sameTempoState.results.length;
  renderSameTempoResults();
}

function openSameTempoGenerator(song) {
  var seed = song || (typeof currentCoverSong === 'function' ? currentCoverSong() : null);
  if (!seed || !(seed.type === 'local' || seed.source === 'local' || seed.localUrl)) seed = localLibrarySongs && localLibrarySongs[0];
  if (!seed) { showToast('先导入本地音乐'); return; }
  sameTempoState.token++;
  sameTempoState.active = false;
  sameTempoState.seedSong = cloneSong(seed);
  sameTempoState.seedBpm = getCachedSongBpm(seed);
  sameTempoState.results = [];
  sameTempoState.mode = 'setup';
  var sub = document.getElementById('same-tempo-sub');
  if (sub) sub.textContent = '参考：' + (seed.name || '本地歌曲') + (sameTempoState.seedBpm ? (' · ' + Math.round(sameTempoState.seedBpm) + ' BPM') : '');
  setSameTempoStatus('选择数量和范围后生成', '');
  updateSameTempoModal();
  openGsapModal(document.getElementById('same-tempo-modal'));
}

function closeSameTempoModal() {
  sameTempoState.token++;
  sameTempoState.active = false;
  closeGsapModal(document.getElementById('same-tempo-modal'));
}

function setSameTempoCount(count) {
  sameTempoState.count = [10, 15, 20].indexOf(Number(count)) >= 0 ? Number(count) : 15;
  updateSameTempoModal();
}

function setSameTempoScope(scope) {
  sameTempoState.scope = scope === 'folder' ? 'folder' : 'all';
  updateSameTempoModal();
}

async function startSameTempoGeneration() {
  if (sameTempoState.active || !sameTempoState.seedSong) return;
  var token = ++sameTempoState.token;
  var seed = sameTempoState.seedSong;
  var candidates = sameTempoCandidatePool(seed);
  sameTempoState.active = true;
  sameTempoState.mode = 'busy';
  updateSameTempoModal();
  try {
    setSameTempoStatus('正在读取参考歌曲节奏...', 'warn');
    var seedBpm = await ensureSongBpm(seed, { allowAnalyze: true });
    if (token !== sameTempoState.token) return;
    if (!(seedBpm > 0)) throw new Error('SEED_BPM_UNAVAILABLE');
    sameTempoState.seedBpm = seedBpm;
    for (var index = 0; index < candidates.length && index < 48; index++) {
      if (token !== sameTempoState.token) return;
      if (getCachedSongBpm(candidates[index]) > 0) continue;
      var map = await loadSameTempoDiskMap(candidates[index]);
      if (map) cacheSameTempoMap(candidates[index], map);
    }
    var matched = matchSameTempoSongs(seedBpm, candidates, sameTempoState.count, seed);
    var missing = candidates.filter(function (song) { return !(getCachedSongBpm(song) > 0); }).slice(0, 6);
    for (var scanIndex = 0; matched.length < sameTempoState.count && scanIndex < missing.length; scanIndex++) {
      if (token !== sameTempoState.token) return;
      setSameTempoStatus('补充分析 ' + (scanIndex + 1) + '/' + missing.length + ' · ' + (missing[scanIndex].name || '本地歌曲'), 'warn');
      await ensureSongBpm(missing[scanIndex], { allowAnalyze: true });
      matched = matchSameTempoSongs(seedBpm, candidates, sameTempoState.count, seed);
    }
    if (token !== sameTempoState.token) return;
    sameTempoState.results = matched;
    sameTempoState.active = false;
    sameTempoState.mode = 'result';
    setSameTempoStatus(matched.length > 1 ? ('已生成 ' + matched.length + ' 首 · ' + Math.round(seedBpm) + ' BPM 起步') : '可用节奏缓存不足，请先播放更多本地歌曲', matched.length > 1 ? '' : 'warn');
    updateSameTempoModal();
  } catch (error) {
    console.warn('[SameTempo]', error);
    if (token !== sameTempoState.token) return;
    sameTempoState.active = false;
    sameTempoState.mode = 'setup';
    setSameTempoStatus('节奏分析失败，请先播放参考歌曲后重试', 'fail');
    updateSameTempoModal();
  }
}

function applySameTempoPlaylist(playNow) {
  var songs = (sameTempoState.results || []).map(function (item) { return cloneSong(item.song); });
  if (!songs.length) return;
  if (playNow) {
    playQueue = songs;
    currentIdx = 0;
    safeRenderQueuePanel('same-tempo-play', { scrollCurrent: true, resetLimit: true });
    closeSameTempoModal();
    playQueueAt(0, { manual: true }).catch(function (error) { console.warn('[SameTempoPlay]', error); });
    return;
  }
  songs.forEach(function (song) { queueSong(song); });
  safeRenderQueuePanel('same-tempo-queue', { resetLimit: true });
  closeSameTempoModal();
  showToast('已加入队列 ' + songs.length + ' 首');
}

