function readProviderVipAuditState() {
  try {
    var raw = localStorage.getItem(PROVIDER_VIP_AUDIT_STORE_KEY) || '{}';
    var parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) { return {}; }
}
function writeProviderVipAuditState(state) {
  try { localStorage.setItem(PROVIDER_VIP_AUDIT_STORE_KEY, JSON.stringify(state || {})); } catch (e) { }
}
var QQ_PLAYBACK_VIP_EVIDENCE_TTL_MS = 12 * 60 * 60 * 1000;
function qqPlaybackVipEvidenceUserKey(status) {
  return String(status && (status.userId || status.uin || status.uid || status.openId || status.id) || '').trim();
}
function readQQPlaybackVipEvidence() {
  try {
    var raw = localStorage.getItem(QQ_PLAYBACK_VIP_EVIDENCE_STORE_KEY) || '{}';
    var parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) { return {}; }
}
function writeQQPlaybackVipEvidence(evidence) {
  try { localStorage.setItem(QQ_PLAYBACK_VIP_EVIDENCE_STORE_KEY, JSON.stringify(evidence || {})); } catch (e) { }
}
function clearQQPlaybackVipEvidence() {
  try { localStorage.removeItem(QQ_PLAYBACK_VIP_EVIDENCE_STORE_KEY); } catch (e) { }
}
function qqPlaybackVipEvidenceApplies(evidence, status) {
  if (!evidence || !status || !status.loggedIn) return false;
  var checkedAt = Number(evidence.checkedAt || evidence.vipCheckedAt || 0) || 0;
  if (!checkedAt || Date.now() - checkedAt > QQ_PLAYBACK_VIP_EVIDENCE_TTL_MS) return false;
  var evidenceUser = qqPlaybackVipEvidenceUserKey(evidence);
  var statusUser = qqPlaybackVipEvidenceUserKey(status);
  return !!(evidenceUser && statusUser && evidenceUser === statusUser);
}
function mergeQQPlaybackVipEvidence(status) {
  if (!status || !status.loggedIn) return status;
  var evidence = readQQPlaybackVipEvidence();
  if (!qqPlaybackVipEvidenceApplies(evidence, status)) return status;
  var svip = providerVipLevel('qq', status) === 'svip' || providerVipLevel('qq', evidence) === 'svip' || !!status.isSvip || !!evidence.isSvip;
  return Object.assign({}, status, {
    provider: 'qq',
    loggedIn: true,
    vipType: Math.max(Number(status.vipType || status.vip_type || 0) || 0, Number(evidence.vipType || evidence.vip_type || 0) || 0, 1),
    svipType: Math.max(Number(status.svipType || status.svip_type || 0) || 0, Number(evidence.svipType || evidence.svip_type || 0) || 0),
    vipLevel: svip ? 'svip' : 'vip',
    isVip: true,
    isSvip: svip,
    playbackKeyReady: true,
    vipCheckedAt: Math.max(Number(status.vipCheckedAt || 0) || 0, Number(evidence.checkedAt || evidence.vipCheckedAt || 0) || 0),
    vipSource: evidence.vipSource || status.vipSource || 'qq-playback-evidence',
    vipProbeAvailable: true,
    membershipStale: false,
    authorizationIncomplete: false,
    vipSyncState: 'playback_evidence'
  });
}
function providerVipAuditSnapshot(provider, status) {
  status = status || {};
  var level = providerVipLevel(provider, status);
  return {
    provider: provider,
    loggedIn: !!status.loggedIn,
    userId: String(status.userId || status.uid || status.uin || status.openId || status.id || ''),
    vipLevel: level,
    isVip: level !== 'none',
    checkedAt: Date.now()
  };
}
function providerVipAuditLabel(provider, snapshot) {
  var meta = platformMeta(provider);
  var label = meta && meta.label || provider;
  var level = snapshot && snapshot.vipLevel === 'svip' ? 'SVIP' : 'VIP';
  return label + ' ' + level;
}
function providerVipAuditSameUser(previous, current) {
  if (!previous || !current) return true;
  if (!previous.userId || !current.userId) return true;
  return String(previous.userId) === String(current.userId);
}
function auditProviderVipState(provider, status) {
  if (!status) return;
  var state = readProviderVipAuditState();
  var previous = state[provider] || null;
  var current = providerVipAuditSnapshot(provider, status);
  var sameUser = providerVipAuditSameUser(previous, current);
  if (previous && sameUser && previous.loggedIn && previous.isVip && current.loggedIn && !current.isVip) {
    var title = providerVipAuditLabel(provider, previous) + ' 状态掉了';
    var body = '本次启动复验时已变为普通账号，会员曲目可能只能试听或需要换源。';
    if (typeof showSourceFallbackNotice === 'function') showSourceFallbackNotice(title, body);
    else showToast(title);
  }
  if (previous && sameUser && previous.loggedIn && !previous.isVip && current.loggedIn && current.isVip) {
    var syncTitle = providerVipAuditLabel(provider, current) + ' 已同步';
    var syncBody = '已重新检查到当前账号会员状态，会员曲目会按新的平台权限继续尝试播放。';
    if (typeof showToast === 'function') showToast(syncTitle);
    else if (typeof showSourceFallbackNotice === 'function') showSourceFallbackNotice(syncTitle, syncBody);
  }
  state[provider] = current;
  writeProviderVipAuditState(state);
}

