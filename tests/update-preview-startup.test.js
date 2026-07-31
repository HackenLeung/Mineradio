'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '..');
const updatePath = path.join(appRoot, 'public', 'js', 'modules', '08-account', '00-update-preview.js');
const statePath = path.join(appRoot, 'public', 'js', 'modules', '00-state', '01-perf-render-state.js');
const startupPath = path.join(appRoot, 'public', 'js', 'modules', '10-shell', '05-startup-bindings.js');
const cssPath = path.join(appRoot, 'public', 'css', 'index.css');
const indexPath = path.join(appRoot, 'public', 'index.html');

const updateText = fs.readFileSync(updatePath, 'utf8');
const stateText = fs.readFileSync(statePath, 'utf8');
const startupText = fs.readFileSync(startupPath, 'utf8');
const cssText = fs.readFileSync(cssPath, 'utf8');
const indexText = fs.readFileSync(indexPath, 'utf8');

function functionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name}()`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = bodyStart; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '\'' || character === '"' || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  assert.fail(`unterminated ${name}()`);
}

test('update check is manual and runs when the panel is opened', () => {
  const init = functionSource(updateText, 'initUpdatePreview');
  const apply = functionSource(updateText, 'applyLatestUpdateInfo');
  const check = functionSource(updateText, 'checkLatestUpdate');
  const open = functionSource(updateText, 'openUpdatePanel');
  const startDownload = functionSource(updateText, 'startUpdatePreviewDownload');

  assert.doesNotMatch(stateText, /startupCheckStarted/);
  assert.doesNotMatch(init, /checkLatestUpdate\(/);
  assert.match(init, /setUpdatePreviewVisible\(true\)/);
  assert.match(apply, /setUpdatePreviewVisible\(true\)/);
  assert.match(check, /setUpdatePreviewVisible\(true\)/);
  assert.match(open, /checkLatestUpdate\(\)/);
  assert.match(startDownload, /checkLatestUpdate\(\)/);
  assert.match(startupText, /\ninitUpdatePreview\(\);/);
  assert.doesNotMatch(startupText, /setTimeout\(initUpdatePreview,\s*9000\)/);
  assert.match(indexText, /id="visual-guide-btn"[\s\S]{0,260}<svg viewBox="0 0 24 24"/);
});

test('titlebar action buttons share the update button rounded-square style', () => {
  const sharedStyle = cssText.match(/#dl-center-btn,[\s\S]{0,1200}#update-entry[\s\S]{0,800}border-radius: 10px !important/);
  assert.ok(sharedStyle, 'download, guide, and update buttons must share the rounded-square update style');
  assert.match(cssText, /body\.desktop-shell #desktop-titlebar #dl-center-btn[\s\S]{0,220}width: 36px[\s\S]{0,160}height: 36px/);
  assert.match(cssText, /body\.desktop-shell #desktop-titlebar #visual-guide-btn svg,[\s\S]{0,180}width: 18px[\s\S]{0,50}height: 18px/);
  assert.match(cssText, /#visual-guide-btn svg[\s\S]{0,180}stroke-width: 1\.8/);
});
