'use strict';

var PLAYBACK_TUNING_STORE_KEY = 'mineradio-playback-tuning-v1';
var AUDIO_EFFECTS_STORE_KEY = 'mineradio-audio-effects-v1';
var playbackTuningCloseTimer = 0;
var pitchInputNode = null;
var pitchShiftNode = null;
var pitchShiftInitPromise = null;
var pitchShiftSupported = true;
var pitchShiftGraphSerial = 0;
var eqNodes = [];
var eqInputNode = null;
var eqOutputNode = null;
var preampGainNode = null;

var EQ_BANDS = [
  { label: '60', freq: 60, type: 'lowshelf' },
  { label: '170', freq: 170, type: 'peaking', q: 1 },
  { label: '350', freq: 350, type: 'peaking', q: 1 },
  { label: '1K', freq: 1000, type: 'peaking', q: 1 },
  { label: '3.5K', freq: 3500, type: 'peaking', q: 1 },
  { label: '10K', freq: 10000, type: 'highshelf' }
];
var EQ_PRESETS = {
  flat: { label: '原声', gains: [0, 0, 0, 0, 0, 0], preamp: 0 },
  bass: { label: '低音', gains: [5, 4, 1, -1, 0, 1], preamp: -2 },
  vocal: { label: '人声', gains: [-2, -1, 1, 4, 3, 0], preamp: -1 },
  bright: { label: '明亮', gains: [-1, 0, 0, 1, 3, 4], preamp: -1 },
  night: { label: '夜间', gains: [-3, -2, 0, 1, -1, -3], preamp: -4 },
  cinema: { label: '电影', gains: [3, 2, -1, 0, 2, 2], preamp: -2 },
  custom: { label: '自定义', gains: [0, 0, 0, 0, 0, 0], preamp: 0 }
};

function readPlaybackTuningSettings() {
  try {
    var raw = JSON.parse(localStorage.getItem(PLAYBACK_TUNING_STORE_KEY) || '{}') || {};
    return {
      speed: clampRange(Math.round((Number(raw.speed) || 1) * 20) / 20, 0.5, 2),
      pitch: clampRange(Math.round(Number(raw.pitch) || 0), -12, 12)
    };
  } catch (_) { return { speed: 1, pitch: 0 }; }
}
function readAudioEffectsSettings() {
  try {
    var raw = JSON.parse(localStorage.getItem(AUDIO_EFFECTS_STORE_KEY) || '{}') || {};
    var gains = Array.isArray(raw.eqGains) ? raw.eqGains : [];
    return {
      enabled: raw.enabled === true,
      preset: Object.prototype.hasOwnProperty.call(EQ_PRESETS, raw.preset) ? raw.preset : 'flat',
      preamp: clampRange(Number(raw.preamp) || 0, -12, 6),
      eqGains: EQ_BANDS.map(function (_, i) { return clampRange(Number(gains[i]) || 0, -12, 12); })
    };
  } catch (_) {
    return { enabled: false, preset: 'flat', preamp: 0, eqGains: EQ_BANDS.map(function () { return 0; }) };
  }
}
var playbackTuning = readPlaybackTuningSettings();
var audioEffects = readAudioEffectsSettings();

function savePlaybackTuningSettings() {
  try { localStorage.setItem(PLAYBACK_TUNING_STORE_KEY, JSON.stringify(playbackTuning)); } catch (_) { }
}
function saveAudioEffectsSettings() {
  try { localStorage.setItem(AUDIO_EFFECTS_STORE_KEY, JSON.stringify(audioEffects)); } catch (_) { }
}
function configurePlaybackAudioElement(media) {
  if (!media) return;
  try { media.preservesPitch = true; } catch (_) { }
  try { media.webkitPreservesPitch = true; } catch (_) { }
  try { media.defaultPlaybackRate = playbackTuning.speed; media.playbackRate = playbackTuning.speed; } catch (_) { }
}
function playbackPitchRatio() { return Math.pow(2, (Number(playbackTuning.pitch) || 0) / 12); }
function formatPlaybackSpeed(value) { return (Math.round((Number(value) || 1) * 100) / 100).toFixed(2) + '×'; }
function formatPlaybackPitch(value) {
  value = Math.round(Number(value) || 0);
  return (value > 0 ? '+' : '') + value + ' 半音';
}
function audioDbLabel(value) {
  value = Number(value) || 0;
  return (value > 0 ? '+' : '') + value.toFixed(Math.abs(value % 1) > 0.01 ? 1 : 0) + 'dB';
}