async function refreshLoginStatus(force) {
  try {
    var info = await apiJson('/api/login/status?t=' + Date.now());
    loginStatusChecked = true;
    loginStatusCheckFailed = false;
    loginStatus = info || { loggedIn: false };
    auditProviderVipState('netease', loginStatus);
    if (loginStatus.loggedIn && !hasPlatformLogin(activeAccountProvider)) activeAccountProvider = 'netease';
    renderUserBtn();
    if (info && info.loggedIn) {
      homeDiscoverState.loaded = false;
      homeDiscoverState.loggedIn = true;
      refreshUserPlaylists(true);
      loadHomeDiscover(true);
      syncLikeStatusForSongs(playQueue.concat(playlist || []));
    } else {
      neteasePlaylists = [];
      userPlaylists = qqPlaylists.concat(kugouPlaylists || []);
      playlistCatalogRevision += 1;
      myPodcastCollections = [];
      myPodcastItems = {};
      likedSongMap = {};
      updateLikeButtons();
    }
    return info;
  } catch (e) {
    console.warn(e);
    loginStatusChecked = true;
    loginStatusCheckFailed = true;
    renderUserBtn();
    return null;
  }
}

function normalizeQQLoginStatus(info) {
  var fallback = { provider: 'qq', loggedIn: false, preview: false, nickname: '小Q', userId: '', avatar: '', vipType: 0, svipType: 0, vipLevel: 'none', isVip: false, isSvip: false, stale: false, playbackKeyReady: false, vipCheckedAt: 0, vipSource: '', vipProbeAvailable: false, membershipKnown: false, membershipStale: false, authorizationIncomplete: false, vipSyncState: '' };
  if (!info || !info.loggedIn) return Object.assign({}, fallback, info || {}, {
    provider: 'qq',
    loggedIn: false,
    nickname: info && info.nickname || fallback.nickname,
    userId: info && (info.userId || info.uin) || '',
    avatar: info && info.avatar || '',
    vipType: Number(info && (info.vipType || info.vip_type) || 0) || 0,
    svipType: Number(info && (info.svipType || info.svip_type) || 0) || 0,
    vipLevel: info && (info.vipLevel || info.vip_level) || 'none',
    isVip: !!(info && info.isVip),
    isSvip: !!(info && info.isSvip),
    stale: !!(info && info.stale),
    vipCheckedAt: Number(info && info.vipCheckedAt || 0) || 0,
    vipSource: info && info.vipSource || '',
    vipProbeAvailable: !!(info && info.vipProbeAvailable),
    membershipKnown: !!(info && info.membershipKnown),
    membershipStale: !!(info && info.membershipStale),
    authorizationIncomplete: !!(info && info.authorizationIncomplete),
    vipSyncState: info && info.vipSyncState || ''
  });
  return Object.assign({}, fallback, info, {
    provider: 'qq',
    loggedIn: true,
    nickname: info.nickname || fallback.nickname,
    userId: info.userId || info.uin || '',
    avatar: info.avatar || '',
    vipType: Number(info.vipType || info.vip_type || 0) || 0,
    svipType: Number(info.svipType || info.svip_type || 0) || 0,
    vipLevel: info.vipLevel || info.vip_level || 'none',
    isVip: !!info.isVip,
    isSvip: !!info.isSvip,
    playbackKeyReady: !!info.playbackKeyReady,
    stale: !!info.stale || !!(info.profileUnavailable && !(info.nickname && info.avatar)),
    vipCheckedAt: Number(info.vipCheckedAt || 0) || 0,
    vipSource: info.vipSource || '',
    vipProbeAvailable: !!info.vipProbeAvailable,
    membershipKnown: !!info.membershipKnown,
    membershipStale: !!info.membershipStale,
    authorizationIncomplete: !!info.authorizationIncomplete,
    vipSyncState: info.vipSyncState || ''
  });
}

