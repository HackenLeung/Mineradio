'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(appRoot, 'public', 'index.html'), 'utf8');
const indexCss = fs.readFileSync(path.join(appRoot, 'public', 'css', 'index.css'), 'utf8');
const dashboardScript = fs.readFileSync(
  path.join(appRoot, 'public', 'js', 'modules', '05-playback', '03a-home-dashboard.js'),
  'utf8',
);

function namedFunctionSource(source, name) {
  const declaration = new RegExp(`function\\s+${name}\\s*\\(`).exec(source);
  if (!declaration) return '';
  const bodyStart = source.indexOf('{', declaration.index + declaration[0].length);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}' && --depth === 0) return source.slice(declaration.index, index + 1);
  }
  return '';
}

test('Home keeps the local hero at its original desktop proportion', () => {
  assert.match(
    indexCss,
    /#empty-home \.empty-home-shell\s*\{[\s\S]*?grid-template-columns:\s*minmax\(520px,\s*\.47fr\)\s+minmax\(720px,\s*\.53fr\)/,
  );
  assert.match(indexCss, /#empty-home \.home-hero\s*\{[\s\S]*?min-height:\s*438px;[\s\S]*?padding:\s*28px/);
});

test('upstream Home content stays grouped in a responsive right-side scroller', () => {
  assert.match(indexHtml, /<div class="home-dashboard-right">[\s\S]*?home-quick-grid[\s\S]*?home-insight-dock[\s\S]*?home-legacy-rail/);
  assert.match(indexCss, /#empty-home \.home-dashboard-right\s*\{[\s\S]*?overflow-y:\s*auto/);
  assert.match(indexCss, /@media \(max-width:760px\)[\s\S]*?#empty-home \.home-dashboard-right\s*\{[\s\S]*?grid-column:\s*1;[\s\S]*?overflow:\s*visible/);
});

test('Home exposes the upstream podcast channel without duplicating playback logic', () => {
  assert.match(indexHtml, /class="home-insight-card home-ranking-entry home-podcast-entry"/);
  assert.match(indexHtml, /onclick="openHomeDashboardPodcasts\(\)"/);
  const handler = namedFunctionSource(dashboardScript, 'openHomeDashboardPodcasts');
  assert.match(handler, /setSearchMode\s*\(\s*['"]podcast['"]\s*\)/);
  assert.match(handler, /loadPodcastHot\s*\(\s*\)/);
});

test('the local Home edit action opens the restored custom Home editor dialog', () => {
  assert.match(indexHtml, /onclick="openHomeDashboardEditor\(\)"[^>]*>编辑内容</);
  assert.match(indexCss, /\.playlist-select-mask\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?z-index:\s*1900/);
  assert.match(indexCss, /\.playlist-select-dialog\s*\{[\s\S]*?background:\s*linear-gradient/);
  const editor = namedFunctionSource(dashboardScript, 'openHomeDashboardEditor');
  assert.match(editor, /mask\.className = 'playlist-select-mask'/);
  assert.match(editor, /document\.body\.appendChild\(mask\)/);
  assert.match(editor, /自定义首页/);
  assert.match(editor, /home-dashboard-editor-save/);
});

test('Home shell stays transparent while cards use neutral dark surfaces', () => {
  assert.match(indexCss, /--home-accent:\s*#ffffff/);
  assert.match(indexCss, /\/\* Keep the Home canvas open[\s\S]*?#empty-home \.empty-home-shell\s*\{[\s\S]*?background:\s*transparent !important;[\s\S]*?box-shadow:\s*none !important/);
  assert.match(indexCss, /#empty-home \.home-card,[\s\S]*?#empty-home \.home-discovery-strip\s*\{[\s\S]*?background:\s*linear-gradient\(145deg, rgba\(25, 29, 36/);
});

test('Home quick cards keep their content aligned near the top edge', () => {
  assert.match(
    indexCss,
    /#empty-home \.home-grid\.home-quick-grid \.home-card\s*\{[\s\S]*?display:\s*flex;[\s\S]*?flex-direction:\s*column;[\s\S]*?align-items:\s*flex-start;[\s\S]*?justify-content:\s*flex-start;[\s\S]*?padding:\s*14px 20px 20px/,
  );
});

test('Home action cards keep their click targets without decorative icons or arrows', () => {
  assert.doesNotMatch(indexHtml, /home-ranking-entry-art|home-radio-entry-art|home-next-arrow/);
  assert.doesNotMatch(indexCss, /#empty-home \.home-ranking-entry-art|#empty-home \.home-radio-entry-art|#empty-home \.home-next-arrow/);
  assert.match(indexCss, /#empty-home \.home-next-card\s*\{[\s\S]*?grid-template-columns:\s*82px minmax\(0, 1fr\)/);
  assert.match(indexCss, /#empty-home \.home-ranking-entry\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\)/);
  assert.match(indexHtml, /onclick="playHomeNextFromDock\(\)"/);
  assert.match(indexHtml, /onclick="openHomeDashboardCharts\(\)"/);
  assert.match(indexHtml, /onclick="openHomeListenRanking\(\)"/);
  assert.match(indexHtml, /onclick="openHomeDashboardRadio\(\)"/);
  assert.match(indexHtml, /onclick="openHomeDashboardPodcasts\(\)"/);
});
