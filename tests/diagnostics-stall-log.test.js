'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const diagDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-diag-'));

process.env.PORT = '0';
process.env.HOST = '127.0.0.1';
process.env.MINERADIO_DIAG_DIR = diagDir;

const server = require('../server');
const STALL_LOG_FILE = path.join(diagDir, 'stall.jsonl');

function request(port, target, options = {}) {
  return new Promise((resolve, reject) => {
    const payload = options.body == null ? null : Buffer.from(options.body, 'utf8');
    const headers = Object.assign({}, options.headers || {});
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(payload.length);
    }
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: target,
      method: options.method || 'GET',
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function readLogLines() {
  if (!fs.existsSync(STALL_LOG_FILE)) return [];
  return fs.readFileSync(STALL_LOG_FILE, 'utf8').split('\n').filter(Boolean);
}

async function run() {
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const port = server.address().port;
  const route = '/api/diag/stall-log';

  // 空日志时也要报出文件绝对路径，用户不必猜缓存根目录在哪。
  const empty = await request(port, route);
  assert.equal(empty.status, 200);
  assert.match(empty.headers['content-type'], /text\/plain/);
  assert.ok(empty.body.includes(STALL_LOG_FILE), 'GET 应打印日志文件绝对路径');
  assert.ok(empty.body.includes('entries: 0'), '空日志应报 entries: 0');

  const posted = await request(port, route, {
    method: 'POST',
    body: JSON.stringify({
      reason: 'clock-frozen',
      currentTime: 87.4237,
      duration: 214.5,
      readyState: 4,
      networkState: 2,
      paused: false,
      seeking: false,
      bufferedEnd: 120.25,
      audioCtxState: 'running',
      lastWaitingAgoMs: 1234.6,
      smartTransition: false,
      songKey: 'song-key-1',
      title: '测试歌曲',
      src: 'http://127.0.0.1/audio?id=1',
    }),
  });
  assert.equal(posted.status, 200);
  const postedJson = JSON.parse(posted.body);
  assert.equal(postedJson.accepted, true);
  assert.equal(postedJson.file, STALL_LOG_FILE);
  assert.equal(postedJson.entry.reason, 'clock-frozen');
  assert.equal(postedJson.entry.currentTime, 87.42, '数值应按 2 位截断');
  assert.equal(postedJson.entry.lastWaitingAgoMs, 1235, 'waiting 间隔应取整');
  assert.equal(postedJson.entry.readyState, 4);
  assert.equal(postedJson.entry.paused, false);
  assert.ok(postedJson.entry.ts, '应带时间戳');

  const lines = readLogLines();
  assert.equal(lines.length, 1, 'POST 应追加一行');
  const stored = JSON.parse(lines[0]);
  assert.equal(stored.title, '测试歌曲');
  assert.equal(stored.audioCtxState, 'running');

  // 追加而不是覆盖：第二条不能把第一条冲掉。
  await request(port, route, { method: 'POST', body: JSON.stringify({ reason: 'clock-frozen', currentTime: 12 }) });
  assert.equal(readLogLines().length, 2, '第二条应追加而非覆盖');

  const rendered = await request(port, route);
  assert.equal(rendered.status, 200);
  assert.ok(rendered.body.includes('entries: 2'));
  assert.ok(rendered.body.includes('rs=4'), '应渲染 readyState');
  assert.ok(rendered.body.includes('ctx=running'), '应渲染 audioCtx 状态');
  assert.ok(rendered.body.includes('waiting=1235ms'), '应渲染 waiting 间隔');
  assert.ok(rendered.body.includes('waiting=never'), '缺少 waiting 时应显示 never');
  const firstEntryLine = rendered.body.split('\n').filter(line => line.startsWith('['))[0];
  assert.ok(firstEntryLine.includes('t=12'), '最新的条目应排在最前');

  // 非法字段不能让端点崩，缺字段落 null 即可。
  const sparse = await request(port, route, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(sparse.status, 200);
  const sparseEntry = JSON.parse(sparse.body).entry;
  assert.equal(sparseEntry.reason, 'unknown');
  assert.equal(sparseEntry.currentTime, null);
  assert.equal(sparseEntry.readyState, null);

  // 超长字符串必须截断，否则这个跨重启累积的文件会被撑爆。
  const longSrc = 'http://127.0.0.1/audio?id=' + 'x'.repeat(500);
  const truncated = await request(port, route, { method: 'POST', body: JSON.stringify({ reason: 'clock-frozen', src: longSrc, title: 'y'.repeat(400) }) });
  const truncatedEntry = JSON.parse(truncated.body).entry;
  assert.equal(truncatedEntry.src.length, 120, 'src 应截断到 120');
  assert.equal(truncatedEntry.title.length, 120, 'title 应截断到 120');

  assert.equal((await request(port, route, { method: 'DELETE' })).status, 405);
  console.log('OK diagnostics-stall-log');
}

run().then(() => {
  server.close(() => process.exit(0));
}).catch((error) => {
  console.error(error && error.stack || error);
  server.close(() => process.exit(1));
});
