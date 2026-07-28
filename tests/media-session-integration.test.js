'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('media session publishes metadata, playback state, position, and transport actions', () => {
  const root = path.join(__dirname, '..');
  const source = fs.readFileSync(path.join(root, 'public', 'js', 'modules', '05-playback', '14a-media-session.js'), 'utf8');
  const actions = {};
  const mediaSession = {
    metadata: null,
    playbackState: 'none',
    position: null,
    setActionHandler(action, handler) { actions[action] = handler; },
    setPositionState(value) { this.position = value; },
  };
  const calls = [];
  function Metadata(value) { Object.assign(this, value); }
  const context = {
    navigator: { mediaSession },
    MediaMetadata: Metadata,
    playQueue: [{ name: '测试歌曲', artist: '测试歌手', album: '测试专辑', cover: '/cover.jpg' }],
    currentIdx: 0,
    playing: true,
    audio: { duration: 180, currentTime: 42, playbackRate: 1 },
    songCoverSrc: (song) => song.cover,
    togglePlay: () => calls.push('toggle'),
    prevTrack: (manual) => calls.push(['previous', manual]),
    nextTrack: (manual) => calls.push(['next', manual]),
    console,
    Date,
    isFinite,
  };
  vm.runInNewContext(source, context);
  context.bindMediaSessionActions();
  context.syncMediaSessionState();

  assert.equal(mediaSession.metadata.title, '测试歌曲');
  assert.equal(mediaSession.metadata.artist, '测试歌手');
  assert.equal(mediaSession.playbackState, 'playing');
  assert.equal(mediaSession.position.position, 42);
  assert.deepEqual(Object.keys(actions).sort(), ['nexttrack', 'pause', 'play', 'previoustrack']);
  actions.pause();
  actions.previoustrack();
  actions.nexttrack();
  assert.deepEqual(calls, ['toggle', ['previous', true], ['next', true]]);

  context.playQueue = [];
  context.currentIdx = -1;
  context.syncMediaSessionState();
  assert.equal(mediaSession.metadata, null);
  assert.equal(mediaSession.playbackState, 'none');
});

test('media session module is loaded in playback order and wired to state changes', () => {
  const root = path.join(__dirname, '..');
  const loader = fs.readFileSync(path.join(root, 'public', 'js', 'index-loader.js'), 'utf8');
  const playback = fs.readFileSync(path.join(root, 'public', 'js', 'modules', '05-playback', '12-playback-switch-core.js'), 'utf8');
  const progress = fs.readFileSync(path.join(root, 'public', 'js', 'modules', '06-lyrics', '04-progress-seek.js'), 'utf8');
  assert.match(loader, /14-player-controls\.js'[\s\S]{0,100}14a-media-session\.js'[\s\S]{0,100}15-control-glass-animations\.js'/);
  assert.match(playback, /syncMediaSessionState\(\)/);
  assert.match(progress, /bindMediaSessionToAudio\(audioEl\)/);
});
