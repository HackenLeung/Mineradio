'use strict';

// 视觉控制台按 FX_CONSOLE_LAYOUT 把 #fx-panel 的平铺子节点搬进标签页，
// 搬完会删掉所有没被登记的直接子节点（09-console-workspace.js 里那句 node.remove()）。
// 所以「在 index.html 加了控件但忘记登记」的后果是控件被静默删除、界面上完全找不到，
// 且没有任何报错 —— 这正是局域网遥控第一版踩的坑。这条测试专门挡它。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const workspace = fs.readFileSync(
  path.join(root, 'public', 'js', 'modules', '07-fx', '09-console-workspace.js'), 'utf8');
const controller = fs.readFileSync(
  path.join(root, 'public', 'js', 'modules', '10-shell', '04b-lan-remote-controller.js'), 'utf8');

function registeredRefs() {
  const refs = new Set();
  const re = /fxConsoleItem\(\s*'([^']+)'/g;
  let match;
  while ((match = re.exec(workspace)) !== null) refs.add(match[1]);
  return refs;
}

test('局域网遥控的控件都登记进了控制台布局', () => {
  const refs = registeredRefs();
  assert.ok(refs.has('t-lanRemote'), '开关 t-lanRemote 必须登记，否则会被控制台删掉');
  assert.ok(refs.has('lan-remote-box'), '配对面板 lan-remote-box 必须登记，否则会被控制台删掉');
});

test('搬运逻辑仍会删除未登记的直接子节点（本测试存在的前提）', () => {
  assert.match(
    workspace,
    /node\.parentNode === panel[\s\S]{0,120}node\.remove\(\)/,
    '若这条清理逻辑被改动，本测试的前提要重新评估',
  );
});

test('局域网遥控的可见文案挂在会被搬走的节点内部', () => {
  // 说明文字必须在 #lan-remote-box 内部。放在它外面当 #fx-panel 的直接子节点
  // 会被清理逻辑删掉，用户永远看不到。
  const boxStart = html.indexOf('id="lan-remote-box"');
  assert.ok(boxStart > 0, 'index.html 应有 lan-remote-box');
  const boxEnd = html.indexOf('</div>', html.indexOf('lan-remote-revoke'));
  const boxHtml = html.slice(boxStart, boxEnd);
  assert.ok(boxHtml.includes('lan-remote-note'), '说明文案应在盒子内部');
  assert.ok(boxHtml.includes('lan-remote-qr'), '二维码容器应在盒子内部');
  assert.ok(boxHtml.includes('lan-remote-reach'), '可达性提示应在盒子内部');
  assert.ok(boxHtml.includes('lan-remote-urls'), '地址列表应在盒子内部');
});

test('控制器引用的 DOM id 在 index.html 里都存在', () => {
  const ids = new Set();
  const re = /getElementById\('([^']+)'\)/g;
  let match;
  while ((match = re.exec(controller)) !== null) ids.add(match[1]);
  assert.ok(ids.size >= 5, '应至少引用若干 DOM 节点');
  ids.forEach((id) => {
    assert.ok(html.includes('id="' + id + '"'), `index.html 缺少 id="${id}"`);
  });
});

test('模块已进入加载清单', () => {
  const loader = fs.readFileSync(path.join(root, 'public', 'js', 'index-loader.js'), 'utf8');
  assert.ok(
    loader.includes('10-shell/04b-lan-remote-controller.js'),
    '新模块必须登记进 index-loader，否则 toggleLanRemote 未定义',
  );
  // 顺序必须在 04a 之后：04a 的 bindCubeRemoteController 会调 hydrateLanRemote。
  assert.ok(
    loader.indexOf('04a-cube-remote-controller.js') < loader.indexOf('04b-lan-remote-controller.js'),
    '04b 应排在 04a 之后',
  );
});

test('onclick 引用的全局函数都有定义', () => {
  const handlers = new Set();
  const re = /onclick="([a-zA-Z_$][\w$]*)\(/g;
  let match;
  while ((match = re.exec(html)) !== null) handlers.add(match[1]);
  ['toggleLanRemote', 'refreshLanRemotePairing', 'revokeLanRemoteDevices'].forEach((name) => {
    assert.ok(handlers.has(name), `index.html 应通过 onclick 调用 ${name}`);
    assert.match(controller, new RegExp('function\\s+' + name + '\\s*\\('), `控制器应定义 ${name}()`);
  });
});
