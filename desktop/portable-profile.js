'use strict';

const path = require('path');

function resolvePortableProfilePaths(options = {}) {
  const packaged = options.packaged === true;
  const execPath = String(options.execPath || '');
  const developmentRoot = String(options.developmentRoot || '');
  const developmentUserData = String(options.developmentUserData || '').trim();
  const installRoot = packaged
    ? path.dirname(path.resolve(execPath))
    : path.resolve(developmentRoot);
  const userDataPath = packaged
    ? path.join(installRoot, 'user-data')
    : (developmentUserData ? path.resolve(developmentUserData) : '');

  return {
    installRoot,
    userDataPath,
    usesPortableUserData: packaged || Boolean(developmentUserData),
    cacheRootPath: path.join(installRoot, 'MineradioCache'),
  };
}

function ensurePortableUserDataDirectory(fsImpl, userDataPath, options = {}) {
  const requireExisting = options.requireExisting !== false;
  if (!fsImpl.existsSync(userDataPath)) {
    if (requireExisting) {
      const error = new Error(`未找到旧版用户数据目录：${userDataPath}`);
      error.code = 'PORTABLE_USER_DATA_MISSING';
      throw error;
    }
    fsImpl.mkdirSync(userDataPath, { recursive: true });
  }

  const stat = fsImpl.statSync(userDataPath);
  if (!stat.isDirectory()) {
    const error = new Error(`旧版用户数据路径不是文件夹：${userDataPath}`);
    error.code = 'PORTABLE_USER_DATA_NOT_DIRECTORY';
    throw error;
  }

  fsImpl.accessSync(userDataPath, fsImpl.constants.R_OK | fsImpl.constants.W_OK);
  const probePath = path.join(userDataPath, `.mineradio-write-probe-${process.pid}-${Date.now()}`);
  let descriptor;
  try {
    descriptor = fsImpl.openSync(probePath, 'wx');
  } catch (cause) {
    const error = new Error(`旧版用户数据目录不可写：${userDataPath}`);
    error.code = 'PORTABLE_USER_DATA_NOT_WRITABLE';
    error.cause = cause;
    throw error;
  } finally {
    if (descriptor !== undefined) {
      try { fsImpl.closeSync(descriptor); } catch (_) { }
      try { fsImpl.unlinkSync(probePath); } catch (_) { }
    }
  }
}

module.exports = {
  resolvePortableProfilePaths,
  ensurePortableUserDataDirectory,
};
