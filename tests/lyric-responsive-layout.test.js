'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/js/modules/02-visual/10-lyrics-mask-textures.js'), 'utf8');

function namedFunctionSource(text, name) {
  const declaration = new RegExp(`function\\s+${name}\\s*\\(`).exec(text);
  assert.ok(declaration, `expected ${name}()`);
  const bodyStart = text.indexOf('{', declaration.index + declaration[0].length);
  let depth = 0;
  for (let index = bodyStart; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1;
    if (text[index] === '}' && --depth === 0) return text.slice(declaration.index, index + 1);
  }
  throw new Error(`unterminated ${name}()`);
}

test('long stage lyrics keep the old fixed frame and shrink before horizontal compression', () => {
  const beginLayoutSource = namedFunctionSource(source, 'beginLyricMaskLayoutBuild');
  assert.match(beginLayoutSource, /var maxCanvasW = baseCanvasW/);
  assert.match(source, /var maxWidth = baseCanvasW - 190/);
  assert.doesNotMatch(beginLayoutSource, /Math\.min\(6144/);

  const finalize = vm.runInNewContext(`(${namedFunctionSource(source, 'finalizeLyricMaskLayoutBuild')})`, {
    clampRange: (value, min, max) => Math.max(min, Math.min(max, Number(value))),
    scaledLyricMaskLayoutWidth: (_state, _index, size) => 7000 * size / 128,
    lyricMeasureTextAtSize: (_ctx, _text, size) => 7000 * size / 128,
    lyricEntryWeight: () => 700,
    lyricFontCss: size => `700 ${size}px sans-serif`,
    lyricLineHeightFactor: () => 1,
    lyricContextSpreadValue: () => 1,
    isFinite,
    Number,
    Math,
  });
  const state = {
    layoutOverride: {},
    payload: {},
    entries: [{ text: 'very long lyric', scale: 1 }],
    lines: ['very long lyric'],
    activeLine: 0,
    fitMeasureIndexes: [0],
    baseCanvasW: 2048,
    maxCanvasW: 2048,
    canvasHeight: 384,
    ctx: {},
    maxLines: 1,
    lockedFontSize: NaN,
    completedPhases: 0,
  };
  const layout = finalize(state);
  assert.equal(layout.canvasWidth, 2048);
  assert.ok(layout.fontSize < 128);
  assert.ok(layout.fitScaleX < 1);
  assert.ok(layout.textWidth <= 2048 - 190);
});

test('locked row font is a ceiling and long Latin lyrics keep readable proportions', () => {
  const finalize = vm.runInNewContext(`(${namedFunctionSource(source, 'finalizeLyricMaskLayoutBuild')})`, {
    clampRange: (value, min, max) => Math.max(min, Math.min(max, Number(value))),
    scaledLyricMaskLayoutWidth: (_state, _index, size) => 7000 * size / 128,
    lyricMeasureTextAtSize: (_ctx, _text, size) => 7000 * size / 128,
    lyricEntryWeight: () => 700,
    lyricFontCss: size => `700 ${size}px sans-serif`,
    lyricLineHeightFactor: () => 1,
    lyricContextSpreadValue: () => 1,
    isFinite,
    Number,
    Math,
  });
  const state = {
    layoutOverride: { fontSize: 128, lineHeight: 138 },
    payload: {},
    entries: [{ text: 'Take me back, back home duong ve cung chang co xa', scale: 1 }],
    lines: ['Take me back, back home duong ve cung chang co xa'],
    activeLine: 0,
    fitMeasureIndexes: [0],
    baseCanvasW: 2048,
    maxCanvasW: 2048,
    canvasHeight: 384,
    ctx: {},
    maxLines: 1,
    lockedFontSize: 128,
    completedPhases: 0,
  };

  const layout = finalize(state);
  assert.equal(layout.canvasWidth, 2048);
  assert.ok(layout.fontSize < 128);
  assert.ok(layout.fitScaleX >= 0.72, `expected readable width, got ${layout.fitScaleX}`);
  assert.ok(layout.textWidth <= 2048 - 190);
});
