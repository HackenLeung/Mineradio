const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '..');
const serverText = fs.readFileSync(path.join(repoRoot, 'server.js'), 'utf8');
const helperStart = serverText.indexOf('const AUDIO_PROXY_OPEN_RANGE_CHUNK_BYTES');
const helperEnd = serverText.indexOf('function audioProxyHeadersFor', helperStart);

assert.ok(helperStart >= 0, 'audio proxy range helper must exist');
assert.ok(helperEnd > helperStart, 'audio proxy range helper boundary must exist');

const context = {};
vm.runInNewContext(
  `${serverText.slice(helperStart, helperEnd)}\nthis.normalizeAudioProxyUpstreamRange = normalizeAudioProxyUpstreamRange;`,
  context,
  { filename: 'audio-proxy-range.js' },
);

test('audio proxy bounds open-ended upstream ranges', () => {
  assert.equal(
    context.normalizeAudioProxyUpstreamRange('bytes=0-'),
    'bytes=0-1048575',
  );
  assert.equal(
    context.normalizeAudioProxyUpstreamRange('bytes=1048576-'),
    'bytes=1048576-2097151',
  );
});

test('audio proxy preserves explicit, empty, and suffix ranges', () => {
  assert.equal(
    context.normalizeAudioProxyUpstreamRange('bytes=0-8191'),
    'bytes=0-8191',
  );
  assert.equal(context.normalizeAudioProxyUpstreamRange(''), '');
  assert.equal(
    context.normalizeAudioProxyUpstreamRange('bytes=-500'),
    'bytes=-500',
  );
});