function pitchWorkletSource() {
  return `
class MineradioPitchShiftProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 65536; this.mask = this.size - 1; this.buffers = [];
    this.writeIndex = 0; this.phase = 0; this.targetRatio = 1; this.currentRatio = 1;
    this.minDelay = 256; this.range = 3072;
    this.port.onmessage = event => {
      const ratio = Number((event.data || {}).ratio);
      if (Number.isFinite(ratio)) this.targetRatio = Math.max(.5, Math.min(2, ratio));
    };
  }
  ensureChannels(count) { while (this.buffers.length < count) this.buffers.push(new Float32Array(this.size)); }
  read(buffer, position) {
    const base = Math.floor(position), frac = position - base;
    const a = buffer[base & this.mask] || 0, b = buffer[(base + 1) & this.mask] || 0;
    return a + (b - a) * frac;
  }
  process(inputs, outputs) {
    const input = inputs[0] || [], output = outputs[0] || [];
    if (!output.length) return true;
    this.ensureChannels(Math.max(input.length, output.length));
    for (let i = 0; i < output[0].length; i++) {
      this.currentRatio += (this.targetRatio - this.currentRatio) * .0025;
      const ratio = this.currentRatio, shifted = Math.abs(ratio - 1) > .001;
      const phaseA = this.phase, phaseB = phaseA < .5 ? phaseA + .5 : phaseA - .5;
      const winA = .5 - .5 * Math.cos(2 * Math.PI * phaseA), winB = 1 - winA;
      const delayA = ratio > 1 ? this.minDelay + this.range * (1 - phaseA) : this.minDelay + this.range * phaseA;
      const delayB = ratio > 1 ? this.minDelay + this.range * (1 - phaseB) : this.minDelay + this.range * phaseB;
      for (let channel = 0; channel < output.length; channel++) {
        const src = input[channel] || input[0], sample = src ? (src[i] || 0) : 0;
        const buffer = this.buffers[channel]; buffer[this.writeIndex] = sample;
        output[channel][i] = shifted ? this.read(buffer, this.writeIndex - delayA) * winA + this.read(buffer, this.writeIndex - delayB) * winB : sample;
      }
      this.writeIndex = (this.writeIndex + 1) & this.mask;
      if (shifted) { this.phase += Math.abs(1 - ratio) / this.range; if (this.phase >= 1) this.phase -= Math.floor(this.phase); }
    }
    return true;
  }
}
registerProcessor('mineradio-pitch-shifter', MineradioPitchShiftProcessor);`;
}

