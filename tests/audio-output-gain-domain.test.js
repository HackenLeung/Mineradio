'use strict';

// 输出增益在拆分链路上分两级：audio.volume 和 gainNode.gain 各持 sqrt(v)，
// 串联相乘等于 v。读回时必须换算成实际输出增益，否则与 targetVolume 不同域，
// rampAudioOutputGain 会把 sqrt(v) 当起点再开一次方 —— 首帧输出从 v 跳到 sqrt(v)，
// 听感就是智能过渡瞬间音量突然放大又回落（音量 30% 时约 +5dB）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const graphSource = fs.readFileSync(path.join(root, 'public/js/modules/05-playback/08-audio-graph-controls.js'), 'utf8');
const transitionSource = fs.readFileSync(path.join(root, 'public/js/modules/05-playback/18-smart-transition-integration.js'), 'utf8');

function namedFunctionSource(text, name) {
  const declaration = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(text);
  assert.ok(declaration, `expected ${name}()`);
  const bodyStart = text.indexOf('{', declaration.index + declaration[0].length);
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = bodyStart; index < text.length; index += 1) {
    const character = text[index];
    if (lineComment) {
      if (character === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === '*' && text[index + 1] === '/') { blockComment = false; index += 1; }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'" || character === '`') { quote = character; continue; }
    if (character === '/' && text[index + 1] === '/') { lineComment = true; index += 1; continue; }
    if (character === '/' && text[index + 1] === '*') { blockComment = true; index += 1; continue; }
    if (character === '{') depth += 1;
    if (character === '}' && --depth === 0) return text.slice(declaration.index, index + 1);
  }
  throw new Error(`unterminated ${name}()`);
}

function createGainSandbox(options) {
  options = options || {};
  const split = options.split !== false;
  const sandbox = {
    Math, Number, isFinite, JSON,
    AUDIO_SILENCE_GAIN: 0.0001,
    targetVolume: options.targetVolume == null ? 0.5 : options.targetVolume,
    audioFadeSerial: 0,
    audioElementFadeFrame: 0,
    __now: 0,
    __raf: null,
    performance: { now: () => sandbox.__now },
    clampRange: (value, lo, hi) => Math.max(lo, Math.min(hi, value)),
    clearAudioFadeTimers() { sandbox.audioFadeSerial++; },
    requestAnimationFrame(fn) { sandbox.__raf = fn; return 1; },
    audio: { volume: 0, muted: true },
    audioCtx: split ? { currentTime: 0 } : null,
    gainNode: split ? {
      gain: {
        value: 0,
        cancelScheduledValues() {},
        setValueAtTime(value) { this.value = value; },
        cancelAndHoldAtTime(when) { this.__heldAt = when; },
      },
    } : null,
  };
  const code = [
    namedFunctionSource(graphSource, 'audioOutputGainIsSplit'),
    namedFunctionSource(graphSource, 'currentAudioOutputGain'),
    namedFunctionSource(graphSource, 'audioSilentFloor'),
    namedFunctionSource(graphSource, 'normalizeAudioOutputGain'),
    namedFunctionSource(graphSource, 'writeAudioOutputGain'),
    namedFunctionSource(graphSource, 'holdAudioOutputGain'),
    namedFunctionSource(graphSource, 'setAudioOutputGainImmediate'),
    namedFunctionSource(graphSource, 'rampAudioOutputGain'),
  ].join('\n');
  vm.runInNewContext(code, sandbox, { filename: 'audio-output-gain.js' });
  return sandbox;
}

// 实际听到的增益：拆分链路是两级相乘，非拆分链路只有元素一级。
function effectiveGain(sandbox) {
  const elementGain = Number(sandbox.audio.volume);
  if (!sandbox.gainNode || !sandbox.audioCtx) return elementGain;
  return elementGain * Number(sandbox.gainNode.gain.value);
}

function runRamp(sandbox, target, durationMs, steps) {
  sandbox.rampAudioOutputGain(target, durationMs);
  const trace = [];
  for (let step = 0; step <= (steps || 12); step += 1) {
    sandbox.__now = step * (durationMs / 8);
    if (sandbox.__raf) {
      const frame = sandbox.__raf;
      sandbox.__raf = null;
      frame(sandbox.__now);
    }
    trace.push(effectiveGain(sandbox));
  }
  return trace;
}

test('写入后读回的是实际输出增益，不是单级值', () => {
  for (const volume of [0.05, 0.2, 0.5, 0.75, 1]) {
    const sandbox = createGainSandbox({ targetVolume: volume });
    sandbox.writeAudioOutputGain(volume);
    assert.ok(Math.abs(effectiveGain(sandbox) - volume) < 1e-9, `输出增益应等于 ${volume}`);
    assert.ok(
      Math.abs(sandbox.currentAudioOutputGain() - volume) < 1e-9,
      `currentAudioOutputGain 应返回 ${volume}，实际 ${sandbox.currentAudioOutputGain()}`,
    );
    // 两级各持 sqrt，拆分设计本身不能被改坏。
    assert.ok(Math.abs(sandbox.audio.volume - Math.sqrt(volume)) < 1e-9, '元素级应持 sqrt(v)');
    assert.ok(Math.abs(sandbox.gainNode.gain.value - Math.sqrt(volume)) < 1e-9, '节点级应持 sqrt(v)');
  }
});

test('稳态音量下触发 ramp 不产生尖峰', () => {
  for (const volume of [0.2, 0.3, 0.5, 0.7, 0.9, 1]) {
    const sandbox = createGainSandbox({ targetVolume: volume });
    sandbox.writeAudioOutputGain(volume);
    const steady = effectiveGain(sandbox);
    const trace = runRamp(sandbox, volume, 120);
    const peak = Math.max(...trace);
    assert.ok(
      peak <= steady + 1e-9,
      `音量 ${volume}: ramp 峰值 ${peak.toFixed(4)} 不应超过稳态 ${steady.toFixed(4)}（旧 bug 会冲到 ${Math.sqrt(volume).toFixed(4)}）`,
    );
    assert.ok(Math.abs(trace[trace.length - 1] - volume) < 1e-6, '结束时应落在目标音量');
  }
});

test('从压低状态 ramp 回目标全程单调不过冲', () => {
  const volume = 0.6;
  const sandbox = createGainSandbox({ targetVolume: volume });
  sandbox.writeAudioOutputGain(volume * 0.25);
  const start = effectiveGain(sandbox);
  const trace = runRamp(sandbox, volume, 160);
  assert.ok(start < volume, '起点应低于目标');
  for (let i = 1; i < trace.length; i += 1) {
    assert.ok(trace[i] >= trace[i - 1] - 1e-9, `第 ${i} 帧不应回落：${trace[i - 1]} → ${trace[i]}`);
    assert.ok(trace[i] <= volume + 1e-9, `第 ${i} 帧不应超过目标：${trace[i]}`);
  }
  assert.ok(Math.abs(trace[trace.length - 1] - volume) < 1e-6, '结束时应落在目标音量');
});

test('holdAudioOutputGain 冻结后输出增益不变', () => {
  const volume = 0.4;
  const sandbox = createGainSandbox({ targetVolume: volume });
  sandbox.writeAudioOutputGain(volume);
  const before = effectiveGain(sandbox);
  const returned = sandbox.holdAudioOutputGain(0);
  assert.ok(Math.abs(effectiveGain(sandbox) - before) < 1e-9, '冻结不应改变实际输出');
  assert.ok(Math.abs(returned - before) < 1e-9, '返回值应是输出增益，与 targetVolume 同域');
});

test('holdAudioOutputGain 无 cancelAndHoldAtTime 时也不改变输出', () => {
  const volume = 0.4;
  const sandbox = createGainSandbox({ targetVolume: volume });
  delete sandbox.gainNode.gain.cancelAndHoldAtTime;
  sandbox.writeAudioOutputGain(volume);
  const before = effectiveGain(sandbox);
  sandbox.holdAudioOutputGain(0);
  assert.ok(
    Math.abs(effectiveGain(sandbox) - before) < 1e-9,
    `降级分支不能把节点写成线性域：${before} → ${effectiveGain(sandbox)}`,
  );
});

test('非拆分链路（capture stream 回退，无 gainNode）保持线性', () => {
  const volume = 0.35;
  const sandbox = createGainSandbox({ targetVolume: volume, split: false });
  sandbox.writeAudioOutputGain(volume);
  assert.ok(Math.abs(sandbox.audio.volume - volume) < 1e-9, '无节点时元素应直接持 v');
  assert.ok(Math.abs(sandbox.currentAudioOutputGain() - volume) < 1e-9, '无节点时读回应等于 v');
  const trace = runRamp(sandbox, volume, 120);
  assert.ok(Math.max(...trace) <= volume + 1e-9, '无节点链路也不应尖峰');
});

test('静音下限可往返，不被误当成 0', () => {
  const sandbox = createGainSandbox({ targetVolume: 0.5 });
  sandbox.writeAudioOutputGain(0);
  assert.ok(Math.abs(effectiveGain(sandbox) - sandbox.AUDIO_SILENCE_GAIN) < 1e-12, '应落到静音下限');
  assert.ok(Math.abs(sandbox.currentAudioOutputGain() - sandbox.AUDIO_SILENCE_GAIN) < 1e-12, '读回应等于静音下限');
});

test('过渡的 outgoingRatio 反映真实占比而非恒为 1', () => {
  // 18-smart-transition-integration.js 用 currentAudioOutputGain()/initialTarget 求旧曲占比。
  // 域混用时该式为 sqrt(v)/v = 1/sqrt(v)，v<1 恒 >1 被 clamp 成 1，占比判断失效。
  const initialTarget = 0.64;
  const sandbox = createGainSandbox({ targetVolume: initialTarget });

  sandbox.writeAudioOutputGain(initialTarget);
  const full = Math.max(0, Math.min(1, sandbox.currentAudioOutputGain() / initialTarget));
  assert.ok(Math.abs(full - 1) < 1e-9, '满音量时占比应为 1');

  sandbox.writeAudioOutputGain(initialTarget * 0.5);
  const halved = Math.max(0, Math.min(1, sandbox.currentAudioOutputGain() / initialTarget));
  assert.ok(
    Math.abs(halved - 0.5) < 1e-6,
    `压到一半时占比应为 0.5，实际 ${halved}（域混用会算成 ${Math.min(1, Math.sqrt(initialTarget * 0.5) / initialTarget)}）`,
  );
});

test('过渡侧仍按 currentAudioOutputGain 求占比（公式未被改走）', () => {
  assert.match(
    transitionSource,
    /currentAudioOutputGain\(\)\s*:\s*initialTarget\)\s*\/\s*initialTarget/,
    'outgoingRatio 仍应基于 currentAudioOutputGain 与 initialTarget 的比值',
  );
});
