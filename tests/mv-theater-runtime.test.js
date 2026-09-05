'use strict';

// MV 剧场的运行时行为。mv-theater.test.js 只断言源码形状；这里真的把模块
// 跑起来，验证行为本身：音频暂停/恢复的配对、mvid 提取、按钮状态、清晰度回填、
// 以及退出时有没有真的断开视频下载。
//
// 项目没装 jsdom，所以手搓一个够用的桩 DOM。模块是「一大段顶层语句 + 全局函数」
// 的写法（和 index-loader 拼接后的运行环境一致），用 vm 给它喂全局依赖即可。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'public/js/modules/05-playback/17-mv-theater.js'), 'utf8');

function makeElement(id) {
  return {
    id,
    disabled: false,
    hidden: false,
    title: '',
    textContent: '',
    innerHTML: '',
    muted: false,
    volume: 1,
    paused: true,
    ended: false,
    currentTime: 0,
    duration: 0,
    playbackRate: 1,
    src: '',
    currentSrc: '',
    attributes: {},
    _classes: new Set(),
    _listeners: {},
    _loadCalls: 0,
    _playCalls: 0,
    classList: {
      add: (...names) => names.forEach(n => this_classesOf(id).add(n)),
      remove: (...names) => names.forEach(n => this_classesOf(id).delete(n)),
      contains: name => this_classesOf(id).has(name),
      toggle: (name, force) => {
        const set = this_classesOf(id);
        const next = force === undefined ? !set.has(name) : !!force;
        if (next) set.add(name); else set.delete(name);
        return next;
      },
    },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name] ?? null; },
    removeAttribute(name) {
      delete this.attributes[name];
      if (name === 'src') { this.src = ''; this.currentSrc = ''; }
    },
    addEventListener(name, fn) { (this._listeners[name] ||= []).push(fn); },
    removeEventListener(name, fn) {
      if (!this._listeners[name]) return;
      this._listeners[name] = this._listeners[name].filter(f => f !== fn);
    },
    dispatch(name, event) { (this._listeners[name] || []).forEach(fn => fn(event || {})); },
    getBoundingClientRect() { return { left: 0, width: 200, top: 0, height: 6 }; },
    setPointerCapture() {},
    releasePointerCapture() {},
    closest() { return null; },
    querySelectorAll() { return []; },
    load() { this._loadCalls++; },
    pause() { this.paused = true; },
    play() { this._playCalls++; this.paused = false; return Promise.resolve(); },
    setSinkId() { return Promise.resolve(); },
  };
}

// classList 需要闭包共享同一个 Set，用一张表按 id 存。
const classSets = new Map();
function this_classesOf(id) {
  if (!classSets.has(id)) classSets.set(id, new Set());
  return classSets.get(id);
}

function makeHarness(opts) {
  opts = opts || {};
  classSets.clear();
  const elements = new Map();
  [
    'mv-theater', 'mv-video', 'mv-title', 'mv-sub', 'mv-quality', 'mv-quality-btn',
    'mv-quality-list', 'mv-close', 'mv-status', 'mv-status-text', 'mv-status-retry',
    'mv-btn', 'progress-bar', 'time-display',
  ].forEach(id => elements.set(id, makeElement(id)));

  const audio = makeElement('audio');
  audio.src = 'http://example.test/song.mp3';
  audio.currentSrc = audio.src;
  // 默认暂停；要测「原本在播」的用例显式传 audioPlaying: true。
  audio.paused = !opts.audioPlaying;

  const calls = { toasts: [], apiUrls: [], attemptAudioPlay: 0, progressUi: 0, stateSyncs: [] };
  const responses = opts.responses || {};

  const sandbox = {
    console,
    performance: { now: () => Date.now() },
    setTimeout, clearTimeout, Promise,
    document: {
      getElementById: id => elements.get(id) || null,
      addEventListener() {},
      body: makeElement('body'),
    },
    audio,
    targetVolume: opts.volume === undefined ? 0.8 : opts.volume,
    playbackTuning: { speed: 1.25, pitch: 0 },
    audioOutputDeviceId: '',
    immersiveMode: false,
    setImmersiveMode() {},
    resetSmartCrossfade() {},
    forcePlaybackControlsInteractive() {},
    updatePlaybackProgressUi() { calls.progressUi++; },
    setProgressVisual() {},
    setPlayIcon() {},
    formatProgramTime: s => String(Math.round(s)),
    clampRange: (v, min, max) => Math.max(min, Math.min(max, v)),
    showToast: msg => calls.toasts.push(String(msg)),
    attemptAudioPlay() { calls.attemptAudioPlay++; audio.paused = false; },
    syncPlaybackStateFromAudioEvent(reason) { calls.stateSyncs.push(String(reason)); },
    queueItemKey: song => 'key:' + (song && song.id),
    currentCoverSong: () => opts.song || null,
    songProviderKey: song => {
      if (song && (song.provider === 'qq' || song.source === 'qq')) return 'qq';
      if (song && (song.provider === 'kugou' || song.hash)) return 'kugou';
      return 'netease';
    },
    apiJson(url) {
      calls.apiUrls.push(url);
      const key = Object.keys(responses).find(k => url.indexOf(k) >= 0);
      if (!key) return Promise.reject(new Error('no stub for ' + url));
      const value = responses[key];
      return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: '17-mv-theater.js' });
  return { sandbox, elements, audio, calls, video: elements.get('mv-video') };
}

