'use strict';

// Run with Node. The child uses the bundled Electron in a hidden, muted window
// and an isolated profile. No user queue, settings or running player is touched.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const root = path.resolve(process.env.MINERADIO_PLAYBACK_QA_ROOT || path.join(__dirname, '..'));

if (!process.versions.electron) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-playback-qa-'));
  try {
    const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
    for (const [name, rate, codec] of [['sample.mp3', '44100', 'libmp3lame'], ['sample.flac', '96000', 'flac']]) {
      const generated = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=24', '-ar', rate, '-ac', '2', '-c:a', codec, path.join(temp, name)], { windowsHide: true, encoding: 'utf8' });
      if (generated.status !== 0) throw new Error(generated.stderr || 'FFmpeg fixture generation failed');
    }
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(require('electron'), [__filename, temp], { cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 120000 });
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    if (result.error) throw result.error;
    process.exitCode = result.status == null ? 1 : result.status;
  } finally {
    const resolved = path.resolve(temp);
    if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('mineradio-playback-qa-')) fs.rmSync(resolved, { recursive: true, force: true });
  }
} else {
  const { app, BrowserWindow } = require('electron');
  const temp = process.argv[2];
  app.setPath('userData', path.join(temp, 'profile'));
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  process.env.PORT = '0';
  process.env.MINERADIO_HOST = '127.0.0.1';
  process.env.MINERADIO_DIAG_DIR = path.join(temp, 'diagnostics');
  process.env.MINERADIO_REMOTE_DIR = path.join(temp, 'remote');
  process.env.MINERADIO_LISTEN_SYNC_FILE = path.join(temp, 'listen.json');
  process.env.COOKIE_FILE = path.join(temp, 'absent-cookie');
  process.env.QQ_COOKIE_FILE = path.join(temp, 'absent-qq-cookie');
  process.env.KUGOU_COOKIE_FILE = path.join(temp, 'absent-kugou-cookie');
  let win;
  app.on('child-process-gone', (_, details) => console.error('PLAYBACK_QA_CHILD_EXIT', JSON.stringify(details)));
  const timeout = setTimeout(() => { console.error('PLAYBACK_RUNTIME_TIMEOUT'); app.exit(1); }, 110000);
  app.whenReady().then(async () => {
    const server = require(path.join(root, 'server'));
    if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
    const port = server.address().port;
    const fixtures = ['sample.mp3', 'sample.flac'].map(name => ({ name, url: `http://127.0.0.1:${port}/api/local-media?id=${server.registerLocalMediaPath(path.join(temp, name))}` }));
    const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
    const graph = read('public/js/modules/05-playback/08-audio-graph-controls.js');
    const output = read('public/js/modules/05-playback/00-api-quality-output.js');
    const controls = read('public/js/modules/05-playback/14-player-controls.js');
    const progress = read('public/js/modules/06-lyrics/04-progress-seek.js');
    const code = [
      'var audio=null,audioCtx=null,source=null,audioSourceMedia=null,analyser=null,beatAnalyser=null,gainNode=null,analysisSinkNode=null,audioReady=false,uiSfxCtx=null;',
      'var FFT_SIZE=2048,BEAT_FFT_SIZE=2048,frequencyData=new Uint8Array(1024),timeDomainData=new Uint8Array(2048),beatFrequencyData=new Uint8Array(1024),beatTimeDomainData=new Uint8Array(2048);',
      'var audioOutputDeviceId="",trackSwitchToken=0,playQueue=[],currentIdx=0,playing=false,playToggleBusy=false,targetVolume=0.3,AUDIO_SILENCE_GAIN=0.0001,audioFadeSerial=0,audioFadeTimer=null,audioElementFadeFrame=0;',
      'var playbackResumeRecovery={serial:0,pending:false,timerIds:[],lastAttemptAt:0},PLAYBACK_RESUME_STALL_DELAYS=[1600,3600];',
      'var lyricsLines=[],fx={}; var runtimeErrors=[]; window.addEventListener("error",function(e){runtimeErrors.push(e.message);}); window.addEventListener("unhandledrejection",function(e){runtimeErrors.push(String(e.reason));});',
      'function clampRange(v,a,b){return Math.max(a,Math.min(b,v));} function queueItemKey(s){return s.localKey;}',
      'function syncMediaSessionState(){} function hideLoading(){} function setPlayIcon(){} function forcePlaybackControlsInteractive(){} function switchPlaybackVisualToEmily(){} function primeCinemaAfterTrackStart(){} function resetRealtimeBeatEngine(){} function markStageLyricsPlaybackResume(){} function showToast(s){console.log(s);} function saveLastPlaybackSnapshot(){} function updateListenStatsTick(){} function scheduleControlsHide(){} function currentCoverSong(){return playQueue[currentIdx];} function syncBeatMapPlaybackCursor(){}',
      'function normalizePlaybackProvider(){return "netease";} function songProviderKey(){return "netease";} function playbackTransitionHasAudibleNextDeck(){return false;} function resetSmartCrossfade(){} function scheduleSmartCrossfadePrepare(){}',
      'function bindAudioOutputMirrorEvents(){} function syncAudioOutputMirrors(){} function renderAudioOutputDeviceUi(){} function saveAudioOutputDevicePreference(){}',
      output.slice(output.indexOf('function setPlaybackOutputSink'), output.indexOf('function setAudioOutputDevice(deviceId')),
      read('public/js/modules/05-playback/12-playback-switch-core.js'),
      graph.slice(0, graph.indexOf('function ensureUiSfxContext')),
      graph.slice(graph.indexOf('function clearAudioFadeTimers'), graph.indexOf('function updateVolumeUi')),
      controls.slice(0, controls.indexOf('function setPlayIcon')),
      progress.slice(0, progress.indexOf('var progressBar =')),
      progress.slice(progress.indexOf('var PLAYBACK_FREEZE_TICKS_REQUIRED'), progress.indexOf('setInterval(function ()', progress.indexOf('var PLAYBACK_FREEZE_TICKS_REQUIRED'))),
    ].join('\n');
    win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true } });
    win.webContents.on('render-process-gone', (_, details) => console.error('PLAYBACK_QA_RENDERER_EXIT', JSON.stringify(details)));
    win.webContents.setAudioMuted(true);
    // A plain response on the real loopback origin permits same-origin diagnostics
    // without loading the full UI or touching any saved account or queue.
    await win.loadURL(`http://127.0.0.1:${port}/api/diag/stall-log`);
    await win.webContents.executeJavaScript(code);
    const result = await win.webContents.executeJavaScript(`(async function () {
      var fixtures=${JSON.stringify(fixtures)}, results=[];
      function check(ok,label){if(!ok)throw new Error(label+': '+audioPlaybackStartState(audio)+' errors='+runtimeErrors.join(';'));}
      function delay(ms){return new Promise(function(r){setTimeout(r,ms);});}
      async function waitUntil(predicate,timeout){var until=performance.now()+timeout;while(!predicate()&&performance.now()<until)await delay(40);return predicate();}
      async function started(label,opts){var t=performance.now();check(await attemptAudioPlay(opts||{}),label);var at=audio.currentTime;await delay(250);check(audio.currentTime>at+0.08,label+' continuous clock');check(readPlaybackAnalyserSignal()>0.0025,label+' decoded audio');results.push({label:label,ms:Math.round(performance.now()-t),position:Number(audio.currentTime.toFixed(2))});}
      var watch=setInterval(function(){tickPlaybackFreezeWatch(audio);},200);
      for(var item of fixtures){
        for(var n=0;n<3;n++){
          if(audio)cancelPlaybackStart(audio,'track-switch');
          if(!audio){audio=new Audio();audio.crossOrigin='anonymous';}else audio.pause();
          trackSwitchToken++;
          playQueue=[{type:'local',localKey:item.name,name:item.name,localUrl:item.url}];
          resetPlaybackAudioGraphForSourceSwitch('smoke');
          audio.autoplay=false;audio.preload='auto';audio.src=item.url;
          audio.__mineradioQueueItemKey=item.name;audio.__mineradioTrackSwitchToken=trackSwitchToken;audio.__mineradioRebuildHistory=[];
          bindPlaybackProgressEvents(audio);
          audio.load();await started(item.name+' switch '+n,{trackSwitch:true});
        }
        for(var i=0;i<3;i++){
          pauseAudioPlayback();await delay(100);check(audio.paused,item.name+' manual pause persists');
          await started(item.name+' resume '+i,{manual:true});
          commitProgressSeek(5+i*3,true);
          await started(item.name+' seek '+i,{manual:true});
          check(audio.currentTime>=5+i*3,item.name+' seek preserved');
        }
        // Emulate a device/context failure. The recovery must adopt the newly
        // created element and verify actual native decoding at the saved offset.
        var before=audio.currentTime,old=audio;
        await audioCtx.close();
        await started(item.name+' closed-context recovery',{manual:true});
        check(audio!==old&&audio.currentTime>=before-0.4,item.name+' replacement position');
        before=audio.currentTime;old=audio;
        check(await recoverFrozenPlayback('runtime-injected-freeze',audio),item.name+' runtime recovery');
        check(audio!==old&&audio.currentTime>=before-0.4,item.name+' frozen rebuild position');
        results.push({label:item.name+' frozen rebuild',position:Number(audio.currentTime.toFixed(2))});
        before=audio.currentTime;old=audio;audio.__mineradioRebuildHistory=[];
        audio.pause();
        check(await waitUntil(function(){return audio!==old&&!audio.paused&&!playbackStartAttempt;},6000),item.name+' unexpected pause recovery');
        check(audio.currentTime>=before-0.4,item.name+' unexpected pause position');
        results.push({label:item.name+' native unexpected pause',position:Number(audio.currentTime.toFixed(2))});
        before=audio.currentTime;old=audio;audio.__mineradioRebuildHistory=[];
        Object.defineProperty(old,'currentTime',{configurable:true,get:function(){return before;}});
        check(await waitUntil(function(){return audio!==old&&!audio.paused&&!playbackStartAttempt;},6000),item.name+' watchdog freeze recovery');
        check(audio.currentTime>=before-0.4,item.name+' watchdog resume position');
        results.push({label:item.name+' watchdog-injected frozen clock',position:Number(audio.currentTime.toFixed(2))});
      }
      clearInterval(watch);
      cancelPlaybackStart(audio,'done');audio.pause();
      check(runtimeErrors.length===0,'no renderer errors');
      return results;
    })()`, true);
    console.log(JSON.stringify({ electron: process.versions.electron, chromium: process.versions.chrome, passed: result.length, results: result }, null, 2));
    clearTimeout(timeout);
    win.destroy();
    server.close(() => app.exit(0));
  }).catch(error => { clearTimeout(timeout); console.error(error.stack || error); if (win && !win.isDestroyed()) win.destroy(); app.exit(1); });
}
