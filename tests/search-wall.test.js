'use strict';

// 全屏搜索页的静态契约。照 music-library-wall.test.js 的路子：
// 只断言能可靠静态判定的部分（DOM id、loader 注册、CSS 兜底、关键调用形状），
// 不做运行时渲染断言 —— 那需要整个 three.js 舞台，代价远超收益。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const html = read('public/index.html');
const css = read('public/css/search-wall.css');
const indexCss = read('public/css/index.css');
const loader = read('public/js/index-loader.js');
const wall = read('public/js/modules/05-playback/07a-search-wall.js');
const search = read('public/js/modules/05-playback/07-search.js');

test('全屏搜索页的骨架元素都在主文档里', () => {
  assert.match(html, /css\/search-wall\.css/, '必须引入 search-wall.css');
  [
    'search-wall',
    'search-wall-back',
    'search-wall-search',
    'search-wall-input',
    'search-wall-clear',
    'search-wall-tabs',
    'search-wall-sources',
    'search-wall-content',
    'search-wall-body',
    'search-wall-footer',
    'search-wall-to-top',
  ].forEach(id => assert.match(html, new RegExp(`id="${id}"`), `${id} 必须存在于主文档`));
});

test('模块已注册进同步 loader，且排在数据层之后', () => {
  const base = loader.indexOf('js/modules/05-playback/07-search.js');
  const next = loader.indexOf('js/modules/05-playback/07a-search-wall.js');
  assert.ok(base >= 0, '数据层 07-search.js 应在 loader 里');
  assert.ok(next > base, '全屏页必须排在 07-search.js 之后，否则拿不到数据层函数');
  // loader 保持同步：改成异步会静默废掉两处无保护的 DOMContentLoaded 监听。
  assert.doesNotMatch(loader, /await\s+import\(/, 'loader 必须保持同步加载');
});

test('开关与渲染的入口函数齐备', () => {
  assert.match(wall, /function openSearchWall\(/);
  assert.match(wall, /function closeSearchWall\(/);
  assert.match(wall, /function isSearchWallOpen\(/);
  assert.match(wall, /function renderSearchWall\(/);
  assert.match(wall, /function searchWallVirtualWindow\(/);
  assert.match(wall, /SEARCH_WALL_OVERSCAN_ROWS/);
});

test('歌曲结果必须写回全局 playlist —— 6 个 index 型 action 全靠它', () => {
  // playSearchResult / queueSearchResult / toggleLikeSearchResult /
  // collectSearchResult / downloadSongFromSearch / openSearchResultArtist
  // 都是按下标读 playlist。全屏页不写它，这些动作就会打到上一批结果上。
  assert.match(wall, /playlist = songs/, '首页结果要写入 playlist');
  assert.match(wall, /playlist = merged/, '加载更多后也要同步 playlist');
  assert.match(wall, /playSearchResult\(index\)/, '播放应复用既有 action');
  assert.match(wall, /queueSearchResult\(index\)/);
  assert.match(wall, /toggleLikeSearchResult\(index\)/);
  assert.match(wall, /collectSearchResult\(index\)/);
});

test('弹窗用项目统一的 modal 体系，不自造显隐过渡', () => {
  assert.match(html, /id="search-wall" class="modal-mask"/, '要挂在标准遮罩上');
  assert.match(html, /class="modal sw-modal"/, '要有 .modal 面板，openGsapModal 靠它做位移动效');
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(wall, /openGsapModal\(wall\)/);
  assert.match(wall, /closeGsapModal\(wall\)/);
  // 弹窗有边界：必须限定宽高，否则又变回铺满全屏。
  assert.match(css, /\.sw-modal\s*\{[\s\S]{0,300}max-height:/);
  // gsap 缺失时要能退回类切换，不能整个打不开。
  assert.match(wall, /wall\.classList\.add\('show'\)/);
  assert.match(wall, /wall\.classList\.remove\('show'\)/);
});

test('样式表顺序：search-wall.css 必须在 index.css 之后', () => {
  // .modal 基础规则写了 max-width:380px / padding:32px / text-align:center，
  // .sw-modal 靠同优先级 + 后加载才能盖过去。一旦调换引用顺序，
  // 弹窗会静默缩成 380px 宽的居中小框，不报任何错。
  const base = html.indexOf('css/index.css');
  const own = html.indexOf('css/search-wall.css');
  assert.ok(base >= 0 && own > base, 'search-wall.css 必须排在 index.css 之后');
  assert.match(indexCss, /^\.modal\s*\{[\s\S]*?max-width:\s*380px/m, '前提：.modal 确实限宽 380px');
  const own_ = /^\.sw-modal\s*\{([^}]*)\}/m.exec(css);
  assert.ok(own_, '.sw-modal 应有基础规则');
  assert.match(own_[1], /max-width:/, '必须显式覆盖 max-width');
  assert.match(own_[1], /padding:\s*0/, '必须清掉 .modal 的 32px 内边距');
  assert.match(own_[1], /text-align:\s*left/, '必须覆盖 .modal 的居中对齐');
});

test('遮罩层级低于其它弹窗，从搜索里打开详情能盖在上面', () => {
  const maskZ = Number(/#search-wall\s*\{[\s\S]*?z-index:\s*(\d+)/.exec(css)[1]);
  const baseZ = Number(/^\.modal-mask\s*\{[\s\S]*?z-index:\s*(\d+)/m.exec(indexCss)[1]);
  assert.ok(maskZ < baseZ,
    `搜索遮罩(${maskZ}) 应低于普通弹窗(${baseZ})，否则歌曲详情会被搜索弹窗压住`);
  // 桌面标题栏必须仍可点（窗口按钮在里面）。
  const titleZ = Number(/body\.desktop-shell #desktop-titlebar\s*\{[\s\S]*?z-index:\s*(\d+)/.exec(indexCss)[1]);
  assert.ok(titleZ > maskZ, `标题栏(${titleZ}) 必须高于遮罩(${maskZ})`);
  assert.match(css, /body\.desktop-shell #search-wall\s*\{[^}]*top:\s*44px/,
    '桌面模式遮罩要让开 44px 标题栏');
});

test('打开弹窗前先关掉音乐库墙，两个大面板不叠加', () => {
  assert.match(wall, /isMusicLibraryWallOpen\(\)/);
  assert.match(wall, /closeMusicLibraryWall\(/);
});

test('点遮罩空白处关闭，且只认遮罩自身', () => {
  // 不判 event.target === mask 的话，点弹窗内部任何空白都会误关。
  assert.match(wall, /event\.target !== searchWallMask/);
  assert.match(wall, /reason: 'backdrop'/);
});

test('播放条浮在遮罩之上 —— 边搜边控播是常态', () => {
  const bar = /body\.search-wall-active #bottom-bar\s*\{([^}]*)\}/.exec(css);
  assert.ok(bar, '应有 bottom-bar 提层规则');
  const barZ = Number(/z-index:\s*(\d+)/.exec(bar[1])[1]);
  const maskZ = Number(/#search-wall\s*\{[\s\S]*?z-index:\s*(\d+)/.exec(css)[1]);
  assert.ok(barZ > maskZ, `播放条 z-index(${barZ}) 必须高于遮罩(${maskZ})`);
  // 内容区底部留白要够，否则最后一排卡片被播放条压住。
  assert.match(css, /\.sw-content\s*\{[\s\S]{0,400}padding:[^;]*clamp\(96px/);
});

// 只取顶层（未缩进）的基础规则。媒体查询里的覆盖规则有缩进，
// 用 `^\.cls` 配 m 标志就能把它们排除掉。
function baseRule(cssText, className) {
  const match = new RegExp(`^\\.${className}\\s*\\{([^}]*)\\}`, 'm').exec(cssText);
  return match ? match[1] : null;
}

test('topbar 走正常流，子元素不会溢出到左上角', () => {
  // 之前 topbar 是 height:0 的 absolute 层，子元素只能各自 absolute 定位；
  // 音源 chip 漏了定位就飘到左上角，被搜索框压住 —— 截图里就是这个现象。
  const topbar = baseRule(css, 'sw-topbar');
  assert.ok(topbar, '应能取到 .sw-topbar 基础规则');
  assert.doesNotMatch(topbar, /position:\s*absolute/, 'topbar 不得再用 absolute');
  assert.doesNotMatch(topbar, /height:\s*0/, 'topbar 不得再是零高度');
  assert.match(topbar, /display:\s*flex/);

  // chip 与搜索框分在 lead/trail 两组里，靠 flex 排布而非绝对定位。
  ['sw-topbar-lead', 'sw-topbar-trail'].forEach(cls => {
    assert.match(html, new RegExp(`class="${cls}"`), `${cls} 应存在于 HTML`);
    const rule = baseRule(css, cls);
    assert.ok(rule, `.${cls} 应有基础样式`);
    assert.doesNotMatch(rule, /position:\s*absolute/);
  });
  ['sw-sources', 'sw-search', 'sw-tabs'].forEach(cls => {
    const rule = baseRule(css, cls);
    assert.ok(rule, `.${cls} 应有基础样式`);
    assert.doesNotMatch(rule, /position:\s*absolute/, `.${cls} 不该再绝对定位`);
  });

  // 回到顶部按钮是唯一的 absolute，必须有 position 锚点，否则会跑到 body 上。
  assert.match(baseRule(css, 'sw-to-top'), /position:\s*absolute/);
  assert.match(baseRule(css, 'sw-shell'), /position:\s*relative/,
    '.sw-to-top 用 absolute，.sw-shell 必须提供定位锚点');
});

test('打开全屏页时顶部胶囊必须让位，避免两个输入框抢焦点', () => {
  assert.match(wall, /setPeek\(searchWallElement\('search-area'\), false, 'search'\)/);
  assert.match(css, /body\.search-wall-active #search-area/);
});

test('音乐搜索结果一律走弹窗，但下拉仍保留搜索历史', () => {
  assert.match(search, /openSearchWall\(q, \{ mode: searchMode \}\)/, '回车应开弹窗');

  // 空词时必须仍然渲染历史 —— 这是下拉留下来的唯一理由（Podcast 结果除外）
  const input = /\$input\.addEventListener\('input'[\s\S]*?\n\}\);/.exec(search);
  assert.ok(input, '应能取到 input 处理器');
  const emptyBranch = /if \(!q\) \{([\s\S]*?)\n  \}/.exec(input[0]);
  assert.ok(emptyBranch, 'input 处理器应有空词分支');
  assert.match(emptyBranch[1], /renderSearchHistory\(\)/, '空词要显示搜索历史');

  // 有词时不在下拉里预览歌曲列表，交给弹窗
  assert.match(input[0], /isMusicSearchMode\(searchMode\)[\s\S]{0,260}return;/,
    '音乐模式有词时提前 return，不渲染下拉结果');

  // 聚焦空输入框也要出历史
  const focus = /\$input\.addEventListener\('focus'[\s\S]*?\n\}\);/.exec(search)[0];
  assert.match(focus, /renderSearchHistory\(\)/, '聚焦空输入框要出历史');

  // 历史 chip 点击也进弹窗
  const replay = /function runSearchHistory\(q\)\s*\{([\s\S]*?)\n\}/.exec(search);
  assert.ok(replay, '应能取到 runSearchHistory');
  assert.match(replay[1], /openSearchWall\(q/, '点历史应开弹窗');
  assert.doesNotMatch(replay[1], /searchMode\s*=/, '既有测试要求它不改 searchMode');

  // Podcast 没有弹窗形态，结果仍走下拉
  assert.match(search, /else if \(!renderSearchHistory\(\)\) loadPodcastHot\(\)/, '既有测试依赖这行形状');

  // 死代码要清掉，别留个点不到的入口
  assert.doesNotMatch(search, /searchOpenWallEntryHtml/, '「查看全部」入口应已移除');
  assert.doesNotMatch(search, /data-search-open-wall/);
  assert.doesNotMatch(indexCss, /\.search-open-wall\b/, 'CSS 里也不该留死规则');
});

test('搜索历史只有下拉一份，弹窗里不重复实现', () => {
  // 历史的读写与渲染都在 07-search.js，别在弹窗里再造一套。
  assert.match(search, /function renderSearchHistory\(/);
  assert.match(search, /function readSearchHistory\(/);
  assert.match(search, /function writeSearchHistory\(/);
  assert.match(indexCss, /\.search-history-chip\s*\{/, '下拉的历史 chip 样式仍在');
  assert.doesNotMatch(wall, /searchWallHistoryHtml|data-sw-history|data-sw-clear-history/,
    '弹窗里不该有第二份历史实现');
  assert.doesNotMatch(css, /\.sw-history/, '弹窗也不该有历史样式');
});

test('切音源时弹窗已开就不要重复发请求', () => {
  // setSearchMode 会被弹窗的音源 chip 调到。它自己随后会重跑搜索，
  // 若 setSearchMode 也发一次，同一个词会打两遍。
  const setMode = /function setSearchMode\(mode\)\s*\{([\s\S]*?)\n\}/.exec(search);
  assert.ok(setMode, '应能取到 setSearchMode');
  assert.match(setMode[1], /isSearchWallOpen\(\)[\s\S]{0,40}return/, '弹窗已开就直接 return');
  assert.match(setMode[1], /openSearchWall\(q/, '弹窗未开则由它拉起弹窗');
});

test('播放全部已移除，相关代码不留残骸', () => {
  assert.doesNotMatch(html, /search-wall-play-all/, 'HTML 里应已移除');
  assert.doesNotMatch(wall, /searchWallPlayAll|search-wall-play-all/, 'JS 里应已移除');
  assert.doesNotMatch(css, /\.sw-play-all\b/, 'CSS 里应已移除');
});

test('数据层仍留在 07-search.js —— 全屏页只做渲染', () => {
  // 这几个是分页与排序的真实实现，搬走会同时踩坏胶囊和既有测试。
  assert.match(search, /function fetchMusicSearchResults\(/);
  assert.match(search, /function mergeSongSearchResults\(/);
  assert.match(search, /function scoreSongSearchResult\(/);
  assert.match(search, /new IntersectionObserver/);
  // 全屏页应当复用而不是复制这些实现。
  assert.match(wall, /fetchMusicSearchResults\(query, searchWallState\.mode\)/);
  assert.doesNotMatch(wall, /function fetchMusicSearchResults\(/, '不得复制数据层实现');
  assert.doesNotMatch(wall, /function scoreSongSearchResult\(/, '不得复制打分实现');
});

test('会被切 hidden 的元素都带 !important 兜底', () => {
  // 本项目没有全局 [hidden]{display:none}。设了 display 又切 hidden 的类
  // 若无兜底，表现是内容为空但仍占位的框，且不报错。
  assert.doesNotMatch(indexCss, /(^|\})\s*\[hidden\]\s*\{[^}]*display\s*:\s*none/,
    '若已有全局兜底，本条可删');
  ['sw-search', 'sw-search-clear', 'sw-to-top', 'sw-tabs', 'sw-sources'].forEach(cls => {
    const own = new RegExp(`(^|\\})\\s*\\.${cls}\\s*\\{([^}]*)\\}`).exec(css);
    if (!own || !/display\s*:/.test(own[2])) return;
    const guard = new RegExp(`\\.${cls}\\[hidden\\][^{]*\\{([^}]*)\\}`).exec(css);
    assert.ok(guard, `.${cls} 设了 display，必须有 .${cls}[hidden] 兜底`);
    assert.match(guard[1], /display\s*:\s*none\s*!important/,
      `.${cls}[hidden] 兜底要带 !important，否则媒体查询会盖回来`);
  });
});

test('HTML 类名与 CSS 定义完全对齐', () => {
  const section = /<div id="search-wall"[\s\S]*?\n    <\/div>/.exec(html);
  assert.ok(section, '应能取到 #search-wall 整段');
  const used = new Set();
  const re = /class="([^"]+)"/g;
  let match;
  while ((match = re.exec(section[0])) !== null) {
    match[1].split(/\s+/).forEach(cls => { if (cls.startsWith('sw-')) used.add(cls); });
  }
  assert.ok(used.size >= 10, '应至少用到 10 个 sw- 类');
  used.forEach(cls => {
    assert.match(css, new RegExp(`\\.${cls}[\\s,{:\\[]`), `.${cls} 在 HTML 里用了但 CSS 没定义`);
  });
});

test('状态只由 aria 属性驱动，不留 active 类这种第二真相', () => {
  const section = /<div id="search-wall"[\s\S]*?\n    <\/div>/.exec(html)[0];
  assert.doesNotMatch(section, /class="sw-tab active"/, 'tab 状态应只用 aria-selected');
  assert.doesNotMatch(section, /class="sw-source-chip active"/, 'chip 状态应只用 aria-pressed');
  assert.match(css, /\.sw-tab\[aria-selected="true"\]/);
  assert.match(css, /\.sw-source-chip\[aria-pressed="true"\]/);
  assert.match(wall, /setAttribute\('aria-pressed'/);
});

test('接管 playlist 时必须作废胶囊的渲染状态，否则下标错位', () => {
  // 胶囊的 appendNextSearchResults 用 searchMusicRenderState.songs 取歌、
  // 却把下标写进 onclick。全屏页改了 playlist 之后，那个下标指向的是全屏页的
  // 结果集 —— 若它的 IntersectionObserver 仍能触发，点谁播谁全错位。
  assert.match(wall, /function searchWallReleasePillResults\(/);
  assert.match(wall, /resetSearchMusicRenderState\(\)/, '要清掉胶囊的渲染状态并断开 observer');
  assert.match(wall, /searchLastResultQuery = ''/, '清 key 才能让胶囊的守卫 bail');

  // 三个写 playlist 的地方都要跟一次作废
  const releases = (wall.match(/searchWallReleasePillResults\(\)/g) || []).length;
  assert.ok(releases >= 4, `至少要在 open/首查/加载更多/切音源 四处调用，实际 ${releases} 次`);

  // 胶囊那侧的守卫必须还在，否则清 key 也拦不住
  assert.match(search, /expectedKey\s*!==\s*searchMusicRenderState\.key/);
  assert.match(search, /expectedKey\s*!==\s*searchLastResultQuery/);
  // resetSearchMusicRenderState 不能顺手清 playlist，否则会把全屏页的结果一起清掉
  const resetSource = /function resetSearchMusicRenderState\(\)\s*\{([\s\S]*?)\n\}/.exec(search);
  assert.ok(resetSource, '应能取到 resetSearchMusicRenderState 源码');
  assert.doesNotMatch(resetSource[1], /playlist\s*=/,
    'resetSearchMusicRenderState 不得改 playlist，全屏页依赖它保留结果');
});

test('弹窗切音源不得走 setSearchMode —— 它会清掉弹窗正在用的 playlist', () => {
  const setModeSource = /function setSearchMode\(mode\)\s*\{([\s\S]*?)\n\}/.exec(search);
  assert.ok(setModeSource, '应能取到 setSearchMode 源码');
  // 前提：它确实有这两个对弹窗有害的副作用
  assert.match(setModeSource[1], /clearSearchResults\(\)/, '前提：它会清结果（含 playlist）');
  assert.match(setModeSource[1], /setPeek\(searchArea, true, 'search'\)/, '前提：它会弹出胶囊');

  // 弹窗只用无副作用的同步函数
  assert.match(search, /function syncSearchModeOnly\(/, '应提供只同步模式的版本');
  const syncOnly = /function syncSearchModeOnly\(mode\)\s*\{([\s\S]*?)\n\}/.exec(search)[1];
  assert.doesNotMatch(syncOnly, /clearSearchResults|setPeek|doSearch|renderSearchHistory/,
    'syncSearchModeOnly 必须没有副作用');
  assert.match(syncOnly, /updateSearchModeTabs\(\)/, '但仍要同步胶囊的 tab 与占位符');

  const wallSetMode = /function searchWallSetMode\(mode\)\s*\{([\s\S]*?)\n\}/.exec(wall);
  assert.ok(wallSetMode, '应能取到 searchWallSetMode 源码');
  assert.match(wallSetMode[1], /syncSearchModeOnly\(mode\)/, '弹窗要用无副作用版本');
  assert.doesNotMatch(wallSetMode[1], /setSearchMode\(/, '弹窗不得调用破坏性的 setSearchMode');

  // 万一别处在弹窗开着时调了 setSearchMode，让开动作必须在破坏之前。
  // 注释里也会提到 clearSearchResults()，比位置前必须先剥掉注释。
  const bare = setModeSource[1].replace(/\/\/[^\n]*/g, '');
  const guardAt = bare.indexOf('isSearchWallOpen()');
  const clearAt = bare.indexOf('clearSearchResults()');
  assert.ok(guardAt >= 0, 'setSearchMode 要有弹窗守卫');
  assert.ok(clearAt >= 0, '前提：确实有 clearSearchResults() 调用');
  assert.ok(guardAt < clearAt, '守卫必须排在 clearSearchResults() 之前，否则 playlist 已经被清了');
});

test('空词切回音乐模式仍要显示搜索历史', () => {
  // 之前把这个 else 分支删掉过：从 Podcast 切回 All 且输入框为空时历史不再出现。
  const setModeSource = /function setSearchMode\(mode\)\s*\{([\s\S]*?)\n\}/.exec(search)[1];
  assert.match(setModeSource, /\} else \{\n\s*renderSearchHistory\(\);/,
    '音乐模式空词分支必须渲染历史');
});

test('Escape 分层处理：先清词，空词才关页', () => {
  assert.match(wall, /event\.target\.id === 'search-wall-input'/,
    '文档级 Escape 要跳过输入框，否则会和输入框自己的处理重复触发');
  assert.match(wall, /closeSearchWall\(\{ reason: 'escape' \}\)/);
});

// ---------- 歌手搜索 / 歌手页 ----------
const server = read('server.js');

test('歌手搜索接口用 cloudsearch type=100，并映射成与歌手详情一致的形状', () => {
  assert.match(server, /pn === '\/api\/search\/artists'/);
  assert.match(server, /cloudsearch\(\{ keywords: kw, type: 100/, '歌手搜索是 type=100');
  assert.match(server, /function mapArtistRecord\(/);
  // 前端一套渲染要同时吃「搜索结果里的歌手卡」和「歌手页 hero」，字段必须对齐。
  ['id', 'name', 'avatar', 'musicSize', 'albumSize'].forEach(field => {
    assert.match(server, new RegExp(`${field}:`), `mapArtistRecord 应含 ${field}`);
  });
  // artist_album 之前没 import，是这次新加的
  assert.match(server, /^\s+artist_album,$/m, 'artist_album 必须在 require 列表里');
  assert.match(server, /pn === '\/api\/artist\/albums'/);
  assert.match(server, /artist_album\(\{ id, limit, offset/);
  assert.match(server, /function mapAlbumRecord\(/);
});

test('歌手只有小云有接口，其它音源要如实标明而不是静默空白', () => {
  assert.match(wall, /function searchWallArtistsAvailable\(/);
  // 小狗只有 song_search_v2；小Q 要靠写死为 0 的 multi_zhida。都拿不到歌手。
  assert.match(wall, /mode === 'song' \|\| mode === 'netease'/);
  assert.match(wall, /没有歌手搜索接口/, '筛到无歌手能力的音源时要给出说明');
  assert.match(wall, /searchWallState\.artistNotice/);
  assert.match(css, /\.sw-section-note\s*\{/, '说明文字要有样式');
});

test('歌手请求与歌曲并行，不互相阻塞', () => {
  // 歌手区晚到就单独重绘一次，不能让歌曲结果等它。
  assert.match(wall, /searchWallFetchArtists\(query, token\)/);
  const fetchSource = /function searchWallFetchArtists\([\s\S]*?\n\}/.exec(wall)[0];
  assert.doesNotMatch(fetchSource, /await/, '歌手请求不该 await，否则会拖住歌曲结果');
  assert.match(fetchSource, /token !== searchWallState\.token/, '要有陈旧响应守卫');
  // 歌手详情与专辑各自成败
  assert.match(wall, /Promise\.allSettled\(\[/);
});

test('没歌不等于没歌手 —— 空结果分支也要渲染歌手区', () => {
  // 搜歌手名时常常是歌手区有货、歌曲区空。若空分支不画歌手区，用户会以为没搜到。
  const render = /function renderSearchWall\([\s\S]*?\n\}/.exec(wall)[0];
  const emptyBranch = /if \(!songs\.length\) \{([\s\S]*?)\n  \}/.exec(render);
  assert.ok(emptyBranch, '应能取到空结果分支');
  assert.match(emptyBranch[1], /searchWallArtistSectionHtml\(\)/, '空分支必须也画歌手区');
  // 缓存 key 要含歌手状态，否则歌手晚到时不会重绘
  assert.match(emptyBranch[1], /searchWallState\.artists\.length/);
});

test('歌手区插在歌曲网格之上后，虚拟窗口必须减掉网格偏移', () => {
  // 行窗口原本假设网格从内容区顶部开始。歌手区插进来后网格起点下移，
  // 直接拿 scrollTop 算行会整体偏移，滚动时取错卡片。
  assert.match(wall, /function searchWallGridOffsetTop\(/);
  const virtual = /function searchWallVirtualWindow\([\s\S]*?\n\}/.exec(wall)[0];
  assert.match(virtual, /searchWallGridOffsetTop\(\)/, '必须扣掉网格偏移');
  assert.match(virtual, /Math\.max\(0,/, '扣完要夹到非负');
});

test('歌手页滚动不得触发结果页分页，也不得覆盖结果页滚动位置', () => {
  // 两个真 bug：
  // 1) 无条件写 searchWallState.scrollTop → 在歌手页滚动会毁掉返回结果页的还原
  // 2) 滚到底触发 searchWallLoadMore → 它 playlist = merged，
  //    把 playlist 从歌手的歌抢走，歌手页卡片下标立刻错位
  const scroll = /searchWallContent\.addEventListener\('scroll'[\s\S]*?\n\}, \{ passive: true \}\);/.exec(wall);
  assert.ok(scroll, '应能取到 scroll 处理器');
  const bare = scroll[0].replace(/\/\/[^\n]*/g, '');
  const guardAt = bare.indexOf("searchWallState.view === 'artist'");
  const saveAt = bare.indexOf('searchWallState.scrollTop =');
  const loadAt = bare.indexOf('searchWallLoadMore()');
  assert.ok(guardAt >= 0, 'scroll 处理器要有 view 守卫');
  assert.ok(saveAt > guardAt, '记滚动位置必须排在守卫之后');
  assert.ok(loadAt > guardAt, '加载更多必须排在守卫之后');

  // 函数自身也要守，别只靠调用点
  const loadMore = /async function searchWallLoadMore\(\)\s*\{([\s\S]*?)\n\}/.exec(wall);
  assert.ok(loadMore, '应能取到 searchWallLoadMore');
  assert.match(loadMore[1], /view !== 'results'[\s\S]{0,40}return false/,
    'searchWallLoadMore 自己也要挡住非结果页');
});

test('歌手页点重试不得覆盖结果页的滚动位置', () => {
  // 重试会再走一遍 searchWallOpenArtist，此时 scrollTop 是歌手页的。
  const openAt = wall.indexOf('function searchWallOpenArtist(');
  const nextAt = wall.indexOf('\nfunction ', openAt + 1);
  const openArtist = wall.slice(openAt, nextAt < 0 ? wall.length : nextAt);
  assert.match(openArtist, /view !== 'artist'[\s\S]{0,60}scrollTop = content\.scrollTop/,
    '只在从结果页进来时才记结果页的滚动位置');
  // 失败态要有重试入口（歌手页 footer 是空的，没有别处能重来）
  assert.match(wall, /data-sw-artist-retry/);
  assert.match(css, /\.sw-retry\s*\{/, '重试按钮要有样式');
});

test('两个视图切换时 playlist 必须跟着换，否则下标指向另一批歌', () => {
  // 歌手页的卡片下标是相对 searchWallArtistState.songs 的；
  // 那 6 个 action 读的是 playlist。两者不换就会点谁播谁全错。
  assert.match(wall, /function searchWallActiveSongs\(/);
  assert.match(wall, /searchWallState\.view === 'artist' \? searchWallArtistState\.songs : searchWallState\.songs/);
  // 取到下一个顶层 function 之前的整段，避免依赖具体的收尾缩进形状
  const openAt = wall.indexOf('function searchWallOpenArtist(');
  assert.ok(openAt >= 0, '应能取到 searchWallOpenArtist');
  const nextAt = wall.indexOf('\nfunction ', openAt + 1);
  const openArtist = wall.slice(openAt, nextAt < 0 ? wall.length : nextAt);
  assert.match(openArtist, /playlist = searchWallArtistState\.songs/, '进歌手页要把 playlist 换成歌手的歌');
  assert.match(openArtist, /searchWallReleasePillResults\(\)/, '换 playlist 后要作废胶囊状态');
  const back = /function searchWallBackToResults\([\s\S]*?\n\}/.exec(wall)[0];
  assert.match(back, /playlist = searchWallState\.songs/, '回结果页要把 playlist 换回歌曲结果');
});

test('左上返回按钮：两种语义共用箭头，Escape 也分层', () => {
  assert.match(wall, /function searchWallSyncBackButton\(/);
  assert.match(wall, /classList\.toggle\('is-back'/);
  assert.match(css, /^\.sw-back\s*\{/m, '返回按钮要有样式');
  // 按钮在 lead 组（左侧），不在 trail 组
  const lead = /<div class="sw-topbar-lead">([\s\S]*?)<\/div>\s*<div class="sw-topbar-trail">/.exec(html);
  assert.ok(lead, '应能取到 topbar 两组');
  assert.match(lead[1], /id="search-wall-back"/, '返回按钮必须在左侧 lead 组里');
  // 图标不随状态换字形，只换标签，避免按钮跳字
  const sync = /function searchWallSyncBackButton\([\s\S]*?\n\}/.exec(wall)[0];
  assert.doesNotMatch(sync, /innerHTML/, '不该重写 innerHTML 换字形');
  assert.match(sync, /aria-label/);
  // 返回按钮与两处 Escape 都要先尝试退回结果页
  const backCalls = (wall.match(/searchWallBackToResults\(\)/g) || []).length;
  assert.ok(backCalls >= 4, `返回按钮 + 文档级 Escape + 输入框 Escape 都要调用，实际 ${backCalls} 次`);
  // 关弹窗要复位 view，否则下次打开停在旧歌手页
  const close = /function closeSearchWall\([\s\S]*?\n\}/.exec(wall)[0];
  assert.match(close, /searchWallState\.view = 'results'/);
});

test('歌手卡是纯圆的，圆角方块背板必须收掉', () => {
  assert.match(wall, /class="sw-card is-artist"/);
  assert.match(css, /\.sw-card\.is-artist \.sw-art[\s\S]{0,120}border-radius:\s*50%/);
  assert.match(css, /\.sw-artist-hero\s*\{/, '歌手页 hero');
  assert.match(css, /\.sw-artist-avatar\s*\{[\s\S]{0,400}border-radius:\s*50%/);

  // .sw-card::before 是唱片架背板，inset 故意往右下偏，在圆头像后面会露出圆角方块。
  const backdrop = /\.sw-card::before\s*\{([^}]*)\}/.exec(css);
  assert.ok(backdrop, '前提：.sw-card::before 确实存在且有偏移');
  assert.match(backdrop[1], /inset:[^;]*-\d/, '前提：inset 里确实有负值偏移');
  assert.match(css, /\.sw-card\.is-artist::before\s*\{[^}]*display:\s*none/,
    '歌手卡必须收掉背板，否则圆头像后面露出方块');
  // 背板没了，立体上浮也没意义
  assert.match(css, /\.sw-card\.is-artist:hover[\s\S]{0,80}transform:\s*scale/);
});

test('歌手横排的滚动条要收掉默认箭头按钮', () => {
  assert.match(css, /\.sw-grid\.is-artist-row\s*\{/, '歌手横排一行');
  // 默认横向滚动条两端带箭头按钮、轨道浅色，在深色弹窗里很刺眼
  assert.match(css, /\.sw-grid\.is-artist-row::-webkit-scrollbar-button[\s\S]{0,140}display:\s*none/,
    '必须收掉两端箭头按钮');
  assert.match(css, /\.sw-grid\.is-artist-row::-webkit-scrollbar-track\s*\{/, '轨道要自己上色');
  assert.match(css, /\.sw-grid\.is-artist-row::-webkit-scrollbar-thumb\s*\{/);
  assert.match(css, /scrollbar-color:/, 'Firefox 也要覆盖');
  // overflow-y 是 hidden，悬停放大得有上下余量否则被裁
  const row = /\.sw-grid\.is-artist-row\s*\{([^}]*)\}/.exec(css)[1];
  assert.match(row, /overflow-y:\s*hidden/);
  assert.match(row, /padding:/, '要有上下内边距给悬停放大留余量');
});

test('头像加载成功后必须收掉首字母兜底', () => {
  // 兜底 span 和 img 同时渲染。只靠 z-index 压不住透明底的头像（会透出字），
  // 而且 hero 里兜底排在 img 之后、自带 z-index:0，img 不标层级就直接被盖住。
  const imgHtml = /function searchWallImageHtml\([\s\S]*?\n\}/.exec(wall)[0];
  assert.match(imgHtml, /onload=[^>]*has-art/, '加载成功要主动标记 has-art');
  assert.match(imgHtml, /onerror=[^>]*is-missing/, '失败仍要露出兜底');
  assert.match(imgHtml, /classList\.remove\(\\?'has-art\\?'\)/,
    '失败时要撤掉 has-art，否则兜底被隐藏就成了空框');
  assert.match(css, /\.sw-art\.has-art \.sw-art-fallback[\s\S]{0,90}display:\s*none/);
  assert.match(css, /\.sw-artist-avatar\.has-art \.sw-art-fallback|\.sw-artist-avatar\.has-art/,
    'hero 的头像也要适用');

  // hero 的 img 必须显式标层级
  const heroImg = /\.sw-artist-avatar img\s*\{([^}]*)\}/.exec(css);
  assert.ok(heroImg, '应有 .sw-artist-avatar img 规则');
  assert.match(heroImg[1], /z-index:\s*[1-9]/, 'hero 的 img 要压在兜底之上');
  // 卡片网格那侧本来就是靠 z-index 压的，别退化
  const cardImg = /^\.sw-art img\s*\{([^}]*)\}/m.exec(css);
  assert.ok(cardImg && /z-index:\s*[1-9]/.test(cardImg[1]), '卡片里的 img 也要有层级');
});

test('顶栏不再有「搜索」标题字', () => {
  const section = /<div id="search-wall"[\s\S]*?\n    <\/div>/.exec(html)[0];
  assert.doesNotMatch(section, /class="sw-title"/, '标题元素应已移除');
  assert.doesNotMatch(css, /\.sw-title\b/, 'CSS 里也不该留死规则');
  // aria-labelledby 指向的元素没了，得改用 aria-label
  assert.doesNotMatch(section, /aria-labelledby="search-wall-title"/,
    '标题移除后 aria-labelledby 会指向空元素，应改用 aria-label');
  assert.match(section, /aria-label="搜索"/);
});

test('卡片图标复用播放队列那套，不自己画', () => {
  const queue = read('public/js/modules/06-lyrics/01-playlist-panel-shell.js');
  // 队列里「下一首播放」用的是汉字「下」，不是图标
  assert.match(queue, /class="queue-next"[^>]*title="下一首播放">下</, '前提：队列用汉字「下」');
  assert.match(wall, /data-sw-next="' \+ index \+ '"[\s\S]{0,120}>下</, '搜索卡片也要用「下」');
  assert.match(css, /\.sw-card-action\.is-next\s*\{/, '「下」字要有字号样式');

  // 收藏与红心直接调队列用的那两个函数，避免手画出两个几乎一样的列表+加号
  assert.match(wall, /playlistPlusIconSvg\(\)/);
  assert.match(wall, /heartIconSvg\(\)/);
  assert.match(queue, /playlistPlusIconSvg\(\)/, '前提：队列收藏用的就是它');

  // 关键：不能给 svg 统一写 fill:none，否则实心的 .heart-svg 会变透明
  const svgRule = /\.sw-card-action svg\s*\{([^}]*)\}/.exec(css);
  assert.ok(svgRule, '应有 .sw-card-action svg 规则');
  assert.doesNotMatch(svgRule[1], /fill:\s*none/,
    '.heart-svg 靠 fill:currentColor 上色，优先级压不过这条，写 fill:none 会让心形消失');
});

test('点专辑卡整张入队，保持专辑顺序', () => {
  assert.match(wall, /function searchWallOpenAlbum\(/);
  assert.match(wall, /\/api\/album\/detail\?id=/);
  // 沿用 playAlbumDetailSong 的约定：专辑要按原顺序放，不能被随机打散
  assert.match(wall, /skipShuffleOrder: true/);
});

test('搜索输入框的文字要垂直居中', () => {
  // input[type=search] 自带 -webkit-appearance: textfield，UA 内部布局会把文字顶偏。
  // 只重置 ::-webkit-search-cancel-button 那两个伪元素不够，得连输入框本身一起重置。
  const inputRule = /^\.sw-search input\s*\{([^}]*)\}/m.exec(css);
  assert.ok(inputRule, '应能取到 .sw-search input 规则');
  assert.match(inputRule[1], /-webkit-appearance:\s*none/, '必须重置输入框自身的 appearance');
  assert.match(inputRule[1], /appearance:\s*none/);
  // line-height 取容器高度，单行文本精确居中，不依赖 UA 基线处理
  const height = /height:\s*(\d+)px/.exec(inputRule[1]);
  const lineHeight = /font:[^;]*\/(\d+)px/.exec(inputRule[1]);
  assert.ok(height && lineHeight, 'height 与 line-height 都要显式写死');
  assert.equal(lineHeight[1], height[1], `line-height(${lineHeight[1]}) 应等于 height(${height[1]}) 才能居中`);
});

console.log('OK search-wall');