const NETEASE_MV_SONG = { id: 1, name: 'Day 1', artist: 'HONNE', mv: 5876680, provider: 'netease' };
const URL_OK = {
  '/api/mv/url': { proxyUrl: '/api/video?url=x', resolution: 720, id: '5876680' },
};
const DETAIL_OK = {
  '/api/mv/detail': { mv: { id: '5876680', name: 'Day 1 MV', artist: '1 MILLION', resolutions: [240, 480, 720, 1080] } },
};

test('mvid 只从小云的歌里取', () => {
  const h = makeHarness({});
  const { mvIdForSong, songCanPlayMv } = h.sandbox;
  assert.equal(mvIdForSong(NETEASE_MV_SONG), '5876680');
  assert.equal(songCanPlayMv(NETEASE_MV_SONG), true);
  assert.equal(mvIdForSong({ mv: 123, provider: 'qq' }), '', '小Q 的歌不能认 mv 字段');
  assert.equal(mvIdForSong({ mv: 123, hash: 'abc' }), '', '小狗的歌不能认 mv 字段');
  assert.equal(mvIdForSong({ mv: 0, provider: 'netease' }), '', 'mv=0 表示没有 MV');
  assert.equal(mvIdForSong(null), '');
  assert.equal(mvIdForSong({ mvid: '777', provider: 'netease' }), '777', 'mvid 也要认');
});

test('没有源时不算「MV 在放」，进度条不该切过去', () => {
  const h = makeHarness({});
  assert.equal(h.sandbox.mvTheaterActiveMedia(), null, '未开剧场时为 null');
  h.sandbox.mvTheaterState.active = true;
  assert.equal(h.sandbox.mvTheaterActiveMedia(), null, '开了但还没有 src 时仍为 null');
  h.video.src = '/api/video?url=x';
  assert.ok(h.sandbox.mvTheaterActiveMedia(), '有 src 后才算在放');
});

test('开场暂停音频，退出恢复 —— 且只在原本在播时恢复', async () => {
  const playing = makeHarness({ song: NETEASE_MV_SONG, audioPlaying: true, responses: { ...URL_OK, ...DETAIL_OK } });
  assert.equal(playing.audio.paused, false, '前置条件：音频在播');
  await playing.sandbox.openMvTheater();
  assert.equal(playing.audio.paused, true, 'MV 用自带音轨，开场必须暂停音频');
  assert.equal(playing.sandbox.mvTheaterState.resumeAudio, true);
  playing.sandbox.closeMvTheater();
  assert.equal(playing.calls.attemptAudioPlay, 1, '原本在播，退出要恢复');

  const paused = makeHarness({ song: NETEASE_MV_SONG, audioPlaying: false, responses: { ...URL_OK, ...DETAIL_OK } });
  await paused.sandbox.openMvTheater();
  paused.sandbox.closeMvTheater();
  assert.equal(paused.calls.attemptAudioPlay, 0, '原本暂停，退出不能擅自起播');
});

test('切歌那条退出路径不恢复音频，避免打两次起播', async () => {
  const h = makeHarness({ song: NETEASE_MV_SONG, audioPlaying: true, responses: { ...URL_OK, ...DETAIL_OK } });
  await h.sandbox.openMvTheater();
  h.sandbox.closeMvTheater({ resumeAudio: false });
  assert.equal(h.calls.attemptAudioPlay, 0, 'resumeAudio:false 时不能恢复');
});

test('非小云 / 无 MV 的歌打不开剧场，并说明原因', async () => {
  const qq = makeHarness({ song: { id: 2, mv: 9, provider: 'qq' }, audioPlaying: true });
  assert.equal(await qq.sandbox.openMvTheater(), false);
  assert.match(qq.calls.toasts.join('|'), /只有小云/, '要如实说明是音源限制');
  assert.equal(qq.audio.paused, false, '打不开时不能顺手把音频停了');

  const none = makeHarness({ song: { id: 3, mv: 0, provider: 'netease' }, audioPlaying: true });
  assert.equal(await none.sandbox.openMvTheater(), false);
  assert.match(none.calls.toasts.join('|'), /没有 MV/);
  assert.equal(none.audio.paused, false, '打不开时音频要继续播');
});

