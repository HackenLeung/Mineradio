function estimateLyricTextureMemoryMB(lineCount, widthBudget, heightPerLine) {
  if (!lineCount || lineCount <= 0) return 0;
  widthBudget = widthBudget || 2048;
  heightPerLine = heightPerLine || Math.min(384, 64 + lineCount * 21);
  var pixelsPerLine = widthBudget * heightPerLine;
  var bytesPerLine = pixelsPerLine * 4;
  return (bytesPerLine * lineCount) / (1024 * 1024);
}

function shouldDowngradeLyricQuality(lineCount) {
  var profile = (typeof runtimeHardwareProfile !== 'undefined' && runtimeHardwareProfile) ? runtimeHardwareProfile : null;
  if (!profile || !lineCount || lineCount <= 0) return null;
  var gpuMemoryMB = profile.gpuMemoryMB || 0;
  var deviceMemoryGB = profile.deviceMemoryGB || 0;
  var lowMemory = deviceMemoryGB > 0 && deviceMemoryGB <= 4;
  var veryLowMemory = gpuMemoryMB > 0 && gpuMemoryMB <= 512;
  if (!gpuMemoryMB && lowMemory) {
    gpuMemoryMB = deviceMemoryGB <= 4 ? 512 : (deviceMemoryGB <= 8 ? 1024 : 2048);
  }
  if (gpuMemoryMB <= 0) return null;
  var currentQuality = (typeof fx !== 'undefined' && fx && fx.performanceQuality) ? String(fx.performanceQuality) : 'default';
  var isLowOrBalanced = currentQuality === 'eco' || currentQuality === 'balanced';
  var widgetLow = (typeof lyricRowTextureWidthBudget === 'function') ? lyricRowTextureWidthBudget() : 1024;
  var estimatedMB = estimateLyricTextureMemoryMB(lineCount, widgetLow, 384);
  var memoryPressure = estimatedMB / gpuMemoryMB;
  if (veryLowMemory && memoryPressure > 0.15) {
    return { from: currentQuality, to: 'eco', reason: 'vram-critical', pressure: memoryPressure, estimatedMB: Math.round(estimatedMB), gpuMemoryMB: gpuMemoryMB };
  }
  if (lowMemory && !isLowOrBalanced && memoryPressure > 0.18) {
    return { from: currentQuality, to: 'balanced', reason: 'vram-high', pressure: memoryPressure, estimatedMB: Math.round(estimatedMB), gpuMemoryMB: gpuMemoryMB };
  }
  if (memoryPressure > 0.25 && currentQuality !== 'eco') {
    return { from: currentQuality, to: isLowOrBalanced ? 'eco' : 'balanced', reason: 'vram-very-high', pressure: memoryPressure, estimatedMB: Math.round(estimatedMB), gpuMemoryMB: gpuMemoryMB };
  }
  return null;
}

var lyricQualityDowngradeState = {
  warned: false,
  appliedDowngrade: null,
  lastCheckAt: 0,
  lastLineCount: 0
};

function checkAndApplyLyricQualityDowngrade(lineCount) {
  var now = performance.now();
  if (now - lyricQualityDowngradeState.lastCheckAt < 1000 && lyricQualityDowngradeState.lastLineCount === lineCount) {
    return lyricQualityDowngradeState.appliedDowngrade;
  }
  lyricQualityDowngradeState.lastCheckAt = now;
  lyricQualityDowngradeState.lastLineCount = lineCount;
  var downgrade = shouldDowngradeLyricQuality(lineCount);
  if (!downgrade) {
    lyricQualityDowngradeState.appliedDowngrade = null;
    return null;
  }
  if (!lyricQualityDowngradeState.warned) {
    lyricQualityDowngradeState.warned = true;
    console.warn('[Lyric Quality] Auto-downgrade:', downgrade.from, '->', downgrade.to, '|', downgrade.reason, '| pressure:', (downgrade.pressure * 100).toFixed(1) + '%', '| est:', downgrade.estimatedMB + 'MB', '/', downgrade.gpuMemoryMB + 'MB GPU');
  }
  lyricQualityDowngradeState.appliedDowngrade = downgrade;
  return downgrade;
}
