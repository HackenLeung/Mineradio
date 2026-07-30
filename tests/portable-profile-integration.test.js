'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  resolvePortableProfilePaths,
  ensurePortableUserDataDirectory,
} = require('../desktop/portable-profile');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-portable-profile-'));
try {
  const installRoot = path.join(root, 'Legacy Main Folder');
  const userData = path.join(installRoot, 'user-data');
  const keyFiles = [
    'Local Storage/leveldb/000003.log',
    'IndexedDB/https_music.163.com_0.indexeddb.leveldb/CURRENT',
    'Partitions/mineradio-netease-login/Network/Cookies',
    'Partitions/mineradio-kugou-login/Network/Cookies',
    '.cookie',
    '.kugou-cookie',
    'desktop-behavior.json',
    'download-settings.json',
    'local-audio-metadata-cache-v1.json',
  ];
  keyFiles.forEach((relative, index) => {
    const file = path.join(userData, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `legacy-${index}`, 'utf8');
  });

  const before = keyFiles.map(relative => [relative, fs.readFileSync(path.join(userData, relative), 'utf8')]);
  const paths = resolvePortableProfilePaths({
    packaged: true,
    execPath: path.join(installRoot, 'Mineradio.exe'),
    developmentRoot: path.join(root, 'ignored-dev-root'),
    developmentUserData: path.join(root, 'ignored-dev-profile'),
  });
  assert.equal(paths.installRoot, installRoot);
  assert.equal(paths.userDataPath, userData);
  assert.equal(paths.usesPortableUserData, true);
  assert.equal(paths.cacheRootPath, path.join(installRoot, 'MineradioCache'));
  ensurePortableUserDataDirectory(fs, paths.userDataPath, { requireExisting: true });
  assert.deepEqual(
    keyFiles.map(relative => [relative, fs.readFileSync(path.join(userData, relative), 'utf8')]),
    before,
    'validating the legacy profile must not rewrite or delete its contents'
  );

  const missing = path.join(root, 'missing-install', 'user-data');
  assert.throws(
    () => ensurePortableUserDataDirectory(fs, missing, { requireExisting: true }),
    error => error && error.code === 'PORTABLE_USER_DATA_MISSING'
  );
  assert.equal(fs.existsSync(missing), false, 'a missing packaged profile must never be replaced by an empty directory');

  const developmentRoot = path.join(root, 'development-checkout');
  const defaultDevelopmentPaths = resolvePortableProfilePaths({
    packaged: false,
    developmentRoot,
  });
  assert.equal(defaultDevelopmentPaths.userDataPath, '');
  assert.equal(defaultDevelopmentPaths.usesPortableUserData, false);
  assert.equal(fs.existsSync(path.join(developmentRoot, 'user-data')), false, 'development must not create a repository-local profile');

  const explicitDevelopmentProfile = path.join(root, 'explicit-development-profile');
  const explicitDevelopmentPaths = resolvePortableProfilePaths({
    packaged: false,
    developmentRoot,
    developmentUserData: explicitDevelopmentProfile,
  });
  assert.equal(explicitDevelopmentPaths.userDataPath, explicitDevelopmentProfile);
  assert.equal(explicitDevelopmentPaths.usesPortableUserData, true);

  const main = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const userDataSet = main.indexOf("app.setPath('userData', STABLE_USER_DATA_PATH)");
  const sessionDataSet = main.indexOf("app.setPath('sessionData', STABLE_USER_DATA_PATH)");
  assert(main.includes('userData: STABLE_USER_DATA_PATH'));
  assert(main.includes("sessionData: (() => { try { return app.getPath('sessionData');"));
  const createWindowStart = main.indexOf('async function createWindowOnce()');
  const createWindowState = main.slice(createWindowStart, main.indexOf('const initialBounds', createWindowStart));
  assert(createWindowState.includes('userData: STABLE_USER_DATA_PATH'), 'window startup state must retain the portable userData path');
  assert(createWindowState.includes("sessionData: (() => { try { return app.getPath('sessionData');"),
    'window startup state must retain the portable sessionData path');
  [
    'registerWallpaperEngineScheme(protocol)',
    'ensureCacheDirectories(readCacheSettings())',
    'new DesktopLyricsWindowState',
    'app.requestSingleInstanceLock()',
  ].forEach(marker => {
    assert(userDataSet >= 0 && userDataSet < main.indexOf(marker), `userData must be fixed before ${marker}`);
    assert(sessionDataSet >= 0 && sessionDataSet < main.indexOf(marker), `sessionData must be fixed before ${marker}`);
  });
  assert.equal((main.match(/setPath\('sessionData'/g) || []).length, 1, 'sessionData must never follow the cache path');
  assert(main.includes("return path.join(INSTALL_ROOT, 'MineradioCache');"));
  assert(main.includes('function isLegacyDriveRootCachePath(value)'));
  assert(!main.includes("path.join(dDrive, 'MineradioCache')"), 'cache defaults must never use a drive-root directory');
  assert(!main.includes('migrateLegacyPortableUserData'));
  assert(!main.includes('migrateLegacyAuthStorage'));
  assert(!main.includes('migrateMisplacedAppOwnedFiles'));
  assert(!main.includes('chromiumSessionDataPath'));
  assert(!main.includes("clearAllProviderLoginState('startup-gate')"));
  assert(main.includes("const NETEASE_LOGIN_PARTITION = 'persist:mineradio-netease-login';"));
  assert(main.includes("const KUGOU_LOGIN_PARTITION = 'persist:mineradio-kugou-login';"));
  assert(server.includes("path.join(path.dirname(process.resourcesPath), 'MineradioCache')"));
  assert(server.includes("path.join(DEFAULT_CACHE_ROOT, 'beatmaps')"));
  assert(!server.includes("'D:\\\\MineradioCache\\\\beatmaps'"), 'standalone server cache must not use a drive-root fallback');

  const runtimeProbe = fs.readFileSync(path.join(__dirname, 'portable-profile-runtime-probe.js'), 'utf8');
  const runtimeCompare = fs.readFileSync(path.join(__dirname, 'portable-profile-runtime-compare.js'), 'utf8');
  assert(!runtimeProbe.includes('Object.keys(localStorage)'), 'runtime probes must not export the complete localStorage profile');
  assert(runtimeProbe.includes('comparisonStorage'), 'runtime probes must expose only the comparison-key whitelist');
  assert(runtimeProbe.includes('queueIdentities'), 'runtime probes must expose the complete queue identity order');
  assert(runtimeProbe.includes('function probeIsReady(result)'), 'runtime probes must wait for the final renderer and login APIs');
  assert(runtimeCompare.includes('baseline.comparisonStorage || baseline.allStorage || {}'),
    'runtime comparison must remain compatible with earlier validation snapshots');
  assert(runtimeCompare.includes('assert.deepEqual(fixed.queueIdentities, baseline.queueIdentities'));
  assert(runtimeCompare.includes("assert.deepEqual(fixed.audioEffects, baseline.audioEffects, 'equalizer state changed')"));
  assert(runtimeCompare.includes("assert.equal(fixed.smartTransitionLeadSec, baseline.smartTransitionLeadSec"));
  assert(runtimeCompare.includes("const installRoot = fs.existsSync(path.join(nestedInstallRoot, 'user-data'))"));
  assert(runtimeCompare.includes('Array.isArray(before.immutableKeyFiles)'));
  assert(runtimeCompare.includes("path.join(testRoot, 'AppData', 'Roaming', 'Mineradio')"));
  assert(runtimeCompare.includes("path.resolve(startupState.sessionData), path.resolve(profile)"));

  console.log('OK portable-profile-integration');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
