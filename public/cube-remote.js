// 音乐遥控器 · 多皮肤
// skin: cube | bar | moon
(function () {
  'use strict';

  var SKINS = {
    cube: { width: 136, height: 136 },
    bar: { width: 320, height: 84 },
    moon: { width: 248, height: 248 },
  };

  var state = {
    enabled: false,
    skin: 'cube',
    title: '未播放',
    artist: '',
    cover: '',
    playing: false,
    volume: 0.85,
    muted: false,
    lyricsEnabled: false,
    mainVisible: true,
  };

  var lastCover = '';
  var lastSkin = '';
  var dragging = false;
  var dragTarget = null;
  var dragPointerId = null;
  var dragLast = { x: 0, y: 0 };
  var moved = false;

  function clampSkin(value) {
    value = String(value || 'cube');
    return SKINS[value] ? value : 'cube';
  }

  function send(command, payload) {
    if (!window.desktopOverlay || !window.desktopOverlay.sendCubeCommand) return;
    window.desktopOverlay.sendCubeCommand(command, payload || {}).catch(function () {});
  }

  function activeRoot() {
    return document.getElementById('skin-' + state.skin);
  }

  function applySkin() {
    var skin = clampSkin(state.skin);
    state.skin = skin;
    document.body.dataset.skin = skin;
    if (skin !== lastSkin) {
      lastSkin = skin;
      lastCover = '';
      requestResize(true);
    }
  }

  function applyState(next) {
    next = next || {};
    state = Object.assign({}, state, next);
    state.skin = clampSkin(state.skin);
    state.title = String(state.title || '未播放').trim() || '未播放';
    state.artist = String(state.artist || '').trim();
    state.cover = String(state.cover || '').trim();

    document.body.classList.toggle('show', !!state.enabled);
    applySkin();

    document.querySelectorAll('[data-field="title"]').forEach(function (el) {
      el.textContent = state.title;
    });
    document.querySelectorAll('[data-field="artist"]').forEach(function (el) {
      el.textContent = state.artist;
    });

    document.querySelectorAll('.play-btn').forEach(function (btn) {
      btn.classList.toggle('is-playing', !!state.playing);
      btn.setAttribute('aria-label', state.playing ? '暂停' : '播放');
      btn.title = state.playing ? '暂停' : '播放';
    });

    document.querySelectorAll('.open-btn, .pad-up').forEach(function (btn) {
      btn.classList.toggle('main-visible', !!state.mainVisible);
      btn.title = state.mainVisible ? '隐藏主程序' : '打开主程序';
      btn.setAttribute('aria-label', btn.title);
    });

    document.querySelectorAll('.lyrics-btn, .pad-down').forEach(function (btn) {
      btn.classList.toggle('active', !!state.lyricsEnabled);
    });

    document.querySelectorAll('.cube-volume').forEach(function (input) {
      input.value = String(state.muted ? 0 : state.volume);
    });

    if (state.cover !== lastCover) {
      lastCover = state.cover;
      document.querySelectorAll('.cover').forEach(function (img) {
        var btn = img.closest('.play-btn');
        if (state.cover) {
          img.src = state.cover;
          if (btn) btn.classList.add('has-cover');
        } else {
          img.removeAttribute('src');
          if (btn) btn.classList.remove('has-cover');
        }
      });
    }
  }

  function requestResize(force) {
    if (!window.desktopOverlay || !window.desktopOverlay.resizeCube) return;
    var size = SKINS[state.skin] || SKINS.cube;
    window.desktopOverlay.resizeCube({
      skin: state.skin,
      width: size.width,
      height: size.height,
      force: !!force,
    }).catch(function () {});
  }

  document.addEventListener('click', function (evt) {
    var btn = evt.target.closest('[data-cmd]');
    if (!btn) return;
    if (moved) return;
    evt.stopPropagation();
    send(btn.getAttribute('data-cmd'));
  });

  document.querySelectorAll('.cube-volume').forEach(function (input) {
    input.addEventListener('input', function () {
      send('set-volume', { value: Number(input.value) || 0 });
    });
  });

  function beginDrag(evt) {
    if (evt.button !== 0) return;
    dragging = true;
    moved = false;
    document.body.classList.add('dragging');
    dragLast.x = evt.screenX;
    dragLast.y = evt.screenY;
    dragTarget = evt.target.closest('.play-btn, [data-drag-handle]') || evt.target.closest('.skin') || activeRoot();
    dragPointerId = evt.pointerId;
    try { dragTarget.setPointerCapture(dragPointerId); } catch (e) {}
  }

  document.addEventListener('pointerdown', function (evt) {
    if (evt.button !== 0) return;
    if (evt.target.closest('input')) return;
    if (evt.target.closest('[data-cmd]') && !evt.target.closest('.play-btn') && !evt.target.closest('[data-drag-handle]')) return;
    if (evt.target.closest('.play-btn') || evt.target.closest('[data-drag-handle]') || evt.target.closest('.skin')) {
      beginDrag(evt);
    }
  });

  window.addEventListener('pointermove', function (evt) {
    if (!dragging) return;
    var dx = evt.screenX - dragLast.x;
    var dy = evt.screenY - dragLast.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
    dragLast.x = evt.screenX;
    dragLast.y = evt.screenY;
    if ((dx || dy) && window.desktopOverlay && window.desktopOverlay.moveCubeBy) {
      window.desktopOverlay.moveCubeBy(dx, dy).catch(function () {});
    }
  });

  function endDrag() {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('dragging');
    var target = dragTarget;
    var pointerId = dragPointerId;
    dragTarget = null;
    dragPointerId = null;
    try {
      if (target && target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
    } catch (e) {}
    setTimeout(function () { moved = false; }, 0);
  }
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);
  document.addEventListener('lostpointercapture', endDrag);
  window.addEventListener('blur', endDrag);

  window.__mineradioCubeApplyState = applyState;
  window.addEventListener('message', function (event) {
    var data = event && event.data;
    if (!data || data.type !== 'mineradio-cube-remote-state') return;
    applyState(data.payload || {});
  });
  if (window.desktopOverlay && window.desktopOverlay.onCubeState) {
    window.desktopOverlay.onCubeState(applyState);
  }
  try {
    var raw = new URLSearchParams(window.location.search).get('state');
    if (raw) applyState(JSON.parse(raw));
  } catch (e) {}

  requestResize(true);
})();
