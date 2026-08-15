'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const workspace = fs.readFileSync(
  path.join(root, 'public', 'js', 'modules', '07-fx', '09-console-workspace.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'public', 'css', 'index.css'), 'utf8');

test('visual console search focuses within the fixed panel without scrolling the window', () => {
  assert.match(workspace, /function fxConsoleScrollEntryIntoView\(entry, reduceMotion\)/);
  assert.match(workspace, /panel\.scrollTo\(\{\s*top: nextScrollTop, behavior:/);
  assert.match(workspace, /fxConsoleScrollEntryIntoView\(entry, reduceMotion\)/);
  assert.doesNotMatch(workspace, /entry\.element\.scrollIntoView\(\{\s*block:\s*'center'/);
});

test('visual console toolbar cannot be clipped by a negative sticky inset', () => {
  const toolbarStart = styles.indexOf('.fx-console-toolbar {');
  assert.ok(toolbarStart >= 0, 'visual console toolbar styles must exist');
  const toolbarBlock = styles.slice(toolbarStart, styles.indexOf('}', toolbarStart) + 1);
  assert.match(toolbarBlock, /position:\s*sticky/);
  assert.match(toolbarBlock, /top:\s*0/);
});