test('清晰度按上游实际返回的档位回填，不显示没生效的档位', async () => {
  const h = makeHarness({
    song: NETEASE_MV_SONG,
    responses: { '/api/mv/url': { proxyUrl: '/api/video?url=x', resolution: 480 }, ...DETAIL_OK },
  });
  await h.sandbox.openMvTheater();
  assert.equal(h.sandbox.mvTheaterState.resolution, 480, '请求 1080 但上游给 480，就要显示 480');
  assert.equal(h.elements.get('mv-quality-btn').textContent, '480P');
});

test('详情回来后标题和清晰度列表真的渲染上去', async () => {
  const h = makeHarness({ song: NETEASE_MV_SONG, responses: { ...URL_OK, ...DETAIL_OK } });
  await h.sandbox.openMvTheater();
  // 详情是并发发出的，等微任务队列排空。
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(h.elements.get('mv-title').textContent, 'Day 1 MV',
    '标题必须换成 MV 名 —— 这里曾因为用 requestToken 判定时效而永远不生效');
  assert.deepEqual(h.sandbox.mvTheaterState.resolutions, [240, 480, 720, 1080]);
  assert.equal(h.elements.get('mv-quality-btn').disabled, false, '多档位时画质按钮要可点');
});

test('取址失败进错误态并给重试，不留在「正在载入」', async () => {
  const h = makeHarness({
    song: NETEASE_MV_SONG,
    responses: { '/api/mv/url': { error: 'MV url unavailable' }, ...DETAIL_OK },
  });
  await h.sandbox.openMvTheater();
  assert.ok(this_classesOf('mv-theater').has('is-error'), '要进错误态');
  assert.equal(this_classesOf('mv-theater').has('is-loading'), false, '不能同时还在加载态');
  assert.equal(h.elements.get('mv-status-retry').hidden, false, '要给重试按钮');
});

test('音量和倍速镜像到视频元素', async () => {
  const h = makeHarness({ song: NETEASE_MV_SONG, volume: 0.42, responses: { ...URL_OK, ...DETAIL_OK } });
  await h.sandbox.openMvTheater();
  assert.equal(h.video.volume, 0.42, '音量要跟全局 targetVolume');
  assert.equal(h.video.muted, false, 'MV 不能是静音的');
  assert.equal(h.video.playbackRate, 1.25, '倍速要跟全局设置');
});

test('退出时真的断开下载，不只是 pause', async () => {
  const h = makeHarness({ song: NETEASE_MV_SONG, responses: { ...URL_OK, ...DETAIL_OK } });
  await h.sandbox.openMvTheater();
  h.video.paused = false;
  const loadsBefore = h.video._loadCalls;
  h.sandbox.closeMvTheater();
  assert.equal(h.video.paused, true, '要暂停');
  assert.equal(h.video.src, '', 'src 要清掉');
  assert.ok(h.video._loadCalls > loadsBefore, '清完要 load() 才真断开连接');
});

test('底栏播放键：MV 在放时接管，不在放时放行给音频', async () => {
  const h = makeHarness({ song: NETEASE_MV_SONG, responses: { ...URL_OK, ...DETAIL_OK } });
  assert.equal(h.sandbox.toggleMvPlayback(), false, '未开剧场时必须放行，否则音频没法播');
  await h.sandbox.openMvTheater();
  h.video.paused = false;
  assert.equal(h.sandbox.toggleMvPlayback(), true, 'MV 模式下要接管');
  assert.equal(h.video.paused, true, '接管后应暂停视频');
  assert.equal(h.sandbox.toggleMvPlayback(), true);
  assert.equal(h.video.paused, false, '再按一次应继续播');
});

test('MV 放完退出剧场，不自动串下一支', async () => {
  const h = makeHarness({ song: NETEASE_MV_SONG, audioPlaying: true, responses: { ...URL_OK, ...DETAIL_OK } });
  await h.sandbox.openMvTheater();
  h.video.dispatch('ended');
  assert.equal(h.sandbox.mvTheaterState.active, false, 'ended 后要退出剧场');
  assert.equal(h.calls.attemptAudioPlay, 1, '回到音频继续播原来那首');
});

test('同一支 MV 重复打开是幂等的，不重复取址', async () => {
  const h = makeHarness({ song: NETEASE_MV_SONG, responses: { ...URL_OK, ...DETAIL_OK } });
  await h.sandbox.openMvTheater();
  const urlCalls = h.calls.apiUrls.filter(u => u.indexOf('/api/mv/url') >= 0).length;
  await h.sandbox.openMvTheater();
  const after = h.calls.apiUrls.filter(u => u.indexOf('/api/mv/url') >= 0).length;
  assert.equal(after, urlCalls, '同一支 MV 不该再取一次地址');
});

