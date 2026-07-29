function songFromListenRecord(record) {
  if (!record) return null;
  var provider = record.provider || record.sourceKey || '';
  if (record.type === 'local' || record.localKey || record.localPath) provider = 'local';
  if (!provider && record.type === 'qq') provider = 'qq';
  if (!provider) provider = record.mid ? 'qq' : 'netease';
  return {
    provider: provider,
    source: provider,
    type: record.type || (provider === 'qq' ? 'qq' : 'song'),
    id: record.id || record.mid || record.key || '',
    mid: record.mid || '',
    songmid: record.mid || '',
    mediaMid: record.mediaMid || '',
    name: record.name || '继续听',
    artist: record.artist || '',
    cover: record.cover || '',
    hash: record.hash || '',
    mixSongId: record.mixSongId || '',
    albumId: record.albumId || '',
    providerSongId: record.providerSongId || '',
    localKey: record.localKey || '',
    localPath: record.localPath || '',
    localFolderPath: record.localFolderPath || '',
    localFolderName: record.localFolderName || '',
    sidecarCover: record.sidecarCover || '',
    embeddedCover: record.embeddedCover || '',
    onlineMetadata: record.onlineMetadata || null,
  };
}
async function playHomeRecent(record) {
  record = record || homeListenSummary().recent;
  if (!record) {
    showToast('还没有听歌记录');
    return;
  }
  var song = songFromListenRecord(record);
  if (!song || (!song.id && !song.mid && !song.localKey && !song.localPath)) {
    runHomeSearch(record.name || '');
    return;
  }
  activeRadioContext = null;
  playQueue = [cloneSong(song)];
  currentIdx = 0;
  safeRenderQueuePanel('home-recent-song');
  safeShelfRebuild('home-recent-song', true);
  forcePlaybackControlsInteractive();
  await playQueueAt(0);
}
async function playHomeRecentQueue(record) {
  var snapshot = typeof readLastPlaybackSnapshot === 'function' ? readLastPlaybackSnapshot() : null;
  var restoredQueue = snapshot && typeof hydrateLastPlaybackSnapshotQueue === 'function'
    ? hydrateLastPlaybackSnapshotQueue(snapshot)
    : null;
  if (!restoredQueue || !restoredQueue.queue.length) return playHomeRecent(record);
  if (typeof clearStartupAutoplayRetryTimer === 'function') clearStartupAutoplayRetryTimer();
  if (typeof startupAutoplayJobId === 'number') startupAutoplayJobId += 1;
  startupAutoplayAttempted = true;
  startupRestoreHomePending = false;
  activeRadioContext = null;
  restoredLastPlaybackSnapshot = snapshot;
  pendingPlaybackResumeAt = typeof startupResumeSecondsFromSnapshot === 'function'
    ? startupResumeSecondsFromSnapshot(snapshot)
    : Math.max(0, Number(snapshot.currentTime) || 0);
  playQueue = restoredQueue.queue;
  currentIdx = restoredQueue.index;
  currentLocalSong = playQueue[currentIdx] && (playQueue[currentIdx].type === 'local' || playQueue[currentIdx].localKey)
    ? playQueue[currentIdx]
    : null;
  if (snapshot.playMode) playMode = snapshot.playMode;
  safeRenderQueuePanel('home-recent-queue', { scrollCurrent: miniQueueOpen });
  safeShelfRebuild('home-recent-queue', true);
  forcePlaybackControlsInteractive();
  var resumeAt = pendingPlaybackResumeAt;
  var started = await playQueueAt(currentIdx, {
    manual: true,
    resumeAt: resumeAt,
    skipShuffleOrder: true
  });
  if (started === true) {
    pendingPlaybackResumeAt = 0;
    if (typeof dismissHomePage === 'function') dismissHomePage({ toast: false });
    showToast('已恢复上次队列 · ' + playQueue.length + ' 首');
  }
  return started;
}
function openHomeInsight() {
  var summary = homeListenSummary();
  if (summary.topArtist && summary.topArtist.name) {
    runHomeSearch(summary.topArtist.name);
    return;
  }
  if (summary.topSong && summary.topSong.name) {
    runHomeSearch(summary.topSong.name);
    return;
  }
  showToast('播放几首歌后会生成听歌画像');
}
function handleHomeTileClick(index) {
  var row = document.getElementById('home-tile-row');
  var item = row && row._homeTiles && row._homeTiles[index];
  if (!item) return;
  if (item.kind === 'recent') playHomeRecentQueue(item.record);
  else if (item.kind === 'profile') openHomeInsight();
  else if (item.kind === 'song') playHomeSong(item.index);
  else if (item.kind === 'login') showLoginModal({ source: 'home-tile' });
  else if (item.kind === 'local') openHomeLocalImport();
  else if (item.kind === 'guide') openHomeProductGuide();
  else if (item.kind === 'playlist') openHomePlaylist(item.index);
  else if (item.kind === 'podcast') openHomePodcast(item.index);
  else if (item.kind === 'podcastSearch') { setSearchMode('podcast'); loadPodcastHot(); }
  else if (item.kind === 'library') openHomeLibrary();
  else runHomeSearch(item.query || item.title || '');
}
