// 局域网遥控（渲染进程侧）。
// 服务端不持有播放状态，所以这里按固定节律把状态推到 /api/remote/state-push（回环）。
// 命令方向相反：手机 → 服务端 → main.js → 已有的 mineradio-cube-remote-command 频道，
// 不新增播放链入口。
var LAN_REMOTE_STORAGE_KEY = 'mineradio-lan-remote-enabled';
var LAN_REMOTE_PUSH_INTERVAL_MS = 1000;
var lanRemoteEnabled = false;
var lanRemotePushTimer = 0;
var lanRemotePairingTimer = 0;
var lanRemotePushInFlight = false;
var lanRemoteLastPushSignature = '';
var lanRemoteOperation = 0;

function lanRemoteReadStoredEnabled() {
  try { return localStorage.getItem(LAN_REMOTE_STORAGE_KEY) === '1'; } catch (e) { return false; }
}

function lanRemoteWriteStoredEnabled(value) {
  try { localStorage.setItem(LAN_REMOTE_STORAGE_KEY, value ? '1' : '0'); } catch (e) { }
}

// 不能把 cubeRemotePayload().cover 直接推给手机：那个值有四种形态，在手机上
// 全是坏的 —— blob: 只在本渲染进程文档内有效；/api/cover 被来源门禁挡成 403；
// http://127.0.0.1 指向手机自己的回环；data: 又可能是几百 KB。
// 这里只推「服务端能自己取到」的原始来源，由 /api/remote/cover 转发给手机。
function lanRemoteCoverSource() {
  var meta = typeof currentDesktopSongMeta === 'function' ? currentDesktopSongMeta() : {};
  var song = (typeof playQueue !== 'undefined' && playQueue && typeof currentIdx === 'number' && currentIdx >= 0)
    ? playQueue[currentIdx]
    : null;
  var candidates = [song && song.cover, meta && meta.cover];
  for (var i = 0; i < candidates.length; i++) {
    var raw = String(candidates[i] || '').trim();
    if (!raw) continue;
    if (/^data:image\//i.test(raw)) return { coverData: raw };
    if (/^https?:\/\//i.test(raw) && !/^https?:\/\/(127\.0\.0\.1|localhost)(?::\d+)?\//i.test(raw)) {
      return { coverUrl: raw };
    }
  }
  return {};
}

function lanRemoteStatePayload() {
  var base = typeof cubeRemotePayload === 'function' ? cubeRemotePayload() : {};
  var media = typeof audio !== 'undefined' ? audio : null;
  var cover = lanRemoteCoverSource();
  return {
    title: base.title || '未播放',
    artist: base.artist || '',
    coverUrl: cover.coverUrl || '',
    coverData: cover.coverData || '',
    playing: !!base.playing,
    volume: Number(base.volume) || 0,
    muted: !!base.muted,
    lyricsEnabled: !!base.lyricsEnabled,
    currentTime: media && isFinite(media.currentTime) ? media.currentTime : null,
    duration: media && isFinite(media.duration) ? media.duration : null,
    queueLength: typeof playQueue !== 'undefined' && playQueue ? playQueue.length : null,
    playMode: typeof playMode !== 'undefined' ? String(playMode || '') : '',
  };
}

// 进度每秒都在变，所以推送不做整体去重；只有在完全静止（暂停且身份未变）
// 时才跳过，避免闲置状态下每秒一次无意义写入。
// 签名里只放封面来源的长度和头部，不放整条 data URL：内嵌封面是几百 KB 的
// base64，每秒 join 一次会持续占用主线程（跟 cubeRemoteIdentitySignature 同一个理由）。
function lanRemotePushSignature(payload) {
  var coverKey = payload.coverUrl
    || (payload.coverData ? ('data:' + payload.coverData.length + ':' + payload.coverData.slice(0, 48)) : '');
  return [payload.title, payload.artist, payload.playing, payload.volume, payload.muted,
    payload.lyricsEnabled, coverKey, Math.floor(Number(payload.currentTime) || 0)].join('|');
}

function pushLanRemoteState() {
  if (!lanRemoteEnabled || lanRemotePushInFlight) return;
  var payload = lanRemoteStatePayload();
  var signature = lanRemotePushSignature(payload);
  if (signature === lanRemoteLastPushSignature) return;
  lanRemoteLastPushSignature = signature;
  lanRemotePushInFlight = true;
  fetch('/api/remote/state-push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(function () { /* 推送失败不影响播放 */ })
    .then(function () { lanRemotePushInFlight = false; });
}

function startLanRemotePush() {
  stopLanRemotePush();
  lanRemoteLastPushSignature = '';
  pushLanRemoteState();
  lanRemotePushTimer = setInterval(pushLanRemoteState, LAN_REMOTE_PUSH_INTERVAL_MS);
}

function stopLanRemotePush() {
  if (lanRemotePushTimer) clearInterval(lanRemotePushTimer);
  lanRemotePushTimer = 0;
}

function lanRemoteFormatExpiry(ms) {
  var seconds = Math.max(0, Math.round(Number(ms) / 1000));
  if (!seconds) return '已过期';
  var m = Math.floor(seconds / 60);
  var s = seconds % 60;
  return m > 0 ? ('剩 ' + m + ' 分 ' + s + ' 秒') : ('剩 ' + s + ' 秒');
}

// 用户手动选中的地址。服务端已经按「内核选路 → 非虚拟 → 家用网段」排好序，
// 默认取第一个；但启发式总有失手的可能（多网卡、VPN、桥接），所以留手动切换兜底。
var lanRemoteSelectedAddress = '';

function lanRemotePickAddress(addresses) {
  for (var i = 0; i < addresses.length; i++) {
    if (addresses[i].address === lanRemoteSelectedAddress) return addresses[i];
  }
  // 选过的网卡消失了（拔网线、关 VPN），回落到服务端排序的首位。
  lanRemoteSelectedAddress = '';
  return addresses[0] || null;
}

function lanRemoteBuildUrl(info, address) {
  return 'http://' + address + ':' + info.port + '/remote.html#' + (info.code || '');
}

// 二维码用 vendor 里的 qrcode-generator（纯前端，无依赖）。库缺失时静默降级成
// 只显示文字地址 —— 扫码是便利，手输 6 位配对码是等价路径，不能因为画不出码就挡住功能。
function renderLanRemoteQr(info, addresses) {
  var wrap = document.getElementById('lan-remote-qr');
  if (!wrap) return;
  var chosen = lanRemotePickAddress(addresses);

  if (!chosen || typeof qrcode !== 'function') {
    wrap.hidden = true;
    wrap.innerHTML = '';
    return;
  }
  var url = lanRemoteBuildUrl(info, chosen.address);
  try {
    var qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    // margin 的单位是像素，不是模块。QR 规范要求四周留 4 个模块的静区，
    // 所以这里必须是 cellSize * 4；传小值（比如 2px）静区不足会明显掉识别率。
    var cellSize = 4;
    var note = chosen.likelyVirtual
      ? '当前是虚拟网卡地址，手机多半连不上，点下面的地址可切换'
      : '扫码后点「配对」即可，配对码已带在链接里';
    wrap.innerHTML = qr.createSvgTag(cellSize, cellSize * 4, '局域网遥控二维码', url)
      + '<div class="lan-remote-qr-note">' + note + '</div>';
    wrap.hidden = false;
  } catch (err) {
    console.warn('LAN remote QR render failed:', err);
    wrap.hidden = true;
    wrap.innerHTML = '';
  }
}

function renderLanRemotePairing(info) {
  var codeEl = document.getElementById('lan-remote-code');
  var hintEl = document.getElementById('lan-remote-code-hint');
  var urlsEl = document.getElementById('lan-remote-urls');
  var devicesEl = document.getElementById('lan-remote-devices');
  if (!codeEl || !urlsEl) return;

  if (!info || info.ok !== true) {
    codeEl.textContent = '------';
    if (hintEl) hintEl.textContent = '读取配对码失败';
    urlsEl.innerHTML = '';
    return;
  }

  // 码和二维码常驻显示：随时能加设备，不用先点按钮。服务端保证读到的码总是有效的
  // （缺码或过期就地补一个），所以屏幕上不会出现扫了配不上的死码。
  codeEl.textContent = String(info.code || '------');
  if (hintEl) {
    hintEl.textContent = lanRemoteFormatExpiry(info.expiresInMs) + ' · 配对成功后自动换新码';
  }

  var addresses = Array.isArray(info.lanAddresses) ? info.lanAddresses : [];
  renderLanRemoteQr(info, addresses);
  if (!addresses.length) {
    urlsEl.innerHTML = '<div class="lan-remote-url">没找到局域网地址，确认电脑已连接 Wi-Fi 或有线网络</div>';
  } else {
    var chosen = lanRemotePickAddress(addresses);
    var chosenAddress = chosen ? chosen.address : '';
    urlsEl.innerHTML = addresses.map(function (item) {
      var url = lanRemoteBuildUrl(info, item.address);
      var tags = [];
      if (item.primary) tags.push('系统出网网卡');
      if (item.likelyVirtual) tags.push('虚拟网卡，多半不通');
      return '<div class="lan-remote-url' + (item.address === chosenAddress ? ' active' : '')
        + '" role="button" tabindex="0" data-lan-remote-address="' + item.address + '"'
        + ' title="点击用这个地址生成二维码">'
        + '<div class="lan-remote-url-text">' + url + '</div>'
        + '<div class="lan-remote-url-meta">' + (item.name || '')
        + (tags.length ? ' · ' + tags.join(' · ') : '') + '</div>'
        + '<button class="lan-remote-url-copy" type="button" data-lan-remote-copy="' + url
        + '" aria-label="复制地址">复制</button>'
        + '</div>';
    }).join('');

    // 整行点击=切换二维码（用户明确要的交互）；复制独立成按钮，避免两个动作抢同一次点击。
    urlsEl.querySelectorAll('[data-lan-remote-address]').forEach(function (node) {
      function selectThis() {
        lanRemoteSelectedAddress = node.getAttribute('data-lan-remote-address') || '';
        renderLanRemotePairing(info);
      }
      node.addEventListener('click', function (e) {
        if (e.target && e.target.hasAttribute && e.target.hasAttribute('data-lan-remote-copy')) return;
        selectThis();
      });
      node.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectThis(); }
      });
    });
    urlsEl.querySelectorAll('[data-lan-remote-copy]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var text = btn.getAttribute('data-lan-remote-copy') || '';
        // 必须走 writeAppClipboardText：navigator.clipboard 在本应用里会被
        // 权限处理器拒掉（clipboard-write 不在白名单内），静默失败。
        var writer = typeof writeAppClipboardText === 'function'
          ? writeAppClipboardText(text)
          : Promise.resolve(false);
        Promise.resolve(writer).then(function (ok) {
          if (typeof showToast === 'function') showToast(ok ? '地址已复制' : '复制失败，可长按选中地址');
        });
      });
    });
  }

  if (devicesEl) {
    var devices = Array.isArray(info.pairedDevices) ? info.pairedDevices : [];
    var deviceText = '已配对设备：' + devices.length + ' 台';
    // 被爆破作废过要说清楚 —— 否则用户只看到码变了，不知道刚有人在猜。
    if (info.lastLockoutAt) deviceText += ' · 上一个配对码因连续输错 5 次已作废';
    devicesEl.textContent = deviceText;
  }

  // 这条是能不能用起来的前提，单独一块显眼展示，不塞在设备数后面。
  var reachEl = document.getElementById('lan-remote-reach');
  if (reachEl) {
    reachEl.hidden = info.lanReachable === true;
    reachEl.textContent = '当前服务只监听本机，手机还连不上。需要以 MINERADIO_HOST=0.0.0.0 启动 Mineradio 才能对局域网开放。';
  }
}

