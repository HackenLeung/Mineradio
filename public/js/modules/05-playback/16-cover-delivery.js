// ============================================================
//  音乐库歌曲卡片 -> 播放器封面投递
//
//  这条路径只负责“视觉交接”。真正的队列导入、音频解析和 autoplay
//  仍由音乐库原有播放入口负责，因此不会复制播放状态机。
//
//  - GSAP：DOM 封面缩放、二次贝塞尔抛物线、到达后的 yoyo 呼吸
//  - Three.js Points：短生命周期的卡片 -> 播放器音波粒子
//  - 现有 uniforms / triggerRipple：和主封面粒子、节奏分析共享实时驱动
// ============================================================

var coverDeliveryState = {
  token: 0,
  active: null,
  bursts: [],
  lyricsPulseToken: 0
};

var COVER_DELIVERY_TRAVEL_SEC = 0.84;
var COVER_DELIVERY_ARRIVAL_SEC = 0.82;
var COVER_DELIVERY_PARTICLE_LIFE_SEC = 1.24;

function coverDeliveryGsap() {
  return typeof window !== 'undefined' && window.gsap ? window.gsap : null;
}

function coverDeliveryClamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function coverDeliveryAudioValue(name, fallback) {
  try {
    var value = typeof window !== 'undefined' ? window[name] : undefined;
    if (value == null && name === 'bass' && typeof bass !== 'undefined') value = bass;
    if (value == null && name === 'beatPulse' && typeof beatPulse !== 'undefined') value = beatPulse;
    if (value == null && name === 'treble' && typeof treble !== 'undefined') value = treble;
    value = Number(value);
    return isFinite(value) ? value : fallback;
  } catch (e) {
    return fallback;
  }
}

function coverDeliveryLayer() {
  var layer = document.getElementById('cover-delivery-layer');
  if (layer) return layer;
  layer = document.createElement('div');
  layer.id = 'cover-delivery-layer';
  layer.setAttribute('aria-hidden', 'true');
  document.body.appendChild(layer);
  return layer;
}

function coverDeliveryRemoveFlight(state) {
  if (!state) return;
  if (state.timeline && state.timeline.kill) state.timeline.kill();
  if (state.flight && state.flight.parentNode) state.flight.parentNode.removeChild(state.flight);
  state.flight = null;
}

function coverDeliveryRemoveBurst(burst) {
  if (!burst) return;
  if (burst.points && burst.points.parent) burst.points.parent.remove(burst.points);
  if (burst.geometry) burst.geometry.dispose();
  if (burst.material) burst.material.dispose();
  burst.points = null;
}

function coverDeliveryBeginSource(state) {
  if (!state || state.sourceBegun) return;
  state.sourceBegun = true;
  if (state.source && typeof state.source.begin === 'function') {
    try { state.source.begin(); } catch (e) { console.warn('[CoverDeliverySourceBegin]', e); }
  }
}

function coverDeliveryEndSource(state) {
  if (!state || !state.sourceBegun) return;
  if (state.source && typeof state.source.end === 'function') {
    try { state.source.end(); } catch (e) { console.warn('[CoverDeliverySourceEnd]', e); }
  } else if (state.row && state.contentList && state.contentList.endCoverDelivery) {
    state.contentList.endCoverDelivery(state.row);
  }
  state.sourceBegun = false;
}

function coverDeliveryCancel(reason) {
  var state = coverDeliveryState.active;
  coverDeliveryState.token += 1;
  coverDeliveryState.lyricsPulseToken += 1;
  if (state) {
    if (state.timeline && state.timeline.kill) state.timeline.kill();
    coverDeliveryEndSource(state);
    coverDeliveryRemoveFlight(state);
  }
  for (var i = coverDeliveryState.bursts.length - 1; i >= 0; i--) {
    coverDeliveryRemoveBurst(coverDeliveryState.bursts[i]);
  }
  coverDeliveryState.bursts.length = 0;
  coverDeliveryState.active = null;
  if (typeof stageLyrics !== 'undefined' && stageLyrics) {
    var gsap = coverDeliveryGsap();
    if (gsap) gsap.killTweensOf(stageLyrics, 'deliveryScale');
    stageLyrics.deliveryScale = 1;
  }
  return reason || 'cancelled';
}

