'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/js/modules/05-playback/10-queue-actions.js'), 'utf8');

function createQueueSandbox(names, currentIndex) {
  const sandbox = {
    playQueue: names.map(name => ({ id: name, name })),
    currentIdx: currentIndex,
    cloneSong: song => ({ ...song }),
    queueItemKey: song => song && String(song.id || ''),
    safeRenderQueuePanel() {},
    safeShelfRebuild() {},
    showToast() {},
  };
  vm.runInNewContext(source, sandbox);
  return sandbox;
}

function queueNames(sandbox) {
  return sandbox.playQueue.map(song => song.name);
}

test('add-next keeps the order in which songs were added', () => {
  const sandbox = createQueueSandbox(['current', 'original-next'], 0);
  sandbox.queueSongNext({ id: 'first', name: 'first' });
  sandbox.queueSongNext({ id: 'second', name: 'second' });
  sandbox.queueSongNext({ id: 'third', name: 'third' });
  assert.deepEqual(queueNames(sandbox), ['current', 'first', 'second', 'third', 'original-next']);
});

test('pending add-next order survives playback advancing into that segment', () => {
  const sandbox = createQueueSandbox(['current', 'original-next'], 0);
  sandbox.queueSongNext({ id: 'first', name: 'first' });
  sandbox.queueSongNext({ id: 'second', name: 'second' });
  sandbox.currentIdx = 1;
  sandbox.queueSongNext({ id: 'third', name: 'third' });
  assert.deepEqual(queueNames(sandbox), ['current', 'first', 'second', 'third', 'original-next']);
});

test('adding an existing song moves it to the end of the pending next segment', () => {
  const sandbox = createQueueSandbox(['current', 'existing', 'tail'], 0);
  sandbox.queueSongNext({ id: 'first', name: 'first' });
  sandbox.queueSongNext({ id: 'existing', name: 'existing' });
  assert.deepEqual(queueNames(sandbox), ['current', 'first', 'existing', 'tail']);
  assert.equal(sandbox.currentIdx, 0);
});
