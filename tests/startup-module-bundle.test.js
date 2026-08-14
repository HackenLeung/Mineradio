'use strict';

// 启动模块合并端点。
//
// 旧实现让浏览器同步请求 110 个模块文件，每个带时间戳强制不缓存。冷启动时这些
// 串行往返会把 loadURL 拖过 15s 上限，报 MR-BOOT-WINDOW-LOAD（startup-error.log
// 里 8/10 两次、8/14 一次）。合并成一次请求把往返收成 1 次。
//
// 不能改的是同步性：10-shell/03-splash.js 和 03-beat/06-sonic-audio-monitor.js 是
// 无保护的 DOMContentLoaded 监听（没有 readyState 判断）。同步注入保证模块在该事件
// 之前跑完；异步注入会让注入落到事件之后，这两处永远收不到，splash 和音频监视器
// 静默失效 —— 不报错、没有栈。所以只优化往返次数，不动同步性。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const loaderPath = path.join(root, 'public/js/index-loader.js');
const loaderText = fs.readFileSync(loaderPath, 'utf8');
const serverText = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

function loaderModulePaths() {
  const declaration = /const\s+modulePaths\s*=\s*\[([\s\S]*?)\];/.exec(loaderText);
  assert.ok(declaration, 'index-loader 里应有 modulePaths 名单');
  const paths = [];
  const literal = /'([^'\\]*(?:\\.[^'\\]*)*)'/g;
  let match;
  while ((match = literal.exec(declaration[1]))) paths.push(match[1]);
  return paths;
}

test('加载器必须保持同步 XHR，不得改成异步注入', () => {
  assert.match(loaderText, /request\.open\('GET',[^)]*,\s*false\)/,
    '第三参数 false 就是同步。改 true 会静默废掉两处无保护的 DOMContentLoaded 监听');
  assert.ok(!/\.defer\s*=\s*true|\basync\s*=\s*true/.test(loaderText),
    '注入的 script 不能加 defer/async');
  assert.ok(!/\bfetch\s*\(/.test(loaderText), '不要换成 fetch：那是异步的');
});

test('那两处无保护的 DOMContentLoaded 监听仍然存在，是同步约束的理由', () => {
  const splash = fs.readFileSync(path.join(root, 'public/js/modules/10-shell/03-splash.js'), 'utf8');
  const sonic = fs.readFileSync(path.join(root, 'public/js/modules/03-beat/06-sonic-audio-monitor.js'), 'utf8');
  assert.match(splash, /addEventListener\('DOMContentLoaded'/);
  assert.match(sonic, /addEventListener\('DOMContentLoaded'/);
  // 若哪天这两处补上了 readyState 判断，同步约束就可以重新评估 —— 这个断言会提醒。
  assert.ok(
    !/readyState[\s\S]{0,80}addEventListener\('DOMContentLoaded'/.test(splash),
    'splash 若已加 readyState 守卫，请同时更新本测试与同步约束的结论',
  );
});

test('加载器先请求合并端点', () => {
  assert.match(loaderText, /index-modules-bundle\.js/, '应请求合并端点');
  const bundlePos = loaderText.indexOf('index-modules-bundle.js');
  const perModulePos = loaderText.indexOf('modulePaths.map(readModule)');
  assert.ok(bundlePos >= 0 && perModulePos >= 0);
  assert.ok(bundlePos < perModulePos, '合并端点是主路径，逐个加载是退路');
});

test('合并端点失败要退回逐个加载，不能让页面起不来', () => {
  assert.match(loaderText, /const bundled = readBundle\(\);/);
  assert.match(loaderText, /bundled\s*\|\|\s*\(modulePaths\.map\(readModule\)/,
    '空字符串要落到逐个加载');
  const readBundle = /function readBundle\(\)\s*\{[\s\S]*?\n  \}/.exec(loaderText);
  assert.ok(readBundle, '应有 readBundle()');
  assert.match(readBundle[0], /catch\s*\(/, '端点异常不能把整个启动带崩');
  assert.match(readBundle[0], /status < 200 \|\| .*status >= 300/, '非 2xx 要当失败处理');
});

test('注入脚本仍带 sourceURL，保持调试行号', () => {
  assert.match(loaderText, /sourceURL=mineradio-index-modules\.js/);
  assert.match(serverText, /sourceURL=mineradio-index-modules\.js/,
    '合并端点也要带，否则走主路径时 DevTools 里没有可读的文件名');
});

test('模块顺序只有一份权威来源：服务端解析 index-loader', () => {
  assert.match(serverText, /index-loader\.js/, '服务端应读 index-loader，而不是另抄一份名单');
  assert.match(serverText, /const\\s\+modulePaths/,
    '服务端用正则解析同一份 modulePaths');
  // 名单若在服务端重抄一遍，两处必然漂移；这里确保没有第二份硬编码清单。
  assert.ok(
    !/js\/modules\/00-state\/00-core-stores\.js/.test(serverText),
    '服务端不得内联模块清单',
  );
});

test('名单里的模块都存在，且按该顺序拼出来是合法脚本', () => {
  const paths = loaderModulePaths();
  assert.ok(paths.length >= 100, `名单应有上百个模块，实际 ${paths.length}`);
  const missing = paths.filter((p) => !fs.existsSync(path.join(root, 'public', p)));
  assert.deepEqual(missing, [], '名单里有不存在的模块');
  const joined = paths.map((p) => fs.readFileSync(path.join(root, 'public', p), 'utf8')).join('\n;\n');
  new vm.Script(joined, { filename: 'mineradio-index-modules.js' });
});

test('合并端点的拼接分隔符与测试预期一致', () => {
  assert.match(serverText, /modules\.join\('\\n;\\n'\)/,
    '分隔符变了要同步更新上面那条拼接测试');
});

test('端点挡住路径穿越，不能变成任意文件读取', () => {
  assert.match(serverText, /INDEX_MODULE_PATH_INVALID/);
  assert.match(serverText, /startsWith\('\/'\)/, '绝对路径要挡');
  assert.match(serverText, /includes\('\.\.\/'\)/, '上跳要挡');
  assert.match(serverText, /INDEX_MODULE_PATH_OUTSIDE_PUBLIC/, '最终还要校验解析结果仍在 public 内');
});

test('端点只接受 GET/HEAD', () => {
  assert.match(serverText, /'\/js\/index-modules-bundle\.js'[\s\S]{0,240}405/,
    '其他方法返回 405');
});

test('端点异常返回 5xx，让加载器能识别并退回', () => {
  const handler = /async function serveIndexModulesBundle\(res\)\s*\{[\s\S]*?\n\}/.exec(serverText);
  assert.ok(handler, '应有 serveIndexModulesBundle()');
  assert.match(handler[0], /writeHead\(500/, '失败要给 5xx，不能给 200 空响应');
  assert.match(handler[0], /Promise\.all\(/, '并行读盘，别又退化成串行');
});