function disposePlaybackEffectGraph() {
  pitchShiftGraphSerial++;
  [pitchInputNode, pitchShiftNode, preampGainNode].concat(eqNodes || []).forEach(function (node) {
    try { if (node) node.disconnect(); } catch (_) { }
  });
  pitchInputNode = null;
  pitchShiftNode = null;
  pitchShiftInitPromise = null;
  eqNodes = [];
  eqInputNode = null;
  eqOutputNode = null;
  preampGainNode = null;
}
function createEqChain(ctx) {
  preampGainNode = ctx.createGain();
  eqNodes = EQ_BANDS.map(function (band) {
    var node = ctx.createBiquadFilter();
    node.type = band.type; node.frequency.value = band.freq;
    if (band.q && node.Q) node.Q.value = band.q;
    return node;
  });
  eqInputNode = eqNodes[0] || null;
  eqOutputNode = eqNodes[eqNodes.length - 1] || null;
  for (var i = 0; i < eqNodes.length - 1; i++) eqNodes[i].connect(eqNodes[i + 1]);
  if (eqOutputNode) eqOutputNode.connect(preampGainNode);
  if (preampGainNode && gainNode) preampGainNode.connect(gainNode);
  applyAudioEffects();
}
function reconnectPitchProcessingGraph() {
  if (!pitchInputNode) return;
  var destination = eqInputNode || gainNode;
  if (!destination) return;
  try { pitchInputNode.disconnect(); } catch (_) { }
  if (pitchShiftNode) {
    try { pitchShiftNode.disconnect(); } catch (_) { }
    pitchInputNode.connect(pitchShiftNode);
    pitchShiftNode.connect(destination);
  } else pitchInputNode.connect(destination);
}
function createPlaybackEffectGraph() {
  if (!audioCtx || !analyser || !gainNode) return false;
  disposePlaybackEffectGraph();
  try { analyser.disconnect(); } catch (_) { }
  pitchInputNode = audioCtx.createGain();
  createEqChain(audioCtx);
  analyser.connect(pitchInputNode);
  reconnectPitchProcessingGraph();
  configurePlaybackAudioElement(audio);
  if (playbackTuning.pitch !== 0) ensurePitchShiftNode();
  return true;
}
function applyPitchShiftValue() {
  if (!pitchShiftNode) {
    if (playbackTuning.pitch !== 0) ensurePitchShiftNode();
    return;
  }
  try { pitchShiftNode.port.postMessage({ ratio: playbackPitchRatio() }); } catch (_) { }
}
function ensurePitchShiftNode() {
  if (!audioCtx || !pitchInputNode) return Promise.resolve(null);
  if (pitchShiftNode) return Promise.resolve(pitchShiftNode);
  if (pitchShiftInitPromise) return pitchShiftInitPromise;
  if (!audioCtx.audioWorklet || typeof AudioWorkletNode === 'undefined') {
    pitchShiftSupported = false; playbackTuning.pitch = 0; savePlaybackTuningSettings(); updatePlaybackTuningUi();
    return Promise.resolve(null);
  }
  var serial = pitchShiftGraphSerial;
  var context = audioCtx;
  var blobUrl = URL.createObjectURL(new Blob([pitchWorkletSource()], { type: 'application/javascript' }));
  pitchShiftInitPromise = context.audioWorklet.addModule(blobUrl).then(function () {
    URL.revokeObjectURL(blobUrl);
    if (serial !== pitchShiftGraphSerial || context !== audioCtx || !pitchInputNode) return null;
    pitchShiftNode = new AudioWorkletNode(context, 'mineradio-pitch-shifter', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
    pitchShiftNode.onprocessorerror = function () {
      pitchShiftSupported = false; playbackTuning.pitch = 0; savePlaybackTuningSettings();
      try { pitchShiftNode.disconnect(); } catch (_) { }
      pitchShiftNode = null; reconnectPitchProcessingGraph(); updatePlaybackTuningUi();
    };
    pitchShiftSupported = true; reconnectPitchProcessingGraph(); applyPitchShiftValue(); updatePlaybackTuningUi();
    return pitchShiftNode;
  }).catch(function (error) {
    try { URL.revokeObjectURL(blobUrl); } catch (_) { }
    console.warn('[PlaybackTuning] pitch processor unavailable:', error && error.message || error);
    pitchShiftSupported = false; playbackTuning.pitch = 0; savePlaybackTuningSettings(); updatePlaybackTuningUi();
    return null;
  }).finally(function () { pitchShiftInitPromise = null; });
  return pitchShiftInitPromise;
}

function applyAudioEffects() {
  if (!audioCtx || !eqNodes.length) return;
  var enabled = audioEffects.enabled === true;
  var now = audioCtx.currentTime || 0;
  eqNodes.forEach(function (node, i) {
    var value = enabled ? clampRange(Number(audioEffects.eqGains[i]) || 0, -12, 12) : 0;
    try { node.gain.cancelScheduledValues(now); node.gain.setTargetAtTime(value, now, .018); } catch (_) { node.gain.value = value; }
  });
  if (preampGainNode) {
    var linear = Math.pow(10, (enabled ? clampRange(Number(audioEffects.preamp) || 0, -12, 6) : 0) / 20);
    try { preampGainNode.gain.cancelScheduledValues(now); preampGainNode.gain.setTargetAtTime(linear, now, .018); } catch (_) { preampGainNode.gain.value = linear; }
  }
}
function eqPresetPayload(name) {
  var preset = EQ_PRESETS[name] || EQ_PRESETS.flat;
  return { preset: name, preamp: preset.preamp, eqGains: preset.gains.slice() };
}
function updateAudioEffectsControls() {
  var toggle = document.getElementById('t-audioEq');
  if (toggle) toggle.classList.toggle('on', audioEffects.enabled === true);
  document.querySelectorAll('#audio-preset-seg [data-audio-preset]').forEach(function (button) { button.classList.toggle('active', button.dataset.audioPreset === audioEffects.preset); });
  var preamp = document.getElementById('audio-preamp');
  if (preamp) { preamp.value = audioEffects.preamp; preamp.parentElement.querySelector('output').textContent = audioDbLabel(preamp.value); }
  EQ_BANDS.forEach(function (_, i) {
    var input = document.getElementById('audio-eq-' + i);
    if (input) { input.value = audioEffects.eqGains[i]; input.parentElement.querySelector('output').textContent = audioDbLabel(input.value); }
  });
}
function buildAudioEffectsControls() {
  var grid = document.getElementById('audio-eq-grid');
  if (grid && !grid._built) {
    grid._built = true;
    grid.innerHTML = EQ_BANDS.map(function (band, i) { return '<div class="eq-band"><label for="audio-eq-' + i + '">' + band.label + '</label><input id="audio-eq-' + i + '" type="range" min="-12" max="12" step="0.5"><output></output></div>'; }).join('');
  }
  document.querySelectorAll('#audio-preset-seg [data-audio-preset]').forEach(function (button) { button.addEventListener('click', function () { setAudioPreset(button.dataset.audioPreset); }); });
  var preamp = document.getElementById('audio-preamp');
  if (preamp) preamp.addEventListener('input', function () { audioEffects.preamp = clampRange(Number(preamp.value) || 0, -12, 6); audioEffects.preset = 'custom'; updateAudioEffectsControls(); applyAudioEffects(); saveAudioEffectsSettings(); });
  EQ_BANDS.forEach(function (_, i) {
    var input = document.getElementById('audio-eq-' + i);
    if (input) input.addEventListener('input', function () { audioEffects.eqGains[i] = clampRange(Number(input.value) || 0, -12, 12); audioEffects.enabled = true; audioEffects.preset = 'custom'; updateAudioEffectsControls(); applyAudioEffects(); saveAudioEffectsSettings(); });
  });
  updateAudioEffectsControls();
}
function setAudioPreset(name) {
  var payload = eqPresetPayload(name);
  audioEffects.enabled = name !== 'flat'; audioEffects.preset = payload.preset; audioEffects.preamp = payload.preamp; audioEffects.eqGains = payload.eqGains;
  updateAudioEffectsControls(); applyAudioEffects(); saveAudioEffectsSettings(); showToast('声音预设: ' + (EQ_PRESETS[name] || EQ_PRESETS.flat).label);
}
function toggleAudioEq() {
  audioEffects.enabled = audioEffects.enabled !== true;
  if (audioEffects.enabled && audioEffects.preset === 'flat') audioEffects.preset = 'custom';
  updateAudioEffectsControls(); applyAudioEffects(); saveAudioEffectsSettings(); showToast(audioEffects.enabled ? '均衡器已开启' : '均衡器已关闭');
}

function updatePlaybackTuningUi() {
  var speed = document.getElementById('playback-speed-slider');
  var pitch = document.getElementById('playback-pitch-slider');
  if (speed) speed.value = playbackTuning.speed;
  if (pitch) { pitch.value = playbackTuning.pitch; pitch.disabled = !pitchShiftSupported; }
  var speedValue = document.getElementById('playback-speed-value');
  var pitchValue = document.getElementById('playback-pitch-value');
  var label = document.getElementById('playback-tuning-btn-label');
  var root = document.getElementById('playback-tuning-control');
  if (speedValue) speedValue.textContent = formatPlaybackSpeed(playbackTuning.speed);
  if (pitchValue) pitchValue.textContent = formatPlaybackPitch(playbackTuning.pitch);
  if (label) label.textContent = formatPlaybackSpeed(playbackTuning.speed);
  if (root) root.classList.toggle('unsupported', !pitchShiftSupported);
}
function applyPlaybackTuning() { configurePlaybackAudioElement(audio); applyPitchShiftValue(); updatePlaybackTuningUi(); }
function setPlaybackSpeed(value, silent) {
  playbackTuning.speed = clampRange(Math.round((Number(value) || 1) * 20) / 20, .5, 2); savePlaybackTuningSettings(); applyPlaybackTuning();
  if (!silent) showToast('倍速 ' + formatPlaybackSpeed(playbackTuning.speed));
}
function setPlaybackPitch(value, silent) {
  var next = clampRange(Math.round(Number(value) || 0), -12, 12);
  if (!pitchShiftSupported && next !== 0) { showToast('当前设备不支持独立音调调节'); return; }
  playbackTuning.pitch = next; savePlaybackTuningSettings(); if (next !== 0) ensurePitchShiftNode(); applyPitchShiftValue(); updatePlaybackTuningUi();
  if (!silent) showToast('音调 ' + formatPlaybackPitch(next));
}
function resetPlaybackTuning() { playbackTuning = { speed: 1, pitch: 0 }; savePlaybackTuningSettings(); applyPlaybackTuning(); showToast('倍速与音调已重置'); }
function togglePlaybackTuningPanel(event) {
  if (event) event.stopPropagation();
  var root = document.getElementById('playback-tuning-control');
  if (root) root.classList.toggle('open');
}
function bindPlaybackTuningControls() {
  var root = document.getElementById('playback-tuning-control');
  var speed = document.getElementById('playback-speed-slider');
  var pitch = document.getElementById('playback-pitch-slider');
  function keepOpen() { if (playbackTuningCloseTimer) clearTimeout(playbackTuningCloseTimer); if (root) root.classList.add('open'); }
  function closeSoon() { if (playbackTuningCloseTimer) clearTimeout(playbackTuningCloseTimer); playbackTuningCloseTimer = setTimeout(function () { if (root && !root.matches(':hover') && !root.matches(':focus-within')) root.classList.remove('open'); }, 520); }
  if (root) { root.addEventListener('mouseenter', keepOpen); root.addEventListener('mouseleave', closeSoon); }
  if (speed) { speed.addEventListener('input', function () { setPlaybackSpeed(speed.value, true); keepOpen(); }); speed.addEventListener('change', function () { showToast('倍速 ' + formatPlaybackSpeed(playbackTuning.speed)); }); }
  if (pitch) { pitch.addEventListener('input', function () { setPlaybackPitch(pitch.value, true); keepOpen(); }); pitch.addEventListener('change', function () { showToast('音调 ' + formatPlaybackPitch(playbackTuning.pitch)); }); }
  document.addEventListener('click', function (event) { if (root && !root.contains(event.target)) root.classList.remove('open'); });
  updatePlaybackTuningUi(); configurePlaybackAudioElement(audio);
}
