'use strict';

// 搜索结果行与搜索墙卡片的红心数徽标。一屏几十首，取数必须限流；
// 非小云歌曲没有红心数接口，不能渲染空占位。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const detailSource = read('public/js/modules/05-playback/06-track-detail-lyrics-actions.js');
const searchSource = read('public/js/modules/05-playback/07-search.js');
const wallSource = read('public/js/modules/05-playback/07a-search-wall.js');
const indexCss = read('public/css/index.css');
const wallCss = read('public/css/search-wall.css');

function namedFunctionSource(source, name) {
  const declaration = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  assert.ok(declaration, `missing ${name}()`);
  const bodyStart = source.indexOf('{', declaration.index + declaration[0].length);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(declaration.index, index + 1);
    }
  }
  throw new Error(`unterminated ${name}()`);
}

function badgeSandbox(overrides) {
  const names = [
    'readCachedHeartCount',
    'writeCachedHeartCount',
    'formatRedCountDisplay',
    'heartCountBadgeHtml',
    'fillHeartCountBadges',
    'pumpHeartCountQueue',
    'ensureHeartCountForSongs',
  ];
  const sandbox = Object.assign({
    heartCountCache: Object.create(null),
    HEART_COUNT_CACHE_TTL_MS: 5 * 60 * 1000,
    HEART_COUNT_MAX_CONCURRENCY: 4,
    HEART_COUNT_MAX_QUEUE: 200,
    HEART_COUNT_REQUEST_TIMEOUT_MS: 12000,
    heartCountPending: Object.create(null),
    heartCountQueue: [],
    heartCountInFlight: 0,
    escHtml: value => String(value),
    songAccountProvider: song => (song && song.provider) || 'netease',
    Date,
  }, overrides || {});
  vm.runInNewContext(
    `${names.map(name => namedFunctionSource(detailSource, name)).join('\n')}
this.badgeHtml = heartCountBadgeHtml;
this.fillBadges = fillHeartCountBadges;
this.ensureForSongs = ensureHeartCountForSongs;
this.readCache = readCachedHeartCount;
this.writeCache = writeCachedHeartCount;
this.queuedCount = function () { return heartCountQueue.length; };`,
    sandbox
  );
  return sandbox;
}

function fakeDocument() {
  const nodes = [];
  return {
    nodes,
    document: {
      querySelectorAll: selector => {
        const key = /data-heart-count-key="([^"]*)"/.exec(selector);
        return nodes.filter(node => !key || node.key === key[1]);
      },
    },
    add(key) {
      const node = { key, textContent: '' };
      nodes.push(node);
      return node;
    },
  };
}

test('红心数徽标只给小云歌曲渲染', () => {
  const sandbox = badgeSandbox();
  assert.equal(sandbox.badgeHtml({ id: 1, provider: 'qq' }), '');
  assert.equal(sandbox.badgeHtml({ id: 1, provider: 'kugou' }), '');
  assert.equal(sandbox.badgeHtml({ provider: 'netease' }), '');
  assert.equal(sandbox.badgeHtml(null), '');
});

test('命中缓存时直接画出缩写，未命中时留空占位等待回填', () => {
  const sandbox = badgeSandbox();
  sandbox.writeCache('netease:347230', 40800);
  const filled = sandbox.badgeHtml({ id: 347230, provider: 'netease' });
  assert.match(filled, /data-heart-count-key="netease:347230"/);
  assert.match(filled, />4万</, '按 count 缩写成万');

  const empty = sandbox.badgeHtml({ id: 999, provider: 'netease' });
  assert.match(empty, /data-heart-count-key="netease:999"/);
  assert.match(empty, />\s*<\/span>/, '未知值先留空，回填时不重排');
});

test('回填按 key 命中所有同曲徽标，0 个红心清空而不是显示 0', () => {
  const dom = fakeDocument();
  const sandbox = badgeSandbox({ document: dom.document });
  const a = dom.add('netease:1');
  const b = dom.add('netease:1');
  const other = dom.add('netease:2');
  sandbox.fillBadges('netease:1', 12345);
  assert.equal(a.textContent, '1万');
  assert.equal(b.textContent, '1万');
  assert.equal(other.textContent, '');
  sandbox.fillBadges('netease:1', 0);
  assert.equal(a.textContent, '');
  assert.equal(b.textContent, '');
});

