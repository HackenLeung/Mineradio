'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'desktop', 'preload.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const loader = fs.readFileSync(path.join(root, 'public', 'js', 'index-loader.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const loginFlows = fs.readFileSync(path.join(root, 'public', 'js', 'modules', '08-account', '03-login-modal-flows.js'), 'utf8');
const loginStatus = fs.readFileSync(path.join(root, 'public', 'js', 'modules', '08-account', '02-login-status.js'), 'utf8');
const logout = fs.readFileSync(path.join(root, 'public', 'js', 'modules', '08-account', '04-user-modal-logout.js'), 'utf8');

[main, preload, server, loader, html, loginFlows, loginStatus, logout].forEach((source) => {
  assert(!/login[-A-Za-z]*easter|LoginEaster|LOGIN_EASTER/i.test(source), 'login easter egg code must be removed');
});

['netease', 'qq', 'kugou', 'qishui', 'spotify'].forEach((provider) => {
  const marker = `ipcMain.handle('${provider}-music-open-login'`;
  const start = main.indexOf(marker);
  assert(start >= 0, `${provider} login IPC missing`);
  assert(!/isUnlocked|LOCKED/.test(main.slice(start, start + 260)), `${provider} login remains gated`);
});

assert.match(loginFlows, /async function showLoginModal\(opts\)[\s\S]*?openGsapModal\(modal\);[\s\S]*?resumeLoginModalAfterGate\(\);/);
assert.match(loginStatus, /btn\.classList\.add\('logged-out'\);[\s\S]*?btn\.innerHTML = '<span class="login-word">登录<\/span>'/);
assert.match(html, /id="login-reset-all-btn"[^>]*\bhidden\b[^>]*onclick="logoutAllAccounts\(\)"/);
assert.match(loginFlows, /function updateLoginResetAllButton\(\)[\s\S]*?button\.hidden = !hasAnyPlatformLogin\(\);/);
assert.match(loginFlows, /function updateLoginNodeGraphUi\(\) \{\s*updateLoginResetAllButton\(\);/);
assert.match(logout, /async function logoutAllAccounts\(\)/);
assert.match(logout, /var results = await Promise\.allSettled\(operations\);/);
assert.match(logout, /var failures = results\.map\(logoutOperationFailure\)\.filter\(Boolean\);/);
assert.match(logout, /if \(failures\.length\)[\s\S]*LOGOUT_ALL_INCOMPLETE/);
assert(!fs.existsSync(path.join(root, 'desktop', 'login-easter-egg-gate.js')));
assert(!fs.existsSync(path.join(root, 'public', 'js', 'modules', '08-account', '00-login-easter-egg.js')));

console.log('OK direct-login-flow');
