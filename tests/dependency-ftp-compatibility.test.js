'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { once } = require('node:events');
const { createRequire } = require('node:module');

// Exercise the actual PAC dependency chain: get-uri declares basic-ftp 5.x,
// but the directory-listing DoS is only fixed in 6.2.3 or newer.
const apiRequire = createRequire(require.resolve('@neteasecloudmusicapienhanced/api'));
const pacRequire = createRequire(apiRequire.resolve('pac-proxy-agent'));
const { getUri } = pacRequire('get-uri');
const payload = 'function FindProxyForURL() { return "DIRECT"; }\n';

async function fixture(t, mode) {
  const sockets = new Set();
  const listeners = new Set();
  const commands = [];
  const control = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setEncoding('utf8');
    socket.write('220 Local read-only test fixture\r\n');
    let pending = '';
    let dataConnection;
    socket.on('data', chunk => {
      pending += chunk;
      let end;
      while ((end = pending.indexOf('\r\n')) !== -1) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 2);
        commands.push(line);
        const command = line.split(' ')[0];
        if (command === 'USER') socket.write('331 Password required\r\n');
        else if (command === 'PASS') socket.write('230 Logged in\r\n');
        else if (command === 'FEAT') socket.write(mode === 'mlsd' ? '211-Features\r\n MLST type*;size*;modify*;\r\n211 End\r\n' : '211 No optional features\r\n');
        else if (['OPTS', 'TYPE', 'STRU'].includes(command)) socket.write('200 OK\r\n');
        else if (command === 'PWD') socket.write('257 "/"\r\n');
        else if (command === 'CWD') socket.write('250 Directory changed\r\n');
        else if (command === 'MDTM') socket.write(mode === 'mdtm' ? '213 20260101000000\r\n' : '502 MDTM unsupported\r\n');
        else if (command === 'EPSV') {
          const passive = net.createServer(data => {
            sockets.add(data);
            data.on('close', () => sockets.delete(data));
            data.on('error', () => {});
          });
          listeners.add(passive);
          dataConnection = once(passive, 'connection').then(([data]) => data);
          passive.listen(0, '127.0.0.1', () => socket.write(`229 Entering Extended Passive Mode (|||${passive.address().port}|)\r\n`));
        } else if (['LIST', 'MLSD', 'RETR'].includes(command)) {
          socket.write('150 Opening data connection\r\n');
          dataConnection.then(data => {
            const body = command === 'LIST' ? `-rw-r--r-- 1 test test ${Buffer.byteLength(payload)} Jan 01 2026 proxy.pac\r\n`
              : command === 'MLSD' ? `type=file;size=${Buffer.byteLength(payload)};modify=20260101000000; proxy.pac\r\n` : payload;
            data.end(body, () => socket.write('226 Transfer complete\r\n'));
          });
        } else if (command === 'QUIT') socket.end('221 Goodbye\r\n');
        else socket.write('502 Unsupported command\r\n');
      }
    });
  });
  listeners.add(control);
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all([...listeners].map(server => new Promise(resolve => server.close(resolve))));
  });
  control.listen(0, '127.0.0.1');
  await once(control, 'listening');
  return { url: `ftp://127.0.0.1:${control.address().port}/proxy.pac`, commands };
}

for (const mode of ['mdtm', 'mlsd', 'list']) {
  test(`PAC FTP retrieval: ${mode}`, { timeout: 10000 }, async t => {
    const { url, commands } = await fixture(t, mode);
    if (mode === 'list') {
      // Existing get-uri behavior: legacy LIST dates lack a reliable timezone,
      // so basic-ftp leaves modifiedAt unset and get-uri rejects the resource.
      await assert.rejects(getUri(url), { code: 'ENOTFOUND' });
      assert.ok(commands.some(line => line.startsWith('LIST')));
      assert.ok(!commands.some(line => line.startsWith('RETR')));
      return;
    }
    const stream = await getUri(url);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), payload);
    assert.ok(stream.lastModified instanceof Date);
    if (mode === 'mlsd') assert.ok(commands.some(line => line.startsWith('MLSD')));
    await assert.rejects(getUri(url, { cache: stream }), { code: 'ENOTMODIFIED' });
    assert.ok(commands.includes('RETR /proxy.pac'));
    assert.ok(!commands.some(line => /^(STOR|APPE|DELE|MKD|RMD)\b/.test(line)));
  });
}
