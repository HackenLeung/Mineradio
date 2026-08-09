'use strict';

// `clipboard-write` 不在 LOCAL_APP_PERMISSION_ALLOWLIST 里，所以在本应用的渲染进程里
// navigator.clipboard.writeText() 会被 setPermissionCheckHandler 直接拒掉 —— 而且是
// 静默失败（Promise reject，不报错到界面）。任何复制功能都必须走 writeAppClipboardText，
// 它以 preload 暴露的 Electron 原生剪贴板为主路径。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'desktop', 'preload.js'), 'utf8');
const archiveSource = fs.readFileSync(
  path.join(root, 'public', 'js', 'modules', '07-fx', '00-preset-archive-data.js'), 'utf8');

// 注释里提到 navigator.clipboard 是在解释为什么不能用它，不算违规。
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function moduleFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) out.push(full);
    }
  };
  walk(path.join(root, 'public', 'js', 'modules'));
  return out;
}

test('clipboard-write 确实不在权限白名单里（本测试存在的前提）', () => {
  const allowlist = /const LOCAL_APP_PERMISSION_ALLOWLIST = new Set\(\[([^\]]*)\]\)/.exec(mainSource);
  assert.ok(allowlist, 'main.js 应定义 LOCAL_APP_PERMISSION_ALLOWLIST');
  assert.ok(
    !/clipboard/i.test(allowlist[1]),
    '若把 clipboard 加进白名单，本测试的前提要重新评估（但扩大权限面不是首选）',
  );
});

test('preload 暴露原生剪贴板写入', () => {
  assert.match(preloadSource, /clipboard\.writeText/, 'preload 应提供原生剪贴板写入');
  assert.match(preloadSource, /copyText/, 'preload 应把它暴露为 copyText');
});

test('writeAppClipboardText 存在且三级降级顺序正确', () => {
  assert.match(archiveSource, /function writeAppClipboardText/, '应提供公用复制函数');
  const start = archiveSource.indexOf('async function writeAppClipboardText');
  const end = archiveSource.indexOf('\nasync function writeUserFxArchiveClipboard', start);
  const body = archiveSource.slice(start, end);
  const nativeIndex = body.indexOf('api.copyText');
  const asyncIndex = body.indexOf('navigator.clipboard');
  const execIndex = body.indexOf('execCommand');
  assert.ok(nativeIndex > 0, '应尝试 preload 原生剪贴板');
  assert.ok(asyncIndex > nativeIndex, 'navigator.clipboard 应排在原生之后');
  assert.ok(execIndex > asyncIndex, 'execCommand 应作为最后兜底');
});

test('原生路径抛错时要能落到下一级', () => {
  const start = archiveSource.indexOf('async function writeAppClipboardText');
  const end = archiveSource.indexOf('\nasync function writeUserFxArchiveClipboard', start);
  const body = archiveSource.slice(start, end);
  // 早期版本没有 try/catch，原生路径抛错会让整个复制炸掉而不是降级。
  const beforeAsync = body.slice(0, body.indexOf('navigator.clipboard'));
  assert.match(beforeAsync, /try\s*\{/, '原生路径应包 try/catch 以便降级');
  // 三个阶段各自要能失败而不中断后续：原生、navigator、execCommand。
  const tryCount = (body.match(/try\s*\{/g) || []).length;
  assert.ok(tryCount >= 3, `应有三处 try/catch 覆盖三级降级，实际 ${tryCount}`);
});

test('局域网遥控的复制走公用函数而不是 navigator.clipboard', () => {
  const controller = fs.readFileSync(
    path.join(root, 'public', 'js', 'modules', '10-shell', '04b-lan-remote-controller.js'), 'utf8');
  assert.match(controller, /writeAppClipboardText/, '应调用公用复制函数');
  assert.ok(
    !/navigator\.clipboard/.test(stripComments(controller)),
    '不该直接用 navigator.clipboard：它在本应用里会被权限处理器静默拒掉',
  );
});

test('没有模块直接把 navigator.clipboard 当唯一复制路径', () => {
  const offenders = [];
  for (const file of moduleFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    if (!/navigator\.clipboard/.test(stripComments(text))) continue;
    // 允许出现在 writeAppClipboardText 的降级链里
    if (/function writeAppClipboardText/.test(text)) continue;
    offenders.push(path.relative(root, file));
  }
  assert.deepEqual(offenders, [],
    '这些模块直接用了 navigator.clipboard，应改用 writeAppClipboardText：' + offenders.join(', '));
});
