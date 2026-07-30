'use strict';

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('Usage: node portable-profile-runtime-probe.js <remote-debugging-port>');
}

const storageKeys = [
  'mineradio-current-fx-autosave-v1',
  'mineradio-playback-tuning-v1',
  'mineradio-audio-effects-v1',
  'mineradio-smart-transition-v2',
  'mineradio-smart-transition-lead-v1',
  'mineradio-last-playback-v1',
  'mineradio-local-library-folders-v2',
  'mineradio-local-metadata-v1',
  'mineradio-close-behavior-v1',
  'mineradio-startup-resume-mode-v1',
  'mineradio-account-view-mode-v1',
  'mineradio-active-account-provider-v1',
  'mineradio-controls-auto-hide-v1',
  'mineradio-custom-lyric-prefs-v1',
  'mineradio-custom-lyrics-v1',
  'mineradio-diy-player-mode-v1',
  'mineradio-free-camera-v1',
  'mineradio-lyric-layout-v1',
  'mineradio-upload-tip-seen',
  'mineradio-user-fx-archives-v1',
  'mineradio-visual-guide-seen-v2',
  'mineradio-weather-city',
  'apex-player-volume',
];

function evaluate(webSocketUrl, expression) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const id = 1;
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('DevTools evaluation timed out'));
    }, 20000);
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true },
      }));
    });
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== id) return;
      clearTimeout(timer);
      socket.close();
      if (message.error) reject(new Error(message.error.message));
      else if (message.result && message.result.exceptionDetails) reject(new Error(message.result.exceptionDetails.text));
      else resolve(message.result.result.value);
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('DevTools websocket failed'));
    });
  });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function probeIsReady(result) {
  if (!result || result.readyState !== 'complete' || !Array.isArray(result.queueIdentities) || !result.fxState) return false;
  return ['/api/login/status', '/api/kugou/login/status'].every(endpoint => {
    const status = result.status && result.status[endpoint];
    return status && !status.probeError;
  });
}

async function main() {
  const expression = `(async () => {
    const keys = ${JSON.stringify(storageKeys)};
    const storage = {};
    const comparisonStorage = {};
    keys.forEach(key => {
      const value = localStorage.getItem(key);
      storage[key] = value;
      comparisonStorage[key] = value;
    });
    const status = {};
    for (const endpoint of ['/api/login/status', '/api/kugou/login/status']) {
      try {
        const response = await fetch(endpoint + '?upgradeProbe=' + Date.now());
        status[endpoint] = await response.json();
      } catch (error) {
        status[endpoint] = { probeError: String(error && error.message || error) };
      }
    }
    return {
      href: location.href,
      title: document.title,
      readyState: document.readyState,
      bodyClass: document.body ? document.body.className : '',
      storage,
      comparisonStorage,
      storageKeyCount: localStorage.length,
      queueLength: typeof playQueue !== 'undefined' && Array.isArray(playQueue) ? playQueue.length : null,
      queueIdentities: typeof playQueue !== 'undefined' && Array.isArray(playQueue) ? playQueue.map(song => {
        song = song || {};
        return String(song.localKey || song.id || song.mid || song.hash || song.audioHash || ((song.name || '') + '|' + (song.artist || '')));
      }) : null,
      currentIndex: typeof currentIdx !== 'undefined' ? currentIdx : null,
      currentSong: typeof currentCoverSong === 'function' ? currentCoverSong() : null,
      localLibraryFolderCount: typeof localLibraryFolders !== 'undefined' && Array.isArray(localLibraryFolders) ? localLibraryFolders.length : null,
      localMetadataCount: typeof localMetadataMap !== 'undefined' && localMetadataMap ? Object.keys(localMetadataMap).length : null,
      fxState: typeof fx !== 'undefined' ? {
        preset: fx.preset,
        intensity: fx.intensity,
        lyricScale: fx.lyricScale,
        lyricFont: fx.lyricFont,
        stageLyricLines: fx.stageLyricLines,
        lyricDisplayMode: fx.lyricDisplayMode,
        lyricCustomLineCount: fx.lyricCustomLineCount,
        lyricGlow: fx.lyricGlow,
        desktopLyrics: fx.desktopLyrics,
        desktopLyricsSize: fx.desktopLyricsSize,
        desktopLyricsFps: fx.desktopLyricsFps,
        smartTransitionStyle: fx.smartTransitionStyle,
        performanceQuality: fx.performanceQuality,
      } : null,
      playbackTuning: typeof playbackTuning !== 'undefined' ? playbackTuning : null,
      audioEffects: typeof audioEffects !== 'undefined' ? audioEffects : null,
      smartTransitionStyle: typeof smartTransitionStyle !== 'undefined' ? smartTransitionStyle : null,
      smartTransitionLeadSec: typeof smartTransitionLeadSec !== 'undefined' ? smartTransitionLeadSec : null,
      loginStatus: typeof loginStatus !== 'undefined' ? loginStatus : null,
      kugouLoginStatus: typeof kugouLoginStatus !== 'undefined' ? kugouLoginStatus : null,
      status,
    };
  })()`;
  const deadline = Date.now() + 30000;
  let lastError = null;
  let lastResult = null;
  while (Date.now() < deadline) {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json`).then(response => response.json());
      const target = targets
        .filter(item => item.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\//.test(item.url))
        .sort((left, right) => String(right.url).localeCompare(String(left.url)))[0];
      if (!target) throw new Error('Mineradio renderer target was not found');
      lastResult = await evaluate(target.webSocketDebuggerUrl, expression);
      if (probeIsReady(lastResult)) {
        process.stdout.write(`${JSON.stringify(lastResult, null, 2)}\n`);
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }
  const detail = lastResult
    ? JSON.stringify({ href: lastResult.href, readyState: lastResult.readyState, status: lastResult.status })
    : String(lastError && lastError.message || lastError || 'no renderer result');
  throw new Error(`Mineradio runtime probe did not become ready: ${detail}`);
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
