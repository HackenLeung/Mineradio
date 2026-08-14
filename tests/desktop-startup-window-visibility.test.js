'use strict';

// 两条启动期约束，都是实机复现出来的。
//
// 1) 魔方隐藏后主窗口自己冒出来。启动阶段有四个时机会无条件 show()：
//    3500ms 兜底定时器、dom-ready、did-finish-load、ready-to-show。
//    index-loader 串行同步拉 110 个模块，did-finish-load 可能十几秒才到，
//    正好落在用户已经用魔方隐藏之后，把隐藏推翻。
//
// 2) MR-BOOT-WINDOW-LOAD 是误杀。loadURL 只在 did-finish-load 兑现，而那要等
//    所有子资源；文档在 dom-ready 就可用了。历史上三次启动失败弹窗
//    （startup-error.log 里 8/10 两次、8/14 一次）都是这个 15s 超时打死了
//    一个其实能用的页面。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const mainText = fs.readFileSync(path.join(root, 'desktop/main.js'), 'utf8');

function namedFunctionSource(text, name) {
  const declaration = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(text);
  assert.ok(declaration, `expected ${name}()`);
  const bodyStart = text.indexOf('{', declaration.index + declaration[0].length);
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = bodyStart; index < text.length; index += 1) {
    const ch = text[index];
    if (lineComment) { if (ch === '\n') lineComment = false; continue; }
    if (blockComment) { if (ch === '*' && text[index + 1] === '/') { blockComment = false; index += 1; } continue; }
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '/' && text[index + 1] === '/') { lineComment = true; index += 1; continue; }
    if (ch === '/' && text[index + 1] === '*') { blockComment = true; index += 1; continue; }
    if (ch === '{') depth += 1;
    if (ch === '}' && --depth === 0) return text.slice(declaration.index, index + 1);
  }
  throw new Error(`unterminated ${name}()`);
}

// ---- 用户主动隐藏后，启动期的显示时机必须让路 ----

test('四个启动显示时机都登记为「启动驱动」，会被用户隐藏拦住', () => {
  const block = /const STARTUP_DRIVEN_SHOW_REASONS = new Set\(\[([\s\S]*?)\]\)/.exec(mainText);
  assert.ok(block, '应有 STARTUP_DRIVEN_SHOW_REASONS 名单');
  const reasons = block[1];
  ['watchdog', 'dom-ready', 'did-finish-load', 'ready-to-show'].forEach(function (reason) {
    assert.match(reasons, new RegExp(`'${reason}'`),
      `${reason} 会无条件 show()，必须登记，否则它照旧推翻用户的隐藏`);
  });
});

test('showMainWindowSafely 在用户隐藏 + 启动驱动时直接返回', () => {
  const source = namedFunctionSource(mainText, 'showMainWindowSafely');
  assert.match(
    source,
    /mainWindowUserHidden\s*&&\s*STARTUP_DRIVEN_SHOW_REASONS\.has\([\s\S]{0,60}\)\s*\)\s*\{\s*return false;/,
    '两个条件必须同时满足才拦：只看隐藏标记会连托盘点击一起挡掉',
  );
});

test('兜底定时器要先清掉，再判断是否让路', () => {
  const source = namedFunctionSource(mainText, 'showMainWindowSafely');
  const clearPos = source.indexOf('__mineradioStartupShowTimer = null');
  const guardPos = source.indexOf('mainWindowUserHidden');
  assert.ok(clearPos >= 0 && guardPos >= 0, '两段都要在');
  assert.ok(clearPos < guardPos,
    '定时器必须无条件清掉。若提前 return 把它留着，它稍后还会再把窗口翻出来');
});

test('魔方隐藏和托盘隐藏都要标记用户意图', () => {
  const cube = namedFunctionSource(mainText, 'toggleMainWindowFromCube');
  assert.match(cube, /mainWindowUserHidden = true;[\s\S]{0,80}mainWindow\.hide\(\)/,
    '魔方隐藏是用户意图，必须置标记');
  assert.match(mainText, /if \(win === mainWindow\) mainWindowUserHidden = true;\s*win\.hide\(\)/,
    '托盘关闭隐藏同理，否则关到托盘后启动事件又把它翻出来');
});

test('明确要显示时必须清掉标记', () => {
  const focus = namedFunctionSource(mainText, 'focusMainWindow');
  assert.match(focus, /mainWindowUserHidden = false/,
    '托盘点击/魔方打开主程序/第二实例唤起都走 focusMainWindow，必须能重新显示');
});

test('新窗口不继承上一个窗口的隐藏标记', () => {
  assert.match(mainText, /mainWindow = win;\s*mainWindowUserHidden = false;/,
    '不重置的话，上次隐藏过就会导致这次启动永远不显示');
});

// ---- 超时但文档可用，不该判启动失败 ----

test('页面到 dom-ready 就记下可用', () => {
  assert.match(
    mainText,
    /'dom-ready'[\s\S]{0,320}__mineradioDocumentUsable = true/,
    'dom-ready 是「文档可用」的判据，要记下来',
  );
});

test('可用判据同时要求渲染进程还活着', () => {
  const source = namedFunctionSource(mainText, 'mainWindowNavigationUsable');
  assert.match(source, /isDestroyed\(\)/, '窗口/webContents 已销毁不算可用');
  assert.match(source, /isCrashed\(\)/, '渲染进程崩了更不算可用，否则会把真失败当成功放过');
  assert.match(source, /__mineradioDocumentUsable === true/);
});

test('超时后文档可用则继续启动，不抛错', () => {
  const source = namedFunctionSource(mainText, 'loadMainWindowWithRetry');
  const catchPos = source.indexOf('} catch (error) {');
  const usablePos = source.indexOf('mainWindowNavigationUsable(win)', catchPos);
  const lastErrorPos = source.indexOf('lastError = error;', catchPos);
  assert.ok(catchPos >= 0 && usablePos >= 0 && lastErrorPos >= 0);
  assert.ok(usablePos < lastErrorPos,
    '必须在记录失败之前先判可用，否则照旧走到 MR-BOOT-WINDOW-LOAD');
  assert.match(source.slice(usablePos, lastErrorPos), /return targetUrl;/,
    '可用就当这次导航成功返回');
});

test('每次导航尝试前重置可用标记', () => {
  const source = namedFunctionSource(mainText, 'loadMainWindowWithRetry');
  const resetPos = source.indexOf('__mineradioDocumentUsable = false');
  const loadPos = source.indexOf('win.loadURL(targetUrl)');
  assert.ok(resetPos >= 0 && resetPos < loadPos,
    '不重置的话，第一次的 dom-ready 会让第二次尝试凭旧标记蒙混过关');
});

test('超时回调对可用页面不得 stop()', () => {
  const source = namedFunctionSource(mainText, 'loadMainWindowWithRetry');
  assert.match(
    source,
    /if \(mainWindowNavigationUsable\(win\)\) return;\s*try \{ win\.webContents\.stop\(\)/,
    'stop() 会掐断剩余子资源，把一个能用的页面弄残',
  );
});

test('启动仍然保留真失败的出口', () => {
  const source = namedFunctionSource(mainText, 'loadMainWindowWithRetry');
  assert.match(source, /loadURL failed after retry/,
    '页面确实没到 dom-ready 时，还是要报错，不能一律放过');
});
