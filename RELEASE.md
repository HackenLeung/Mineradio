# Mineradio v1.3.2 发布说明

## 本次版本定位

`v1.3.2` 是 HackenLeung/Mineradio 的功能与稳定性更新，重点完善音乐库浏览、封面投递、本地智能过渡和播放状态恢复，同时保留维护版已有的桌面歌词、Wallpaper Engine、桌面锁定、遥控器、均衡器、视觉设置和安装目录用户数据。

当前维护仓库：`https://github.com/HackenLeung/Mineradio`

## 用户可见更新

- 新增舞台式 3D 音乐库封面墙，支持本地歌曲、文件夹和在线歌单的分层浏览。
- 本地歌曲页新增搜索、定位当前歌曲、悬浮“下一首播放”和回到顶部；当前歌曲定位使用一次性应用内高亮。
- 新增音乐库封面投递：卡片封面以 70% 起步沿抛物线进入播放器，联动粒子、节奏、控制条玻璃动画和歌词舞台。
- 封面投递加入令牌校验，切歌后旧动画不会覆盖封面或重播旧歌曲；无法加载的封面直接回退原有播放路径。
- 新增本地月度与年度听歌报告、统计海报和导出；仅统计有效播放，排名不足时不补造数据。
- 本地智能过渡会预准备下一首，读取 sidecar/内嵌歌词和匹配元数据定位人声进入点，未匹配歌曲不再请求无效歌词地址。
- 修复快照恢复与首页“恢复上次队列”后播放模式图标和实际行为不一致的问题。
- 局域网遥控支持二维码和 6 位配对码；监听器、来源校验、配对设备管理及媒体时钟冻结诊断均已加固。
- 继续加固旧播放请求隔离、音源回退、长暂停恢复、音频代理 Range 和本地封面/歌词持久化。
- 新旧用户仍使用安装目录下的 `user-data`；缓存使用同级 `MineradioCache`。

## 覆盖升级和用户数据

- 已安装用户应直接覆盖安装到原目录，例如 `D:\Mineradio`。
- 安装器优先采用注册表中的旧安装目录，不会默认换到另一个新目录。
- `<安装目录>\user-data` 是完整 Electron profile，包含设置、Cookies、localStorage、IndexedDB、登录分区、账号凭据、队列和本地库。
- `<安装目录>\MineradioCache` 仅保存可重新生成的缓存，`sessionData` 不跟随缓存目录移动。
- 覆盖安装不得复制、合并、移动或删除上述两个目录。
- 默认卸载保留两个目录；只有用户主动勾选“删除用户数据”时才删除。
- 旧安装目录缺少 `user-data` 或目录不可写时，安装器会停止并显示错误，不会创建一套空白正式数据。

## 发布前检查

- 确认 `package.json`、`package-lock.json`、运行时版本和内测配置均为 `1.3.2`。
- 确认更新与发布仓库为 `HackenLeung/Mineradio`。
- 确认 `.cookie`、`.qq-cookie`、`.kugou-cookie`、`user-data/`、`MineradioCache/`、`dist/`、`node_modules/`、`tmp/` 和 `工作区备份/` 未进入 Git。
- 运行 `git diff --check` 和 `node scripts/quick-check.js`。
- 使用一份旧 main 正式版 `user-data` 副本执行覆盖升级测试，比较安装前后文件数量和关键文件。
- 验证设置、完整队列、当前歌曲、本地库、小云/小狗/小Q登录、桌面歌词、托盘和下载设置。
- 启动后确认没有向 `%APPDATA%\Mineradio` 写入新的正式用户数据。
- 执行 `npm run build:win`，生成 Windows NSIS 安装包。

## 预期发布资产

- `dist/Mineradio-1.3.2-Setup.exe`
- `dist/Mineradio-1.3.2-Setup.exe.blockmap`
- `dist/Mineradio-1.3.2-SHA256SUMS.txt`
- `dist/latest.yml`

Release tag：

```text
v1.3.2
```

Release 标题：

```text
Mineradio v1.3.2 音乐库与本地播放体验更新
```

## 发布边界

- 本版本必须通过完整安装包交付安装器和用户数据兼容修复，不能只发布快速补丁。
- 不复用旧 `dist/` 或历史 packaged build，发布资产必须从当前源码重新构建。
- `v1.0.10` 及更早旧安装包仍不建议继续安装或传播。
- 当前修改版不是原项目作者发布或维护的官方版本；来源、署名和第三方移植边界见 README、NOTICE 与 `docs/THIRD_PARTY_PORTS.md`。
