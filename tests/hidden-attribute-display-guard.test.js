'use strict';

// 本项目的 index.css 没有全局 `[hidden] { display: none }` 兜底规则。
// 而作者样式表里的 `display` 声明优先级高于 hidden 属性自带的 UA 样式，
// 所以给一个设了 display 的类加 hidden 属性完全不生效 —— 表现是一个内容被清空
// 但仍然占位的空白框，而且不报任何错。局域网遥控的二维码容器就踩了这个坑。
//
// 这里只覆盖能可靠静态判定的部分：本文件列出的、代码里真的会切 hidden 的元素。
// 完整的 CSS 层叠分析没法用正则做（后代选择器、媒体查询、优先级都要算），
// 所以不做全项目扫描，避免给出假阳性结论。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'public', 'css', 'index.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const controller = fs.readFileSync(
  path.join(root, 'public', 'js', 'modules', '10-shell', '04b-lan-remote-controller.js'), 'utf8');

function escapeForRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 只看 `.cls {` 这种单一类选择器规则，不含后代选择器 —— 后者作用域不同，
// 混进来会得出错误结论（例如 `.a .fx-mini-btn` 不影响别处的 .fx-mini-btn）。
function ownRuleSetsDisplay(className) {
  const re = new RegExp('(^|\\})\\s*\\.' + escapeForRegex(className) + '\\s*\\{([^}]*)\\}', 'g');
  let match;
  while ((match = re.exec(css)) !== null) {
    if (/display\s*:/.test(match[2])) return true;
  }
  return false;
}

function hasHiddenGuard(className) {
  return new RegExp('\\.' + escapeForRegex(className) + '\\[hidden\\]').test(css);
}

test('项目确实没有全局 [hidden] 兜底（本测试存在的前提）', () => {
  // 若哪天加了全局兜底，这条会失败，届时本测试可以删掉。
  const hasGlobal = /(^|\})\s*\[hidden\]\s*\{[^}]*display\s*:\s*none/.test(css);
  assert.equal(hasGlobal, false,
    '已存在全局 [hidden] 兜底，本测试可以移除，逐类兜底也不再必要');
});

test('会被切 hidden 的遥控元素，若自身设了 display 就必须有 [hidden] 兜底', () => {
  // 从控制器里找出真的会赋值 .hidden 的元素 id
  const toggled = new Set();
  const re = /getElementById\('([^']+)'\)/g;
  let match;
  while ((match = re.exec(controller)) !== null) toggled.add(match[1]);

  const checked = [];
  toggled.forEach((id) => {
    // 取 index.html 里这个 id 的 class 列表
    const tag = new RegExp('<[^>]*id="' + escapeForRegex(id) + '"[^>]*>').exec(html);
    if (!tag) return;
    const classAttr = /class="([^"]+)"/.exec(tag[0]);
    if (!classAttr) return;
    classAttr[1].split(/\s+/).forEach((cls) => {
      if (!cls || !cls.startsWith('lan-remote')) return;
      if (!ownRuleSetsDisplay(cls)) return;
      checked.push(cls);
      assert.ok(hasHiddenGuard(cls),
        `.${cls} 设了 display 但没有 .${cls}[hidden] 兜底，hidden 会失效并留下空白占位框`);
    });
  });

  // 至少要真的检查到一个，否则这条测试是空转
  assert.ok(checked.includes('lan-remote-qr'),
    '应至少覆盖二维码容器（它设了 display: flex 且会被切 hidden）');
});

test('二维码容器的 [hidden] 兜底用了 !important', () => {
  // 不带 !important 时，优先级相同的后续规则仍可能盖回来。
  const guard = /\.lan-remote-qr\[hidden\][^{]*\{([^}]*)\}/.exec(css)
    || /\[hidden\][^{]*\{([^}]*)\}/.exec(css.slice(css.indexOf('.lan-remote-qr[hidden]')));
  assert.ok(guard, '应存在 .lan-remote-qr[hidden] 规则');
  assert.match(guard[1], /display\s*:\s*none\s*!important/,
    '[hidden] 兜底应带 !important，否则同优先级的后续 display 规则会盖回来');
});

test('遥控面板容器自身不设 display，靠 hidden 属性即可收起', () => {
  // lan-remote-box 是整块面板的开关点。它一旦设了 display，
  // 关掉「局域网遥控」时面板不会消失。
  if (ownRuleSetsDisplay('lan-remote-box')) {
    assert.ok(hasHiddenGuard('lan-remote-box'),
      '.lan-remote-box 设了 display，必须补 [hidden] 兜底');
  }
  assert.match(controller, /box\.hidden = !lanRemoteEnabled/, '面板应由开关状态控制 hidden');
});
