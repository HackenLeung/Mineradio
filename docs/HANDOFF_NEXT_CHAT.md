# Mineradio Next Chat Handoff

更新时间：2026-07-18

## 2026-07-18 当前开发状态

- 当前源码版本：`v1.2.1`。
- 当前维护仓库：`https://github.com/HackenLeung/Mineradio`；原项目和原作者署名仍按 README 保留。
- 已接入小云、小狗双平台账号与搜索；默认只显示当前平台账号、搜索、歌单和排行，本地排行保留。
- 已移除/隐藏小Q相关前端入口；旧 `/api/qq/*` 兼容路由不再作为功能入口，后续不要恢复 QQ UI/API。
- 已接入本地文件夹音乐库、二级歌单、同目录封面/歌词、重启恢复、默认 MR 分析和本地歌曲手动在线匹配。
- 本地歌曲手动匹配入口在歌曲详情和评论空状态；默认按当前平台优先搜索，可切小云/小狗，选中后用于封面、歌词、评论入口和自然听歌上报。
- 评论接口目前只接入小云：本地歌匹配到小云可显示评论，匹配到小狗只用于封面、歌词和上报，评论区提示小狗评论接口未接入。
- 已接入平台歌单导入、托盘控制、倍速/音调、均衡器、歌词布局和壁纸浏览/镜像。
- Home 已改为紧凑歌单与自定义图片文案；天气只显示 Open-Meteo 当前天气，定位/城市设置位于自定义首页，失败时隐藏。
- 提交前排除 `.cookie`、`.kugou-cookie`、`dist/`、`node_modules/`、`tmp/` 和 `工作区备份/`；`platform-playlist-import.js` 需要提交。
- 详细内容与提交审计见 `docs/DEVELOPMENT_UPDATE_2026-07-10.md`。下方 v1.1.0 发布说明为历史记录。

## 新对话先执行

```powershell
cd D:\projects\Mineradio
git status --short --branch
git log --oneline -5 --decorate
Get-Content AGENTS.md
Get-Content docs\PROJECT_MEMORY.md
Get-Content docs\HANDOFF_NEXT_CHAT.md
```

如涉及 3D 歌单架、安全重建、发布、安装包或旧备份取用，再读：

```powershell
Get-Content docs\3D_PLAYLIST_SHELF_MEMORY.md
Get-Content docs\SECURITY_REBUILD_2026-06-24.md
Get-Content CHANGELOG.md -TotalCount 80
Get-Content RELEASE.md
```

## 当前状态

- 当前真实代码/Git 仓库：`D:\projects\Mineradio`
- 当前版本：`v1.2.1`
- 当前发布策略：从当前可信源码构建完整 Windows 安装包，并生成配套 `.blockmap` 与 `latest.yml`。
- `v1.2.1` 本地构建资产为 `dist/Mineradio-1.2.1-Setup.exe`、对应 `.blockmap` 和 `dist/latest.yml`。
- 安装包样式继续沿用 `docs/INSTALLER_STYLE.md` 的中文极简黑白蓝格式。
- 当前维护仓库：`https://github.com/HackenLeung/Mineradio`。

## 本轮重点

- 已将本地默认测试用户存档设为首次启动默认用户存档和软件内默认视觉参数。
- 新增 `public/default-user-fx-archive.json`，代码中 `PACKAGED_DEFAULT_FX_SNAPSHOT` 与该 JSON 已脚本比对一致。
- 没有本地 `mineradio-lyric-layout-v1` 时，`readSavedLyricLayout()` 使用 packaged 默认快照；没有本地用户存档 key 时自动创建「默认测试」槽位。
- 已恢复详细日志和发布说明：`CHANGELOG.md`、`README.md`、`SECURITY.md`、`RELEASE.md`、`docs/SECURITY_REBUILD_2026-06-24.md`、`docs/RELEASE_NOTES_v1.1.0.md`。
- 已生成安装包：`dist/Mineradio-1.1.0-Setup.exe`。
- 已生成校验文件：`dist/Mineradio-1.1.0-SHA256SUMS.txt`。
- 已发布资产：安装包、blockmap、SHA256SUMS；未上传 `latest.yml`。
- 已批量给旧 Release（`v1.0.10` 到 `v0.9.9`）正文顶部追加旧安装包隔离警示。

## 已知验证

- `git diff --check`：通过。
- `node --check server.js`：通过。
- 前端 `public/index.html` 5 个内联脚本解析：通过。
- `public/default-user-fx-archive.json` JSON 解析：通过。
- 代码内置默认快照与 `public/default-user-fx-archive.json` 字段比对：一致。
- Git 跟踪高风险残留检查：没有匹配 `.exe/.dll/.scr/.bat/.cmd/.ps1/.vbs/.jse/.wsf/.hta/.xlsm/.msi`。
- `npm run build:win`：旧代理 `127.0.0.1:26001` 不可用；当前本机代理端口为 `127.0.0.1:7890`，electron-builder 下载 NSIS 构建资源时应使用该端口。
- Defender 状态：实时防护开启，签名版本 `1.453.247.0`。
- Defender 已扫描新安装包和 `dist\win-unpacked`；`Get-MpThreatDetection` 查询为空。
- 安装包 SHA256：`bd53aae4e551f5b0b5a398a51e6ec1de5a9a57cb42e5eecedb0a1647fdcee6e6`。

## 发布注意

- GitHub CLI / electron-builder 命令需要在命令内覆盖代理：

```powershell
$env:HTTP_PROXY='http://127.0.0.1:7890'
$env:HTTPS_PROXY='http://127.0.0.1:7890'
$env:ALL_PROXY='socks5://127.0.0.1:7890'
```

- 发布 `v1.1.0` 时不要上传 `dist/latest.yml`。
- Release 建议上传：
  - `dist/Mineradio-1.1.0-Setup.exe`
  - `dist/Mineradio-1.1.0-Setup.exe.blockmap`
  - `dist/Mineradio-1.1.0-SHA256SUMS.txt`
- Release 正文使用 `docs/RELEASE_NOTES_v1.1.0.md`。
- Release 需要 `--latest=false` 或等价 API，避免旧版客户端通过 `/releases/latest` 自动发现。
- 旧 release 尤其 `v1.0.10` 需要追加隔离警示，不要删除旧资产。

## 不要做

- 不要按旧的 `E:\桌面\播放器软件\Mineradio\resources\app` 路径操作；当前本地有效源码在 `D:\projects\Mineradio`。
- 不要从 `工作区备份\2026-06-18-workspace-cleanup`、旧 `dist`、旧 `node_modules` 或旧 packaged build 中恢复可执行产物。
- 不要使用 `git reset --hard` 或 `git checkout --` 回滚用户改动。
- 不要把 `v1.1.0` 当作 `v1.0.10` 的软件内更新发布。
- 不要上传 `latest.yml` 或 `v1.0.10 -> v1.1.0` 快速补丁。
