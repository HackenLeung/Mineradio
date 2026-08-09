'use strict';

// 第二监听器：主端口永远只绑回环，手机连的是这个按需起停的独立监听器。
// 这样「装机版也能用局域网遥控」不再依赖用户设环境变量，且开关不碰主服务
// （重绑主端口会断掉 /api/audio 的长连接流式代理，正在播的歌会断）。
//
// 这里重点验三件事：
//   1. 关闭时端口真的不存在（不是靠 403 挡，而是压根没监听）
//   2. 遥控监听器上的请求一律按外部来源处理 —— 包括本机回环连过来的
//   3. 端口稳定，关开一轮还是同一个（手机存了书签/token 不用重扫）
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-listener-'));

process.env.PORT = '0';
process.env.MINERADIO_REMOTE_DIR = remoteDir;
delete process.env.MINERADIO_HOST;
delete process.env.HOST;

const server = require('../server');
server.setRemoteCommandSink(() => {});

function firstLanIPv4() {
  for (const group of Object.values(os.networkInterfaces())) {
    for (const info of group || []) {
      if ((info.family === 'IPv4' || info.family === 4) && !info.internal) return info.address;
    }
  }
  return null;
}

function request(host, port, target, options = {}) {
  return new Promise((resolve) => {
    const payload = options.body == null ? null : Buffer.from(JSON.stringify(options.body), 'utf8');
    const headers = Object.assign({}, options.headers || {});
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(payload.length);
    }
    const req = http.request({
      host, port, path: target, method: options.method || 'GET', headers, timeout: 4000,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) { json = null; }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', (err) => resolve({ status: 0, error: err.code }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'TIMEOUT' }); });
    if (payload) req.write(payload);
    req.end();
  });
}

