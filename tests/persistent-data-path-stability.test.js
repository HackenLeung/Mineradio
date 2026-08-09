'use strict';

// 诊断日志和已配对设备要跨重启、跨启动方式长期累积。
// 第一版把它们挂在 DEFAULT_CACHE_ROOT 上，那个值：
//   - Electron 下（process.resourcesPath 有值）→ node_modules/electron/dist/MineradioCache
//   - 裸跑 node（resourcesPath undefined）→ 项目根目录/MineradioCache
// 同一台机器两个位置，换启动方式数据就「凭空消失」；而且前者会被
// npm install / 升级 Electron 整个删掉重建。这条测试挡住这类漂移。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8');

test('诊断与遥控目录不挂在 DEFAULT_CACHE_ROOT 上', () => {
  const diagLine = /const DIAGNOSTICS_DIR = ([^\n;]+)/.exec(serverSource);
  const remoteLine = /const REMOTE_DIR = ([^\n;]+)/.exec(serverSource);
  assert.ok(diagLine, 'server.js 应定义 DIAGNOSTICS_DIR');
  assert.ok(remoteLine, 'server.js 应定义 REMOTE_DIR');
  assert.ok(
    !/DEFAULT_CACHE_ROOT/.test(diagLine[1]),
    'DIAGNOSTICS_DIR 不能用 DEFAULT_CACHE_ROOT：它在 Electron 下指向 node_modules/electron/dist',
  );
  assert.ok(
    !/DEFAULT_CACHE_ROOT/.test(remoteLine[1]),
    'REMOTE_DIR 不能用 DEFAULT_CACHE_ROOT：npm install 会把那个位置删掉重建',
  );
});

test('两个目录都支持环境变量覆盖', () => {
  assert.match(serverSource, /MINERADIO_DIAG_DIR/, '应支持 MINERADIO_DIAG_DIR');
  assert.match(serverSource, /MINERADIO_REMOTE_DIR/, '应支持 MINERADIO_REMOTE_DIR');
});

test('main.js 显式注入这两个目录', () => {
  // 打包后 __dirname 是 <安装目录>/resources/app，而本仓库的约定是
  // <安装目录>/MineradioCache（见 defaultCacheRootPath）。所以必须由 main.js 注入，
  // 跟既有的 MINERADIO_BEAT_CACHE_DIR 一致。
  assert.match(
    mainSource,
    /process\.env\.MINERADIO_DIAG_DIR\s*=\s*cacheSettings\.diagnosticsPath/,
    'main.js 应把 diagnosticsPath 注入 MINERADIO_DIAG_DIR',
  );
  assert.match(
    mainSource,
    /process\.env\.MINERADIO_REMOTE_DIR\s*=\s*cacheSettings\.remotePath/,
    'main.js 应把 remotePath 注入 MINERADIO_REMOTE_DIR',
  );
});

test('cacheSettings 里定义了这两条路径且挂在 rootPath 下', () => {
  assert.match(
    mainSource,
    /diagnosticsPath:\s*path\.join\(rootPath, 'diagnostics'\)/,
    'normalizeCacheSettings 应包含 diagnosticsPath',
  );
  assert.match(
    mainSource,
    /remotePath:\s*path\.join\(rootPath, 'remote'\)/,
    'normalizeCacheSettings 应包含 remotePath',
  );
});

test('注入发生在 require server.js 之前', () => {
  // server.js 在模块加载时就把这两个常量算好了，注入晚一步就没用。
  const injectIndex = mainSource.indexOf('process.env.MINERADIO_DIAG_DIR');
  const requireIndex = mainSource.indexOf('localServer = require(serverModulePath)');
  assert.ok(injectIndex > 0, '应有注入语句');
  assert.ok(requireIndex > 0, '应有 require server.js');
  assert.ok(
    injectIndex < requireIndex,
    '注入必须在 require 之前，否则 server.js 已经用默认值算完了',
  );
});

test('注入语句在 configureLocalServerEnvironment 内部', () => {
  const fnStart = mainSource.indexOf('function configureLocalServerEnvironment');
  assert.ok(fnStart > 0, '应有 configureLocalServerEnvironment');
  const fnEnd = mainSource.indexOf('\n}', fnStart);
  const body = mainSource.slice(fnStart, fnEnd);
  assert.match(body, /MINERADIO_DIAG_DIR/, '应与其它环境变量注入放在同一处');
  assert.match(body, /MINERADIO_REMOTE_DIR/, '应与其它环境变量注入放在同一处');
});