function coverDeliveryActive() {
  return !!(coverDeliveryState.active && !coverDeliveryState.active.committed);
}

// 所有实际切歌都会经过 playQueueAt。普通入口需要撤销仍在飞行的旧封面；
// 只有投递完成后携带同一 token 的回调才可以继续，过期回调绝不能干掉较新的投递。
function coverDeliveryPreparePlayback(opts) {
  opts = opts || {};
  if (opts.coverDeliveryToken != null) {
    var token = Number(opts.coverDeliveryToken);
    var state = coverDeliveryState.active;
    return isFinite(token) && !!state && state.committed && state.token === token;
  }
  coverDeliveryCancel('root-playback');
  return true;
}

// 播放操作由音乐库点击方提供。正常路径会等封面落位再启动音频，
// 而投递无法启动时仍能立即回退到原有播放状态机。
function coverDeliveryStartPlayback(state) {
  if (!state || state.playbackStarted || typeof state.onPlaybackReady !== 'function') return;
  state.playbackStarted = true;
  try {
    var playbackOptions = state.committed && state.token === coverDeliveryState.token && coverDeliveryState.active === state
      ? { coverDeliveryToken: state.token }
      : null;
    var result = state.onPlaybackReady(playbackOptions);
    if (result && typeof result.catch === 'function') result.catch(function (error) {
      console.warn('[CoverDeliveryPlayback]', error);
    });
  } catch (e) {
    console.warn('[CoverDeliveryPlayback]', e);
  }
}

function coverDeliveryAbort(state, reason) {
  if (!state || state.token !== coverDeliveryState.token || coverDeliveryState.active !== state) return;
  // 先恢复源卡片并销毁视觉资源。未完成投递不会携带 token，
  // 因此封面加载失败时仍会安全地回退到原有播放状态机。
  coverDeliveryCancel(reason || 'aborted');
  coverDeliveryStartPlayback(state);
}

// 在不触发视觉闪烁的情况下测量“播放器已弹出”后的封面位置。
// 点击时控制条可能处于 soft-hidden 或 home-controls-locked，直接取 rect
// 会多出底部 translateY；临时关闭 transition、测量、立刻恢复即可得到准确终点。
function coverDeliveryPlayerCoverRect() {
  var cover = document.getElementById('control-cover');
  if (!cover) return null;
  var bar = document.getElementById('bottom-bar');
  var body = document.body;
  if (!bar || !body) return cover.getBoundingClientRect();
  var hadVisible = bar.classList.contains('visible');
  var hadSoftHidden = bar.classList.contains('soft-hidden');
  var hadLocked = body.classList.contains('home-controls-locked');
  var previousTransition = bar.style.transition;
  bar.style.transition = 'none';
  body.classList.remove('home-controls-locked');
  bar.classList.add('visible');
  bar.classList.remove('soft-hidden');
  var rect = cover.getBoundingClientRect();
  if (hadVisible) bar.classList.add('visible');
  else bar.classList.remove('visible');
  if (hadSoftHidden) bar.classList.add('soft-hidden');
  else bar.classList.remove('soft-hidden');
  if (hadLocked) body.classList.add('home-controls-locked');
  bar.style.transition = previousTransition;
  return rect;
}

function coverDeliveryScreenToWorld(x, y, distance) {
  if (typeof THREE === 'undefined' || typeof camera === 'undefined' || !camera) return null;
  var ndc = new THREE.Vector3(
    (Number(x) / Math.max(1, innerWidth)) * 2 - 1,
    1 - (Number(y) / Math.max(1, innerHeight)) * 2,
    0.5
  );
  ndc.unproject(camera);
  var direction = ndc.sub(camera.position).normalize();
  return camera.position.clone().addScaledVector(direction, Math.max(0.1, Number(distance) || 4.8));
}

function coverDeliveryAccentColor() {
  if (typeof THREE === 'undefined') return null;
  var fallback = new THREE.Color(0xf4d28a);
  try {
    var hex = typeof shelfAccentHex === 'function'
      ? shelfAccentHex()
      : (typeof fx !== 'undefined' && fx ? fx.shelfAccentColor : '');
    if (hex) fallback.set(String(hex));
  } catch (e) { }
  return fallback;
}