async function run() {
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const mainPort = server.address().port;
  const local = (target, options) => request('127.0.0.1', mainPort, target, options);

  // 默认状态：主端口只绑回环，监听器没起
  const initial = await local('/api/remote/listener');
  assert.equal(initial.status, 200);
  assert.equal(initial.json.running, false, '默认不该有遥控监听器');
  assert.equal(initial.json.port, 0);

  const pairingBefore = await local('/api/remote/pairing');
  assert.equal(pairingBefore.json.lanReachable, false, '监听器没起时不该报可达');
  assert.equal(pairingBefore.json.port, mainPort, '没起时端口回落到主端口仅用于展示');

  // 首选端口第一次被占用时会选备用端口。释放占用后再重开，也必须留在已经
  // 保存的备用端口，否则浏览器 origin 变化会让手机看不到旧 token。
  let lowerPortBlocker = null;
  if (mainPort < 65534) {
    lowerPortBlocker = http.createServer();
    await new Promise((resolve, reject) => {
      lowerPortBlocker.once('error', (error) => {
        lowerPortBlocker = null;
        if (error && (error.code === 'EADDRINUSE' || error.code === 'EACCES')) resolve();
        else reject(error);
      });
      lowerPortBlocker.listen(mainPort + 1, '0.0.0.0', resolve);
    });
  }

  // 起监听器
  const started = await local('/api/remote/listener', { method: 'POST', body: { enabled: true } });
  assert.equal(started.status, 200);
  assert.equal(started.json.running, true, '应成功起监听器');
  const remotePort = started.json.port;
  assert.ok(remotePort > 0 && remotePort !== mainPort, '遥控端口应独立于主端口');
  if (lowerPortBlocker) assert.notEqual(remotePort, mainPort + 1, '首选端口被占时应选择备用端口');
  const persisted = JSON.parse(fs.readFileSync(path.join(remoteDir, 'remote-tokens.json'), 'utf8'));
  assert.equal(persisted.preferredPort, remotePort, '实际监听端口应持久化为下次首选');

  const pairingAfter = await local('/api/remote/pairing');
  assert.equal(pairingAfter.json.lanReachable, true, '起了监听器就该报可达');
  assert.equal(pairingAfter.json.port, remotePort, '配对信息里的端口应指向遥控监听器');
  assert.equal(pairingAfter.json.mainPort, mainPort);

  // 幂等：重复起不该换端口
  const again = await local('/api/remote/listener', { method: 'POST', body: { enabled: true } });
  assert.equal(again.json.port, remotePort, '重复开启应幂等');

  // 遥控端口上，本机回环也必须被当成外部来源
  const adminViaRemote = await request('127.0.0.1', remotePort, '/api/remote/pairing');
  assert.equal(adminViaRemote.status, 403,
    '回环连遥控端口也必须拿不到管理面，否则「只服务本机」等于「谁能连上都算本机」');
  assert.equal(adminViaRemote.json.error, 'LOOPBACK_ONLY');

  for (const adminPath of ['/api/remote/state-push', '/api/remote/revoke', '/api/remote/listener']) {
    const res = await request('127.0.0.1', remotePort, adminPath, { method: 'POST', body: {} });
    assert.equal(res.status, 403, `${adminPath} 在遥控端口上必须 403`);
  }

  // 遥控端口上其它端点也进不去
  for (const guarded of ['/api/local-media?id=x', '/api/listen/total', '/api/app/version', '/index.html']) {
    const res = await request('127.0.0.1', remotePort, guarded);
    assert.equal(res.status, 403, `${guarded} 在遥控端口上必须 403`);
  }

  // 白名单在遥控端口上要放行
  const page = await request('127.0.0.1', remotePort, '/remote.html');
  assert.equal(page.status, 200, '遥控页面应可访问');
  assert.ok(page.text.length > 1000, '应返回真实页面内容');
  const asset = await request('127.0.0.1', remotePort, '/remote-assets/remote.js');
  assert.equal(asset.status, 200, '遥控脚本应可访问');

  // 配对与遥控在遥控端口上走通
  // 配对码只在显式请求时生成（POST），GET 只读状态。
  const code = String((await local('/api/remote/pairing', { method: 'POST', body: {} })).json.code);
  assert.match(code, /^[1-9]\d{5}$/, 'POST 应生成 6 位配对码');
  const paired = await request('127.0.0.1', remotePort, '/api/remote/pair', { method: 'POST', body: { code } });
  assert.equal(paired.status, 200, '应能在遥控端口上完成配对');
  assert.equal(paired.json.ok, true);
  const token = paired.json.token;

  await local('/api/remote/state-push', { method: 'POST', body: { title: '监听器测试', playing: true } });
  const state = await request('127.0.0.1', remotePort, '/api/remote/state', {
    headers: { 'X-Mineradio-Token': token },
  });
  assert.equal(state.status, 200, '带 token 应能读状态');
  assert.equal(state.json.state.title, '监听器测试');

  const command = await request('127.0.0.1', remotePort, '/api/remote/command', {
    method: 'POST', headers: { 'X-Mineradio-Token': token }, body: { command: 'next' },
  });
  assert.equal(command.status, 200, '带 token 应能发命令');

  // 主端口上遥控页面仍然可达（回环），但那不是给手机用的
  const mainStillWorks = await local('/api/app/version');
  assert.equal(mainStillWorks.status, 200, '主端口的既有功能不该受影响');

  // 停监听器：端口必须真的消失，不是靠 403 挡
  const stopped = await local('/api/remote/listener', { method: 'POST', body: { enabled: false } });
  assert.equal(stopped.json.running, false);
  assert.equal(stopped.json.port, 0);
  if (lowerPortBlocker) {
    await new Promise((resolve) => lowerPortBlocker.close(resolve));
    lowerPortBlocker = null;
  }
  await new Promise((resolve) => setTimeout(resolve, 600));
  const afterStop = await request('127.0.0.1', remotePort, '/remote.html');
  assert.equal(afterStop.status, 0, '停掉后端口应压根不监听');
  assert.ok(['ECONNREFUSED', 'ECONNRESET', 'TIMEOUT'].includes(afterStop.error),
    `期望连接被拒，实际 ${afterStop.error}`);

  // 端口稳定性：关开一轮还是同一个，手机不用重扫
  const restarted = await local('/api/remote/listener', { method: 'POST', body: { enabled: true } });
  assert.equal(restarted.json.running, true);
  assert.equal(restarted.json.port, remotePort, '较低端口恢复可用后，重开仍应拿回已保存端口');

  // 撤销后旧 token 在遥控端口上也失效
  await local('/api/remote/revoke', { method: 'POST', body: {} });
  const revoked = await request('127.0.0.1', remotePort, '/api/remote/state', {
    headers: { 'X-Mineradio-Token': token },
  });
  assert.equal(revoked.status, 401, '撤销后旧 token 在遥控端口上也必须失效');

  await local('/api/remote/listener', { method: 'POST', body: { enabled: false } });

  const lan = firstLanIPv4();
  console.log('OK remote-listener-lifecycle' + (lan ? ` (本机局域网 ${lan})` : ''));
}

run().then(() => {
  server.close(() => process.exit(0));
}).catch((error) => {
  console.error(error && error.stack || error);
  server.close(() => process.exit(1));
});
