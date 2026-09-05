'use strict';

// MV 剧场的静态契约。照 search-wall.test.js 的路子：只断言能可靠静态判定的
// 部分（DOM id、loader 注册、CSS 兜底、后端路由与关键调用形状），不做运行时
// 渲染断言 —— 那需要整个 three.js 舞台加一条真实 MV 流，代价远超收益。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const html = read('public/index.html');
const css = read('public/css/mv-theater.css');
const indexCss = read('public/css/index.css');
const loader = read('public/js/index-loader.js');
const theater = read('public/js/modules/05-playback/17-mv-theater.js');
const progress = read('public/js/modules/06-lyrics/04-progress-seek.js');
const controls = read('public/js/modules/05-playback/14-player-controls.js');
const audioGraph = read('public/js/modules/05-playback/08-audio-graph-controls.js');
const tuning = read('public/js/modules/05-playback/08a-playback-tuning-eq.js');
const startAudio = read('public/js/modules/05-playback/13-playback-start-audio.js');
const snapshot = read('public/js/modules/05-playback/09-queue-snapshot-autoplay.js');
const coverDepth = read('public/js/modules/02-visual/15-ripples-cover-depth.js');
const detail = read('public/js/modules/05-playback/06-track-detail-lyrics-actions.js');
const server = read('server.js');

