function loggedProviderCount() {
  return ['netease', 'qq', 'kugou', 'qishui', 'spotify'].filter(function (key) { return hasPlatformLogin(key); }).length;
}
function updateUserModalUi() {
  activeAccountProvider = firstLoggedProvider();
  var st = platformStatus(activeAccountProvider);
  var meta = platformMeta(activeAccountProvider);
  var chip = document.getElementById('account-provider-chip');
  var avatar = document.getElementById('user-modal-avatar');
  var name = document.getElementById('user-modal-name');
  var vipEl = document.getElementById('user-modal-vip');
  var hint = document.getElementById('account-hint');
  var logoutBtn = document.getElementById('account-logout-btn');
  var addNetease = document.getElementById('account-add-netease');
  var addQQ = document.getElementById('account-add-qq');
  var addKugou = document.getElementById('account-add-kugou');
  var addQishui = document.getElementById('account-add-qishui');
  var addSpotify = document.getElementById('account-add-spotify');
  if (chip) {
    chip.className = 'account-provider-chip ' + activeAccountProvider;
    chip.innerHTML = '<span class="account-source-dot ' + meta.dot + '"></span><span>' + meta.label + '</span>';
  }
  if (avatar) avatar.src = providerAvatarSrc(activeAccountProvider, st);
  if (name) name.textContent = (st && st.nickname) || meta.label;
  if (vipEl) {
    if (activeAccountProvider === 'netease') {
      var neVipLevel = providerVipLevel('netease', st);
      var vipLabel = neVipLevel === 'svip' ? '小云 SVIP' : (neVipLevel === 'vip' ? '小云 VIP' : '普通用户');
      vipEl.textContent = 'UID: ' + ((st && st.userId) || '-') + '  /  ' + vipLabel;
      vipEl.style.color = hasProviderVip('netease', st) ? 'rgba(244,210,138,0.86)' : 'rgba(255,255,255,0.5)';
    } else if (activeAccountProvider === 'kugou') {
      var kgVipLevel = providerVipLevel('kugou', st);
      var kgVipLabel = kgVipLevel === 'svip' ? '小狗 SVIP 会员' : (kgVipLevel === 'vip' ? '小狗 VIP 会员' : '小狗会话');
      vipEl.textContent = 'UID: ' + ((st && st.userId) || '-') + '  /  ' + kgVipLabel;
      vipEl.style.color = hasProviderVip('kugou', st) ? 'rgba(86,224,255,0.86)' : 'rgba(86,224,255,0.58)';
    } else if (activeAccountProvider === 'qishui') {
      var qishuiMode = st && st.webSession ? '本机小汽会话已导入' : (st && st.tokenConfigured ? 'OpenAPI 授权已保存' : '小汽登录态未导入');
      var qishuiSync = st && st.webSession ? '可同步我的喜欢、歌单并直接播放' : '匹配源';
      vipEl.textContent = qishuiMode + '  /  ' + qishuiSync;
      vipEl.style.color = 'rgba(69,214,143,0.78)';
    } else if (activeAccountProvider === 'spotify') {
      var spProduct = st && st.product === 'premium' ? 'Spotify Premium' : (st && st.product ? ('Spotify ' + String(st.product).toUpperCase()) : 'Spotify 方案未知');
      vipEl.textContent = 'ID: ' + ((st && st.userId) || '-') + '  /  ' + spProduct + '  /  可同步歌单和 Liked Songs';
      vipEl.style.color = hasProviderVip('spotify', st) ? 'rgba(30,215,96,0.86)' : 'rgba(30,215,96,0.60)';
    } else {
      var qqVipLevel = providerVipLevel('qq', st);
      var qqVipLabel = qqLoginNeedsAuthorizationRefresh(st) ? '小Q会员待同步' : (qqVipLevel === 'svip' ? '小Q SVIP 会员' : (qqVipLevel === 'vip' ? '小Q VIP 会员' : '小Q会话'));
      vipEl.textContent = 'UID: ' + ((st && st.userId) || '-') + '  /  ' + qqVipLabel;
      vipEl.style.color = qqLoginNeedsAuthorizationRefresh(st) ? 'rgba(255,232,174,0.86)' : (hasProviderVip('qq', st) ? 'rgba(0,245,212,0.82)' : 'rgba(0,245,212,0.58)');
    }
  }
  ['netease', 'qq', 'kugou', 'qishui', 'spotify', 'both'].forEach(function (key) {
    var btn = document.getElementById('user-provider-' + key);
    if (btn) btn.classList.toggle('active', key === 'both' ? dualAccountMode : (!dualAccountMode && activeAccountProvider === key));
  });
  if (addNetease) addNetease.style.display = hasPlatformLogin('netease') ? 'none' : '';
  if (addQQ) addQQ.textContent = hasPlatformLogin('qq') ? '查看小Q' : '补登小Q';
  if (addKugou) addKugou.textContent = hasPlatformLogin('kugou') ? '查看小狗' : '补登小狗';
  if (addQishui) addQishui.textContent = hasPlatformLogin('qishui') ? '重新导入小汽' : '导入小汽登录态';
  if (addSpotify) addSpotify.textContent = hasPlatformLogin('spotify') ? '查看 Spotify' : '连接 Spotify';
  if (logoutBtn) logoutBtn.textContent =
    activeAccountProvider === 'qq' ? '退出小Q' :
    (activeAccountProvider === 'kugou' ? '退出小狗' :
    (activeAccountProvider === 'qishui' ? '清除小汽登录态' :
    (activeAccountProvider === 'spotify' ? '退出 Spotify' : '退出小云')));
  if (hint) hint.textContent = dualAccountMode
    ? '右上角已切换为多平台并排展示。'
    : '可切换右上角展示的平台；“我两个都要”会并排显示当前已登录的平台。';
}
function showUserModal() {
  if (!hasAnyPlatformLogin()) return showLoginModal();
  updateUserModalUi();
  openGsapModal(document.getElementById('user-modal'));
  if (qqLoginStatus && qqLoginStatus.loggedIn && typeof refreshQQVipStatusNow === 'function') {
    refreshQQVipStatusNow('account-modal')
      .then(updateUserModalUi)
      .catch(function (e) { console.warn('QQ VIP modal refresh failed:', e); });
  }
}
function closeUserModal() { closeGsapModal(document.getElementById('user-modal')); }
function setActiveAccountProvider(provider) {
  provider = provider === 'qq' ? 'qq' : (provider === 'kugou' ? 'kugou' : (provider === 'qishui' ? 'qishui' : (provider === 'spotify' ? 'spotify' : 'netease')));
  if (!hasPlatformLogin(provider)) {
    openProviderLogin(provider);
    return;
  }
  activeAccountProvider = provider;
  dualAccountMode = false;
  renderUserBtn();
  updateUserModalUi();
}
function enableDualAccountView() {
  if (loggedProviderCount() < 2) {
    openProviderLogin(firstLoggedProvider() === 'netease' ? 'qq' : 'netease');
    return;
  }
  dualAccountMode = true;
  renderUserBtn();
  updateUserModalUi();
  showToast('已启用多平台账号展示');
}
function requestDualLoginMode() {
  enableDualAccountView();
}
function openProviderLogin(provider) {
  provider = provider === 'qq' ? 'qq' : (provider === 'kugou' ? 'kugou' : (provider === 'qishui' ? 'qishui' : (provider === 'spotify' ? 'spotify' : 'netease')));
  closeUserModal();
  loginProvider = provider;
  showLoginModal({ provider: provider });
}

