'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const server = read('server.js');
const wall = read('public/js/modules/05-playback/03c-music-library-wall.js');
const queueLoader = read('public/js/modules/06-lyrics/03-podcast-playlist-loaders.js');
const playback = read('public/js/modules/05-playback/13-playback-start-audio.js');
const playbackSnapshot = read('public/js/modules/05-playback/09-queue-snapshot-autoplay.js');
const coverMap = read('public/js/modules/05-playback/01-cover-custom-map.js');
const lyrics = read('public/js/modules/06-lyrics/00-lyrics-fetch-parse.js');

assert.match(server, /user_cloud,\s*user_cloud_detail/);
assert.match(server, /song_cloud_download: enhancedNeteaseCloudDownload/);
assert.match(server, /if \(pn === '\/api\/user\/cloud'\)/);
assert.match(server, /if \(pn === '\/api\/user\/cloud\/detail'\)/);
assert.match(server, /handleNeteaseCloudSongUrl/);
assert.match(server, /if \(pn === '\/api\/cloud\/lyric'\)/);
assert.match(server, /cloudPlaybackRequested \? sendPrivateJSON : sendJSON/);
assert.match(server, /sendPrivateJSON\(res, \{\s*provider: 'netease',\s*cloud: true/);
assert.match(server, /requireLogin\(res, sendPrivateJSON\)/);
assert.match(server, /cloudSource: 'netease-cloud'/);

assert.match(wall, /kind: 'netease-cloud'/);
assert.match(wall, /\/api\/user\/cloud\?limit=/);
assert.match(wall, /'netease-cloud:' \+ \(detail\.playlistId/);
assert.match(queueLoader, /raw\.indexOf\('netease-cloud:'\)/);
assert.match(queueLoader, /source\.provider === 'netease-cloud'/);
assert.match(playback, /var cloudParam = song && \(song\.cloudSong/);
assert.match(playback, /\+ cloudParam \+ neteasePlaybackMatchQuery/);
assert.match(playbackSnapshot, /'cloudSong', 'cloudSource', 'cloudId'/);
assert.match(playbackSnapshot, /netease-cloud:' \+ \(song\.cloudId/);
assert.match(coverMap, /netease-cloud:' \+ \(song\.cloudId/);
assert.match(lyrics, /\/api\/cloud\/lyric\?id=/);

console.log('OK netease-cloud-integration');