function coverDeliveryParticleShader() {
  return {
    vertexShader: [
      'precision highp float;',
      'attribute float aSize;',
      'attribute float aAlpha;',
      'attribute vec3 color;',
      'varying vec3 vColor;',
      'varying float vAlpha;',
      'uniform float uSize;',
      'uniform float uBass;',
      'uniform float uBeat;',
      'uniform float uTreble;',
      'void main() {',
      '  vColor = color;',
      '  vAlpha = aAlpha;',
      '  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);',
      '  float drive = 1.0 + uBass * 0.30 + uBeat * 0.62 + uTreble * 0.20;',
      '  gl_PointSize = clamp(aSize * uSize * drive * (260.0 / max(1.0, -mvPosition.z)), 1.0, 26.0);',
      '  gl_Position = projectionMatrix * mvPosition;',
      '}'
    ].join('\n'),
    fragmentShader: [
      'precision highp float;',
      'varying vec3 vColor;',
      'varying float vAlpha;',
      'void main() {',
      '  float d = length(gl_PointCoord - vec2(0.5));',
      '  float soft = 1.0 - smoothstep(0.08, 0.50, d);',
      '  gl_FragColor = vec4(vColor, soft * vAlpha);',
      '}'
    ].join('\n')
  };
}

function coverDeliveryCreateParticleBurst(source, target) {
  if (typeof THREE === 'undefined' || typeof scene === 'undefined' || !scene
    || typeof camera === 'undefined' || !camera || !source || !target) return null;
  var count = 168;
  var positions = new Float32Array(count * 3);
  var colors = new Float32Array(count * 3);
  var sizes = new Float32Array(count);
  var alphas = new Float32Array(count);
  var particles = [];
  var baseColor = coverDeliveryAccentColor();
  if (!baseColor) return null;
  var right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion).normalize();
  var up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion).normalize();
  var direction = target.clone().sub(source);
  var distance = Math.max(0.12, direction.length());
  var control = source.clone().lerp(target, 0.50).addScaledVector(up, Math.max(0.14, distance * 0.23));
  for (var i = 0; i < count; i++) {
    var seed = Math.random();
    var angle = Math.random() * Math.PI * 2;
    var color = baseColor.clone();
    color.offsetHSL((Math.random() - 0.5) * 0.055, 0.06 + Math.random() * 0.10, (Math.random() - 0.5) * 0.16);
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
    sizes[i] = 0.72 + seed * 1.02;
    alphas[i] = 0;
    particles.push({
      seed: seed,
      angle: angle,
      side: (Math.random() - 0.5) * 2,
      lift: (Math.random() - 0.5) * 2,
      depth: (Math.random() - 0.5) * 2,
      delay: Math.random() * 0.075,
      targetJitter: (Math.random() - 0.5) * 2,
      alpha: 0.38 + Math.random() * 0.62
    });
    positions[i * 3] = source.x;
    positions[i * 3 + 1] = source.y;
    positions[i * 3 + 2] = source.z;
  }
  var geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1));
  var shader = coverDeliveryParticleShader();
  var material = new THREE.ShaderMaterial({
    uniforms: {
      uSize: { value: 0.072 },
      uBass: { value: 0 },
      uBeat: { value: 0 },
      uTreble: { value: 0 }
    },
    vertexShader: shader.vertexShader,
    fragmentShader: shader.fragmentShader,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    vertexColors: true,
    blending: THREE.AdditiveBlending
  });
  var points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 920;
  scene.add(points);
  var burst = {
    points: points,
    geometry: geometry,
    material: material,
    positions: positions,
    alphas: alphas,
    particles: particles,
    source: source.clone(),
    target: target.clone(),
    control: control,
    right: right,
    up: up,
    distance: distance,
    age: 0,
    life: COVER_DELIVERY_PARTICLE_LIFE_SEC,
    travel: COVER_DELIVERY_TRAVEL_SEC,
    lastBeatAt: -1
  };
  coverDeliveryState.bursts.push(burst);
  return burst;
}

function coverDeliveryQuadratic(a, b, c, t, target) {
  var inv = 1 - t;
  target.copy(a).multiplyScalar(inv * inv)
    .addScaledVector(b, 2 * inv * t)
    .addScaledVector(c, t * t);
  return target;
}

