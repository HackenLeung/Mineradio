'use strict';

// 二维码只能承载一个地址，挑错了用户扫了连不上还不知道为什么。
// 第一版靠网卡名正则挑，漏了 Windows 的 Hyper-V 交换机（叫 `vEthernet (Default Switch)`，
// 不含 "hyper-v" 字样），结果二维码编了那个不通的地址。
// 现在主信号是内核选路（UDP connect 拿出网源地址），名字正则只当辅助。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function namedFunctionSource(text, name) {
  const declaration = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(text);
  assert.ok(declaration, `expected ${name}()`);
  const bodyStart = text.indexOf('{', declaration.index + declaration[0].length);
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  let regex = false;
  let regexClass = false;
  for (let index = bodyStart; index < text.length; index += 1) {
    const ch = text[index];
    if (lineComment) { if (ch === '\n') lineComment = false; continue; }
    if (blockComment) { if (ch === '*' && text[index + 1] === '/') { blockComment = false; index += 1; } continue; }
    if (regex) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '[') regexClass = true;
      else if (ch === ']') regexClass = false;
      else if (ch === '/' && !regexClass) regex = false;
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '/' && text[index + 1] === '/') { lineComment = true; index += 1; continue; }
    if (ch === '/' && text[index + 1] === '*') { blockComment = true; index += 1; continue; }
    if (ch === '/') {
      const prev = text.slice(bodyStart, index).trimEnd().slice(-1);
      if (!prev || /[=(,:;!&|?{}[]/.test(prev)) { regex = true; regexClass = false; continue; }
    }
    if (ch === '{') depth += 1;
    if (ch === '}' && --depth === 0) return text.slice(declaration.index, index + 1);
  }
  throw new Error(`unterminated ${name}()`);
}

const VIRTUAL_PATTERN_LINE = /const VIRTUAL_ADAPTER_PATTERN = (\/.*\/i);/.exec(serverSource);
assert.ok(VIRTUAL_PATTERN_LINE, 'server.js 应定义 VIRTUAL_ADAPTER_PATTERN');

// 用给定的网卡表和选路结果跑真实的排序逻辑。
function rank(interfaces, primaryAddress) {
  const sandbox = {
    os: { networkInterfaces: () => interfaces },
    require: () => { throw new Error('dgram 不应在此路径被调用'); },
    detectPrimaryLanAddress: () => Promise.resolve(primaryAddress),
    console,
  };
  const code = `
    const VIRTUAL_ADAPTER_PATTERN = ${VIRTUAL_PATTERN_LINE[1]};
    ${namedFunctionSource(serverSource, 'listRemoteLanAddresses')}
    result = listRemoteLanAddresses();
  `;
  vm.runInNewContext(code, sandbox, { filename: 'lan-rank.js' });
  return sandbox.result;
}

const HYPERV_AND_WLAN = {
  'vEthernet (Default Switch)': [{ family: 'IPv4', address: '172.29.224.1', internal: false }],
  WLAN: [{ family: 'IPv4', address: '192.168.31.111', internal: false }],
  'Loopback Pseudo-Interface 1': [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
};

test('Hyper-V 虚拟交换机被识别为虚拟网卡', () => {
  const pattern = new RegExp(VIRTUAL_PATTERN_LINE[1].slice(1, -2), 'i');
  assert.ok(pattern.test('vEthernet (Default Switch)'), 'vEthernet 必须被判为虚拟 —— 这是第一版漏掉的');
  assert.ok(pattern.test('VMware Network Adapter VMnet1'));
  assert.ok(pattern.test('VirtualBox Host-Only Network'));
  assert.ok(pattern.test('vEthernet (WSL)'));
  assert.ok(pattern.test('Docker Desktop Bridge'));
  assert.ok(pattern.test('TAP-Windows Adapter V9'));
  assert.ok(pattern.test('Tailscale'));
  // 真实网卡不能被误判
  assert.ok(!pattern.test('WLAN'), 'WLAN 不应被判为虚拟');
  assert.ok(!pattern.test('Wi-Fi'), 'Wi-Fi 不应被判为虚拟');
  assert.ok(!pattern.test('以太网'), '以太网不应被判为虚拟');
  assert.ok(!pattern.test('Ethernet'), 'Ethernet 不应被判为虚拟');
});

test('内核选路命中的地址排第一并标 primary', async () => {
  const list = await rank(HYPERV_AND_WLAN, '192.168.31.111');
  assert.equal(list.length, 2, '回环应被排除');
  assert.equal(list[0].address, '192.168.31.111', 'WLAN 必须排第一');
  assert.equal(list[0].primary, true);
  assert.equal(list[0].name, 'WLAN');
  assert.equal(list[1].address, '172.29.224.1');
  assert.equal(list[1].likelyVirtual, true);
  assert.equal(list[1].primary, false);
});

test('选路检测失败时靠虚拟标记兜底', async () => {
  const list = await rank(HYPERV_AND_WLAN, '');
  assert.equal(list[0].address, '192.168.31.111', '选路失败也要把非虚拟网卡排前面');
  assert.equal(list[0].primary, false, '没有选路结果就不该标 primary');
});

test('选路指向虚拟网卡时仍尊重内核结果', async () => {
  // 内核确实选了虚拟网卡出网（比如全局 VPN），那手机也该连它 —— 不该用名字覆盖事实。
  const list = await rank(HYPERV_AND_WLAN, '172.29.224.1');
  assert.equal(list[0].address, '172.29.224.1');
  assert.equal(list[0].primary, true);
});

test('多个非虚拟网卡时家用网段靠前', async () => {
  const list = await rank({
    'Ethernet 2': [{ family: 'IPv4', address: '10.8.0.5', internal: false }],
    WLAN: [{ family: 'IPv4', address: '192.168.1.20', internal: false }],
  }, '');
  assert.equal(list[0].address, '192.168.1.20', '192.168.* 应比 10.* 靠前');
});

test('没有任何外部网卡时返回空数组而不是抛错', async () => {
  const list = await rank({
    'Loopback Pseudo-Interface 1': [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
  }, '');
  // 不用 deepStrictEqual：数组是在 vm 沙箱里造的，原型跨 realm 不相等。
  assert.equal(list.length, 0);
});

test('IPv6 地址被排除', async () => {
  const list = await rank({
    WLAN: [
      { family: 'IPv6', address: 'fe80::1', internal: false },
      { family: 'IPv4', address: '192.168.31.111', internal: false },
    ],
  }, '');
  assert.equal(list.length, 1);
  assert.equal(list[0].address, '192.168.31.111');
});

test('本机真实网卡表能跑通且选路能拿到地址', async () => {
  // 这条是环境自检：确认 detectPrimaryLanAddress 在真实机器上真能拿到源地址，
  // 否则上面的主信号在生产里等于永远失效、只剩名字兜底。
  // require 是模块作用域而不是全局，必须显式传进去，否则函数里的
  // require('dgram') 会抛错、被 try/catch 吞掉、永远返回空串。
  const detect = new Function('require', 'return ' + namedFunctionSource(serverSource, 'detectPrimaryLanAddress'))(require);
  const primary = await detect();
  const hasExternal = Object.values(os.networkInterfaces()).some((group) => (group || []).some(
    (info) => (info.family === 'IPv4' || info.family === 4) && !info.internal));
  if (!hasExternal) {
    assert.equal(typeof primary, 'string');
    return;
  }
  assert.match(primary, /^\d+\.\d+\.\d+\.\d+$/, '有外部网卡时应能拿到 IPv4 源地址');
  assert.notEqual(primary, '127.0.0.1', '源地址不应是回环');
});