test('每首歌只请求一次，且在飞请求不超过并发上限', async () => {
  let inFlight = 0;
  let peak = 0;
  const calls = [];
  const sandbox = badgeSandbox({
    apiJson: (url, opts) => {
      calls.push({ url, opts });
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      return new Promise(resolve => {
        setTimeout(() => {
          inFlight -= 1;
          resolve({ count: 42, available: true });
        }, 0);
      });
    },
    document: fakeDocument().document,
  });
  const songs = [];
  for (let id = 1; id <= 12; id += 1) songs.push({ id, provider: 'netease' });
  songs.push({ id: 1, provider: 'netease' });
  sandbox.ensureForSongs(songs);
  sandbox.ensureForSongs(songs);
  assert.equal(calls.length, 4, '同一批去重，且只放出并发上限那么多');
  assert.ok(calls.every(call => call.opts && call.opts.timeoutMs > 0),
    'apiJson 缺省不设超时，悬住的请求会永久占住并发位');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(calls.length, 12, '每个 id 只请求一次');
  assert.ok(peak <= 4, `并发上限失效: ${peak}`);
});

test('available 为 false 或请求失败时不写缓存', async () => {
  const sandbox = badgeSandbox({
    apiJson: () => Promise.resolve({ count: 0, available: false }),
    document: fakeDocument().document,
  });
  sandbox.ensureForSongs([{ id: 7, provider: 'netease' }]);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(sandbox.readCache('netease:7'), null);
});

test('队列攒到上限后丢弃新歌，不再无限堆积请求', () => {
  const sandbox = badgeSandbox({
    apiJson: () => new Promise(() => {}),
    document: fakeDocument().document,
  });
  const songs = [];
  for (let id = 1; id <= 260; id += 1) songs.push({ id, provider: 'netease' });
  sandbox.ensureForSongs(songs);
  // 并发位被永不返回的请求占住，队列只会单向增长，正是需要上限的场景。
  // 4 个已被并发位取走，其余全部被上限挡下，不会有第 201 个进来。
  assert.equal(sandbox.queuedCount(), 196, `队列应停在上限，实际 ${sandbox.queuedCount()}`);
  assert.ok(sandbox.queuedCount() < 200, '超过上限的歌必须被丢弃');
});

test('两处渲染都挂上了徽标与限流取数', () => {
  assert.match(namedFunctionSource(searchSource, 'searchSongResultHtml'), /heartCountBadgeHtml\(s\)/);
  assert.match(searchSource, /ensureHeartCountForSongs\(/);
  assert.match(namedFunctionSource(wallSource, 'searchWallSongCardHtml'), /heartCountBadgeHtml\(song, 'is-card'\)/);
  assert.match(wallSource, /ensureHeartCountForSongs\(/);
});

test('徽标样式留出数字宽度，卡片徽标挂在按钮外不跟着 3D 倾斜', () => {
  const rowRule = /\.search-result-actions>button\.search-heart-btn\s*\{([^}]*)\}/.exec(indexCss);
  assert.ok(rowRule, '搜索结果行需要放宽固定宽度');
  assert.match(rowRule[1], /width:\s*auto/);
  assert.match(rowRule[1], /min-width:\s*28px/);

  const cardRule = /\.sw-card-action \.heart-count-mini\.is-card\s*\{([^}]*)\}/.exec(wallCss);
  assert.ok(cardRule, '卡片 30px 圆钮放不下数字，要有角标规则');
  assert.match(cardRule[1], /position:\s*absolute/);
  assert.match(cardRule[1], /pointer-events:\s*none/, '角标不能抢按钮的点击');
});

