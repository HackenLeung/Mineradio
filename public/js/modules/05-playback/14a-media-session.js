var mediaSessionPositionLastAt = 0;

function mediaSessionAvailable() {
  return typeof navigator !== 'undefined' && !!navigator.mediaSession;
}

function mediaSessionSongMeta() {
  var song = playQueue && currentIdx >= 0 && currentIdx < playQueue.length ? playQueue[currentIdx] : null;
  if (!song) return null;
  var cover = '';
  try {
    cover = typeof songCoverSrc === 'function' ? (songCoverSrc(song, 256) || song.cover || '') : (song.cover || '');
  } catch (_) {
    cover = song.cover || '';
  }
  return {
    title: String(song.name || song.title || 'Mineradio').trim() || 'Mineradio',
    artist: String(song.artist || song.ar || song.author || '').trim(),
    album: String(song.album || song.albumName || song.al || 'Mineradio').trim() || 'Mineradio',
    cover: String(cover || '').trim()
  };
}

function syncMediaSessionPosition(force) {
  if (!mediaSessionAvailable() || typeof navigator.mediaSession.setPositionState !== 'function') return;
  var now = Date.now();
  if (!force && now - mediaSessionPositionLastAt < 750) return;
  mediaSessionPositionLastAt = now;
  try {
    var duration = audio && Number(audio.duration);
    var position = audio && Number(audio.currentTime);
    if (!isFinite(duration) || duration <= 0 || !isFinite(position)) return;
    navigator.mediaSession.setPositionState({
      duration: duration,
      playbackRate: audio && isFinite(audio.playbackRate) && audio.playbackRate > 0 ? audio.playbackRate : 1,
      position: Math.max(0, Math.min(duration, position))
    });
  } catch (_) { }
}

function syncMediaSessionState() {
  if (!mediaSessionAvailable()) return;
  try {
    var meta = mediaSessionSongMeta();
    if (!meta) {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = 'none';
      return;
    }
    var artwork = meta.cover ? [{ src: meta.cover, sizes: '256x256' }] : [];
    if (typeof MediaMetadata === 'function') {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: meta.title,
        artist: meta.artist,
        album: meta.album,
        artwork: artwork
      });
    }
    navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    syncMediaSessionPosition(true);
  } catch (e) {
    console.warn('[MediaSession] state update failed:', e);
  }
}

function bindMediaSessionToAudio(media) {
  if (!media || media._mineradioMediaSessionBound) return;
  media._mineradioMediaSessionBound = true;
  ['loadedmetadata', 'durationchange', 'seeked'].forEach(function (name) {
    media.addEventListener(name, function () {
      if (media === audio) syncMediaSessionPosition(true);
    });
  });
  media.addEventListener('timeupdate', function () {
    if (media === audio) syncMediaSessionPosition(false);
  });
}

function bindMediaSessionActions() {
  if (!mediaSessionAvailable() || bindMediaSessionActions.bound) return;
  bindMediaSessionActions.bound = true;
  var handlers = {
    play: function () { if (!playing) togglePlay(); },
    pause: function () { if (playing) togglePlay(); },
    previoustrack: function () { prevTrack(true); },
    nexttrack: function () { nextTrack(true); }
  };
  Object.keys(handlers).forEach(function (action) {
    try { navigator.mediaSession.setActionHandler(action, handlers[action]); } catch (_) { }
  });
}
