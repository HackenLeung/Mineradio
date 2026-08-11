const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '..');
const serverText = fs.readFileSync(path.join(repoRoot, 'server.js'), 'utf8');
const helperStart = serverText.indexOf('const AUDIO_PROXY_OPEN_RANGE_CHUNK_BYTES');
const helperEnd = serverText.indexOf('function sendAudioBuffer', helperStart);

assert.ok(helperStart >= 0, 'audio proxy range helper must exist');
assert.ok(helperEnd > helperStart, 'audio proxy range helper boundary must exist');

const stallLogEntries = [];
const context = {
  Buffer,
  Date,
  Map,
  Math,
  Number,
  Promise,
  console: { warn() {} },
  setTimeout,
  clearTimeout,
  readStreamChunkWithTimeout(reader) { return reader.read(); },
  fetchWithTimeout() { throw new Error('fetchWithTimeout stub not installed'); },
  appendStallLogEntry(entry) { stallLogEntries.push(entry); return Promise.resolve(entry); },
};
vm.runInNewContext(
  `${serverText.slice(helperStart, helperEnd)}\nthis.normalizeAudioProxyUpstreamRange = normalizeAudioProxyUpstreamRange; this.parseAudioProxyContentRange = parseAudioProxyContentRange; this.audioProxyContentRangeMatchesRequest = audioProxyContentRangeMatchesRequest; this.audioProxyRangeResponseComplete = audioProxyRangeResponseComplete; this.fetchCompleteAudioProxyRange = fetchCompleteAudioProxyRange; this.fetchAudioProxyRangeWithCache = fetchAudioProxyRangeWithCache; this.scheduleAudioProxyReadAhead = scheduleAudioProxyReadAhead; this.recordAudioProxyPrefetchBytes = recordAudioProxyPrefetchBytes; this.throughputSample = audioProxyThroughputSample; this.CHUNK = AUDIO_PROXY_OPEN_RANGE_CHUNK_BYTES; this.READ_AHEAD = AUDIO_PROXY_READ_AHEAD_CHUNKS; this.READ_AHEAD_BYTES = AUDIO_PROXY_READ_AHEAD_BYTES; this.READ_AHEAD_MAX = AUDIO_PROXY_READ_AHEAD_MAX_CHUNKS; this.FETCH_ATTEMPTS = AUDIO_PROXY_RANGE_FETCH_ATTEMPTS; this.SAMPLE_MS = AUDIO_PROXY_THROUGHPUT_SAMPLE_MS;`,
  context,
  { filename: 'audio-proxy-range.js' },
);

// 块大小是可调参数，断言从常量推导，避免每次调优都要改一遍测试。
const CHUNK = context.CHUNK;
assert.ok(CHUNK > 0, 'chunk size must be exported');
assert.ok(context.READ_AHEAD > 0, 'read-ahead depth must be exported');

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
    `bytes=0-${CHUNK - 1}`,
  );
  assert.equal(
    context.normalizeAudioProxyUpstreamRange(`bytes=${CHUNK}-`),
    `bytes=${CHUNK}-${2 * CHUNK - 1}`,
  );
});

