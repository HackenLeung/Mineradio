'use strict';
// 局域网遥控页面。只跟 /api/remote/* 说话，所有请求带 token。
// 命令不直接碰播放链：服务端把它转成渲染进程已有的遥控频道。
(function () {
  var TOKEN_KEY = 'mineradio-remote-token';
  var POLL_INTERVAL_MS = 1000;
  var POLL_IDLE_MS = 4000;

  var els = {};
  ['pair-view', 'control-view', 'code-input', 'pair-btn', 'pair-msg', 'cover', 'cover-fallback',
    'title', 'artist', 'time-now', 'time-total', 'progress-fill', 'btn-prev', 'btn-play', 'btn-next',
    'play-icon', 'volume', 'volume-label', 'btn-mute', 'btn-lyrics', 'stale-note', 'unpair-btn',
  ].forEach(function (id) { els[id] = document.getElementById(id); });

  var token = '';
  try { token = localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { token = ''; }
  var pollTimer = 0;
  var volumeHeldUntil = 0;
  var lastRenderedVolume = -1;

  function formatTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '0:00';
    var total = Math.floor(seconds);
    var m = Math.floor(total / 60);
    var s = total % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function showPairView(message, isError) {
    els['control-view'].hidden = true;
    els['pair-view'].hidden = false;
    els['pair-msg'].textContent = message || '';
    els['pair-msg'].className = 'msg' + (isError ? ' error' : '');
  }

  function showControlView() {
    els['pair-view'].hidden = true;
    els['control-view'].hidden = false;
  }

  function api(path, options) {
    options = options || {};
    var headers = { 'Content-Type': 'application/json' };
    if (token) headers['X-Mineradio-Token'] = token;
    return fetch(path, {
      method: options.method || 'GET',
      headers: headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      cache: 'no-store',
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (json) {
        return { status: res.status, json: json };
      });
    });
  }

  // ---------- 配对 ----------
  function submitPairing() {
    var code = String(els['code-input'].value || '').replace(/\D/g, '');
    if (code.length !== 6) {
      showPairView('请输入 6 位数字配对码', true);
      return;
    }
    els['pair-btn'].disabled = true;
    els['pair-msg'].textContent = '配对中…';
    els['pair-msg'].className = 'msg';
    api('/api/remote/pair', { method: 'POST', body: { code: code, label: navigator.platform || '手机' } })
      .then(function (result) {
        els['pair-btn'].disabled = false;
        if (result.json && result.json.ok && result.json.token) {
          token = result.json.token;
          try { localStorage.setItem(TOKEN_KEY, token); } catch (e) { }
          els['code-input'].value = '';
          els['pair-msg'].textContent = '';
          els['pair-msg'].className = 'msg';
          if (location.hash) history.replaceState(null, '', location.pathname);
          showControlView();
          startPolling(true);
          return;
        }
        showPairView(pairingErrorText(result.json), true);
      })
      .catch(function () {
        els['pair-btn'].disabled = false;
        showPairView('连不上 Mineradio，确认和电脑在同一个网络', true);
      });
  }

  function pairingErrorText(json) {
    var error = json && json.error;
    if (json && json.message) return json.message;
    if (error === 'PAIRING_LOCKED') return '尝试次数过多，配对码已作废。请在电脑上重新生成。';
    if (error === 'PAIRING_CODE_EXPIRED') return '配对码已过期，请在电脑上重新生成。';
    if (error === 'PAIRING_CODE_UNAVAILABLE') return '电脑端还没生成配对码。';
    if (error === 'PAIRING_CODE_INVALID') {
      var left = json && json.remainingAttempts;
      return '配对码不对' + (typeof left === 'number' ? '，还可以试 ' + left + ' 次' : '');
    }
    return '配对失败：' + (error || '未知错误');
  }

  // ---------- 状态渲染 ----------
  function renderState(payload) {
    var state = payload && payload.state;
    if (!state) {
      els['title'].textContent = '未播放';
      els['artist'].textContent = '';
      els['cover'].hidden = true;
      els['cover-fallback'].hidden = false;
      return;
    }
    els['title'].textContent = state.title || '未播放';
    els['artist'].textContent = state.artist || '';

    // <img> 没法带自定义请求头，所以封面的 token 走 query（服务端两种都认）。
    if (state.cover) {
      var coverSrc = state.cover + (state.cover.indexOf('?') >= 0 ? '&' : '?')
        + 'token=' + encodeURIComponent(token);
      if (els['cover'].getAttribute('src') !== coverSrc) els['cover'].src = coverSrc;
      els['cover'].hidden = false;
      els['cover-fallback'].hidden = true;
    } else {
      els['cover'].removeAttribute('src');
      els['cover'].hidden = true;
      els['cover-fallback'].hidden = false;
    }

    els['play-icon'].innerHTML = state.playing
      ? '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>'
      : '<polygon points="6 3 20 12 6 21 6 3"/>';

    var now = Number(state.currentTime);
    var total = Number(state.duration);
    els['time-now'].textContent = formatTime(now);
    els['time-total'].textContent = formatTime(total);
    els['progress-fill'].style.width = (isFinite(now) && isFinite(total) && total > 0)
      ? Math.max(0, Math.min(100, (now / total) * 100)) + '%'
      : '0%';

    // 拖动音量时不要被轮询回来的旧值拽回去。
    var volumePct = Math.round(Math.max(0, Math.min(1, Number(state.volume) || 0)) * 100);
    if (Date.now() > volumeHeldUntil && volumePct !== lastRenderedVolume) {
      els['volume'].value = String(volumePct);
      lastRenderedVolume = volumePct;
    }
    els['volume-label'].textContent = volumePct + '%';
    els['btn-mute'].textContent = state.muted ? '取消静音' : '静音';
    els['btn-lyrics'].textContent = state.lyricsEnabled ? '关闭桌面歌词' : '桌面歌词';

    if (payload.stale) {
      els['stale-note'].hidden = false;
      els['stale-note'].textContent = 'Mineradio 有几秒没上报状态了。可能是电脑端已关闭，或没有开启局域网遥控。';
    } else {
      els['stale-note'].hidden = true;
    }
  }

  function pollOnce() {
    if (!token) return Promise.resolve();
    return api('/api/remote/state').then(function (result) {
      if (result.status === 401) {
        token = '';
        try { localStorage.removeItem(TOKEN_KEY); } catch (e) { }
        stopPolling();
        showPairView('这台设备的授权已被撤销，请重新配对。', true);
        return;
      }
      if (result.json && result.json.ok) renderState(result.json);
    }).catch(function () { /* 轮询失败静默重试 */ });
  }

  function startPolling(immediate) {
    stopPolling();
    if (immediate) pollOnce();
    pollTimer = setInterval(pollOnce, document.hidden ? POLL_IDLE_MS : POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = 0;
  }

  // ---------- 命令 ----------
  function sendCommand(command, value) {
    if (!token) return;
    var body = { command: command };
    if (value != null) body.value = value;
    api('/api/remote/command', { method: 'POST', body: body }).then(function (result) {
      if (result.status === 401) {
        token = '';
        try { localStorage.removeItem(TOKEN_KEY); } catch (e) { }
        stopPolling();
        showPairView('这台设备的授权已被撤销，请重新配对。', true);
        return;
      }
      if (result.status === 503) {
        els['stale-note'].hidden = false;
        els['stale-note'].textContent = 'Mineradio 主窗口不可用，命令没有送达。';
        return;
      }
      // 命令生效后立刻拉一次，别等下一个轮询周期。
      setTimeout(pollOnce, 120);
    }).catch(function () { });
  }

  els['pair-btn'].addEventListener('click', submitPairing);
  els['code-input'].addEventListener('keydown', function (e) {
    if (e.key === 'Enter') submitPairing();
  });
  els['btn-prev'].addEventListener('click', function () { sendCommand('previous'); });
  els['btn-play'].addEventListener('click', function () { sendCommand('toggle-play'); });
  els['btn-next'].addEventListener('click', function () { sendCommand('next'); });
  els['btn-mute'].addEventListener('click', function () { sendCommand('mute'); });
  els['btn-lyrics'].addEventListener('click', function () { sendCommand('toggle-lyrics'); });

  els['volume'].addEventListener('input', function () {
    var pct = Number(els['volume'].value) || 0;
    volumeHeldUntil = Date.now() + 900;
    lastRenderedVolume = pct;
    els['volume-label'].textContent = pct + '%';
  });
  els['volume'].addEventListener('change', function () {
    var pct = Number(els['volume'].value) || 0;
    volumeHeldUntil = Date.now() + 900;
    sendCommand('set-volume', pct / 100);
  });

  els['unpair-btn'].addEventListener('click', function () {
    token = '';
    try { localStorage.removeItem(TOKEN_KEY); } catch (e) { }
    stopPolling();
    showPairView('已断开。重新输入配对码可再次连接。', false);
  });

  document.addEventListener('visibilitychange', function () {
    if (!token) return;
    startPolling(!document.hidden);
  });

  // 扫码进来时配对码在 URL fragment 里：fragment 不随请求发到服务端、
  // 不进服务端日志、不进 Referer，比放 query 干净。
  var hashCode = String(location.hash || '').replace(/[^0-9]/g, '');
  if (hashCode.length === 6) els['code-input'].value = hashCode;

  if (token) {
    showControlView();
    startPolling(true);
  } else {
    showPairView(hashCode.length === 6 ? '已从二维码读到配对码，点配对即可。' : '', false);
  }
})();