function tickCoverDeliveryParticles(dt) {
  if (typeof THREE === 'undefined' || !coverDeliveryState.bursts.length) return;
  dt = Math.max(0, Math.min(0.10, Number(dt) || 0));
  var bassValue = coverDeliveryAudioValue('bass', 0);
  var beatValue = coverDeliveryAudioValue('beatPulse', 0);
  var trebleValue = coverDeliveryAudioValue('treble', 0);
  var now = typeof performance !== 'undefined' && performance.now ? performance.now() / 1000 : Date.now() / 1000;
  var temp = new THREE.Vector3();
  var controlPoint = new THREE.Vector3();
  var particleIndex;
  for (var bi = coverDeliveryState.bursts.length - 1; bi >= 0; bi--) {
    var burst = coverDeliveryState.bursts[bi];
    burst.age += dt;
    if (burst.age > burst.life) {
      coverDeliveryRemoveBurst(burst);
      coverDeliveryState.bursts.splice(bi, 1);
      continue;
    }
    var beatKick = beatValue > 0.20 ? beatValue : 0;
    burst.material.uniforms.uBass.value = bassValue;
    burst.material.uniforms.uBeat.value = beatValue;
    burst.material.uniforms.uTreble.value = trebleValue;
    burst.material.uniforms.uSize.value = 0.068 + bassValue * 0.026 + trebleValue * 0.018 + beatKick * 0.032;
    if (beatValue > 0.42 && (burst.lastBeatAt < 0 || now - burst.lastBeatAt > 0.095)) {
      burst.lastBeatAt = now;
      if (typeof uniforms !== 'undefined' && uniforms.uBurstAmt) uniforms.uBurstAmt.value = Math.max(uniforms.uBurstAmt.value, 0.72 + beatValue * 0.20);
    }
    for (particleIndex = 0; particleIndex < burst.particles.length; particleIndex++) {
      var particle = burst.particles[particleIndex];
      var delayed = burst.age - particle.delay;
      var localT = coverDeliveryClamp(delayed / burst.travel, 0, 1);
      var active = delayed > 0;
      var baseOffset = Math.sin(Math.PI * localT) * (0.060 + bassValue * 0.070 + beatKick * 0.045);
      var wave = Math.sin(now * (5.5 + trebleValue * 11.0) + particle.seed * 18.0) * (0.012 + trebleValue * 0.018);
      controlPoint.copy(burst.control)
        .addScaledVector(burst.right, particle.side * (0.06 + burst.distance * 0.018))
        .addScaledVector(burst.up, particle.lift * 0.055);
      coverDeliveryQuadratic(burst.source, controlPoint, burst.target, localT, temp);
      temp.addScaledVector(burst.right, Math.cos(particle.angle) * baseOffset + wave * particle.side);
      temp.addScaledVector(burst.up, Math.sin(particle.angle) * baseOffset + wave * particle.lift);
      temp.z += particle.depth * baseOffset * 0.46;
      if (!active) temp.copy(burst.source);
      burst.positions[particleIndex * 3] = temp.x;
      burst.positions[particleIndex * 3 + 1] = temp.y;
      burst.positions[particleIndex * 3 + 2] = temp.z;
      var fadeIn = coverDeliveryClamp(delayed / 0.055, 0, 1);
      var fadeOut = coverDeliveryClamp((burst.life - burst.age) / 0.34, 0, 1);
      burst.alphas[particleIndex] = particle.alpha * fadeIn * fadeOut * (0.72 + beatKick * 0.34);
    }
    burst.geometry.attributes.position.needsUpdate = true;
    burst.geometry.attributes.aAlpha.needsUpdate = true;
  }
}

function coverDeliveryPulseExistingParticles() {
  try {
    if (typeof uniforms !== 'undefined' && uniforms.uBurstAmt) uniforms.uBurstAmt.value = Math.max(uniforms.uBurstAmt.value, 0.86);
    if (typeof triggerRipple === 'function') triggerRipple(0, 0, 1.05);
  } catch (e) { }
}

