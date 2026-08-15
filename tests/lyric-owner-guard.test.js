'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const lyricsText = fs.readFileSync(path.join(root, 'public/js/modules/06-lyrics/00-lyrics-fetch-parse.js'), 'utf8');

function namedFunctionSource(text, name) {
  const declaration = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(text);
  assert.ok(declaration, `expected ${name}()`);
  const bodyStart = text.indexOf('{', declaration.index + declaration[0].length);
  let depth = 0, quote = '', escaped = false, lineComment = false, blockComment = false;
  for (let index = bodyStart; index < text.length; index += 1) {
    const ch = text[index];
    if (lineComment) { if (ch === '\n') lineComment = false; continue; }
    if (blockComment) { if (ch === '*' && text[index + 1] === '/') { blockComment = false; index += 1; } continue; }
    if (quote) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '/' && text[index + 1] === '/') { lineComment = true; index += 1; continue; }
    if (ch === '/' && text[index + 1] === '*') { blockComment = true; index += 1; continue; }
    if (ch === '{') depth += 1;
    if (ch === '}' && --depth === 0) return text.slice(declaration.index, index + 1);
  }
  throw new Error(`unterminated ${name}()`);
}

function makeSandbox() {
  const writes = [];
  const renders = [];
  const timers = [];
  const songA = { id: 1, name: 'A 有歌词', artist: '甲' };
  const songB = { id: 2, name: 'B 没歌词', artist: '乙' };
  var sandbox;
  sandbox = {
    Number, String, Object, Array, Math, Date, Promise,
    trackSwitchToken: 7,
    currentIdx: 0,
    playQueue: [songA, songB],
    originalLyricsState: { lines: [], timingSource: 'pending' },
    lyricsHasNativeKaraoke: false,
    lyricsTimingSource: 'pending',
    lyricsTranslationLines: [],
    lyricsTranslationSource: 'none',
    lyricsLines: [],
    pendingTrackFallbackLyricTimer: 0,
    cancelPendingTrackFallbackLyrics() { },
    queueItemKey(song) { return 'song:' + song.id; },
    currentLyricSong() { return sandbox.playQueue[sandbox.currentIdx]; },
    hasUsableLyricLines(lines) { return Array.isArray(lines) && lines.some((line) => line && !line.fallback && String(line.text || '').trim()); },
    withLyricFallbackForSong(song) { return [{ t: 0, text: song.name + ' - ' + song.artist, fallback: true }]; },
    setOriginalLyricsState(lines, native, timing, translations, translationSource) {
      writes.push({ song: sandbox.currentLyricSong().name, lines, timing });
      sandbox.originalLyricsState = { lines, hasNativeKaraoke: native, timingSource: timing, translationLines: translations || [], translationSource: translationSource || 'none' };
    },
    applyPreferredLyricsForCurrent() { renders.push(sandbox.currentLyricSong().name); },
    parseLyricResponseToOriginalState(_song, response) {
      return { lines: response.lines || [], hasNativeKaraoke: false, timingSource: 'lrc', translationLines: [], translationSource: 'none', usableLyric: !!(response.lines && response.lines.length) };
    },
    mergeInlineLyricResponseForSong(_song, response) { return response; },
    scheduleNeteaseLyricTranslationFallback() {},
    writePersistentLyricCache() {},
    isNeteaseCloudSong() { return false; },
    cloudLyricRematchForSong() { return null; },
    cloudLyricRematchIdentity() { return ''; },
    setTimeout(fn, ms) { timers.push({ fn, ms }); return timers.length; },
    clearTimeout() {},
  };
  const source = [
    namedFunctionSource(lyricsText, 'lyricSongKey'),
    namedFunctionSource(lyricsText, 'lyricRequestStillOwnsCurrentSong'),
    namedFunctionSource(lyricsText, 'applyFetchedLyricResponse'),
    namedFunctionSource(lyricsText, 'scheduleTrackSwitchFallbackLyrics'),
  ].join('\n');
  vm.runInNewContext(source, sandbox, { filename: 'lyric-owner.js' });
  return { sandbox, songA, songB, writes, renders, timers };
}

test('慢回来的 A 歌歌词不能覆盖已经切到的 B', () => {
  const ctx = makeSandbox();
  ctx.sandbox.currentIdx = 1;
  const result = ctx.sandbox.applyFetchedLyricResponse(ctx.songA, 7, { lines: [{ t: 1, text: 'A 的歌词' }] });
  assert.equal(result, null);
  assert.equal(ctx.writes.length, 0);
  assert.equal(ctx.renders.length, 0);
});

test('同一首歌的歌词正常应用', () => {
  const ctx = makeSandbox();
  const result = ctx.sandbox.applyFetchedLyricResponse(ctx.songA, 7, { lines: [{ t: 1, text: 'A 的歌词' }] });
  assert.ok(result);
  assert.equal(ctx.writes.length, 1);
  assert.equal(ctx.renders.length, 1);
});

test('A 的延迟无歌词兜底不能覆盖已经切到的 B', () => {
  const ctx = makeSandbox();
  ctx.sandbox.scheduleTrackSwitchFallbackLyrics(ctx.songA, 7, 10);
  assert.equal(ctx.timers.length, 1);
  ctx.sandbox.currentIdx = 1;
  ctx.timers[0].fn();
  assert.equal(ctx.writes.length, 0);
  assert.equal(ctx.renders.length, 0);
});

test('暂停但仍是 A 时，A 的歌词响应仍能正常应用', () => {
  const ctx = makeSandbox();
  // 暂停不应改变歌词归属；这里不改 currentIdx，只模拟请求回来。
  const result = ctx.sandbox.applyFetchedLyricResponse(ctx.songA, 7, { lines: [{ t: 1, text: 'A 的歌词' }] });
  assert.ok(result);
  assert.deepEqual(ctx.writes[0].lines, [{ t: 1, text: 'A 的歌词' }]);
});

test('歌词 token 过期仍然丢弃', () => {
  const ctx = makeSandbox();
  const result = ctx.sandbox.applyFetchedLyricResponse(ctx.songA, 6, { lines: [{ t: 1, text: '旧歌词' }] });
  assert.equal(result, null);
  assert.equal(ctx.writes.length, 0);
});

test('歌词归属用队列稳定 key，不用对象引用', () => {
  const ctx = makeSandbox();
  const clonedA = { id: 1, name: 'A 有歌词（回填后对象）', artist: '甲' };
  ctx.sandbox.playQueue[0] = clonedA;
  const result = ctx.sandbox.applyFetchedLyricResponse(ctx.songA, 7, { lines: [{ t: 1, text: 'A 的歌词' }] });
  assert.ok(result, '本地元数据回填可能替换对象，但同一个 queueItemKey 仍应能应用');
});