var logoutAllAccountsResetBusy = false;

function logoutOperationFailure(result) {
  if (!result || result.status === 'rejected') {
    return String(result && result.reason && (result.reason.message || result.reason) || 'LOGOUT_OPERATION_REJECTED');
  }
  var value = result.value;
  if (value && (value.ok === false || value.success === false || value.error)) {
    return String(value.error || value.message || 'LOGOUT_OPERATION_FAILED');
  }
  return '';
}

function resetAllProviderRendererLoginState() {
  loginStatus = { loggedIn: false, vipType: 0, vipLevel: 'none', isVip: false, isSvip: false, vipLabel: '无VIP' };
  qqLoginStatus = { provider: 'qq', loggedIn: false, preview: false, nickname: '小Q', userId: '', avatar: '', vipType: 0, vipLevel: 'none', isVip: false, isSvip: false };
  kugouLoginStatus = { provider: 'kugou', loggedIn: false, preview: false, nickname: '小狗', userId: '', avatar: '', vipType: 0, vipLevel: 'none', isVip: false, isSvip: false, playbackKeyReady: false };
  qishuiLoginStatus = { provider: 'qishui', loggedIn: false, configured: false, oauthConfigured: false, oauthMissing: [], preview: false, nickname: '小汽', userId: '', avatar: '', vipType: 0, vipLevel: 'none', isVip: false, isSvip: false, playbackKeyReady: false, playbackMode: 'recommend-match' };
  spotifyLoginStatus = { provider: 'spotify', loggedIn: false, configured: false, oauthConfigured: false, oauthMissing: [], preview: false, nickname: 'Spotify', userId: '', avatar: '', product: '', vipType: 0, vipLevel: 'none', isVip: false, isSvip: false, playbackKeyReady: false, playbackMode: 'recommend-match', tokenConfigured: false, tokenFileExists: false, credentialsFileExists: false, localConfigMissing: false };
  loginStatusChecked = true;
  loginStatusCheckFailed = false;
  neteasePlaylists = [];
  qqPlaylists = [];
  kugouPlaylists = [];
  qishuiPlaylists = [];
  spotifyPlaylists = [];
  userPlaylists = [];
  myPodcastCollections = [];
  myPodcastItems = {};
  likedSongMap = {};
  dualAccountMode = false;
  activeAccountProvider = 'netease';
  playlistCatalogRevision += 1;
  if (typeof clearQQPlaybackVipEvidence === 'function') clearQQPlaybackVipEvidence();
  if (typeof homeDiscoverState !== 'undefined' && homeDiscoverState) {
    homeDiscoverState.loading = false;
    homeDiscoverState.loaded = true;
    homeDiscoverState.loggedIn = false;
    homeDiscoverState.mode = 'starter';
    homeDiscoverState.songs = [];
    homeDiscoverState.playlists = [];
    homeDiscoverState.podcasts = [];
  }
}