function refreshLanRemotePairing(rotate) {
  var box = document.getElementById('lan-remote-box');
  if (!box || box.hidden) return Promise.resolve(null);
  return fetch('/api/remote/pairing', {
    method: rotate ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
  }).then(function (res) { return res.json(); })
    .then(function (info) { renderLanRemotePairing(info); return info; })
    .catch(function () { renderLanRemotePairing(null); return null; });
}

function startLanRemotePairingRefresh() {
  stopLanRemotePairingRefresh();
  refreshLanRemotePairing(false);
  // 每 15 秒刷一次，主要是让「剩余有效时间」和已配对设备数跟得上。
  lanRemotePairingTimer = setInterval(function () { refreshLanRemotePairing(false); }, 15000);
}

function stopLanRemotePairingRefresh() {
  if (lanRemotePairingTimer) clearInterval(lanRemotePairingTimer);
  lanRemotePairingTimer = 0;
}

function revokeLanRemoteDevices() {
  fetch('/api/remote/revoke', { method: 'POST', headers: { 'Content-Type': 'application/json' } })
    .then(function (res) { return res.json(); })
    .then(function (result) {
      if (result && result.ok) {
        if (typeof showToast === 'function') {
          showToast(result.removed ? ('已移除 ' + result.removed + ' 台设备') : '没有已配对的设备');
        }
        refreshLanRemotePairing(false);
      }
    })
    .catch(function () {
      if (typeof showToast === 'function') showToast('移除设备失败');
    });
}