test('audio proxy preserves explicit, empty, and suffix ranges', () => {
  assert.equal(
    context.normalizeAudioProxyUpstreamRange(`bytes=0-${4 * CHUNK - 1}`),
    `bytes=0-${CHUNK - 1}`,
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
  // total 收紧到 52：这块正好到文件结尾，预读会在 EOF 处停住，
  // 让这个用例只考察「同一 Range 去重」，不被预读的额外请求干扰。
  context.fetchWithTimeout = function () {
    calls += 1;
    return new Promise(resolve => {
      releaseUpstream = () => resolve(rangeUpstream(payload, 'bytes 40-51/52', 52));
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

// 预读把「攒满一块再发」的串行链路变成真正的缓冲。这一组盯住四件事：
// 请求头要整份克隆、到文件尾要停、失败不能转嫁给真实请求、窗口深度要对得上。
test('read-ahead clones upstream headers instead of sending Range alone', async () => {
  const seen = [];
  context.fetchWithTimeout = async function (url, options) {
    seen.push(options.headers);
    const range = /bytes=(\d+)-(\d+)/.exec(options.headers.Range);
    const start = Number(range[1]);
    const end = Number(range[2]);
    return rangeUpstream(Buffer.alloc(end - start + 1, 1), `bytes ${start}-${end}/${100 * CHUNK}`, 100 * CHUNK);
  };
  const headers = {
    'User-Agent': 'probe-agent',
    Referer: 'https://music.163.com/',
    'Accept-Encoding': 'identity',
    Range: `bytes=0-${CHUNK - 1}`,
  };
  context.scheduleAudioProxyReadAhead('https://audio.invalid/headers.flac', headers, 100 * CHUNK);
  await new Promise(resolve => setTimeout(resolve, 20));

  assert.equal(seen.length, context.READ_AHEAD, 'read-ahead must open one request per configured chunk');
  for (const sent of seen) {
    // 只带 Range 会被 CDN 以 403 挡掉，而且失败是静默的：播放仍走客户端那条路，
    // 预读永远不生效却看不出来。所以这三个头必须逐个盯住。
    assert.equal(sent['User-Agent'], 'probe-agent', 'read-ahead dropped User-Agent');
    assert.equal(sent.Referer, 'https://music.163.com/', 'read-ahead dropped Referer');
    assert.equal(sent['Accept-Encoding'], 'identity', 'read-ahead dropped Accept-Encoding');
  }
  // 预读的键必须和浏览器之后发的 `bytes=N-` 归一化结果逐字一致，否则永远不命中。
  assert.deepEqual(
    seen.map(sent => sent.Range),
    Array.from({ length: context.READ_AHEAD }, (_, i) => context.normalizeAudioProxyUpstreamRange(`bytes=${(i + 1) * CHUNK}-`)),
  );
});

test('read-ahead stops at end of file instead of requesting past it', async () => {
  let calls = 0;
  context.fetchWithTimeout = async function (url, options) {
    calls += 1;
    const range = /bytes=(\d+)-(\d+)/.exec(options.headers.Range);
    const start = Number(range[1]);
    const total = 2 * CHUNK;
    const end = Math.min(Number(range[2]), total - 1);
    return rangeUpstream(Buffer.alloc(end - start + 1, 2), `bytes ${start}-${end}/${total}`, total);
  };
  // 已served 第 0 块，总长 2 块 → 只剩第 1 块可预读，第 2 块起越界必须停。
  context.scheduleAudioProxyReadAhead(
    'https://audio.invalid/eof.flac',
    { Referer: 'https://music.163.com/', Range: `bytes=0-${CHUNK - 1}` },
    2 * CHUNK,
  );
  await new Promise(resolve => setTimeout(resolve, 20));
  // 越界的 Range 会拿回 416，而非 206 分支不 cancel body，等于每首歌漏一个连接。
  assert.equal(calls, 1, 'read-ahead must not request ranges beyond the known total');
});

test('a failed read-ahead never rejects a real client awaiting the same range', async () => {
  const url = 'https://audio.invalid/poison.flac';
  const nextRange = `bytes=${CHUNK}-${2 * CHUNK - 1}`;
  // 按 Range 分别计数，而不是用全局调用序号：4 个预读是并发的，
  // 用全局序号会让断言依赖交错顺序。
  const failures = Object.create(null);
  context.fetchWithTimeout = async function (targetUrl, options) {
    const sentRange = options.headers.Range;
    if (sentRange === nextRange) {
      failures[sentRange] = (failures[sentRange] || 0) + 1;
      // 把重试额度全部打挂，让这次预读彻底 reject，才能验证它不会转嫁出去。
      if (failures[sentRange] <= context.FETCH_ATTEMPTS) throw new Error('prefetch upstream exploded');
    }
    const range = /bytes=(\d+)-(\d+)/.exec(sentRange);
    const start = Number(range[1]);
    const end = Number(range[2]);
    return rangeUpstream(Buffer.alloc(end - start + 1, 3), `bytes ${start}-${end}/${100 * CHUNK}`, 100 * CHUNK);
  };
  context.scheduleAudioProxyReadAhead(
    url,
    { Referer: 'https://music.163.com/', Range: `bytes=0-${CHUNK - 1}` },
    100 * CHUNK,
  );
  // 预读失败若 reject 到 in-flight promise 上，真实请求 await 它就会变成播放侧的 502。
  // 先让预读走完（含重试）再发真实请求，覆盖「客户端接手一个已失败的预读」这条路径。
  await new Promise(resolve => setTimeout(resolve, 30));
  const served = await context.fetchAudioProxyRangeWithCache(
    url,
    { Referer: 'https://music.163.com/', Range: nextRange },
    { clientClosed: false, reader: null },
  );
  assert.ok(served && served.buffer, 'client must still get its bytes after a read-ahead failure');
  assert.equal(served.buffer.length, CHUNK);
});

test('read-ahead depth follows the byte budget and stays under the connection cap', () => {
  // 深度是推导值而不是魔数：块大小一改，预算不变，连接数不能跟着翻倍。
  assert.equal(
    context.READ_AHEAD,
    Math.max(1, Math.min(context.READ_AHEAD_MAX, Math.floor(context.READ_AHEAD_BYTES / CHUNK))),
  );
  assert.ok(context.READ_AHEAD >= 1, 'depth must never round down to zero');
  assert.ok(context.READ_AHEAD <= context.READ_AHEAD_MAX, 'depth must respect the connection cap');
  assert.ok(context.READ_AHEAD * CHUNK <= context.READ_AHEAD_BYTES, 'in-flight bytes must stay within budget');
});

test('prefetch throughput is aggregated over wall clock, not summed per request', () => {
  stallLogEntries.length = 0;
  // 前面的预读用例已经把窗口起点设成了真实墙上时间。不清掉的话，下面把时钟
  // 拨到 1_000_000 会算出负的 elapsed，报告永远不触发——用例会以错误的理由通过。
  context.throughputSample.bytes = 0;
  context.throughputSample.since = 0;
  context.throughputSample.reportedKbps = -1;
  const realDate = context.Date;
  let now = 1_000_000;
  // 只有 Date.now 被用到，给个最小替身即可；Object.create(Date) 不是可用的构造器。
  context.Date = { now: () => now };
  try {
    // 窗口未满不出报告，免得每块都写一行盘。
    context.recordAudioProxyPrefetchBytes(CHUNK);
    assert.equal(stallLogEntries.length, 0, 'a partial window must not emit a report');

    // 并发预读：同一窗口内多块完成，聚合速率要按墙上时间算。
    // 若把每个请求的耗时相加，并行度会被当成额外速度，正好抹掉要测的那个量。
    now += context.SAMPLE_MS;
    context.recordAudioProxyPrefetchBytes(CHUNK);
    assert.equal(stallLogEntries.length, 1, 'a full window must emit exactly one report');

    const entry = stallLogEntries[0];
    assert.equal(entry.reason, 'prefetch-throughput');
    assert.equal(entry.sampleBytes, 2 * CHUNK);
    assert.equal(entry.sampleMs, context.SAMPLE_MS);
    assert.equal(entry.throughputKbps, Math.round((2 * CHUNK / 1024) / (context.SAMPLE_MS / 1000)));

    // 窗口要归零，否则字节会一直累加，速率越算越高。
    now += context.SAMPLE_MS;
    context.recordAudioProxyPrefetchBytes(CHUNK);
    assert.equal(stallLogEntries.length, 2);
    assert.equal(stallLogEntries[1].sampleBytes, CHUNK, 'the window must reset after reporting');
  } finally {
    context.Date = realDate;
    context.throughputSample.bytes = 0;
    context.throughputSample.since = 0;
    context.throughputSample.reportedKbps = -1;
  }
});

// stall.jsonl 只留最后 500 行。每 10 秒无条件写一行 = 每小时 360 行，稳态播放
// 不到一小时半就把 clock-frozen 全挤出去——加一个诊断反而毁掉文件本来的用途。
// 所以「平稳时保持安静」不是优化，是这个文件能继续用下去的前提。
test('steady throughput stays silent so it cannot evict freeze rows', () => {
  stallLogEntries.length = 0;
  context.throughputSample.bytes = 0;
  context.throughputSample.since = 0;
  context.throughputSample.reportedKbps = -1;
  const realDate = context.Date;
  let now = 5_000_000;
  context.Date = { now: () => now };
  try {
    // since=0 时第一次调用只是把窗口起点设成"现在"就返回，本身不构成一个采样窗口。
    // 要凑满一个窗口得先有起点、再让时钟走过 SAMPLE_MS。
    context.recordAudioProxyPrefetchBytes(4 * CHUNK);
    assert.equal(stallLogEntries.length, 0, 'opening the window must not report on its own');

    // 首条必报，否则一首歌可能一条吞吐都没有。
    now += context.SAMPLE_MS;
    context.recordAudioProxyPrefetchBytes(4 * CHUNK);
    assert.equal(stallLogEntries.length, 1, 'the first full window must always report');
    const steady = stallLogEntries[0].throughputKbps;

    // 完全持平的十个窗口：一条都不该写。
    for (let i = 0; i < 10; i += 1) {
      now += context.SAMPLE_MS;
      context.recordAudioProxyPrefetchBytes(8 * CHUNK);
    }
    assert.equal(stallLogEntries.length, 1, 'flat throughput must not append a single row');

    // 劣化必须出声：这正是要留住的信号。
    now += context.SAMPLE_MS;
    context.recordAudioProxyPrefetchBytes(2 * CHUNK);
    assert.equal(stallLogEntries.length, 2, 'a material drop must report');
    assert.ok(stallLogEntries[1].throughputKbps < steady);

    // 恢复也要出声，否则只看得到掉下去、看不到爬回来。
    now += context.SAMPLE_MS;
    context.recordAudioProxyPrefetchBytes(8 * CHUNK);
    assert.equal(stallLogEntries.length, 3, 'a recovery must report too');
    assert.equal(stallLogEntries[2].throughputKbps, steady);
  } finally {
    context.Date = realDate;
    context.throughputSample.bytes = 0;
    context.throughputSample.since = 0;
    context.throughputSample.reportedKbps = -1;
  }
});