test('不恢复播放时要把播放图标刷回音频的真实状态', async () => {
  const h = makeHarness({ song: NETEASE_MV_SONG, audioPlaying: false, responses: { ...URL_OK, ...DETAIL_OK } });
  await h.sandbox.openMvTheater();
  h.sandbox.closeMvTheater();
  assert.equal(h.calls.attemptAudioPlay, 0);
  assert.ok(h.calls.stateSyncs.length > 0,
    '否则图标会卡在 MV 留下的「正在播放」上 —— 视频那两个监听在 active 置 false 后已提前 return');

  const playing = makeHarness({ song: NETEASE_MV_SONG, audioPlaying: true, responses: { ...URL_OK, ...DETAIL_OK } });
  await playing.sandbox.openMvTheater();
  playing.sandbox.closeMvTheater();
  assert.equal(playing.calls.attemptAudioPlay, 1, '要恢复播放时走起播，不需要额外刷图标');
});

// 下面三条覆盖「模式开着但视频不就绪」的两个窗口。之前 50 条全绿而 bug 仍在，
// 就是因为只构造了已就绪的状态。
test('取址在途时播放键必须被吃掉，不能放行给刚暂停的音频', async () => {
  let releaseUrl;
  const pending = new Promise(resolve => { releaseUrl = resolve; });
  const h = makeHarness({
    song: NETEASE_MV_SONG,
    audioPlaying: true,
    responses: { '/api/mv/url': pending, ...DETAIL_OK },
  });
  const opening = h.sandbox.openMvTheater();

  assert.equal(h.sandbox.mvTheaterState.active, true, '剧场已经开了');
  assert.equal(h.audio.paused, true, '音频已经被暂停');
  assert.equal(h.sandbox.mvTheaterActiveMedia(), null, '视频还没有 src');
  assert.equal(h.sandbox.mvTheaterOwnsPlayback(), true, '但归属已经是剧场的');
  assert.equal(h.sandbox.toggleMvPlayback(), true,
    '必须返回 true 吃掉这次 toggle。返回 false 会让 togglePlay 往下走去恢复音频，' +
    '等视频就绪 autoplay 后两路声音一起响');
  assert.equal(h.audio.paused, true, '音频不能被这次 toggle 弄成播放');

  releaseUrl({ proxyUrl: '/api/video?url=x', resolution: 720 });
  await opening;
  assert.ok(h.sandbox.mvTheaterActiveMedia(), '就绪后读数门槛才放行');
});

test('取址失败后剧场还开着，播放键仍不能放歌', async () => {
  const h = makeHarness({
    song: NETEASE_MV_SONG,
    audioPlaying: true,
    responses: { '/api/mv/url': new Error('boom'), ...DETAIL_OK },
  });
  await h.sandbox.openMvTheater();

  assert.equal(h.sandbox.mvTheaterState.active, true, '错误态下剧场不自动关');
  assert.equal(this_classesOf('mv-theater').has('is-error'), true, '显示错误和重试');
  assert.equal(h.sandbox.mvTheaterActiveMedia(), null, '视频永远不会就绪');
  assert.equal(h.sandbox.toggleMvPlayback(), true,
    '这个窗口是永久的：放行的话用户每按一次播放都在暗场背后放歌，只能靠退出解开');
  assert.equal(h.audio.paused, true);
  assert.equal(h.calls.attemptAudioPlay, 0, '不能起播音频');
});

test('未开剧场时必须放行，否则音频没法播', () => {
  const h = makeHarness({ song: NETEASE_MV_SONG });
  assert.equal(h.sandbox.mvTheaterOwnsPlayback(), false);
  assert.equal(h.sandbox.toggleMvPlayback(), false);
});

test('按钮状态：有 MV 可点，没 MV 置灰并说明原因', () => {
  const yes = makeHarness({ song: NETEASE_MV_SONG });
  yes.sandbox.syncMvButton();
  assert.equal(yes.elements.get('mv-btn').disabled, false);
  assert.match(yes.elements.get('mv-btn').title, /看 MV/);

  const no = makeHarness({ song: { id: 4, mv: 0, provider: 'netease' } });
  no.sandbox.syncMvButton();
  assert.equal(no.elements.get('mv-btn').disabled, true);
  assert.match(no.elements.get('mv-btn').title, /没有 MV/);

  const qq = makeHarness({ song: { id: 5, provider: 'qq' } });
  qq.sandbox.syncMvButton();
  assert.match(qq.elements.get('mv-btn').title, /只有小云/);
});