// 卡片大小必须由可用高度反推。写死 px 上限的话宽屏上永远停在那个数：
// 3440×1440 上 min(74vw, 1180px) 只用掉 34% 宽度和 55% 高度。
test('卡片大小由可用高度反推，不写死 px 上限', () => {
  assert.match(css, /--mv-reserve:\s*\d+px/, '预留高度要是一个可调的变量');
  const frame = css.match(/\.mv-frame \{[\s\S]*?\n\}/)[0];
  assert.match(frame, /width: min\(100%, calc\(\(100vh - var\(--mv-reserve\)\) \* 16 \/ 9\)\)/,
    '宽度取「可用高度换算出的宽度」和容器宽度的较小值');
  assert.match(frame, /aspect-ratio: 16 \/ 9/, '高度由 16:9 派生');
  // 注释里会提到 max-height 说明为什么不用它，断言只看声明。
  assert.doesNotMatch(frame.replace(/\/\*[\s\S]*?\*\//g, ''), /max-height/,
    '不能再用 max-height 夹高度：宽度是显式值时那样会把框压成非 16:9，视频被 contain 加左右黑边');
  const stage = css.match(/\.mv-stage \{[\s\S]*?\n\}/)[0];
  assert.doesNotMatch(stage, /\d{3,}px/, '舞台宽度不能有写死的 px 上限');

  const fs = css.match(/\.mv-theater\.is-fullscreen \.mv-frame \{[\s\S]*?\n\}/)[0];
  assert.match(fs, /width: min\(100vw, calc\(100vh \* 16 \/ 9\)\)/,
    '铺满态也要按高度反推，否则 21:9 屏上会裁掉左右');
});

test('剧场骨架元素都在主文档里', () => {
  assert.match(html, /css\/mv-theater\.css/, '必须引入 mv-theater.css');
  [
    'mv-theater',
    'mv-video',
    'mv-title',
    'mv-sub',
    'mv-quality',
    'mv-quality-btn',
    'mv-quality-list',
    'mv-close',
    'mv-status',
    'mv-status-text',
    'mv-status-retry',
    'mv-btn',
  ].forEach(id => assert.match(html, new RegExp(`id="${id}"`), `${id} 必须存在于主文档`));
});

test('模块注册进同步 loader，且排在封面投递之后', () => {
  const base = loader.indexOf('js/modules/05-playback/16-cover-delivery.js');
  const mv = loader.indexOf('js/modules/05-playback/17-mv-theater.js');
  assert.ok(mv > 0, 'MV 模块必须注册进 loader');
  assert.ok(mv > base, 'MV 模块要排在封面投递之后');
});

test('MV 视频不能是 muted —— 自带音轨是这版的核心决定', () => {
  const tag = html.match(/<video id="mv-video"[^>]*>/);
  assert.ok(tag, '必须有 mv-video 元素');
  assert.doesNotMatch(tag[0], /\bmuted\b/, 'mv-video 不能 muted，否则 MV 没声音');
  assert.match(tag[0], /playsinline/, 'mv-video 要带 playsinline');
});

test('剧场层级压在底栏之下，底栏才能继续管播放控制', () => {
  const theaterZ = css.match(/\.mv-theater\s*\{[^}]*z-index:\s*(\d+)/);
  assert.ok(theaterZ, '.mv-theater 必须有 z-index');
  const bottomBar = indexCss.match(/#bottom-bar\s*\{[^}]*z-index:\s*(\d+)/);
  assert.ok(bottomBar, '#bottom-bar 必须有 z-index');
  assert.ok(
    Number(theaterZ[1]) < Number(bottomBar[1]),
    `剧场 z-index(${theaterZ[1]}) 必须小于底栏(${bottomBar[1]})`
  );
  const modalMask = indexCss.match(/\.modal-mask\s*\{[^}]*z-index:\s*(\d+)/);
  assert.ok(Number(theaterZ[1]) < Number(modalMask[1]), '弹窗必须压在剧场上面');
});

test('MV 播放中隐掉封面舞台，但不 display:none 掉 canvas', () => {
  assert.match(css, /body\.mv-theater-active #canvas-container/, 'MV 播放时要让位 canvas');
  assert.match(css, /body\.mv-theater-active #stage-lyrics/, 'MV 播放时要隐掉舞台歌词');
  const block = css.match(/body\.mv-theater-active #canvas-container[^}]*\}/)[0];
  assert.doesNotMatch(block, /display:\s*none/, 'canvas 不能 display:none —— WebGL 上下文还在跑');
  assert.match(block, /opacity:\s*0/, '让位靠 opacity');
});

test('只有小云的歌能看 MV', () => {
  assert.match(theater, /function mvIdForSong/, '必须有 mvIdForSong');
  const fn = theater.match(/function mvIdForSong\([^)]*\)\s*\{[\s\S]*?\n\}/)[0];
  assert.match(fn, /songProviderKey\(song\) !== 'netease'/, '非小云音源必须直接返回空');
});

test('进剧场暂停音频，退出按原状态恢复', () => {
  assert.match(theater, /resumeAudio = !!\(typeof audio !== 'undefined' && audio && !audio\.paused/,
    '开场要记录音频当时是否在播');
  assert.match(theater, /audio\.pause\(\)/, '开场必须暂停音频 —— MV 用自带音轨');
  assert.match(theater, /shouldResume[\s\S]*attemptAudioPlay/, '退出时按标记恢复播放');
});

test('剧场不把 video 接进 audioCtx', () => {
  assert.doesNotMatch(theater, /createMediaElementSource/,
    '不能给 video 建 MediaElementSource：那套生命周期只服务 audio');
  assert.doesNotMatch(theater, /^(?!\s*\/\/).*applyAudioOutputDevice\(/m,
    '不能走 applyAudioOutputDevice —— 它会把视频事件接到多设备镜像同步上');
  assert.match(theater, /video\.setSinkId/, '输出设备只写 sinkId');
});

test('进度和时间在 MV 模式下读视频时钟', () => {
  assert.match(progress, /function playbackClockMedia/, '必须有统一的时钟来源函数');
  assert.match(progress, /mvTheaterActiveMedia/, '时钟来源要考虑 MV');
  const duration = progress.match(/function getPlaybackDurationSeconds\(\)\s*\{[\s\S]*?\n\}/)[0];
  assert.match(duration, /playbackClockMedia\(\)/, '时长要走统一时钟来源');
  assert.match(duration, /if \(media !== audio\) return 0/,
    'MV 时长拿不到时不能退回歌曲时长 —— MV 有片头，两者本来就不是一回事');
});

test('两条进度拖拽互斥，不会同时生效', () => {
  assert.match(progress, /mvTheaterOwnsPlayback === 'function' && mvTheaterOwnsPlayback\(\)\) return/,
    '音频那条 pointerdown 必须在剧场开着时就提前 return');
  assert.doesNotMatch(progress, /mvTheaterActiveMedia\(\)\) return/,
    '不能用就绪门槛拦拖拽：取址那段时间它是 null，拖拽会落回音频链去 seek 并起播');
  assert.match(theater, /mvTheaterActiveMedia\(\);\s*\n\s*if \(!media/,
    'MV 那条 pointerdown 必须自己判定 MV 是否在放');
});

// 「谁接住用户输入」和「读谁的时钟」是两个问题，必须两个判定。用就绪门槛去路由
// 输入，会在取址那段窗口把输入放行给刚被剧场暂停的音频。
test('意图门槛和读数门槛必须是两个独立函数', () => {
  assert.match(theater, /function mvTheaterOwnsPlayback/, '必须有独立的意图门槛');
  const owns = theater.match(/function mvTheaterOwnsPlayback\(\)\s*\{[\s\S]*?\n\}/)[0];
  assert.doesNotMatch(owns, /currentSrc|mvTheaterActiveMedia/,
    '意图门槛只能看 active，掺进就绪判断就退化成同一个函数了');
  const toggle = theater.match(/function toggleMvPlayback\(\)\s*\{[\s\S]*?\n\}/)[0];
  assert.ok(
    toggle.indexOf('mvTheaterOwnsPlayback') < toggle.indexOf('mvTheaterActiveMedia'),
    'toggle 要先问归属，再问视频就绪'
  );
  assert.match(toggle, /if \(!video\) return true/,
    '视频没就绪也得吃掉这次 toggle，返回 false 就是放行给音频');
});

test('没有写了但没人读的状态字段', () => {
  assert.doesNotMatch(theater, /mvTheaterState\.loading/,
    'loading 写 6 次读 0 次，已删除。这种字段会在下个人拿它做判定时说谎');
});

test('底栏播放键在 MV 模式下作用于视频', () => {
  assert.match(theater, /function toggleMvPlayback/, '必须有 toggleMvPlayback');
  const fn = controls.match(/async function togglePlay\(\)\s*\{[\s\S]*?playToggleBusy = true/)[0];
  assert.match(fn, /toggleMvPlayback\(\)/, 'togglePlay 要先给 MV 分支机会');
  assert.ok(
    fn.indexOf('toggleMvPlayback') < fn.indexOf('playToggleBusy = true'),
    'MV 分支要在 playToggleBusy 之前 —— 它不碰音频链，没有要串行化的异步起播'
  );
});

test('音量与倍速镜像到视频', () => {
  assert.match(audioGraph, /applyVolumeToAudio[\s\S]{0,320}applyMvVideoOutput/,
    'applyVolumeToAudio 要镜像音量到视频');
  assert.match(tuning, /function applyPlaybackTuning[\s\S]{0,320}applyMvVideoOutput/,
    'applyPlaybackTuning 要镜像倍速到视频');
  assert.match(theater, /video\.volume = Math\.max\(0, Math\.min\(1, Number\(targetVolume\)/,
    '视频音量要跟全局 targetVolume');
});

test('切歌退出剧场，且不重复起播', () => {
  const fn = startAudio.match(/async function playQueueAt\([\s\S]{0,700}/)[0];
  assert.match(fn, /closeMvTheater\(\{ resumeAudio: false \}\)/,
    '切歌要关剧场，且不能再恢复一次旧音频');
});

test('MV 放完回音频，不自动串下一支 MV', () => {
  const ended = theater.match(/addEventListener\('ended'[\s\S]{0,220}/)[0];
  assert.match(ended, /closeMvTheater\(\)/, 'ended 后退出剧场');
  assert.doesNotMatch(ended, /nextTrack|openMvTheater/, '不能自动切下一首或下一支 MV');
});

test('退出时真的断开视频下载，不只是 pause', () => {
  const fn = theater.match(/function closeMvTheater\([\s\S]*?\n\}/)[0];
  assert.match(fn, /removeAttribute\('src'\)/, '必须清 src');
  assert.match(fn, /video\.load\(\)/, '清完要 load() 才真断开，否则继续吃带宽');
});

test('MV 按钮状态随切歌同步，没 MV 时置灰', () => {
  assert.match(coverDepth, /syncMvButton\(song\)/, '切歌更新控件信息时要同步 MV 按钮');
  assert.match(theater, /btn\.disabled = !canPlay/, '没 MV 的歌要 disabled');
  assert.match(css, /#mv-btn\[disabled\]/, 'disabled 要有视觉表达');
  assert.match(theater, /MV 只有小云音源支持/, '非小云音源要如实说明原因');
});

test('详情请求按 mvid 判定时效，不能用 requestToken', () => {
  const fn = theater.match(/function loadMvDetail\(\)\s*\{[\s\S]*?\n\}/)[0];
  assert.match(fn, /mvid !== mvTheaterState\.mvid/, '详情要按 mvid 判定');
  assert.doesNotMatch(fn, /token !== mvTheaterState\.requestToken/,
    '用 token 判定必然过期：开场 loadMvSource 会 ++requestToken，标题和清晰度列表永远渲染不上去');
});

test('双击全屏不能顺带把视频暂停再播放', () => {
  assert.match(theater, /mvSuppressClickUntil/, '双击要能吃掉随之派发的两次 click');
  const dbl = theater.match(/addEventListener\('dblclick'[\s\S]{0,400}/)[0];
  assert.match(dbl, /mvSuppressClickUntil = performance\.now\(\)/, 'dblclick 要设抑制窗口');
  const close = theater.match(/function closeMvTheater\([\s\S]*?\n\}/)[0];
  assert.match(close, /mvClickTimer/, '关剧场要清掉挂着的单击判定');
});

test('系统媒体键在 MV 模式下也能暂停', () => {
  const session = read('public/js/modules/05-playback/14a-media-session.js');
  assert.match(session, /function mvMediaPlaying/, '媒体键要能判断 MV 是否在出声');
  assert.match(session, /pause: function \(\) \{ if \(playing \|\| mvMediaPlaying\(\)\)/,
    'MV 放着时媒体键 pause 必须有效 —— 全局 playing 这时是 false');
  assert.doesNotMatch(session, /playing = true/, '不能靠把全局 playing 置真来绕过');
});

test('遥控端报真实出声状态和真实进度', () => {
  const cube = read('public/js/modules/10-shell/04a-cube-remote-controller.js');
  const lan = read('public/js/modules/10-shell/04b-lan-remote-controller.js');
  assert.match(cube, /playing: !!playing \|\| cubeRemoteMvPlaying\(\)/,
    'MV 放着时遥控端不能显示「已暂停」');
  assert.match(lan, /playbackClockMedia === 'function'/,
    '遥控端进度要和底栏读同一个时钟来源，否则 MV 时推的是冻结进度');
});

test('底栏两侧列必须等分，播放键才在正中', () => {
  // 中间那列是 max-content + justify-self:center，只有左右等宽播放键才落在正中。
  // 把第三列改成 auto 能防溢出，但会让中轴偏左（左列 1fr 吃掉全部剩余）—— 撞过一次。
  const grids = indexCss.match(/grid-template-columns:\s*minmax\(0,\s*1fr\)\s*max-content\s*[^;]+;/g) || [];
  assert.ok(grids.length >= 2, '应该能找到那两处三列网格声明');
  grids.forEach(rule => {
    assert.match(rule, /max-content\s+minmax\(0,\s*1fr\)/,
      '第三列必须和第一列同为 1fr，否则播放键会偏离中轴');
  });
});

test('底栏够长：modes 簇能装进一个等分列，不会往左盖住队列按钮', () => {
  // 等分三列意味着 modes 的宽度要被摊两次，所以「条子够长」是个可以算的约束，
  // 不是感觉问题。1120px 时代 modes 只剩 7px 余量，加一颗 MV 按钮就溢出糊到
  // transport 簇上，把队列按钮盖掉了。这里按 CSS 里真实的数值复算一遍。
  // 必须读 body.desktop-shell.diy-mode 那条：它 (0,3,1) 比 body.diy-mode (0,2,1)
  // 更具体、位置也更靠后，Electron 里真正生效的是它。只改前者的话装机版宽度不变，
  // 底栏照旧挤在一起 —— 这个坑踩过一次。
  const barRule = indexCss.match(/body\.desktop-shell\.diy-mode #bottom-bar,\s*body\.desktop-shell\.diy-mode #bottom-bar\.stage-mode \{[^}]*width:\s*min\((\d+)px,\s*calc\(100vw - clamp\((\d+)px,\s*([\d.]+)vw,\s*(\d+)px\)\)\)/);
  assert.ok(barRule, '应能读到 Electron 桌面端 DIY 模式底栏的宽度公式');
  const [, barMax, insetLo, insetVw, insetHi] = barRule.map(Number);

  // 同一个公式必须在两条规则上一致，否则窗口版和装机版宽度会漂移。
  const plainBar = indexCss.match(/body\.diy-mode #bottom-bar,\s*body\.diy-mode #bottom-bar\.stage-mode \{[^}]*width:\s*min\((\d+)px/);
  assert.ok(plainBar && Number(plainBar[1]) === barMax,
    `body.diy-mode 那条的上限 ${plainBar && plainBar[1]} 应与 desktop-shell 那条的 ${barMax} 一致`);

  const clamp = (lo, v, hi) => Math.max(lo, Math.min(v, hi));
  // 实测自 CSS：.ctrl-btn 36 / #play-btn 58 / .playback-tuning-pill min-width 54
  // / #time-display min-width 86 / .control-cover 52。评论键带计数，约 60。
  const CTRL = 36, PLAY = 58, PILL = 54, TIME = 86, COVER = 52, COMMENT = 60;
  // 锚在行首：不锚会先匹配到 `body.simple-mode .control-cluster.modes`（gap 12），
  // 算出来的右簇比实际宽 21px，模型就跟真实布局脱节了。
  const modesGap = Number(indexCss.match(/^\.control-cluster\.modes \{[^}]*gap:\s*(\d+)px/m)[1]);
  const hiddenAt = id => {
    const m = indexCss.match(new RegExp(`@media \\(max-width:\\s*(\\d+)px\\)[^@]*?#${id}\\b`));
    return m ? Number(m[1]) : 0;
  };
  const mvHide = hiddenAt('mv-btn');
  const timeHide = hiddenAt('time-display');
  const hideBtnHide = hiddenAt('controls-hide-btn');
  assert.ok(mvHide > 0, 'MV 按钮必须有收纳断点');
  assert.ok(hideBtnHide >= mvHide, '「控制条自动隐藏」是最不常用的一颗，应最早退场');

  function slack(vw) {
    const bar = Math.min(barMax, vw - clamp(insetLo, vw * insetVw / 100, insetHi));
    const narrow = vw <= 920;
    const content = (narrow ? vw - 28 : bar) - (narrow ? 14 : clamp(12, vw * 0.022, 24)) * 2;
    const gridGap = narrow ? 8 : (vw <= 1180 ? 10 : clamp(8, vw * 0.017, 18));
    const clusterGap = narrow ? 8 : clamp(8, vw * 0.011, 13);
    const transport = CTRL * 4 + (narrow ? 54 : PLAY) + clusterGap * 4;
    const col = (content - gridGap * 2 - transport) / 2;

    // 右簇：倍速胶囊 + 图标按钮 + 时间
    const mGap = vw <= 720 ? 6 : (narrow ? 8 : (vw <= 1180 ? 7 : modesGap));
    const items = [PILL /*倍速*/, CTRL /*沉浸*/];
    if (vw > 940) items.push(CTRL, CTRL, CTRL);       // 词 + 音量 + 全屏
    if (vw > hideBtnHide) items.push(CTRL);           // 控制条自动隐藏
    if (vw > mvHide) items.push(CTRL);                // MV
    let modes = items.reduce((a, b) => a + b, 0) + mGap * (items.length - 1);
    if (vw > 920 && vw > timeHide) modes += TIME + mGap;

    // 左簇下限：标题能缩到 0，封面和这三颗按钮不能。剩下的宽度就是歌名能用的。
    const cover = vw <= 720 ? 0 : (narrow ? 44 : COVER);
    const actions = cover + CTRL + COMMENT + CTRL + clusterGap * 4;
    return {
      right: Math.round(col - modes),
      left: Math.round(col - actions),
      title: Math.round(col - actions),
      bar: Math.round(bar),
    };
  }

  [2560, 1920, 1536, 1512, 1456, 1366, 1301, 1300, 1280, 1240, 1200, 1181, 1180, 1150, 1101, 1100, 1040, 1000, 960, 940, 921, 920, 800, 721]
    .forEach(vw => {
      const s = slack(vw);
      assert.ok(s.right >= 0, `视口 ${vw}px：右簇超出等分列 ${-s.right}px，会往左盖住队列按钮`);
      assert.ok(s.left >= 0, `视口 ${vw}px：左簇超出等分列 ${-s.left}px，会往右盖住播放键`);
      // 时间显示的 min-width 是 86，但一小时长的播客是 `1:02:33 / 1:14:20`（约 110px），
      // min-width 挡不住内容变宽。1300px 以上要能吃下这 24px；1101–1300 那几段差十几 px，
      // 是 min-width 本身的老问题（跟 MV 和这次挪位无关），要修得再加断点，暂不为它加。
      if (vw > 1300) {
        assert.ok(s.right - 24 >= 0,
          `视口 ${vw}px：一小时播客的时间显示会让右簇超出 ${-(s.right - 24)}px`);
      }
    });

  // 歌名要拿得到像样的宽度 —— 倍速胶囊放左簇那版只剩 108px，`love... at first si···`。
  [1920, 1536, 1366].forEach(vw => {
    assert.ok(slack(vw).title >= 190,
      `视口 ${vw}px：歌名只有 ${slack(vw).title}px，太窄了`);
  });

  // 另一头：条子不能顶到屏幕边上。1440 那版在 1536 的桌面上占到 94%，就是一条横杠。
  assert.ok(barMax <= 1280, `条宽上限 ${barMax}px 太长了，1536 的桌面上会顶到屏幕边`);
});

test('播放调节在右簇最左（「词」左边），不占歌名的宽度', () => {
  const actions = html.match(/<div class="control-cluster actions">[\s\S]*?\n        <\/div>/)[0];
  const modes = html.match(/<div class="control-cluster modes">[\s\S]*?\n        <\/div>/)[0];
  assert.doesNotMatch(actions, /id="playback-tuning-control"/,
    '不能放左簇：那会挤掉歌名的宽度');
  assert.match(modes, /id="playback-tuning-control"/, '倍速胶囊要在右簇');
  assert.ok(
    modes.indexOf('id="playback-tuning-control"') < modes.indexOf('id="lyric-timing-control"'),
    '要排在「词」之前 —— 右簇是 justify-content:flex-end，DOM 顺序就是左到右'
  );
  // 右簇的间距不能比另两簇宽：它每 1px 都要花 2px 条宽。
  const modesGap = Number(indexCss.match(/^\.control-cluster\.modes \{[^}]*gap:\s*(\d+)px/m)[1]);
  const baseGap = Number(indexCss.match(/^\.control-cluster \{[^}]*gap:\s*(\d+)px/m)[1]);
  assert.ok(modesGap <= baseGap, `右簇间距 ${modesGap}px 不该大于基础间距 ${baseGap}px`);
});

test('收纳梯度：先收「控制条自动隐藏」，再收时间和 MV', () => {
  const first = indexCss.match(/@media \(max-width:1300px\)\s*\{[\s\S]*?\n\}/)[0];
  assert.match(first, /body\.diy-mode #controls-hide-btn/, '1300px 先收最不常用的那颗');
  const second = indexCss.match(/@media \(max-width:1100px\)\s*\{[\s\S]*?\n\}/)[0];
  assert.match(second, /body\.diy-mode #mv-btn/, 'MV 在 1100px 这一档收');
  assert.match(second, /body\.diy-mode #time-display/, '时间显示和 MV 同一档');
});

test('徽章和音质胶囊单独一行压在歌名上面，歌名才有整行宽度', () => {
  const meta = html.match(/<div class="control-meta">[\s\S]*?\n            <\/div>/)[0];
  const chipRow = meta.match(/<div id="control-chip-row"[\s\S]*?\n              <\/div>/);
  assert.ok(chipRow, '应该有独立的 .control-chip-row');
  assert.match(chipRow[0], /id="control-title-badges"/, '徽章要在这一行里');
  assert.match(chipRow[0], /id="quality-control"/, '音质胶囊也在这一行 —— 它同样是 flex:0 0 auto');

  const titleRow = meta.match(/<div id="control-title"[\s\S]*?\n              <\/div>/)[0];
  assert.doesNotMatch(titleRow, /id="control-title-badges"/,
    '徽章不能和歌名同排：它是 flex:0 0 auto，会把歌名挤到只剩省略号');
  assert.doesNotMatch(titleRow, /id="quality-control"/, '音质胶囊同理');
  assert.ok(meta.indexOf('control-chip-row') < meta.indexOf('id="control-title"'),
    'chip 行要排在歌名之前（压在上面）');

  // 重建歌名时不能把徽章一起重建 —— 那会在歌名同排造出第二份，又挤没歌名。
  const fn = coverDepth.match(/function updateControlTrackInfo\([\s\S]*?\n\}/)[0];
  const rebuild = fn.match(/title\.innerHTML = '[^']*'/)[0];
  assert.doesNotMatch(rebuild, /control-title-badges/,
    'updateControlTrackInfo 的兜底重建只能补歌名那一个 span');
  assert.match(fn, /getElementById\('control-title-badges'\)/, '徽章仍按 id 查找，不依赖父子关系');
});

test('详情弹窗是底栏按钮被收纳后的 MV 入口', () => {
  assert.match(detail, /openMvTheaterFromDetail/, '详情弹窗要有 MV 入口');
  const fn = detail.match(/function openMvTheaterFromDetail\(\)\s*\{[\s\S]*?\n\}/)[0];
  assert.ok(
    fn.indexOf('closeTrackDetailModal()') < fn.indexOf('openMvTheater(song)'),
    '必须先关详情弹窗：它 z-index 50，压在剧场上面'
  );
  assert.match(indexCss, /\.detail-chip-action/, '可点 chip 要有样式');
});

test('重启恢复的歌不能丢 mv 字段', () => {
  const keys = snapshot.match(/PLAYBACK_SNAPSHOT_EXTRA_KEYS = \[[\s\S]*?\]/)[0];
  assert.match(keys, /'mv'/, '快照白名单要带上 mv，否则恢复后有 MV 的歌按钮也是灰的');
});

test('音调在 MV 模式下置灰 —— 它对视频无效', () => {
  assert.match(css, /body\.mv-theater-active \.pitch-tuning-row/, '音调那一行要置灰');
  const block = css.match(/body\.mv-theater-active \.pitch-tuning-row[^}]*\}/)[0];
  assert.match(block, /pointer-events:\s*none/, '置灰同时要禁用交互');
});

// ---------- 后端 ----------

test('三个 MV 端点都在，且从小云 API 导入了对应模块', () => {
  assert.match(server, /^\s*mv_detail,$/m, '必须导入 mv_detail');
  assert.match(server, /^\s*mv_url,$/m, '必须导入 mv_url');
  ["/api/mv/detail", "/api/mv/url", "/api/video"].forEach(route => {
    assert.match(server, new RegExp(`pn === '${route}'`), `${route} 必须注册`);
  });
});

test('视频代理不复用音频那条 range 缓存', () => {
  const branch = server.match(/if \(pn === '\/api\/video'\)\s*\{[\s\S]*?\n  \}/)[0];
  assert.doesNotMatch(branch, /fetchAudioProxyRangeWithCache|audioProxyRangeCache/,
    '视频不能进音频分片缓存：它有总字节上限，视频会把音频分片全挤掉');
  assert.match(branch, /'Accept-Ranges': 'bytes'/, '必须支持 Range，否则视频不能拖进度');
  assert.match(branch, /req\.headers\.range/, '要透传客户端 Range');
  assert.match(branch, /'Access-Control-Allow-Origin': '\*'/, '媒体流要带 CORS');
});

test('清晰度只收小云真实存在的四档', () => {
  assert.match(server, /MV_RESOLUTIONS = \[240, 480, 720, 1080\]/, '四档要写死');
  const fn = server.match(/function normalizeMvResolution\([\s\S]*?\n\}/)[0];
  assert.match(fn, /MV_RESOLUTIONS/, '归一化必须落到这四档，不能把任意数字透传给上游');
});

test('brs 两种形状都要能解析', () => {
  const fn = server.match(/function mapMvResolutions\([\s\S]*?\n\}/)[0];
  assert.match(fn, /Array\.isArray\(brs\)/, '新接口的数组形状');
  assert.match(fn, /typeof brs === 'object'/, '老接口的映射形状');
});

test('mv 字段带进歌曲记录，前端才不用额外发请求', () => {
  const fn = server.match(/function mapSongRecord\([\s\S]*?\n\}/)[0];
  assert.match(fn, /mv: Number\(s\.mv \|\| s\.mvid \|\| 0\)/, 'mapSongRecord 要带上 mv');
});

test('mv/url 回实际生效的清晰度，不只回请求的那档', () => {
  const branch = server.match(/if \(pn === '\/api\/mv\/url'\)\s*\{[\s\S]*?\n  \}/)[0];
  assert.match(branch, /requested: r/, '要回请求的档位');
  assert.match(branch, /resolution: Number\(data\.r \|\| r\)/, '要回上游实际给的档位');
  assert.match(branch, /proxyUrl: '\/api\/video\?url='/, '要直接给出代理地址');
});

test('视频 Content-Type 不能让上游的 octet-stream 漏过去', () => {
  const fn = server.match(/function videoContentTypeForUrl\([\s\S]*?\n\}/)[0];
  assert.match(fn, /video\/mp4/, '默认回 video/mp4');
  assert.match(fn, /\^video\\\//, '只有上游确实是 video\\/* 才采用它');
});