function updateLanRemoteControls() {
  var toggle = document.getElementById('t-lanRemote');
  if (toggle) toggle.classList.toggle('on', lanRemoteEnabled);
  var box = document.getElementById('lan-remote-box');
  if (box) box.hidden = !lanRemoteEnabled;
}

// 起停服务端的遥控监听器。主端口永远只绑回环，手机连的是这个独立监听器，
// 所以开关必须真的把它拉起来 —— 否则界面开了但端口不存在。
function requestLanRemoteListener(enabled) {
  return fetch('/api/remote/listener', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: enabled === true }),
  }).then(function (res) { return res.json(); })
    .catch(function () { return null; });
}

function setLanRemoteEnabled(enabled, options) {
  options = options || {};
  var operation = ++lanRemoteOperation;
  lanRemoteEnabled = enabled === true;
  lanRemoteWriteStoredEnabled(lanRemoteEnabled);
  updateLanRemoteControls();
  if (lanRemoteEnabled) {
    startLanRemotePush();
    return requestLanRemoteListener(true).then(function (result) {
      if (operation !== lanRemoteOperation) return false;
      if (!result || result.ok !== true || !result.running) {
        // 监听器起不来（端口全被占等），别让开关停在「已开启」的假象上。
        lanRemoteEnabled = false;
        lanRemoteWriteStoredEnabled(false);
        updateLanRemoteControls();
        stopLanRemotePush();
        if (typeof showToast === 'function') {
          showToast('局域网遥控启动失败：' + ((result && result.error) || '端口不可用'));
        }
        return false;
      }
      startLanRemotePairingRefresh();
      if (!options.quiet && typeof showToast === 'function') {
        showToast('局域网遥控已开启（端口 ' + result.port + '）');
      }
      return true;
    });
  }
  stopLanRemotePush();
  stopLanRemotePairingRefresh();
  return requestLanRemoteListener(false).then(function (result) {
    if (operation !== lanRemoteOperation) return false;
    if (!result || result.ok !== true || result.running) {
      if (typeof showToast === 'function') {
        showToast('局域网遥控关闭失败：' + ((result && result.error) || '服务未响应'));
      }
      return false;
    }
    if (!options.quiet && typeof showToast === 'function') showToast('局域网遥控已关闭');
    return true;
  });
}

function toggleLanRemote() {
  setLanRemoteEnabled(!lanRemoteEnabled);
}

function hydrateLanRemote() {
  var stored = lanRemoteReadStoredEnabled();
  lanRemoteEnabled = false;
  updateLanRemoteControls();
  // 监听器是进程内状态，重启后不会自己回来。上次开着的话这里重新拉起，
  // 走 setLanRemoteEnabled 是为了复用「起不来就把开关退回关闭」那条逻辑。
  if (stored) setLanRemoteEnabled(true, { quiet: true });
}
