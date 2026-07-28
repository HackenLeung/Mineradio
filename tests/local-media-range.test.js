'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

process.env.PORT = '0';
process.env.HOST = '127.0.0.1';

const server = require('../server');

function request(port, target, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: target,
      method: options.method || 'GET',
      headers: options.headers || {},
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function run() {
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-local-media-'));
  const mediaPath = path.join(tempDir, 'sample.mp3');
  const payload = Buffer.from('0123456789abcdef', 'ascii');
  fs.writeFileSync(mediaPath, payload);
  const id = server.registerLocalMediaPath(mediaPath);
  const port = server.address().port;
  const route = `/api/local-media?id=${encodeURIComponent(id)}`;

  const full = await request(port, route);
  assert.equal(full.status, 200);
  assert.equal(full.headers['accept-ranges'], 'bytes');
  assert.equal(full.headers['content-type'], 'audio/mpeg');
  assert.equal(Number(full.headers['content-length']), payload.length);
  assert.deepEqual(full.body, payload);

  const head = await request(port, route, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers['content-length']), payload.length);
  assert.equal(head.body.length, 0);

  const range = await request(port, route, { headers: { Range: 'bytes=3-7' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers['content-range'], 'bytes 3-7/16');
  assert.equal(range.body.toString('ascii'), '34567');

  const invalidRange = await request(port, route, { headers: { Range: 'bytes=99-100' } });
  assert.equal(invalidRange.status, 416);
  assert.equal(invalidRange.headers['content-range'], 'bytes */16');

  assert.equal((await request(port, '/api/local-media?id=unknown')).status, 404);
  assert.equal((await request(port, route, { method: 'POST' })).status, 405);
  console.log('OK local-media-range');
}

run().then(() => {
  server.close(() => process.exit(0));
}).catch((error) => {
  console.error(error && error.stack || error);
  server.close(() => process.exit(1));
});

