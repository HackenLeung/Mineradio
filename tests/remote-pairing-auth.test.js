'use strict';

// 局域网遥控鉴权。重点不是「能配对成功」，而是几条安全边界：
// 配对码限速与作废、token 只授权 /api/remote/*、管理面只服务本机、
// 命令走白名单、撤销后旧 token 立即失效。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-remote-'));

process.env.PORT = '0';
process.env.MINERADIO_HOST = '0.0.0.0';
process.env.MINERADIO_REMOTE_DIR = remoteDir;
delete process.env.HOST;

const server = require('../server');
const TOKEN_FILE = path.join(remoteDir, 'remote-tokens.json');

const dispatched = [];
server.setRemoteCommandSink((payload) => { dispatched.push(payload); });

function firstNonLoopbackIPv4() {
  for (const group of Object.values(os.networkInterfaces())) {
    for (const info of group || []) {
      if ((info.family === 'IPv4' || info.family === 4) && !info.internal) return info.address;
    }
  }
  return null;
}

function request(host, port, target, options = {}) {
  return new Promise((resolve, reject) => {
    const payload = options.body == null ? null : Buffer.from(JSON.stringify(options.body), 'utf8');
    const headers = Object.assign({}, options.headers || {});
    if (payload) {
      if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
        headers['Content-Type'] = options.contentType || 'application/json';
      }
      headers['Content-Length'] = String(payload.length);
    }
    const req = http.request({ host, port, path: target, method: options.method || 'GET', headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function run() {
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  const local = (target, options) => request('127.0.0.1', port, target, options);

  // ---- 浏览器来源边界：回环地址不等于可信调用者 ----
  const hostileOrigin = 'https://attacker.example';
  const blockedPairing = await local('/api/remote/pairing', {
    headers: { Origin: hostileOrigin, 'Sec-Fetch-Site': 'cross-site' },
  });
  assert.equal(blockedPairing.status, 403, '跨站网页不能读取本机配对码');
  assert.equal(blockedPairing.json.error, 'LOCAL_ORIGIN_FORBIDDEN');
  assert.equal(blockedPairing.headers['access-control-allow-origin'], undefined,
    '私有管理响应不能带通配 CORS');

  const blockedListener = await local('/api/remote/listener', {
    method: 'POST',
    headers: { Origin: hostileOrigin, 'Sec-Fetch-Site': 'cross-site' },
    body: { enabled: true },
  });
  assert.equal(blockedListener.status, 403, '跨站网页不能开启局域网监听器');
  assert.equal(blockedListener.json.error, 'LOCAL_ORIGIN_FORBIDDEN');

  const simplePair = await local('/api/remote/pair', {
    method: 'POST',
    headers: { Origin: hostileOrigin, 'Sec-Fetch-Site': 'cross-site' },
    contentType: 'text/plain',
    body: { code: '000000' },
  });
  assert.equal(simplePair.status, 415, '简单请求不能绕过浏览器预检去配对');
  assert.equal(simplePair.json.error, 'JSON_CONTENT_TYPE_REQUIRED');
  assert.equal(simplePair.headers['access-control-allow-origin'], undefined,
    '遥控响应不需要跨域读取能力');

  const trustedOrigin = `http://127.0.0.1:${port}`;
  const trustedPairing = await local('/api/remote/pairing', {
    headers: { Origin: trustedOrigin, 'Sec-Fetch-Site': 'same-origin' },
  });
  assert.equal(trustedPairing.status, 200, '主页面同源请求必须继续可用');
  const trustedPush = await local('/api/remote/state-push', {
    method: 'POST',
    headers: { Origin: trustedOrigin, 'Sec-Fetch-Site': 'same-origin' },
    body: { title: '同源守卫测试' },
  });
  assert.equal(trustedPush.status, 200, '主页面同源 JSON POST 必须继续可用');

  // ---- 二维码常驻显示，所以读到的码必须总是有效的 ----
  const pairingInfo = await local('/api/remote/pairing');
  assert.equal(pairingInfo.status, 200);
  assert.equal(pairingInfo.json.ok, true);
  assert.equal(pairingInfo.json.hasCode, true, '读取时应总有可用配对码');
  assert.match(String(pairingInfo.json.code), /^[1-9]\d{5}$/, '配对码应是 6 位且不以 0 开头');
  assert.ok(pairingInfo.json.expiresInMs > 0, '应带剩余有效期');
  assert.equal(pairingInfo.json.lanReachable, true, 'MINERADIO_HOST=0.0.0.0 时应报告局域网可达');
  assert.ok(Array.isArray(pairingInfo.json.lanAddresses), '应列出局域网地址');

  // 轮询读取不能换码：界面 15 秒刷新一次，码要是每次都变就没法用了
  const readBack = await local('/api/remote/pairing');
  assert.equal(readBack.json.code, pairingInfo.json.code, 'GET 不该换掉现有的码');

  // ---- 错码限速：连续 5 次失败后作废 ----
  const code = String(pairingInfo.json.code);
  const wrong = code === '111111' ? '222222' : '111111';
  const attempts = [];
  for (let i = 0; i < 5; i += 1) {
    attempts.push(await local('/api/remote/pair', { method: 'POST', body: { code: wrong } }));
  }
  assert.equal(attempts[0].status, 401);
  assert.equal(attempts[0].json.error, 'PAIRING_CODE_INVALID');
  assert.equal(attempts[0].json.remainingAttempts, 4, '应回报剩余尝试次数');
  assert.equal(attempts[4].json.error, 'PAIRING_LOCKED', '第 5 次失败后应锁定');

  // 锁定后即使拿对的码也不能配对 —— 否则限速形同虚设
  const afterLock = await local('/api/remote/pair', { method: 'POST', body: { code } });
  assert.equal(afterLock.status, 401);
  assert.equal(afterLock.json.error, 'PAIRING_LOCKED', '锁定后正确的码也必须被拒');

  // 被爆破作废后自动换新码（二维码要保持可用），但「刚有人在猜」必须能告诉用户
  const lockedState = await local('/api/remote/pairing');
  assert.equal(lockedState.json.hasCode, true, '作废后应自动补新码，二维码不能变死码');
  assert.notEqual(String(lockedState.json.code), code, '新码应不同于被作废的码');
  assert.ok(lockedState.json.lastLockoutAt > 0, '应保留作废留痕，否则用户只看到码变了');
  const lockedCode = String(lockedState.json.code);
  const lockedAgain = await local('/api/remote/pairing');
  assert.equal(String(lockedAgain.json.code), lockedCode, '补码后再读不该又换一次');
  assert.ok(lockedAgain.json.lastLockoutAt > 0, '自动补码不能抹掉作废留痕');

  // ---- 换码后可以正常配对 ----
  const rotated = await local('/api/remote/pairing', { method: 'POST', body: {} });
  assert.equal(rotated.json.ok, true);
  assert.notEqual(String(rotated.json.code), code, '换码后应是新的码');
  assert.equal(rotated.json.locked, false, '换码应解除锁定');
  assert.equal(rotated.json.lastLockoutAt, 0, '生成新码应清掉作废标记');

  const paired = await local('/api/remote/pair', { method: 'POST', body: { code: String(rotated.json.code), label: '测试手机' } });
  assert.equal(paired.status, 200);
  assert.equal(paired.json.ok, true);
  assert.equal(String(paired.json.token).length, 64, 'token 应是 32 字节 hex');
  const token = paired.json.token;

  // 配对成功即换码：同一个码不能再配第二台设备
  const reuse = await local('/api/remote/pair', { method: 'POST', body: { code: String(rotated.json.code) } });
  assert.equal(reuse.status, 401, '旧码不应还能配对');
  assert.notEqual(reuse.json.ok, true, '旧码复用必须失败');
  assert.equal(reuse.json.error, 'PAIRING_CODE_INVALID', '配对成功后已换新码，旧码应被当作错码');

  // 配对成功后立刻有新码可用：二维码常驻，不能出现空窗
  const afterPair = await local('/api/remote/pairing');
  assert.equal(afterPair.json.hasCode, true, '配对成功后应立刻有新码');
  assert.notEqual(String(afterPair.json.code), String(rotated.json.code), '应换成新码');
  assert.equal(afterPair.json.pairedDevices.length, 1, '应记录已配对设备');

  // ---- token 持久化 ----
  assert.ok(fs.existsSync(TOKEN_FILE), 'token 应落盘以便重启后免重扫');
  const stored = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  assert.equal(stored.tokens.length, 1);
  assert.equal(stored.tokens[0].label, '测试手机');

  // ---- 无 token 一律 401 ----
  assert.equal((await local('/api/remote/state')).status, 401);
  assert.equal((await local('/api/remote/command', { method: 'POST', body: { command: 'next' } })).status, 401);

  // ---- 状态：先推后读 ----
  const push = await local('/api/remote/state-push', {
    method: 'POST',
    body: { title: '测试歌曲', artist: '测试歌手', playing: true, volume: 0.42, currentTime: 30.5, duration: 200 },
  });
  assert.equal(push.status, 200);

  const state = await local('/api/remote/state', { headers: { 'X-Mineradio-Token': token } });
  assert.equal(state.status, 200);
  assert.equal(state.json.ok, true);
  assert.equal(state.json.stale, false, '刚推过的状态不应判为陈旧');
  assert.equal(state.json.state.title, '测试歌曲');
  assert.equal(state.json.state.volume, 0.42);
  assert.equal(state.json.state.playing, true);

  // ---- 封面：状态里只给相对地址，不泄露平台图床，也不内联 data URL ----
  const pngData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
  await local('/api/remote/state-push', {
    method: 'POST',
    body: { title: '带封面', coverData: pngData, coverUrl: 'https://p1.music.126.net/secret.jpg' },
  });
  const covered = await local('/api/remote/state', { headers: { 'X-Mineradio-Token': token } });
  assert.match(covered.json.state.cover, /^\/api\/remote\/cover\?v=/, '状态里的封面应是带版本号的相对地址');
  assert.ok(!/126\.net/.test(JSON.stringify(covered.json)), '状态不应泄露平台图床地址');
  assert.ok(!/base64/.test(JSON.stringify(covered.json)), '状态不应内联 data URL（几百 KB 会吃满手机流量）');

  assert.equal((await local('/api/remote/cover')).status, 401, '封面无 token 必须 401');

  // <img> 带不了请求头，所以 token 必须能走 query
  const coverViaQuery = await local('/api/remote/cover?token=' + encodeURIComponent(token));
  assert.equal(coverViaQuery.status, 200, '封面应接受 query 里的 token');
  assert.equal((await local('/api/remote/cover', {
    method: 'POST', headers: { 'X-Mineradio-Token': token },
  })).status, 405);

  // 换歌换封面时版本号必须变，否则手机会缓存住上一首的图
  const firstVersion = covered.json.state.cover;
  await local('/api/remote/state-push', {
    method: 'POST', body: { title: '换了封面', coverUrl: 'https://example.invalid/other.jpg' },
  });
  const recovered = await local('/api/remote/state', { headers: { 'X-Mineradio-Token': token } });
  assert.notEqual(recovered.json.state.cover, firstVersion, '换封面后版本号应变化');

  // 没有封面时不应给出地址，否则页面会拿到一个必然 404 的 src
  await local('/api/remote/state-push', { method: 'POST', body: { title: '无封面' } });
  const bare = await local('/api/remote/state', { headers: { 'X-Mineradio-Token': token } });
  assert.equal(bare.json.state.cover, '', '无封面时应留空');

  // ---- 命令白名单 ----
  dispatched.length = 0;
  const good = await local('/api/remote/command', {
    method: 'POST', headers: { 'X-Mineradio-Token': token }, body: { command: 'next' },
  });
  assert.equal(good.status, 200);
  assert.deepEqual(dispatched, [{ command: 'next' }], '命令应原样转到下发口');

  const simpleCommand = await local('/api/remote/command?token=' + encodeURIComponent(token), {
    method: 'POST',
    headers: { Origin: hostileOrigin, 'Sec-Fetch-Site': 'cross-site' },
    contentType: 'text/plain',
    body: { command: 'next' },
  });
  assert.equal(simpleCommand.status, 415, '跨站简单请求不能借 query token 下发命令');
  assert.equal(dispatched.length, 1, '被拒绝的跨站命令不能进入下发口');

  const volume = await local('/api/remote/command', {
    method: 'POST', headers: { 'X-Mineradio-Token': token }, body: { command: 'set-volume', value: 1.8 },
  });
  assert.equal(volume.status, 200);
  assert.equal(dispatched[1].value, 1, '音量应被夹到 0..1');

  const denied = await local('/api/remote/command', {
    method: 'POST', headers: { 'X-Mineradio-Token': token }, body: { command: 'eval-something' },
  });
  assert.equal(denied.status, 400);
  assert.equal(denied.json.error, 'COMMAND_NOT_ALLOWED');
  assert.equal(dispatched.length, 2, '白名单外的命令不应下发');

  // ---- 撤销后旧 token 立即失效 ----
  const revoke = await local('/api/remote/revoke', { method: 'POST', body: {} });
  assert.equal(revoke.status, 200);
  assert.equal(revoke.json.removed, 1);
  assert.equal((await local('/api/remote/state', { headers: { 'X-Mineradio-Token': token } })).status, 401,
    '撤销后旧 token 必须立即失效');

  // ---- 非回环来源：能配对与遥控，但碰不到管理面和其它端点 ----
  const lan = firstNonLoopbackIPv4();
  if (lan) {
    const lanReq = (target, options) => request(lan, port, target, options);
    for (const adminPath of ['/api/remote/pairing', '/api/remote/state-push', '/api/remote/revoke']) {
      const res = await lanReq(adminPath, { method: 'POST', body: {} });
      assert.equal(res.status, 403, `${adminPath} 必须只服务本机，实际 ${res.status}`);
      assert.equal(res.json && res.json.error, 'LOOPBACK_ONLY');
    }
    for (const guarded of ['/api/local-media?id=x', '/api/listen/total', '/api/app/version', '/index.html']) {
      const res = await lanReq(guarded);
      assert.equal(res.status, 403, `${guarded} 不应对局域网开放，实际 ${res.status}`);
    }
    // 配对入口必须对局域网开放，否则手机没法接入
    const lanPair = await lanReq('/api/remote/pair', { method: 'POST', body: { code: '000000' } });
    assert.notEqual(lanPair.status, 403, '/api/remote/pair 必须对局域网开放');
    const lanPage = await lanReq('/remote.html');
    assert.equal(lanPage.status, 200, '遥控页面必须对局域网开放');
    const lanAsset = await lanReq('/remote-assets/remote.js');
    assert.equal(lanAsset.status, 200, '遥控页面的脚本必须对局域网开放');
  }

  // ---- 未注入下发口时明确 503，不静默丢命令 ----
  const relayInfo = await local('/api/remote/pairing', { method: 'POST', body: {} });
  const relayPair = await local('/api/remote/pair', { method: 'POST', body: { code: String(relayInfo.json.code) } });
  const freshToken = relayPair.json.token;
  server.setRemoteCommandSink(null);
  const noSink = await local('/api/remote/command', {
    method: 'POST', headers: { 'X-Mineradio-Token': freshToken }, body: { command: 'next' },
  });
  assert.equal(noSink.status, 503);
  assert.equal(noSink.json.error, 'REMOTE_SINK_UNAVAILABLE');

  console.log('OK remote-pairing-auth' + (lan ? ` (局域网来源 ${lan} 已验证)` : ' (跳过非回环用例)'));
}

run().then(() => {
  server.close(() => process.exit(0));
}).catch((error) => {
  console.error(error && error.stack || error);
  server.close(() => process.exit(1));
});
