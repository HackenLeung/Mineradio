'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const controls = fs.readFileSync(path.join(root, 'public/js/modules/05-playback/14-player-controls.js'), 'utf8');
const snapshot = fs.readFileSync(path.join(root, 'public/js/modules/05-playback/09-queue-snapshot-autoplay.js'), 'utf8');
const homeActions = fs.readFileSync(path.join(root, 'public/js/modules/05-playback/05-home-actions.js'), 'utf8');

// playModeLabel .. cyclePlayMode are contiguous, so one slice pulls in the whole
// play-mode block without needing the rest of the module's dependencies.
function playModeBlock() {
  const start = controls.indexOf('function playModeLabel');
  const end = controls.indexOf('function cyclePlayMode');
  assert.ok(start >= 0 && end > start, 'expected the play-mode block');
  return controls.slice(start, end);
}

function fakeElement() {
  return {
    dataset: {},
    textContent: '',
    innerHTML: '',
    title: '',
    attributes: {},
    classes: new Set(),
    setAttribute(name, value) { this.attributes[name] = value; },
    classList: {
      toggle(name, on) { if (on) this.owner.classes.add(name); else this.owner.classes.delete(name); },
      add(name) { this.owner.classes.add(name); },
      remove(name) { this.owner.classes.delete(name); },
    },
  };
}

function createSandbox(initialMode) {
  const elements = {
    'play-mode-chip': fakeElement(),
    'play-mode-btn': fakeElement(),
    'play-mode-icon': fakeElement(),
  };
  Object.values(elements).forEach(element => { element.classList.owner = element; });
  const sandbox = {
    playMode: initialMode,
    document: { getElementById: id => elements[id] || null },
    window: {},
    String,
    setTimeout,
  };
  vm.runInNewContext(playModeBlock(), sandbox);
  return { sandbox, elements };
}

test('restoring a persisted play mode repaints the button instead of leaving it on loop', () => {
  // The module-load updatePlayModeButton() runs while playMode is still the initial
  // 'loop'. A restore path that only assigns the variable leaves the chip reading
  // 顺序循环 while nextTrack()/smartCrossfadeNextIndex() already behave as shuffle.
  const { sandbox, elements } = createSandbox('loop');
  assert.equal(elements['play-mode-chip'].textContent, '');

  sandbox.applyRestoredPlayMode('shuffle');
  assert.equal(sandbox.playMode, 'shuffle');
  assert.equal(elements['play-mode-chip'].textContent, '随机播放');
  assert.equal(elements['play-mode-btn'].dataset.mode, 'shuffle');
  assert.equal(elements['play-mode-btn'].attributes['aria-label'], '随机播放');
  assert.equal(elements['play-mode-btn'].classes.has('active'), true);
  assert.match(elements['play-mode-icon'].innerHTML, /M4 20 21 3/);

  sandbox.applyRestoredPlayMode('single');
  assert.equal(elements['play-mode-chip'].textContent, '单曲循环');
  assert.equal(elements['play-mode-btn'].dataset.mode, 'single');
});

test('an absent or unusable persisted play mode never desyncs the button', () => {
  const { sandbox, elements } = createSandbox('shuffle');

  // Nothing saved: keep whatever the session already has, do not force loop.
  sandbox.applyRestoredPlayMode('');
  assert.equal(sandbox.playMode, 'shuffle');
  assert.equal(elements['play-mode-btn'].dataset.mode, undefined);

  // Garbage in storage must land on a real mode, not on a value cyclePlayMode
  // cannot find in its modes array.
  sandbox.applyRestoredPlayMode('random');
  assert.equal(sandbox.playMode, 'loop');
  assert.equal(elements['play-mode-chip'].textContent, '顺序循环');
  assert.equal(elements['play-mode-btn'].classes.has('active'), false);
});

test('both snapshot restore paths go through applyRestoredPlayMode', () => {
  [snapshot, homeActions].forEach(source => {
    assert.match(source, /applyRestoredPlayMode\(snapshot\.playMode\)/);
    assert.doesNotMatch(source, /^\s*if \(snapshot\.playMode\) playMode = snapshot\.playMode;/m);
  });
});
