'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'public/js/modules/03-beat/04a-same-tempo-playlist.js'), 'utf8');
const loader = fs.readFileSync(path.join(root, 'public/js/index-loader.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');

function namedFunctionSource(text, name) {
  const declaration = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(text);
  assert.ok(declaration, `expected ${name}()`);
  const bodyStart = text.indexOf('{', declaration.index + declaration[0].length);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = bodyStart; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'" || character === '`') { quote = character; continue; }
    if (character === '{') depth += 1;
    if (character === '}' && --depth === 0) return text.slice(declaration.index, index + 1);
  }
  throw new Error(`unterminated ${name}()`);
}

test('BPM normalization tolerates half-time and double-time maps', () => {
  const normalize = vm.runInNewContext(`(${namedFunctionSource(source, 'normalizeSameTempoBpm')})`);
  const bpmFromMap = vm.runInNewContext(`(${namedFunctionSource(source, 'bpmFromBeatMap')})`, {
    normalizeSameTempoBpm: normalize,
    Number,
    Math,
    isFinite,
  });
  const distance = vm.runInNewContext(`(${namedFunctionSource(source, 'sameTempoBpmDistance')})`);
  assert.equal(normalize(60), 120);
  assert.equal(normalize(200), 100);
  assert.equal(bpmFromMap({ gridStep: 0.5 }), 120);
  assert.equal(distance(87, 174), 0);
});
test('transition playlist keeps the seed first and builds an energy arc', () => {
  const bpm = { seed: 120, a: 119, b: 121, c: 124, d: 116, e: 128, f: 112 };
  const energy = { seed: 0.2, a: 0.24, b: 0.31, c: 0.43, d: 0.52, e: 0.66, f: 0.78 };
  const distance = vm.runInNewContext(`(${namedFunctionSource(source, 'sameTempoBpmDistance')})`);
  const match = vm.runInNewContext(`(${namedFunctionSource(source, 'matchSameTempoSongs')})`, {
    sameTempoSongKey: song => song.key,
    getCachedSongBpm: song => bpm[song.key],
    getCachedSongEnergy: song => energy[song.key],
    sameTempoBpmDistance: distance,
    Number,
    Math,
    Infinity,
  });
  const seed = { key: 'seed' };
  const candidates = [seed, ...['a', 'b', 'c', 'd', 'e', 'f'].map(key => ({ key }))];
  const result = match(120, candidates, 6, seed);
  assert.equal(result.length, 6);
  assert.equal(result[0].song.key, 'seed');
  for (let index = 2; index < result.length; index += 1) {
    assert.ok(result[index].energy >= result[index - 1].energy - 0.15);
  }
});

test('same-tempo module is loaded in order and limits expensive fallback analysis', () => {
  assert.match(loader, /03-beat\/04-beat-map-runtime\.js'[\s\S]{0,120}03-beat\/04a-same-tempo-playlist\.js'[\s\S]{0,120}03-beat\/05-cover-loading-crop\.js'/);
  assert.match(html, /id="same-tempo-modal"/);
  assert.match(html, /onclick="openSameTempoGenerator\(\)"/);
  assert.match(source, /loadSameTempoDiskMap\(candidates\[index\]\)/);
  assert.match(source, /\.slice\(0, 6\)/);
  assert.match(source, /writeBeatDiskCache\(diskKey, map, song, 'same-tempo'\)/);
});
