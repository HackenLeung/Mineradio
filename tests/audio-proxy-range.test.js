const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '..');
const serverText = fs.readFileSync(path.join(repoRoot, 'server.js'), 'utf8');
const helperStart = serverText.indexOf('const AUDIO_PROXY_OPEN_RANGE_CHUNK_BYTES');
const helperEnd = serverText.indexOf('function qishuiAudioAuthFromUrl', helperStart);

assert.ok(helperStart >= 0, 'audio proxy range helper must exist');
assert.ok(helperEnd > helperStart, 'audio proxy range helper boundary must exist');

const context = {
  Buffer,
  Date,
  Map,
  Promise,
  console: { warn() {} },
  setTimeout,
  clearTimeout,
  readStreamChunkWithTimeout(reader) { return reader.read(); },
  fetchWithTimeout() { throw new Error('fetchWithTimeout stub not installed'); },
};
vm.runInNewContext(
  `${serverText.slice(helperStart, helperEnd)}\nthis.normalizeAudioProxyUpstreamRange = normalizeAudioProxyUpstreamRange; this.parseAudioProxyContentRange = parseAudioProxyContentRange; this.audioProxyContentRangeMatchesRequest = audioProxyContentRangeMatchesRequest; this.audioProxyRangeResponseComplete = audioProxyRangeResponseComplete; this.fetchCompleteAudioProxyRange = fetchCompleteAudioProxyRange; this.fetchAudioProxyRangeWithCache = fetchAudioProxyRangeWithCache;`,
  context,
  { filename: 'audio-proxy-range.js' },
);

function rangeUpstream(payload, range, total) {
  let sent = false;
  return {
    status: 206,
    headers: {
      get(name) {
        if (String(name).toLowerCase() === 'content-range') return range;
        if (String(name).toLowerCase() === 'content-type') return 'audio/flac';
        return '';
      },
    },
    body: {
      getReader() {
        return {
          read() {
            if (sent) return Promise.resolve({ done: true });
            sent = true;
            return Promise.resolve({ done: false, value: payload });
          },
          cancel() { return Promise.resolve(); },
        };
      },
      cancel() { return Promise.resolve(); },
    },
    total,
  };
}

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
    context.normalizeAudioProxyUpstreamRange('bytes=0-2097151'),
    'bytes=0-1048575',
  );
  assert.equal(context.normalizeAudioProxyUpstreamRange(''), '');
  assert.equal(
    context.normalizeAudioProxyUpstreamRange('bytes=-500'),
    'bytes=-500',
  );
});

test('audio proxy validates complete bounded range bodies before responding', () => {
  const parsed = context.parseAudioProxyContentRange('bytes 1048576-2097151/5000000');
  assert.deepEqual({ ...parsed }, { start: 1048576, end: 2097151, total: 5000000, length: 1048576 });
  assert.equal(context.audioProxyRangeResponseComplete(parsed, 1048576), true);
  assert.equal(context.audioProxyRangeResponseComplete(parsed, 900000), false);
  assert.equal(context.audioProxyContentRangeMatchesRequest(parsed, 'bytes=1048576-2097151'), true);
  assert.equal(context.audioProxyContentRangeMatchesRequest(parsed, 'bytes=0-1048575'), false);
  assert.equal(context.audioProxyContentRangeMatchesRequest('bytes 1048576-1572863/5000000', 'bytes=1048576-2097151'), true);
  assert.equal(context.audioProxyContentRangeMatchesRequest('bytes 4194304-4999999/5000000', 'bytes=4194304-5242879'), true);
  assert.equal(context.audioProxyContentRangeMatchesRequest('bytes 9500-9999/10000', 'bytes=-500'), true);
  assert.equal(context.audioProxyContentRangeMatchesRequest('bytes 9000-9499/10000', 'bytes=-500'), false);
  assert.equal(context.parseAudioProxyContentRange('bytes 0-10/10'), null);
});

test('audio proxy retries when upstream headers miss the open deadline', async () => {
  const payload = Buffer.from('retry-range');
  let calls = 0;
  context.fetchWithTimeout = async function () {
    calls += 1;
    if (calls === 1) {
      await new Promise(resolve => setTimeout(resolve, 12));
      const error = new Error('upstream headers timed out');
      error.name = 'AbortError';
      throw error;
    }
    return rangeUpstream(payload, 'bytes 20-30/100', 100);
  };
  const result = await context.fetchCompleteAudioProxyRange(
    'https://audio.invalid/retry.flac',
    { Range: 'bytes=20-30' },
    { clientClosed: false, reader: null },
  );
  assert.equal(calls, 2);
  assert.equal(result.buffer.toString('ascii'), payload.toString('ascii'));
});

test('duplicate renderer ranges share one in-flight fetch and reuse its cache', async () => {
  const payload = Buffer.from('shared-range');
  let calls = 0;
  let releaseUpstream;
  context.fetchWithTimeout = function () {
    calls += 1;
    return new Promise(resolve => {
      releaseUpstream = () => resolve(rangeUpstream(payload, 'bytes 40-51/100', 100));
    });
  };
  const headers = { Range: 'bytes=40-51' };
  const first = context.fetchAudioProxyRangeWithCache(
    'https://audio.invalid/shared.flac',
    headers,
    { clientClosed: false, reader: null },
  );
  const second = context.fetchAudioProxyRangeWithCache(
    'https://audio.invalid/shared.flac',
    headers,
    { clientClosed: false, reader: null },
  );
  assert.equal(calls, 1, 'duplicate range opened more than one upstream request');
  releaseUpstream();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.buffer.toString('ascii'), payload.toString('ascii'));
  assert.strictEqual(firstResult, secondResult);

  const cached = await context.fetchAudioProxyRangeWithCache(
    'https://audio.invalid/shared.flac',
    headers,
    { clientClosed: false, reader: null },
  );
  assert.equal(calls, 1, 'cached range unexpectedly reopened upstream');
  assert.strictEqual(cached, firstResult);
});