function qqLoginNeedsAuthorizationRefresh(status) {
  status = status || qqLoginStatus;
  return !!(status && status.loggedIn && (
    status.authorizationIncomplete ||
    status.membershipStale ||
    status.membershipKnown === false ||
    status.playbackKeyReady === false
  ));
}
function qqMembershipLabel(status) {
  if (qqLoginNeedsAuthorizationRefresh(status)) return '会员待同步';
  var level = providerVipLevel('qq', status);
  return level === 'svip' ? 'SVIP 会员' : (level === 'vip' ? 'VIP 会员' : '普通账号');
}
function qqLoginStatusText(info) {
  info = normalizeQQLoginStatus(info || qqLoginStatus);
  if (!info.loggedIn) return '点击“扫码登录”打开小Q官方窗口';
  if (qqLoginNeedsAuthorizationRefresh(info)) return '小Q会话需要重新授权 · 会员状态待同步';
  var syncText = info.vipCheckedAt ? ' · 会员已复验' : '';
  return '已保存小Q会话 · ' + (info.nickname || '小Q') + ' · ' + qqMembershipLabel(info) + syncText;
}

async function refreshQQLoginStatus(options) {
  if (options === true) options = { forceVip: true };
  options = options || {};
  try {
    var query = '/api/qq/login/status?t=' + Date.now() + (options.forceVip ? '&forceVip=1' : '');
    var info = await apiJson(query);
    var prevLogged = !!qqLoginStatus.loggedIn;
    qqLoginStatus = normalizeQQLoginStatus(info);
    auditProviderVipState('qq', qqLoginStatus);
    if (!qqLoginStatus.loggedIn) {
      if (prevLogged || qqLoginWasLoggedIn) showToast(qqLoginStatus.stale ? '小Q登录已失效' : '小Q已掉登录');
      qqPlaylists = [];
      userPlaylists = userPlaylists.filter(function (pl) { return pl.provider !== 'qq'; });
      playlistCatalogRevision += 1;
      homeDiscoverState.loaded = false;
    } else if (!userPlaylists.some(function (pl) { return pl && pl.provider === 'qq'; })) {
      homeDiscoverState.loaded = false;
      homeDiscoverState.loggedIn = true;
      loadHomeDiscover(true);
      refreshUserPlaylists(true);
    } else if (qqLoginStatus.stale) {
      showToast('小Q登录状态可能已失效');
    }
    qqLoginWasLoggedIn = !!qqLoginStatus.loggedIn;
    if (!hasPlatformLogin(activeAccountProvider)) activeAccountProvider = firstLoggedProvider();
    renderUserBtn();
    return qqLoginStatus;
  } catch (e) {
    console.warn('QQ login status failed:', e);
    if (qqLoginStatus && qqLoginStatus.loggedIn) {
      qqLoginStatus = normalizeQQLoginStatus(Object.assign({}, qqLoginStatus, {
        loggedIn: true,
        stale: true,
        membershipStale: true,
        vipProbeAvailable: false,
        vipSyncState: 'stale'
      }));
    } else {
      qqLoginStatus = normalizeQQLoginStatus(null);
    }
    renderUserBtn();
    return qqLoginStatus;
  }
}
function refreshQQVipStatusNow(reason) {
  var now = Date.now();
  if (now - qqLoginStatusLastForcedAt < 8000) return Promise.resolve(qqLoginStatus);
  qqLoginStatusLastForcedAt = now;
  return refreshQQLoginStatus({ forceVip: true, reason: reason || 'manual' });
}
function startQQLoginStatusAutoRefresh() {
  if (qqLoginAutoRefreshTimer) clearInterval(qqLoginAutoRefreshTimer);
  qqLoginAutoRefreshTimer = setInterval(function () {
    refreshQQLoginStatus({ reason: 'auto' }).catch(function (e) { console.warn('QQ login auto refresh failed:', e); });
  }, 45000);
  if (startQQLoginStatusAutoRefresh._boundFocusRefresh) return;
  startQQLoginStatusAutoRefresh._boundFocusRefresh = true;
  function refreshOnVisible(reason) {
    if (document.hidden) return;
    if (!qqLoginStatus.loggedIn && !qqLoginWasLoggedIn) return;
    refreshQQVipStatusNow(reason).catch(function (e) { console.warn('QQ VIP foreground refresh failed:', e); });
  }
  window.addEventListener('focus', function () { refreshOnVisible('window-focus'); });
  document.addEventListener('visibilitychange', function () { refreshOnVisible('visibility'); });
}

