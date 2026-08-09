'use strict';

// 二维码在视觉控制台里常驻显示，所以「屏幕上的码永远能用」是一条硬要求：
// 缺码、过期、被爆破作废、配对成功之后，都必须立刻有一个新的有效码，
// 否则用户扫到的是死码 —— 扫了配不上，还查不出原因。
//
// 同时轮询读取不能换码：界面 15 秒刷新一次，码要是每次都变就根本来不及输。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-code-'));

process.env.PORT = '0';
process.env.MINERADIO_REMOTE_DIR = remoteDir;
delete process.env.MINERADIO_HOST;
delete process.env.HOST;

const server = require('../server');
server.setRemoteCommandSink(() => {});

function request(port, target, options = {}) {
  return new Promise((resolve) => {
    const payload = options.body == null ? null : Buffer.from(JSON.stringify(options.body), 'utf8');
    const headers = Object.assign({}, options.headers || {});
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(payload.length);
    }
    const req = http.request({
      host: '127.0.0.1', port, path: target, method: options.method || 'GET', headers, timeout: 4000,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) { json = null; }
        resolve({ status: res.statusCode, json });
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
  const port = server.address().port;
  const get = () => request(port, '/api/remote/pairing');
  const issue = () => request(port, '/api/remote/pairing', { method: 'POST', body: {} });
  const pair = (code) => request(port, '/api/remote/pair', { method: 'POST', body: { code } });

  // 首次读取就该有码：界面一打开二维码就要能扫
  const boot = await get();
  assert.equal(boot.json.hasCode, true, '首次读取应自动补一个码');
  const bootCode = String(boot.json.code);
  assert.match(bootCode, /^[1-9]\d{5}$/);
  assert.ok(boot.json.expiresInMs > 0);

  // 轮询稳定性：反复读同一个码，界面刷新不会把用户正在输的码换掉
  for (let i = 0; i < 6; i += 1) {
    const res = await get();
    assert.equal(String(res.json.code), bootCode, `第 ${i + 1} 次读取不该换码`);
  }

  // 显式换码（「换码」按钮）
  const rotated = await issue();
  assert.notEqual(String(rotated.json.code), bootCode, 'POST 应换新码');
  const rotatedCode = String(rotated.json.code);
  assert.equal((await pair(bootCode)).status, 401, '换码后旧码必须失效');

  // 配对成功 → 立刻有新码，不出现空窗
  const paired = await pair(rotatedCode);
  assert.equal(paired.status, 200);
  assert.equal(paired.json.ok, true);
  const afterPair = await get();
  assert.equal(afterPair.json.hasCode, true, '配对成功后必须立刻有新码');
  const afterPairCode = String(afterPair.json.code);
  assert.notEqual(afterPairCode, rotatedCode, '配对成功后应换掉用过的码');
  assert.equal(afterPair.json.pairedDevices.length, 1);

  // 用过的码不能再配第二台（一个码只对应一台设备）
  const reuse = await pair(rotatedCode);
  assert.equal(reuse.status, 401);
  assert.equal(reuse.json.error, 'PAIRING_CODE_INVALID');

  // 直接用当前显示的码就能加第二台，不需要先点任何按钮
  const secondDevice = await pair(afterPairCode);
  assert.equal(secondDevice.status, 200, '应能直接用界面上显示的码加设备');
  assert.equal((await get()).json.pairedDevices.length, 2);

  // 爆破作废：自动补新码，但留痕要能告诉用户
  const target = await get();
  const targetCode = String(target.json.code);
  const wrong = targetCode === '111111' ? '222222' : '111111';
  for (let i = 0; i < 5; i += 1) await pair(wrong);
  const lockedOut = await get();
  assert.equal(lockedOut.json.hasCode, true, '被爆破后也要有可用码，二维码不能变死码');
  assert.notEqual(String(lockedOut.json.code), targetCode, '应换掉被爆破的码');
  assert.ok(lockedOut.json.lastLockoutAt > 0, '必须留痕，否则用户只看到码变了、不知有人在猜');

  // 自动补码不能把留痕抹掉（否则下一次读取就看不到提示了）
  const stillMarked = await get();
  assert.ok(stillMarked.json.lastLockoutAt > 0, '自动补码不该清掉作废留痕');
  assert.equal(String(stillMarked.json.code), String(lockedOut.json.code), '补码后不该反复换');

  // 显式换码才清掉留痕
  const manual = await issue();
  assert.equal(manual.json.lastLockoutAt, 0, '显式换码应清掉作废留痕');

  // 作废后的新码可以正常配对 —— 限速不能把功能永久锁死
  const recovered = await pair(String(manual.json.code));
  assert.equal(recovered.status, 200, '作废并换码后应能重新配对');

  // 撤销全部设备后仍有可用码
  const revoked = await request(port, '/api/remote/revoke', { method: 'POST', body: {} });
  assert.equal(revoked.json.ok, true);
  const afterRevoke = await get();
  assert.equal(afterRevoke.json.pairedDevices.length, 0);
  assert.equal(afterRevoke.json.hasCode, true, '撤销后二维码仍要可用');

  console.log('OK remote-pairing-code-lifecycle');
}

run().then(() => {
  server.close(() => process.exit(0));
}).catch((error) => {
  console.error(error && error.stack || error);
  server.close(() => process.exit(1));
});
