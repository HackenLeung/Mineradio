'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const installer = fs.readFileSync(path.join(root, 'build', 'installer.nsh'), 'utf8');
const afterPack = fs.readFileSync(path.join(root, 'build', 'after-pack.js'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const indexHtml = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const updatePreview = fs.readFileSync(path.join(root, 'public', 'js', 'modules', '08-account', '00-update-preview.js'), 'utf8');

function functionBody(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = installer.match(new RegExp(`Function ${escaped}\\r?\\n([\\s\\S]*?)\\r?\\nFunctionEnd`));
  assert.ok(match, `${name} must exist`);
  return match[1];
}

assert.doesNotMatch(installer, /RMDir\s+\/r\s+"\$INSTDIR"(?:\r?\n|$)/,
  'the installer root must never be deleted recursively');
assert.match(installer, /Section \/o "un\.删除用户数据（设置、缓存和登录状态）"/,
  'user data deletion must remain an explicit opt-in uninstall section');
assert.match(installer, /RMDir \/r "\$INSTDIR\\user-data"/);
assert.match(installer, /RMDir \/r "\$INSTDIR\\MineradioCache"/);
assert.match(installer, /RMDir \/r "\$LOCALAPPDATA\\mineradio-updater"/);
assert.match(installer, /RMDir \/r "\$INSTDIR\\resources"/,
  'program resources must be removed before update extraction so stale code cannot survive');
assert.match(installer, /RMDir \/r "\$INSTDIR\\locales"/);
assert.match(installer, /!macro customFiles_x64[\s\S]*!insertmacro MineradioReplacePackagedProgramDirectories/,
  'the current installer must replace stale program directories left by a main-era uninstaller');
assert.match(installer, /RMDir \/r "\$INSTDIR\\resources"[\s\S]*CopyFiles \/SILENT "\$PLUGINSDIR\\7z-out\\resources" "\$INSTDIR"/);
assert.doesNotMatch(installer, /\$PLUGINSDIR\\7z-out\\(?:user-data|MineradioCache)/,
  'post-extraction replacement must never source or replace user data directories');

const preferred = functionBody('MineradioUsePreferredInstallDir');
assert.ok(preferred.indexOf('Call MineradioUseRegisteredInstallDir') < preferred.indexOf('${GetOptions} $R0 "/D=" $R1'),
  'a valid registered legacy directory must take priority over /D and defaults');
assert.match(preferred, /\$R2 == "2"[\s\S]*没有找到原 user-data[\s\S]*Abort/,
  'a broken registered legacy install must stop instead of falling back to a fresh directory');
assert.match(functionBody('MineradioRegisteredInstallPathCanBeUsed'), /IfFileExists "\$2\\user-data\\\." usable 0/);
assert.match(functionBody('MineradioRegisteredInstallPathCanBeUsed'), /broken:[\s\S]*StrCpy \$1 "2"/);
assert.doesNotMatch(functionBody('MineradioUseRegisteredInstallDir'), /Call MineradioNormalizeInstallDir/,
  'the exact registered legacy install directory must not be renamed or nested');

const normalize = functionBody('MineradioNormalizeInstallDir');
assert.match(normalize, /ExpandEnvStrings \$0 "\$0"/);
['$1', '$2', '$3', '$4', '$5'].forEach(register => {
  assert.ok(normalize.includes(`Push ${register}`), `${register} must be preserved before use`);
  assert.ok(normalize.includes(`Pop ${register}`), `${register} must be restored after use`);
});

const adopt = functionBody('MineradioExistingInstallPathCanBeAdopted');
assert.match(adopt, /Call MineradioInstallDirContainsOnlyUserData/,
  'a dedicated install folder containing only portable user data must remain migratable');
assert.match(functionBody('MineradioInstallDirContainsOnlyUserData'), /StrCmp \$2 "user-data" userData 0/);
assert.match(functionBody('MineradioInstallDirContainsOnlyUserData'), /StrCmp \$2 "MineradioCache" cacheData reject/,
  'a normally uninstalled directory may retain the adjacent disposable cache');
assert.match(functionBody('MineradioInstallDirContainsOnlyUserData'), /cacheData:[\s\S]*IfFileExists "\$0\\MineradioCache\\\." 0 reject[\s\S]*Goto next/);

const quarantine = functionBody('MineradioDisableUnsafeOldUninstallers');
assert.equal((quarantine.match(/Call MineradioDeleteLegacyUninstallerFileIfMissingMarker/g) || []).length, 4);
assert.equal((quarantine.match(/Call MineradioOldInstallPathNeedsQuarantine/g) || []).length, 4);
assert.equal((quarantine.match(/Call MineradioDeleteLegacyUninstallerFileIfMissingMarker\r?\n\s+Pop \$1/g) || []).length, 4,
  'legacy uninstaller cleanup must consume every helper return value');

const uninstallValidation = functionBody('un.MineradioValidateUninstallDir');
assert.match(uninstallValidation, /Call un\.MineradioNormalizeInstallDir/);
assert.match(uninstallValidation, /Call un\.MineradioInstallDirLooksOwned/);
assert.match(uninstallValidation, /SetErrorLevel 2[\s\S]*?Quit/);

const removeFiles = functionBody('un.MineradioRemoveInstalledFiles');
assert.match(removeFiles, /RMDir \/r "\$INSTDIR\\resources"/);
assert.doesNotMatch(removeFiles, /RMDir \/r "\$INSTDIR\\user-data"/,
  'default uninstall/update cleanup must preserve the adjacent complete profile');
assert.doesNotMatch(removeFiles, /RMDir \/r "\$INSTDIR\\MineradioCache"/,
  'default uninstall/update cleanup must preserve the adjacent cache root');
assert.match(removeFiles, /Delete "\$INSTDIR\\\.mineradio-install-root"|Delete "\$INSTDIR\\\$\{MINERADIO_INSTALL_MARKER\}"/);
assert.match(removeFiles, /Delete "\$INSTDIR\\resources\\app-update\.yml"/);
assert.doesNotMatch(removeFiles, /user-data|MineradioCache/,
  'default uninstall must leave the portable profile and adjacent cache untouched');

assert.match(installer, /CreateDirectory "\$INSTDIR\\user-data"/,
  'a fresh install must create an empty user-data dir so the packaged runtime (requireExisting) can start');
assert.match(installer, /CreateDirectory "\$INSTDIR\\user-data"[\s\S]*\$\{If\} \$\{Errors\}[\s\S]*无法创建或访问用户数据目录[\s\S]*Abort/);
assert.match(functionBody('MineradioValidateInstallDir'), /legacyProfileMissing:[\s\S]*没有找到原 user-data[\s\S]*Abort/,
  'an existing Mineradio program directory without user-data must not be treated as a fresh install');
assert.match(functionBody('MineradioUserDataPathIsWritable'), /FileOpen \$2 "\$0\\\.mineradio-installer-write-probe\.tmp" w/);
assert.match(functionBody('MineradioValidateInstallDir'), /legacyProfileCheckWritable:[\s\S]*Call MineradioUserDataPathIsWritable[\s\S]*旧版用户数据目录不可写[\s\S]*Abort/);

assert.match(afterPack, /fs\.rmSync\(appUpdateConfigPath, \{ force: true \}\)/,
  'unused electron-builder updater metadata must not recreate the legacy updater cache');

assert.equal(packageJson.mineradio.update.owner, 'HackenLeung');
assert.equal(packageJson.build.publish[0].owner, 'HackenLeung');
assert.match(indexHtml, /class="update-version-row"[\s\S]*?https:\/\/github\.com\/HackenLeung\/Mineradio/);
assert.match(updatePreview, /updatePreviewState\.downloadUrl = '';[\s\S]*?updatePreviewState\.patchAvailable = false/);
assert.match(updatePreview, /function openUpdatePanel\(\)[\s\S]*?正在检查 GitHub 最新版本。[\s\S]*?checkLatestUpdate\(\)\.finally/);
assert.match(updatePreview, /function startUpdatePreviewDownload\(\)[\s\S]*?https:\/\/github\.com\/HackenLeung\/Mineradio\/releases\/tag\/v[\s\S]*?window\.open\(releaseUrl, '_blank'\)/);

console.log('OK installer-safety-integration');
