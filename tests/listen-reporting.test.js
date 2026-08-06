'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const stats = fs.readFileSync(path.join(root, 'public', 'js', 'modules', '05-playback', '02-listen-stats.js'), 'utf8');
const packageJson = require(path.join(root, 'package.json'));

function namedFunctionSource(source, name) {
  const declaration = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  assert.ok(declaration, `missing ${name}()`);
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
    if (character === '}' && --depth === 0) return source.slice(declaration.index, index + 1);
  }
  throw new Error(`unterminated ${name}()`);
}

test('Netease listen reports use the first valid context source and fall back to album ID', () => {
  const resolveSourceId = vm.runInNewContext(`(${namedFunctionSource(server, 'resolveNeteaseListenSourceId')})`);
  assert.equal(resolveSourceId({ context: { playlistId: '123' }, song: { albumId: '456' } }), '123');
  assert.equal(resolveSourceId({ context: { id: 'home-discovery', sourceId: '789' }, song: { albumId: '456' } }), '789');
  assert.equal(resolveSourceId({ context: { id: 'search' }, song: { albumId: '456' } }), '456');
  assert.equal(resolveSourceId({ songId: '321', context: {}, song: {} }), '321');
  assert.equal(resolveSourceId({ context: {}, song: {} }), '0');
});

test('Netease uses the enhanced EAPI startplay/play reporter and validates both responses', () => {
  assert.equal(packageJson.dependencies['@neteasecloudmusicapienhanced/api'], '4.36.1');
  assert.match(server, /scrobble: enhancedNeteaseScrobble/);
  assert.match(server, /await enhancedNeteaseScrobble\(/);
  assert.match(server, /startplayCode !== 200 \|\| playCode !== 200/);
  assert.match(server, /reporter: 'enhanced-eapi'/);
});

test('successful reports persist enough evidence to diagnose platform submissions', () => {
  const remember = namedFunctionSource(server, 'rememberListenSyncSubmission');
  assert.match(remember, /sourceId:/);
  assert.match(remember, /listenSeconds:/);
  assert.match(remember, /platformCode:/);
  assert.match(remember, /startplayCode:/);
  assert.match(remember, /playCode:/);
  assert.match(server, /\[ListenReport\] netease submitted/);
});

test('the renderer retains the last response and exposes failed submissions', () => {
  const report = namedFunctionSource(stats, 'reportListenSession');
  assert.match(report, /__mineradioLastListenReport/);
  assert.match(report, /response\.json\(\)/);
  assert.match(report, /result\.platformSubmitted !== true/);
  assert.match(report, /\[ListenReport\] request failed/);
});
