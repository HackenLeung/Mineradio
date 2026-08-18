'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const actions = fs.readFileSync(path.join(root, 'public/js/modules/05-playback/06-track-detail-lyrics-actions.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

const start = actions.indexOf('function albumReleaseDateLabel(');
const end = actions.indexOf('function songSourceLabel(', start);
assert.ok(start >= 0 && end > start, '发行时间格式化函数应可提取');

const context = {};
vm.runInNewContext(actions.slice(start, end) + '\nthis.formatReleaseDate = albumReleaseDateLabel;', context);

assert.equal(context.formatReleaseDate(1577923200000), '2020-01-02');
assert.equal(context.formatReleaseDate('2024-8-6'), '2024-08-06');
assert.equal(context.formatReleaseDate('20240806'), '2024-08-06');
assert.equal(context.formatReleaseDate(0), '');
assert.equal(context.formatReleaseDate('0'), '');
assert.equal(context.formatReleaseDate(''), '未知');

assert.match(server, /releaseDate: info\.publishTime/);
assert.match(server, /releaseDate: data\.aDate/);
const albumMarkup = actions.slice(actions.indexOf("if (type === 'album')"), actions.indexOf("} else if (type === 'artist')"));
assert.doesNotMatch(albumMarkup, /detailRow\('当前歌曲'/);
assert.match(albumMarkup, /detail-k">发行时间<\/div><div class="detail-v" id="album-detail-release-date"/);
assert.match(actions, /id="album-detail-release-date"/);
assert.match(actions, /albumReleaseDateLabel\(albumInfo\.releaseDate\)/);