// 详情胶囊与底栏共用 applyDetailRedCount：胶囊必须同曲才写，底栏格式必须统一。
function detailSandbox(overrides) {
  const nodes = {};
  // 当前播放的歌用可变引用：被求值的源码里也有 currentCoverSong，
  // 直接赋值会被 vm 内的同名函数遮蔽掉。
  const state = { active: null };
  const sandbox = Object.assign({
    heartCountCache: Object.create(null),
    heartCountSeq: 0,
    HEART_COUNT_CACHE_TTL_MS: 5 * 60 * 1000,
    detailCommentSong: null,
    document: {
      getElementById: id => (id in nodes ? nodes[id] : null),
      querySelectorAll: () => [],
    },
    currentCoverSong: () => state.active,
    songAccountProvider: song => (song && song.provider) || 'netease',
    Date,
  }, overrides || {});
  sandbox.setActive = song => { state.active = song; };
  vm.runInNewContext(
    `${namedFunctionSource(detailSource, 'formatRedCountDisplay')}
${namedFunctionSource(detailSource, 'readCachedHeartCount')}
${namedFunctionSource(detailSource, 'writeCachedHeartCount')}
${namedFunctionSource(detailSource, 'fillHeartCountBadges')}
${namedFunctionSource(detailSource, 'applyDetailRedCount')}\napplyDetailRedCount`,
    sandbox
  );
  sandbox.nodes = nodes;
  return sandbox;
}

function badge(id) {
  return { id, textContent: '', title: '', hidden: true };
}

test('详情弹窗开在 A 歌时，给 B 歌回填不会覆盖 A 歌的胶囊', () => {
  const sandbox = detailSandbox();
  sandbox.nodes['detail-red-count'] = badge('detail-red-count');
  sandbox.nodes['heart-count'] = badge('heart-count');
  sandbox.detailCommentSong = { id: '111', provider: 'netease' };

  sandbox.applyDetailRedCount({ id: '111', provider: 'netease' }, 100, '');
  assert.equal(sandbox.nodes['detail-red-count'].textContent, '红心数 100');

  // 给队列里另一首歌点红心，回填不能串到已打开的胶囊上。
  sandbox.applyDetailRedCount({ id: '222', provider: 'netease' }, 99999, '');
  assert.equal(sandbox.nodes['detail-red-count'].textContent, '红心数 100', '别的歌的红心数不能写进当前弹窗');
});

test('底栏只认当前播放的歌，且数字一律按 count 缩写', () => {
  const sandbox = detailSandbox();
  const chip = badge('detail-red-count');
  const bottom = badge('heart-count');
  sandbox.nodes['detail-red-count'] = chip;
  sandbox.nodes['heart-count'] = bottom;
  sandbox.detailCommentSong = { id: '111', provider: 'netease' };
  sandbox.setActive({ id: '111', provider: 'netease' });

  sandbox.applyDetailRedCount({ id: '111', provider: 'netease' }, 408000, '40w+');
  assert.equal(chip.textContent, '红心数 40w+', '详情胶囊可以用上游原文');
  assert.equal(bottom.textContent, '41万', '底栏必须按 count 缩写，不能混用上游原文');
  assert.equal(bottom.hidden, false);

  // 非当前播放的歌不碰底栏。
  sandbox.applyDetailRedCount({ id: '222', provider: 'netease' }, 50000, '');
  assert.equal(bottom.textContent, '41万');
});

test('红心数掉到 0 时底栏隐藏，不显示 0', () => {
  const sandbox = detailSandbox();
  const bottom = badge('heart-count');
  sandbox.nodes['heart-count'] = bottom;
  sandbox.detailCommentSong = { id: '111', provider: 'netease' };
  sandbox.setActive({ id: '111', provider: 'netease' });

  sandbox.applyDetailRedCount({ id: '111', provider: 'netease' }, 0, '');
  assert.equal(bottom.hidden, true, '0 个红心要隐藏徽标');
  assert.equal(bottom.textContent, '');
  // 与搜索徽标一致：0 仍写入缓存，切歌时不会再打一次请求。
  assert.equal(sandbox.heartCountCache['netease:111'].count, 0);
});

test('切歌时读到 0 的缓存也隐藏底栏徽标', () => {
  const sandbox = detailSandbox();
  const bottom = badge('heart-count');
  sandbox.nodes['heart-count'] = bottom;
  sandbox.heartCountCache['netease:111'] = { count: 0, at: Date.now() };
  sandbox.setActive({ id: '111', provider: 'netease' });

  vm.runInNewContext(
    `${namedFunctionSource(detailSource, 'formatRedCountDisplay')}
${namedFunctionSource(detailSource, 'readCachedHeartCount')}
${namedFunctionSource(detailSource, 'updateHeartCountForSong')}\nupdateHeartCountForSong`,
    sandbox
  );
  sandbox.updateHeartCountForSong({ id: '111', provider: 'netease' });
  assert.equal(bottom.hidden, true, '缓存命中 0 时不能显示 0');
});
