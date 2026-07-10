# Mineradio v1.1.5 开发更新与提交审计

## 本次开发内容

- 三平台展示名统一为小云、小Q、小狗，内部协议标识和 Cookie 文件名保持兼容。
- 增加 30/45/60 FPS 分档限帧、失焦 24 FPS、最小化 1 FPS，并保留超高画质高刷模式。
- 恢复 Chromium 后台节流，本地库扫描和 WebGL 预热改为启动页退出后错峰执行。
- 小云、小Q、小狗三平台账号状态同时保留，界面默认聚焦当前平台，“全部”仅用于汇总。
- 小狗新增二维码、网页和 Cookie 登录，接入账号、歌单、歌单详情、搜索、播放地址、歌词与音质选择。
- 搜索新增 `KG`，`All` 聚合三平台并优先排列当前账号平台结果。
- 本地音乐库支持选择并恢复文件夹、文件夹二级歌单、同目录封面/歌词、本地搜索和默认 MR 节奏分析。
- 支持导入小Q、小云、酷我、小狗和咪咕公开歌单，并在本地保存。
- Home 增加紧凑歌单卡片、排序、自定义图片和文案；天气改为 Open-Meteo 当前天气，不再生成天气电台。
- 自定义首页集中管理天气显示、IP 定位和城市更新；接口不可用或数据无效时不渲染天气区域。
- 增加托盘播放控制、关闭到托盘、开机启动、沉浸自动全屏、倍速/音调、均衡器和歌词布局控制。
- 增加 Wallpaper Engine 素材浏览、隐藏/恢复和壁纸镜像。

## 用户数据与隐私

- Electron 正式运行时，小云、小Q、小狗会话文件位于 Electron `userData` 目录。
- 直接运行 `server.js` 时，项目根目录可能生成 `.cookie`、`.qq-cookie` 或 `.kugou-cookie`。
- `.kugou-cookie` 用于保存小狗会话和设备标识；即使当前文件只有设备标识，也按私有数据处理。
- 上述 Cookie 文件均已由 `.gitignore` 排除，不应提交、上传或粘贴到 Issue。
- 小狗签名常量是客户端协议兼容参数，不是用户账号凭据；用户 Cookie、token 和二维码登录结果不会写入源码。

## 提交审计

可以提交的源码和文档：

- `.gitignore`
- `AGENTS.md`
- `README.md`
- `CHANGELOG.md`
- `desktop/main.js`
- `desktop/preload.js`
- `docs/PROJECT_MEMORY.md`
- `docs/HANDOFF_NEXT_CHAT.md`
- `docs/DEVELOPMENT_UPDATE_2026-07-10.md`
- `package.json`
- `package-lock.json`
- `platform-playlist-import.js`
- `public/index.html`
- `public/wallpaper.html`
- `server.js`

不得提交的本地数据和产物：

- `.cookie`、`.qq-cookie`、`.kugou-cookie`
- `dist/`、`win-unpacked/`、安装包和 blockmap
- `node_modules/`
- `tmp/`、`output/`、`screenshots/`、`verification/`
- `工作区备份/`

审计结果：未提交 diff 中没有发现真实 Cookie 值、账号 token、GitHub token、API 私钥、用户图片或 Codex 临时截图路径。`platform-playlist-import.js` 虽然是未跟踪文件，但它被服务端加载并列入 electron-builder 打包清单，属于必须提交的功能源码。

依赖审计补充：使用 npm 官方 registry 执行 `npm audit --omit=dev` 后，现有 `NeteaseCloudMusicApi -> music-metadata -> file-type` 链路报告 3 个漏洞（2 个 high、1 个 moderate）。当前 `NeteaseCloudMusicApi@4.32.0` 已是上游最新版，npm 建议的 `audit fix --force` 会降级到不兼容的 3.x，因此本轮没有自动改依赖。新增的 `qrcode` 不是这组漏洞的来源；正式发布前仍需跟踪上游修复或单独验证兼容升级方案。

## 提交前检查

```powershell
git status --short --ignored
git diff --check
node --check server.js
node --check desktop/main.js
node --check desktop/preload.js
node --check platform-playlist-import.js
```
