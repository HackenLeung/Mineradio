'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appRoot = path.resolve(__dirname, '..');
const homeVisualScript = fs.readFileSync(
  path.join(appRoot, 'public', 'js', 'modules', '05-playback', '04-home-empty-wallpaper.js'),
  'utf8',
);
const persistenceScript = fs.readFileSync(
  path.join(appRoot, 'public', 'js', 'modules', '02-visual', '04-visual-settings-persistence.js'),
  'utf8',
);

function namedFunctionSource(source, name) {
  const declaration = new RegExp(`function\\s+${name}\\s*\\(`).exec(source);
  assert.ok(declaration, `expected ${name}()`);
  const bodyStart = source.indexOf('{', declaration.index + declaration[0].length);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = bodyStart; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(declaration.index, index + 1);
    }
  }
  assert.fail(`could not extract ${name}()`);
}

test('startup uses starfield even when the previous queue and current item were restored', () => {
  const calls = [];
  const context = {
    playing: false,
    audio: { paused: true },
    currentIdx: 3,
    fx: { preset: 2 },
    startupVisualPreviewActive: false,
    hasRestoredPlaybackCandidate: () => true,
    setPreset: (preset, options) => calls.push({ preset, options }),
    syncFxUniforms: () => calls.push({ sync: true }),
  };
  const applyStartupStarfieldPreset = vm.runInNewContext(
    `(${namedFunctionSource(homeVisualScript, 'applyStartupStarfieldPreset')})`,
    context,
  );

  applyStartupStarfieldPreset();

  assert.equal(context.startupVisualPreviewActive, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].preset, 5);
  assert.equal(calls[0].options.noSave, true);
  assert.equal(calls[0].options.skipTransition, true);
});

test('successful playback restores the saved playback visual without overwriting it', () => {
  const calls = [];
  const context = {
    document: { body: { classList: { remove: () => {} } } },
    homeVisualPresetActive: false,
    playbackVisualPreset: 2,
    startupVisualPreviewActive: true,
    fxDefaults: { preset: 0 },
    fx: { preset: 5 },
    setPreset: (preset, options) => calls.push({ preset, options }),
    syncFxUniforms: () => calls.push({ sync: true }),
    updateRenderPowerClasses: () => {},
    recoverVisualsAfterBackground: () => {},
    isDeepBackgroundMode: () => false,
  };
  const switchPlaybackVisualToEmily = vm.runInNewContext(
    `(${namedFunctionSource(homeVisualScript, 'switchPlaybackVisualToEmily')})`,
    context,
  );

  switchPlaybackVisualToEmily();

  assert.equal(context.startupVisualPreviewActive, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].preset, 2);
  assert.equal(calls[0].options.noSave, true);
});

test('saving settings during the startup preview preserves the saved playback preset', () => {
  const saveLyricLayout = namedFunctionSource(persistenceScript, 'saveLyricLayout');
  const presetExpression = /var presetForSave = ([\s\S]*?);/.exec(saveLyricLayout);
  assert.ok(presetExpression, 'expected presetForSave expression');
  assert.match(presetExpression[1], /startupVisualPreviewActive && !playing/);
  assert.doesNotMatch(presetExpression[1], /currentIdx/);
  assert.match(presetExpression[1], /\? playbackVisualPreset/);
});
