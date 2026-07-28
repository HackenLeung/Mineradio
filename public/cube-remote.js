(function () {
  'use strict';

  var sizes = { cube: { width: 136, height: 136 }, bar: { width: 320, height: 84 }, moon: { width: 248, height: 248 } };
  var state = { enabled: false, skin: 'cube', title: '未播放', artist: '', cover: '', playing: false, volume: 0.85, muted: false, lyricsEnabled: false, mainVisible: true };
  var dragging = false;
  var moved = false;
  var pointerId = null;
  var dragTarget = null;
  var lastPoint = { x: 0, y: 0 };
  var wheelTotal = 0;
  var wheelTimer = 0;

  function skin(value) { return sizes[value] ? value : 'cube'; }
  function send(command, payload) {
    if (!window.desktopOverlay || typeof window.desktopOverlay.sendCubeCommand !== 'function') return;
    window.desktopOverlay.sendCubeCommand(command, payload || {}).catch(function () {});
  }
  function resize() {
    if (!window.desktopOverlay || typeof window.desktopOverlay.resizeCube !== 'function') return;
    window.desktopOverlay.resizeCube({ skin: state.skin }).catch(function () {});
  }
  function applyState(next) {
    next = next || {};
    var previousSkin = state.skin;
    state = Object.assign({}, state, next);
    state.skin = skin(state.skin);
    document.body.dataset.skin = state.skin;
    document.body.classList.toggle('visible', !!state.enabled);
    document.querySelectorAll('[data-field="title"]').forEach(function (node) { node.textContent = state.title || '未播放'; });
    document.querySelectorAll('[data-field="artist"]').forEach(function (node) { node.textContent = state.artist || ''; });
    document.querySelectorAll('.cover-button').forEach(function (button) {
      button.classList.toggle('is-playing', !!state.playing);
      button.title = state.playing ? '暂停' : '播放';
      button.setAttribute('aria-label', button.title);
      button.classList.toggle('has-cover', !!state.cover);
      var image = button.querySelector('.cover');
      if (!image) return;
      if (state.cover) image.src = state.cover;
      else image.removeAttribute('src');
    });
    document.querySelectorAll('.lyrics-button').forEach(function (button) { button.classList.toggle('lyrics-active', !!state.lyricsEnabled); });
    document.querySelectorAll('.main-button').forEach(function (button) { button.classList.toggle('main-visible', !!state.mainVisible); });
    document.querySelectorAll('.volume-input').forEach(function (input) { input.value = String(state.muted ? 0 : state.volume); });
    if (previousSkin !== state.skin) resize();
  }

  document.addEventListener('click', function (event) {
    var button = event.target.closest('[data-command]');
    if (!button || moved) return;
    event.preventDefault();
    send(button.dataset.command);
  });
  document.querySelectorAll('.volume-input').forEach(function (input) {
    input.addEventListener('input', function () { send('set-volume', { value: Number(input.value) || 0 }); });
  });
  document.addEventListener('wheel', function (event) {
    if (!state.enabled || !event.target.closest('.skin')) return;
    event.preventDefault();
    wheelTotal += Number(event.deltaY) || 0;
    if (wheelTimer) clearTimeout(wheelTimer);
    wheelTimer = setTimeout(function () { wheelTotal = 0; }, 180);
    if (Math.abs(wheelTotal) < (event.deltaMode === 0 ? 40 : 1)) return;
    var direction = wheelTotal < 0 ? 1 : -1;
    wheelTotal = 0;
    var current = state.muted ? 0 : Number(state.volume) || 0;
    var next = Math.max(0, Math.min(1, Math.round((current + direction * 0.05) * 100) / 100));
    state.volume = next;
    state.muted = next <= 0.001;
    document.querySelectorAll('.volume-input').forEach(function (input) { input.value = String(next); });
    send('set-volume', { value: next });
  }, { passive: false });

  document.addEventListener('pointerdown', function (event) {
    if (event.button !== 0 || event.target.closest('input')) return;
    var target = event.target.closest('.drag-handle');
    if (!target) return;
    dragging = true;
    moved = false;
    pointerId = event.pointerId;
    dragTarget = target;
    lastPoint = { x: event.screenX, y: event.screenY };
    document.body.classList.add('dragging');
    if (window.desktopOverlay && window.desktopOverlay.setCubeDragging) window.desktopOverlay.setCubeDragging(true).catch(function () {});
    try { target.setPointerCapture(pointerId); } catch (_) {}
  });
  window.addEventListener('pointermove', function (event) {
    if (!dragging) return;
    var dx = event.screenX - lastPoint.x;
    var dy = event.screenY - lastPoint.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
    lastPoint = { x: event.screenX, y: event.screenY };
    if ((dx || dy) && window.desktopOverlay && window.desktopOverlay.moveCubeBy) window.desktopOverlay.moveCubeBy(dx, dy).catch(function () {});
  });
  function endDrag() {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('dragging');
    if (window.desktopOverlay && window.desktopOverlay.setCubeDragging) window.desktopOverlay.setCubeDragging(false).catch(function () {});
    try { if (dragTarget && dragTarget.hasPointerCapture(pointerId)) dragTarget.releasePointerCapture(pointerId); } catch (_) {}
    dragTarget = null;
    pointerId = null;
    setTimeout(function () { moved = false; }, 0);
  }
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);
  window.addEventListener('blur', endDrag);

  if (window.desktopOverlay && typeof window.desktopOverlay.onCubeState === 'function') window.desktopOverlay.onCubeState(applyState);
  resize();
}());