function coverDeliveryLoadImage(source, onReady, onFail) {
  var settled = false;
  var timeout = null;
  function finish(callback, value) {
    if (settled) return;
    settled = true;
    if (timeout) clearTimeout(timeout);
    callback(value);
  }
  function ready(image) { finish(onReady, image); }
  function fail() { finish(onFail); }
  if (source && source.image && source.image.complete && (source.image.naturalWidth || source.image.width)) {
    ready(source.image);
    return;
  }
  if (typeof Image === 'undefined') {
    fail();
    return;
  }
  var image = new Image();
  image.decoding = 'async';
  image.onload = function () { ready(image); };
  image.onerror = fail;
  var src = String(source && (source.imageUrl || source.url) || '');
  if (!src) {
    fail();
    return;
  }
  timeout = setTimeout(fail, 1600);
  image.src = src;
}

function coverDeliverySetPlaybackCover(src) {
  if (!src) return;
  var thumb = document.getElementById('thumb-cover');
  if (thumb) thumb.src = src;
  if (typeof setControlCoverSrc === 'function') setControlCoverSrc(src);
}

function coverDeliveryRevealPlaybackControls() {
  var body = document.body;
  if (body) body.classList.remove('home-controls-locked');
  // 复用原有控制条的玻璃 reveal / hold 状态；下面的 class 写入是
  // 音乐库墙退场后播放器仍被锁定时的兜底，避免 reveal 保护条件
  // 把这次明确的用户播放操作再次挡掉。
  if (typeof holdBottomControlsVisible === 'function') holdBottomControlsVisible(2600);
  if (typeof revealBottomControls === 'function') revealBottomControls(1800);
  var bar = document.getElementById('bottom-bar');
  if (bar) {
    bar.classList.add('visible');
    bar.classList.remove('soft-hidden');
    bar.style.pointerEvents = '';
  }
  if (typeof forcePlaybackControlsInteractive === 'function') forcePlaybackControlsInteractive();
  if (typeof animateWallpaperEngineControlGlassSurface === 'function') animateWallpaperEngineControlGlassSurface(620);
}

function coverDeliveryStageLyricsPulse() {
  if (typeof stageLyrics === 'undefined' || !stageLyrics) return;
  var pulseToken = coverDeliveryState.lyricsPulseToken + 1;
  coverDeliveryState.lyricsPulseToken = pulseToken;
  function settleScale() {
    if (coverDeliveryState.lyricsPulseToken !== pulseToken) return;
    if (typeof stageLyrics !== 'undefined' && stageLyrics) stageLyrics.deliveryScale = 1;
  }
  var gsap = coverDeliveryGsap();
  if (!gsap) {
    settleScale();
    return;
  }
  gsap.killTweensOf(stageLyrics, 'deliveryScale');
  if (typeof gsap.timeline !== 'function') {
    gsap.fromTo(stageLyrics, { deliveryScale: 0.90 }, {
      deliveryScale: 1.075,
      duration: 0.30,
      ease: 'back.out(1.8)',
      yoyo: true,
      repeat: 1,
      overwrite: true,
      onComplete: settleScale
    });
    return;
  }
  // 保留一次轻微的 yoyo 呼吸，但最后显式回到基线，避免歌词舞台永久缩在 90%。
  var pulse = gsap.timeline({
    onComplete: settleScale
  });
  pulse.fromTo(stageLyrics, { deliveryScale: 0.90 }, {
    deliveryScale: 1.075,
    duration: 0.30,
    ease: 'back.out(1.8)',
    yoyo: true,
    repeat: 1,
    overwrite: true
  }).to(stageLyrics, {
    deliveryScale: 1,
    duration: 0.18,
    ease: 'power2.out',
    overwrite: true
  });
}

