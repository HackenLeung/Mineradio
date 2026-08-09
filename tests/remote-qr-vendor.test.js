'use strict';

// 守 vendor 里的 qrcode-generator：二维码画错了不会报错，只会扫不出来，
// 所以按 QR 规范校验结构（定位图案 / 时序图案 / 暗模块 / 版本自适应），
// 而不是只断言「没抛异常」。以后升级这个库时这条会挡住坏码。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const qrcode = require(path.join(__dirname, '..', 'public', 'vendor', 'qrcode-generator.js'));

function build(url, ec) {
  const qr = qrcode(0, ec || 'M');
  qr.addData(url);
  qr.make();
  return qr;
}

// 定位图案是 7x7：外框实心、内芯 3x3 实心、之间一圈空。
function finderPatternValid(qr, row, col) {
  for (let i = 0; i < 7; i += 1) {
    for (let j = 0; j < 7; j += 1) {
      const expected = (i === 0 || i === 6 || j === 0 || j === 6) || (i >= 2 && i <= 4 && j >= 2 && j <= 4);
      if (qr.isDark(row + i, col + j) !== expected) return false;
    }
  }
  return true;
}

const SAMPLE_URL = 'http://192.168.31.111:3000/remote.html#385767';

test('vendor 库可用且导出可调用', () => {
  assert.equal(typeof qrcode, 'function', 'qrcode-generator 应导出函数');
  const qr = build(SAMPLE_URL);
  ['addData', 'make', 'isDark', 'getModuleCount', 'createSvgTag'].forEach((name) => {
    assert.equal(typeof qr[name], 'function', `应提供 ${name}()`);
  });
});

test('三个定位图案正确、右下角没有', () => {
  const qr = build(SAMPLE_URL);
  const n = qr.getModuleCount();
  assert.ok(finderPatternValid(qr, 0, 0), '左上定位图案应正确');
  assert.ok(finderPatternValid(qr, 0, n - 7), '右上定位图案应正确');
  assert.ok(finderPatternValid(qr, n - 7, 0), '左下定位图案应正确');
  assert.ok(!finderPatternValid(qr, n - 7, n - 7), '右下角不应有定位图案');
});

test('时序图案在第 6 行与第 6 列交替', () => {
  const qr = build(SAMPLE_URL);
  const n = qr.getModuleCount();
  for (let i = 8; i < n - 8; i += 1) {
    assert.equal(qr.isDark(6, i), i % 2 === 0, `第 6 行第 ${i} 列时序应交替`);
    assert.equal(qr.isDark(i, 6), i % 2 === 0, `第 6 列第 ${i} 行时序应交替`);
  }
});

test('固定暗模块存在', () => {
  const qr = build(SAMPLE_URL);
  const version = (qr.getModuleCount() - 17) / 4;
  assert.equal(qr.isDark(4 * version + 9, 8), true, '(4×version+9, 8) 必须是暗模块');
});

test('版本随内容长度自适应且模块数合法', () => {
  const short = build('http://10.0.0.2:3000/remote.html#100000');
  const long = build('http://192.168.100.200:39999/remote.html#999999' + 'x'.repeat(120));
  const shortModules = short.getModuleCount();
  const longModules = long.getModuleCount();
  // 模块数必须是 4×version+17，version 1..40
  [shortModules, longModules].forEach((n) => {
    const version = (n - 17) / 4;
    assert.ok(Number.isInteger(version), `模块数 ${n} 应满足 4×version+17`);
    assert.ok(version >= 1 && version <= 40, `version ${version} 应在 1..40`);
  });
  assert.ok(longModules > shortModules, '更长的内容应选更大的版本');
});

test('createSvgTag 输出可直接插进 DOM 的 SVG', () => {
  const qr = build(SAMPLE_URL);
  const svg = qr.createSvgTag(4, 16, '局域网遥控二维码', SAMPLE_URL);
  assert.match(svg, /^<svg /, '应以 <svg 开头');
  assert.match(svg, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, '应带 SVG 命名空间');
  assert.match(svg, /viewBox="0 0 \d+ \d+"/, '应带 viewBox');
  assert.ok(svg.includes('局域网遥控二维码'), 'alt 文本应进入输出');

  // margin 是像素而非模块：尺寸 = 模块数×cellSize + margin×2。
  // CSS 若写死一个不同的像素值会造成非整数模块缩放、边缘发虚。
  const n = qr.getModuleCount();
  const expected = n * 4 + 16 * 2;
  const box = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
  assert.equal(Number(box[1]), expected, `viewBox 宽应为 ${expected}`);
  assert.equal(Number(box[2]), expected, `viewBox 高应为 ${expected}`);
});

test('静区必须够 4 个模块（QR 规范要求）', () => {
  const qr = build(SAMPLE_URL);
  const n = qr.getModuleCount();
  const cellSize = 4;
  const svg = qr.createSvgTag(cellSize, cellSize * 4, '', SAMPLE_URL);
  const box = /viewBox="0 0 (\d+) /.exec(svg);
  const size = Number(box[1]);
  // 每边静区 = (总尺寸 - 码本体) / 2，换算成模块数必须 >= 4。
  const quietModules = ((size - n * cellSize) / 2) / cellSize;
  assert.ok(quietModules >= 4, `静区只有 ${quietModules} 个模块，规范要求 >= 4，会掉识别率`);

  // 库的默认 margin 就是 cellSize*4，省略参数也应满足规范。
  const defaulted = qr.createSvgTag(cellSize);
  const defaultBox = /viewBox="0 0 (\d+) /.exec(defaulted);
  const defaultQuiet = ((Number(defaultBox[1]) - n * cellSize) / 2) / cellSize;
  assert.ok(defaultQuiet >= 4, '库默认 margin 也应满足 4 模块静区');
});

test('纠错等级都能出码', () => {
  ['L', 'M', 'Q', 'H'].forEach((ec) => {
    const qr = build(SAMPLE_URL, ec);
    const n = qr.getModuleCount();
    assert.ok(n >= 21, `${ec} 级应出有效模块数`);
    assert.ok(finderPatternValid(qr, 0, 0), `${ec} 级定位图案应正确`);
  });
});
