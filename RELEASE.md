# Mineradio v1.3.0 发布说明

## 本次版本定位

`v1.3.0` 是 HackenLeung/Mineradio 维护版的大版本功能同步与融合版本。它采用后续模块化架构，同时保留维护版原有的本地音乐、智能过渡、桌面歌词、Wallpaper Engine、桌面锁定、遥控器、均衡器、视觉设置和安装目录用户数据。

当前维护仓库：`https://github.com/HackenLeung/Mineradio`

## 用户可见更新

- 多平台账号、搜索和歌单流程补充到小云、小Q、小狗、小汽和 Spotify。
- 本地音乐文件夹、内嵌封面/歌词、匹配结果和完整播放队列继续持久保存。
- 本地歌词匹配优先当前平台，仅使用小云、小狗、小Q；已匹配歌曲跳过重复请求，翻译/逐字/罗马音写入持久缓存。
- 批量歌词匹配增加平台请求间隔和 405 限流冷却。
- 本地歌单增加“定位到当前歌曲”。
- 智能过渡继续保留，删除独立“无缝衔接”和 Cuefield AutoMix 引擎。
- 加固播放失败自动换源、长暂停恢复、小Q授权/会员状态和长列表性能。
- 新旧用户均使用安装目录下的 `user-data`；缓存使用同级 `MineradioCache`。

## 覆盖升级和用户数据

- 已安装用户应直接覆盖安装到原目录，例如 `D:\Mineradio`。
- 安装器优先采用注册表中的旧安装目录，不会默认换到另一个新目录。
- `<安装目录>\user-data` 是完整 Electron profile，包含设置、Cookies、localStorage、IndexedDB、登录分区、账号凭据、队列和本地库。
- `<安装目录>\MineradioCache` 仅保存可重新生成的缓存，`sessionData` 不跟随缓存目录移动。
- 覆盖安装不得复制、合并、移动或删除上述两个目录。
- 默认卸载保留两个目录；只有用户主动勾选“删除用户数据”时才删除。
- 旧安装目录缺少 `user-data` 或目录不可写时，安装器会停止并显示错误，不会创建一套空白正式数据。

## 发布前检查

- 确认 `package.json`、`package-lock.json`、运行时版本和内测配置均为 `1.3.0`。
- 确认更新与发布仓库为 `HackenLeung/Mineradio`。
- 确认 `.cookie`、`.qq-cookie`、`.kugou-cookie`、`.spotify-token.json`、`user-data/`、`MineradioCache/`、`dist/`、`node_modules/`、`tmp/` 和 `工作区备份/` 未进入 Git。
- 运行 `git diff --check` 和 `node scripts/quick-check.js`。
- 使用一份旧 main 正式版 `user-data` 副本执行覆盖升级测试，比较安装前后文件数量和关键文件。
- 验证设置、完整队列、当前歌曲、本地库、小云/小狗/小Q登录、桌面歌词、托盘和下载设置。
- 启动后确认没有向 `%APPDATA%\Mineradio` 写入新的正式用户数据。
- 执行 `npm run build:win`，生成 Windows NSIS 安装包。

## 预期发布资产

- `dist/Mineradio-1.3.0-Setup.exe`
- `dist/Mineradio-1.3.0-Setup.exe.blockmap`
- `dist/Mineradio-1.3.0-SHA256SUMS.txt`
- `dist/latest.yml`

Release tag：

```text
v1.3.0
```

Release 标题：

```text
Mineradio v1.3.0 功能同步与兼容升级
```

## 发布边界

- 本版本必须通过完整安装包交付安装器和用户数据兼容修复，不能只发布快速补丁。
- 不复用旧 `dist/` 或历史 packaged build，发布资产必须从当前源码重新构建。
- `v1.0.10` 及更早旧安装包仍不建议继续安装或传播。
- 当前修改版不是原项目作者发布或维护的官方版本；来源、署名和第三方移植边界见 README、NOTICE 与 `docs/THIRD_PARTY_PORTS.md`。