function coverDeliveryFinish(state) {
  if (!state || state.token !== coverDeliveryState.token || coverDeliveryState.active !== state) return;
  state.committed = true;
  var flight = state.flight;
  if (!flight) return;
  var target = state.targetRect;
  var gsap = coverDeliveryGsap();
  if (gsap) {
    gsap.set(flight, {
      x: target.left + target.width / 2,
      y: target.top + target.height / 2,
      width: target.width,
      height: target.height,
      scale: 1,
      rotation: 0
    });
  }
  coverDeliverySetPlaybackCover(state.imageSrc);
  coverDeliveryRevealPlaybackControls();
  coverDeliveryStageLyricsPulse();
  coverDeliveryEndSource(state);
  coverDeliveryStartPlayback(state);
  if (gsap) {
    gsap.to(flight, {
      opacity: 0,
      duration: 0.52,
      ease: 'power2.out',
      overwrite: true,
      onComplete: function () {
        if (state.token !== coverDeliveryState.token) return;
        coverDeliveryRemoveFlight(state);
        if (coverDeliveryState.active === state) coverDeliveryState.active = null;
      }
    });
  } else {
    coverDeliveryRemoveFlight(state);
    coverDeliveryState.active = null;
  }
}

function coverDeliveryLaunch(state, image) {
  if (!state || state.token !== coverDeliveryState.token || coverDeliveryState.active !== state) return;
  var gsap = coverDeliveryGsap();
  coverDeliveryBeginSource(state);
  var layer = coverDeliveryLayer();
  var flight = document.createElement('img');
  flight.className = 'cover-delivery-flight';
  flight.alt = '';
  flight.draggable = false;
  flight.src = image.currentSrc || image.src;
  layer.appendChild(flight);
  state.flight = flight;
  state.imageSrc = flight.src;
  state.targetRect = coverDeliveryPlayerCoverRect();
  if (!state.targetRect || state.targetRect.width < 2 || state.targetRect.height < 2) {
    coverDeliveryAbort(state, 'missing-player-cover');
    return;
  }
  var startX = state.source.centerX;
  var startY = state.source.centerY;
  var targetX = state.targetRect.left + state.targetRect.width / 2;
  var targetY = state.targetRect.top + state.targetRect.height / 2;
  var arc = Math.max(82, Math.min(230, Math.abs(targetY - startY) * 0.18 + innerHeight * 0.08));
  state.path = {
    x0: startX,
    y0: startY,
    x1: targetX,
    y1: targetY,
    cx: (startX + targetX) / 2 + coverDeliveryClamp((targetX - startX) * 0.12, -72, 72),
    cy: Math.min(startY, targetY) - arc
  };
  var sourceDistance = state.source.world && typeof camera !== 'undefined' && camera
    ? state.source.world.distanceTo(camera.position)
    : 4.8;
  var targetWorld = coverDeliveryScreenToWorld(targetX, targetY, sourceDistance);
  if (state.source.world && targetWorld) coverDeliveryCreateParticleBurst(state.source.world, targetWorld);
  coverDeliveryPulseExistingParticles();
  if (!gsap) {
    coverDeliveryFinish(state);
    return;
  }
  function updateFlight() {
    if (!state.flight || state.token !== coverDeliveryState.token) return;
    var t = coverDeliveryClamp(state.pathT, 0, 1);
    var inv = 1 - t;
    var x = inv * inv * state.path.x0 + 2 * inv * t * state.path.cx + t * t * state.path.x1;
    var y = inv * inv * state.path.y0 + 2 * inv * t * state.path.cy + t * t * state.path.y1;
    var tangentX = 2 * inv * (state.path.cx - state.path.x0) + 2 * t * (state.path.x1 - state.path.cx);
    var tangentY = 2 * inv * (state.path.cy - state.path.y0) + 2 * t * (state.path.y1 - state.path.cy);
    gsap.set(state.flight, { x: x, y: y, rotation: coverDeliveryClamp(Math.atan2(tangentY, tangentX) * 180 / Math.PI * 0.10, -9, 9) });
  }
  gsap.set(flight, {
    left: 0,
    top: 0,
    x: startX,
    y: startY,
    xPercent: -50,
    yPercent: -50,
    width: Math.max(2, state.source.width),
    height: Math.max(2, state.source.height),
    scale: 0.70,
    opacity: 1,
    rotation: 0
  });
  state.pathT = 0;
  state.timeline = gsap.timeline({
    onComplete: function () { coverDeliveryFinish(state); }
  });
  state.timeline.to(state, { pathT: 1, duration: COVER_DELIVERY_TRAVEL_SEC, ease: 'power2.inOut', onUpdate: updateFlight }, 0);
  // 明确的 70% 起步段：图片一落手就收缩，再开始向播放器抛出。
  state.timeline.to(flight, { scale: 0.70, duration: 0.08, ease: 'power2.out' }, 0);
  state.timeline.to(flight, {
    width: state.targetRect.width,
    height: state.targetRect.height,
    duration: COVER_DELIVERY_ARRIVAL_SEC,
    ease: 'power3.out'
  }, COVER_DELIVERY_TRAVEL_SEC);
  state.timeline.to(flight, { scale: 1, duration: 0.28, ease: 'power3.out' }, COVER_DELIVERY_TRAVEL_SEC);
  // 到达后的轻微多拍 yoyo 只影响 DOM 封面，不影响终点尺寸；最后一帧回到 1。
  state.timeline.to(flight, {
    scale: 1.075,
    duration: 0.135,
    ease: 'sine.inOut',
    repeat: 3,
    yoyo: true
  }, COVER_DELIVERY_TRAVEL_SEC + 0.28);
}