async function logoutAllAccounts() {
  if (logoutAllAccountsResetBusy) return;
  if (!window.confirm('退出全部平台并清除登录 Cookie？')) return;
  logoutAllAccountsResetBusy = true;
  var button = document.getElementById('login-reset-all-btn');
  if (button) {
    button.disabled = true;
    button.textContent = '正在清除…';
  }
  try {
    var operations = [
      apiJson('/api/logout'),
      apiJson('/api/qq/logout'),
      apiJson('/api/kugou/logout'),
      apiJson('/api/qishui/logout'),
      apiJson('/api/spotify/logout')
    ];
    var desktop = window.desktopWindow;
    if (desktop) {
      if (typeof desktop.clearNeteaseMusicLogin === 'function') operations.push(desktop.clearNeteaseMusicLogin());
      if (typeof desktop.clearQQMusicLogin === 'function') operations.push(desktop.clearQQMusicLogin());
      if (typeof desktop.clearKugouMusicLogin === 'function') operations.push(desktop.clearKugouMusicLogin());
      if (typeof desktop.clearQishuiMusicLogin === 'function') operations.push(desktop.clearQishuiMusicLogin());
      if (typeof desktop.clearSpotifyMusicLogin === 'function') operations.push(desktop.clearSpotifyMusicLogin());
    }
    var results = await Promise.allSettled(operations);
    var failures = results.map(logoutOperationFailure).filter(Boolean);
    if (failures.length) {
      throw new Error('LOGOUT_ALL_INCOMPLETE:' + failures.join('|'));
    }
    resetAllProviderRendererLoginState();
    closeCollectModal();
    closeUserModal();
    closeLoginModal();
    updateLikeButtons();
    safeRenderQueuePanel('logout-all-reset', { scrollCurrent: miniQueueOpen });
    renderUserBtn();
    safeShelfRebuild('logout-all-reset');
    homeSuppressed = false;
    homeForcedOpen = true;
    if (typeof setHomeControlsLocked === 'function') setHomeControlsLocked(true);
    if (typeof updateEmptyHomeVisibility === 'function') updateEmptyHomeVisibility({ forceLoad: false });
    if (typeof renderHomeDashboard === 'function') renderHomeDashboard();
    showToast('已退出全部账号');
  } catch (error) {
    console.warn('Logout all accounts failed:', error);
    await Promise.allSettled([
      refreshLoginStatus(true),
      refreshQQLoginStatus({ force: true }),
      refreshKugouLoginStatus(),
      refreshQishuiLoginStatus(),
      refreshSpotifyLoginStatus()
    ]);
    renderUserBtn();
    showToast('清理未完成，请重启后重试');
  } finally {
    logoutAllAccountsResetBusy = false;
    if (button) {
      button.disabled = false;
      button.textContent = '退出登录';
    }
  }
}

