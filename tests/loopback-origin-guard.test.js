'use strict';

// 验证来源分层：把 MINERADIO_HOST 放开到 0.0.0.0 供局域网遥控使用时，
// 非回环来源只能碰到遥控白名单，其余端点（本地音乐流、听歌数据、平台账号、
// 诊断日志）必须仍然只有本机可达。
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');

process.env.PORT = '0';
process.env.MINERADIO_HOST = '0.0.0.0';
delete process.env.HOST;

const server = require('../server');

function firstNonLoopbackIPv4() {
  const groups = os.networkInterfaces();
  for (const name of Object.keys(groups)) {
    for (const info of groups[name] || []) {
      if (info.family !== 'IPv4' && info.family !== 4) continue;
      if (info.internal) continue;
      return info.address;
    }
  }
  return null;
}

function request(host, port, target, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host,
      port,
      path: target,
      method: options.method || 'GET',
      headers: options.headers || {},
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

const GUARDED_PATHS = [
  '/api/local-media?id=whatever',
  '/api/listen/total',
  '/api/diag/stall-log',
  '/api/app/version',
  '/index.html',
  '/',
];

async function run() {
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const port = server.address().port;

  // 回环来源：分层不该挡住本机，播放器自己走的就是这条路。
  const loopbackVersion = await request('127.0.0.1', port, '/api/app/version');
  assert.equal(loopbackVersion.status, 200, '回环访问 /api/app/version 应正常');
  assert.ok(JSON.parse(loopbackVersion.body).version, '应返回版本号');

  const loopbackDiag = await request('127.0.0.1', port, '/api/diag/stall-log');
  assert.equal(loopbackDiag.status, 200, '回环访问诊断日志应正常');

  const lanAddress = firstNonLoopbackIPv4();
  if (!lanAddress) {
    console.log('OK loopback-origin-guard (跳过非回环用例：本机没有可用的局域网网卡)');
    return;
  }

  for (const target of GUARDED_PATHS) {
    const res = await request(lanAddress, port, target);
    assert.equal(res.status, 403, `非回环来源访问 ${target} 应被拒绝，实际 ${res.status}`);
    assert.match(res.body, /Forbidden/, `${target} 应返回 Forbidden 文案`);
  }

  // 遥控白名单必须放行到路由层（此处遥控端点尚未实现，所以只断言「不是 403」，
  // 即门禁没有把它一起拦掉）。
  const remoteAllowed = await request(lanAddress, port, '/api/remote/state');
  assert.notEqual(remoteAllowed.status, 403, '/api/remote/* 不应被来源门禁拦下');

  const remotePage = await request(lanAddress, port, '/remote.html');
  assert.notEqual(remotePage.status, 403, '/remote.html 不应被来源门禁拦下');

  console.log(`OK loopback-origin-guard (局域网来源 ${lanAddress} 已被正确拦截)`);
}

run().then(() => {
  server.close(() => process.exit(0));
}).catch((error) => {
  console.error(error && error.stack || error);
  server.close(() => process.exit(1));
});