function normalizeKugouLoginStatus(info) {
  var fallback = { provider: 'kugou', loggedIn: false, preview: false, nickname: '小狗', userId: '', avatar: '', vipType: 0, svipType: 0, vipLevel: 'none', isVip: false, isSvip: false, stale: false, playbackKeyReady: false };
  var normalizedLevel = info && info.loggedIn ? providerVipLevel('kugou', info) : (info && (info.vipLevel || info.vip_level) || 'none');
  if (!info || !info.loggedIn) return Object.assign({}, fallback, info || {}, {
    provider: 'kugou',
    loggedIn: false,
    nickname: info && info.nickname || fallback.nickname,
    userId: info && (info.userId || info.userid) || '',
    avatar: info && info.avatar || '',
    vipType: Number(info && (info.vipType || info.vip_type) || 0) || 0,
    svipType: Number(info && (info.svipType || info.svip_type) || 0) || 0,
    vipLevel: normalizedLevel,
    isVip: normalizedLevel !== 'none' || !!(info && info.isVip),
    isSvip: normalizedLevel === 'svip' || !!(info && info.isSvip),
    stale: !!(info && info.stale),
    playbackKeyReady: !!(info && info.playbackKeyReady)
  });
  return Object.assign({}, fallback, info, {
    provider: 'kugou',
    loggedIn: true,
    nickname: info.nickname || fallback.nickname,
    userId: info.userId || info.userid || '',
    avatar: info.avatar || '',
    vipType: Number(info.vipType || info.vip_type || 0) || 0,
    svipType: Number(info.svipType || info.svip_type || 0) || 0,
    vipLevel: normalizedLevel,
    isVip: normalizedLevel !== 'none' || !!info.isVip,
    isSvip: normalizedLevel === 'svip' || !!info.isSvip,
    playbackKeyReady: !!info.playbackKeyReady,
    stale: !!info.stale
  });
}
function applyKugouPlaybackStatusEvidence(info) {
  if (!info || info.provider !== 'kugou' || !info.loggedIn) return false;
  var existing = kugouLoginStatus || {};
  var verifiedMembership = info.membershipVerified === true &&
    (info.membershipSource === 'kugou-vip-api' || info.membershipSource === 'kugou-cookie-explicit');
  var safeUpdate = {
    provider: 'kugou',
    loggedIn: true,
    playbackKeyReady: !!(info.playbackReady || info.playbackKeyReady || existing.playbackKeyReady)
  };
  if (verifiedMembership) {
    safeUpdate.vipType = Number(info.vipType || 0) || 0;
    safeUpdate.svipType = Number(info.svipType || 0) || 0;
    safeUpdate.vipLevel = info.vipLevel === 'svip' ? 'svip' : (info.vipLevel === 'vip' ? 'vip' : 'none');
    safeUpdate.isVip = info.isVip === true;
    safeUpdate.isSvip = info.isSvip === true;
    safeUpdate.membershipVerified = true;
    safeUpdate.membershipSource = info.membershipSource;
  }
  kugouLoginStatus = normalizeKugouLoginStatus(Object.assign({}, existing, safeUpdate));
  kugouLoginWasLoggedIn = true;
  renderUserBtn();
  return true;
}
function qqPlaybackShowsMemberAccess(info, song) {
  // A playable URL plus a song-level VIP hint proves that this request worked;
  // it does not prove the account owns a subscription.
  return false;
}
function applyQQPlaybackStatusEvidence(info, song) {
  return false;
}
async function refreshKugouLoginStatus() {
  try {
    var info = await apiJson('/api/kugou/login/status?t=' + Date.now());
    var prevLogged = !!kugouLoginStatus.loggedIn;
    kugouLoginStatus = normalizeKugouLoginStatus(info);
    auditProviderVipState('kugou', kugouLoginStatus);
    if (!kugouLoginStatus.loggedIn) {
      if (prevLogged || kugouLoginWasLoggedIn) showToast(kugouLoginStatus.stale ? '小狗登录已失效' : '小狗已掉登录');
      kugouPlaylists = [];
      userPlaylists = userPlaylists.filter(function (pl) { return pl.provider !== 'kugou'; });
      playlistCatalogRevision += 1;
      homeDiscoverState.loaded = false;
    } else if (!userPlaylists.some(function (pl) { return pl && pl.provider === 'kugou'; })) {
      homeDiscoverState.loaded = false;
      homeDiscoverState.loggedIn = true;
      refreshUserPlaylists(true);
    } else if (kugouLoginStatus.stale) {
      showToast('小狗登录状态可能已失效');
    }
    kugouLoginWasLoggedIn = !!kugouLoginStatus.loggedIn;
    if (!hasPlatformLogin(activeAccountProvider)) activeAccountProvider = firstLoggedProvider();
    renderUserBtn();
    return kugouLoginStatus;
  } catch (e) {
    console.warn('Kugou login status failed:', e);
    kugouLoginStatus = normalizeKugouLoginStatus(null);
    renderUserBtn();
    return kugouLoginStatus;
  }
}
function startKugouLoginStatusAutoRefresh() {
  if (kugouLoginAutoRefreshTimer) clearInterval(kugouLoginAutoRefreshTimer);
  kugouLoginAutoRefreshTimer = setInterval(function () {
    refreshKugouLoginStatus().catch(function (e) { console.warn('Kugou login auto refresh failed:', e); });
  }, 45000);
}