function coverDeliveryCreateMusicLibrarySource(card, song) {
  if (!card || typeof card.querySelector !== 'function' || typeof card.getBoundingClientRect !== 'function') return null;
  var art = card.querySelector('.music-library-wall-art') || card;
  var rect = art.getBoundingClientRect();
  if (!rect || rect.width < 2 || rect.height < 2) return null;
  var image = art.querySelector('img:not([hidden])') || art.querySelector('img');
  if (image && image.hidden) image = null;
  var imageUrl = image && (image.currentSrc || image.src) || '';
  if (!imageUrl && typeof musicLibraryWallCover === 'function') imageUrl = musicLibraryWallCover(song);
  if (!imageUrl) return null;
  // 浏览器已确认该 img 加载失败时，不再重新请求并等待 1.6 秒超时；
  // 直接让调用方走原有播放路径，避免用户点击后无响应。
  if (image && image.complete && imageUrl && typeof image.naturalWidth === 'number' && image.naturalWidth === 0) return null;
  var centerX = rect.left + rect.width / 2;
  var centerY = rect.top + rect.height / 2;
  return {
    url: imageUrl,
    imageUrl: imageUrl,
    image: image && image.complete && (image.naturalWidth || image.width) ? image : null,
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
    centerX: centerX,
    centerY: centerY,
    world: coverDeliveryScreenToWorld(centerX, centerY, 4.8),
    begin: function () {
      if (card.classList) card.classList.add('is-cover-delivering');
    },
    end: function () {
      if (card.classList) card.classList.remove('is-cover-delivering');
    }
  };
}

function coverDeliverySchedule(source, options) {
  if (!source || !source.url || source.width < 2 || source.height < 2) return false;
  options = options || {};
  // 每次新点击都使旧投递失效，避免旧卡片在新歌之后覆盖播放器封面。
  coverDeliveryCancel('new-song');
  if (typeof markRenderInteraction === 'function') markRenderInteraction('cover-delivery', 2600);
  if (typeof wakeMainLoopFromBackground === 'function') wakeMainLoopFromBackground();
  var token = coverDeliveryState.token;
  var state = {
    token: token,
    source: source,
    committed: false,
    flight: null,
    timeline: null,
    sourceBegun: false,
    playbackStarted: false,
    onPlaybackReady: typeof options.onPlaybackReady === 'function' ? options.onPlaybackReady : null
  };
  coverDeliveryState.active = state;
  coverDeliveryLoadImage(source, function (image) {
    if (typeof stageLyrics !== 'undefined' && stageLyrics) {
      var gsap = coverDeliveryGsap();
      if (gsap) gsap.killTweensOf(stageLyrics, 'deliveryScale');
      stageLyrics.deliveryScale = 0.90;
    }
    coverDeliveryLaunch(state, image);
  }, function () {
    coverDeliveryAbort(state, 'cover-load-failed');
  });
  return true;
}

function startCoverDeliveryFromMusicLibraryCard(card, song, options) {
  // 即便封面缺失，也要取消上一首尚未结束的投递；调用方随后会走普通播放。
  coverDeliveryCancel('music-library-selection');
  var source = coverDeliveryCreateMusicLibrarySource(card, song);
  if (!source) return false;
  return coverDeliverySchedule(source, options);
}