async function logoutActiveAccount() {
  if (activeAccountProvider === 'spotify') {
    try { await apiJson('/api/spotify/logout'); } catch (e) { }
    try {
      if (window.desktopWindow && typeof window.desktopWindow.clearSpotifyMusicLogin === 'function') {
        await window.desktopWindow.clearSpotifyMusicLogin();
      }
    } catch (e) { }
    spotifyLoginStatus = { provider: 'spotify', loggedIn: false, configured: false, oauthConfigured: false, oauthMissing: [], preview: false, nickname: 'Spotify', userId: '', avatar: '', product: '', vipType: 0, vipLevel: 'none', isVip: false, isSvip: false, playbackKeyReady: false, playbackMode: 'recommend-match', tokenConfigured: false, tokenFileExists: false, credentialsFileExists: false, localConfigMissing: false };
    spotifyPlaylists = [];
    userPlaylists = userPlaylists.filter(function (pl) { return pl.provider !== 'spotify'; });
    playlistCatalogRevision += 1;
    dualAccountMode = false;
    activeAccountProvider = firstLoggedProvider();
    renderUserBtn();
    safeShelfRebuild('spotify-logout');
    if (hasAnyPlatformLogin()) updateUserModalUi();
    else closeUserModal();
    showToast('已退出 Spotify');
    return;
  }
  if (activeAccountProvider === 'qishui') {
    try { await apiJson('/api/qishui/logout'); } catch (e) { }
    try {
      if (window.desktopWindow && typeof window.desktopWindow.clearQishuiMusicLogin === 'function') {
        await window.desktopWindow.clearQishuiMusicLogin();
      }
    } catch (e) { }
    qishuiLoginStatus = { provider: 'qishui', loggedIn: false, configured: false, oauthConfigured: false, oauthMissing: [], preview: false, nickname: '小汽', userId: '', avatar: '', vipType: 0, vipLevel: 'none', isVip: false, isSvip: false, playbackKeyReady: false, playbackMode: 'recommend-match' };
    qishuiPlaylists = [];
    userPlaylists = userPlaylists.filter(function (pl) { return pl.provider !== 'qishui'; });
    playlistCatalogRevision += 1;
    dualAccountMode = false;
    activeAccountProvider = firstLoggedProvider();
    renderUserBtn();
    safeShelfRebuild('qishui-logout');
    if (hasAnyPlatformLogin()) updateUserModalUi();
    else closeUserModal();
    showToast('已清除小汽授权');
    return;
  }
  if (activeAccountProvider === 'kugou') {
    try { await apiJson('/api/kugou/logout'); } catch (e) { }
    try {
      if (window.desktopWindow && typeof window.desktopWindow.clearKugouMusicLogin === 'function') {
        await window.desktopWindow.clearKugouMusicLogin();
      }
    } catch (e) { }
    kugouLoginStatus = { provider: 'kugou', loggedIn: false, preview: false, nickname: '小狗', userId: '', avatar: '', vipType: 0, vipLevel: 'none', isVip: false, isSvip: false, playbackKeyReady: false };
    kugouPlaylists = [];
    userPlaylists = userPlaylists.filter(function (pl) { return pl.provider !== 'kugou'; });
    playlistCatalogRevision += 1;
    dualAccountMode = false;
    activeAccountProvider = firstLoggedProvider();
    renderUserBtn();
    if (hasAnyPlatformLogin()) updateUserModalUi();
    else closeUserModal();
    showToast('已退出小狗');
    return;
  }
  if (activeAccountProvider === 'qq') {
    try { await apiJson('/api/qq/logout'); } catch (e) { }
    try {
      if (window.desktopWindow && typeof window.desktopWindow.clearQQMusicLogin === 'function') {
        await window.desktopWindow.clearQQMusicLogin();
      }
    } catch (e) { }
    if (typeof clearQQPlaybackVipEvidence === 'function') clearQQPlaybackVipEvidence();
    qqLoginStatus = { provider: 'qq', loggedIn: false, preview: false, nickname: '小Q', userId: '', avatar: '', vipType: 0, vipLevel: 'none', isVip: false, isSvip: false };
    qqPlaylists = [];
    userPlaylists = userPlaylists.filter(function (pl) { return pl.provider !== 'qq'; });
    playlistCatalogRevision += 1;
    dualAccountMode = false;
    activeAccountProvider = firstLoggedProvider();
    renderUserBtn();
    if (hasAnyPlatformLogin()) updateUserModalUi();
    else closeUserModal();
    showToast('已退出小Q');
    return;
  }
  doLogout();
}
async function doLogout() {
  await apiJson('/api/logout');
  try {
    if (window.desktopWindow && typeof window.desktopWindow.clearNeteaseMusicLogin === 'function') {
      await window.desktopWindow.clearNeteaseMusicLogin();
    }
  } catch (e) { }
  loginStatus = { loggedIn: false };
  neteasePlaylists = [];
  if (!hasPlatformLogin('netease') || loggedProviderCount() < 2) dualAccountMode = false;
  activeAccountProvider = firstLoggedProvider();
  userPlaylists = qqPlaylists.concat(kugouPlaylists || [], qishuiPlaylists || [], spotifyPlaylists || []);
  playlistCatalogRevision += 1;
  myPodcastCollections = [];
  myPodcastItems = {};
  likedSongMap = {};
  closeCollectModal();
  updateLikeButtons();
  safeRenderQueuePanel('logout', { scrollCurrent: miniQueueOpen });
  renderUserBtn();
  safeShelfRebuild('logout');
  closeUserModal();
  showToast('已退出登录');
}