function renderUserBtn() {
  var btn = document.getElementById('user-btn');
  if (!btn) return;
  var loggedIn = hasAnyPlatformLogin();
  var externalProviders = accountProviderExternalRenderList().filter(function (provider) {
    return hasPlatformLogin(provider);
  });
  if (loggedIn && !externalProviders.length) externalProviders = [firstLoggedProvider()];
  var topRight = document.getElementById('top-right');
  if (topRight) topRight.classList.toggle('account-pill-stack', externalProviders.length > 1);
  btn.classList.remove('multi-account', 'external-account-pills', 'logged-in', 'logged-out');
  if (loggedIn) {
    activeAccountProvider = firstLoggedProvider();
    var st = platformStatus(activeAccountProvider);
    var meta = platformMeta(activeAccountProvider);
    btn.classList.add('logged-in', 'multi-account', 'external-account-pills');
    btn.title = providerAccountIdentity(activeAccountProvider, st) + ' / 账号与登录接入';
    btn.innerHTML = externalProviders.map(function (provider) {
      return renderTopAccountPill(provider);
    }).join('');
  } else {
    btn.classList.add('logged-out');
    btn.title = '登录账号';
    btn.innerHTML = '<span class="login-word">登录</span>';
  }
  if (typeof updateAccountPillGlassDisplacementMap === 'function') {
    requestAnimationFrame(updateAccountPillGlassDisplacementMap);
  }
  bindTopAccountPillSorting();
  if (typeof updateLoginNodeGraphUi === 'function') {
    requestAnimationFrame(updateLoginNodeGraphUi);
  }
  updatePlaybackQualityUi();
}
