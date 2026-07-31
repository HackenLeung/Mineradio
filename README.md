# Mineradio

Mineradio 是 Windows Electron 桌面音乐播放器，包含在线搜索与播放、本地音乐库、歌词舞台、粒子视觉、3D 歌单架、音频调节、桌面模式和自动更新。

当前维护仓库：[HackenLeung/Mineradio](https://github.com/HackenLeung/Mineradio)

## 本次更新内容（v1.3.1）

- **播放稳定性修复：** 修复旧歌曲的异步播放请求在切歌后继续影响新歌曲的问题，切歌失败时增加当前媒体和 token 校验，并完善音频代理的分段 Range 请求。
- **桌面歌词修复：** 主窗口生命周期清理时保留桌面歌词启用状态，重开后可继续恢复桌面歌词。
- **更新入口调整：** 更新入口启动即显示，改为点击后手动检查更新，避免后台频繁请求；标题栏图标统一为 SVG 尺寸和线条样式。
- **模块化架构同步：** 主界面运行时同步到模块化前端结构，并融合原有 Home、本地音乐、歌词、视觉控制台、桌面功能和远程控制能力，后续维护不再依赖旧版单文件前端。
- **本地音乐增强：** 保留已添加文件夹、完整本地元数据和在线匹配结果；继续优先读取自定义、同目录和内嵌封面/歌词，并新增“定位到当前歌曲”。
- **歌词匹配修复：** 自动匹配只使用小云、小狗、小Q，优先当前登录平台；已匹配且有可用歌词的歌曲直接复用，持久缓存保留翻译、逐字歌词和罗马音。批量匹配加入平台间隔和限流冷却，减少 `405 操作频繁`。
- **播放与过渡：** 保留智能过渡的音频和画面联动，删除独立的专辑“无缝衔接”和 Cuefield AutoMix 运行时；音源失败时按已登录平台有限回退，失败候选会回滚队列。
- **桌面与视觉：** 保留 Wallpaper Engine 原生 Scene 联动、锁定到桌面、桌面歌词、托盘控制、音乐魔方遥控器、均衡器、歌词布局、用户存档和视觉控制台。
- **覆盖升级兼容：** 新旧用户统一使用安装目录下的 `user-data` 完整 Electron profile；缓存位于同级 `MineradioCache`。覆盖安装沿用原安装目录，默认卸载保留两个目录，不迁移到 AppData，也不逐文件合并 Cookies、Local Storage 或 IndexedDB。
- **稳定性：** 加固完整队列恢复、小Q登录/会员状态、长暂停恢复、播放所有权、长列表虚拟化和安装/卸载路径安全。

## 近期基线（v1.2.1 - v1.2.6）

- 继续听恢复完整播放队列、当前歌曲、播放位置和“下一首播放”顺序。
- 过渡歌单使用节奏网格填充率区分能量，支持本地库节奏扫描和已听在线歌曲候选。
- Wallpaper Engine Scene 使用原生运行方式，桌面锁定会适配显示器坐标、分辨率和缩放变化。
- 本地音乐优先读取音频内嵌封面/歌词，在线匹配避免 Live、翻唱或错误版本覆盖本地信息。
- 桌面歌词、歌词设置、均衡器、托盘、悬浮遥控器和视觉用户存档均可持久化。

详细记录见 [CHANGELOG.md](./CHANGELOG.md)。

## 安装与覆盖升级

发布后从 [GitHub Releases](https://github.com/HackenLeung/Mineradio/releases) 下载并运行：

```text
Mineradio-1.3.1-Setup.exe
```

- 已安装用户应直接选择原安装目录，例如 `D:\Mineradio`，安装器会优先采用注册表记录的原路径。
- 正式用户数据位于 `<安装目录>\user-data`，包含设置、登录分区、Cookies、localStorage、IndexedDB、播放队列和本地库信息。
- 缓存位于 `<安装目录>\MineradioCache`，与 `user-data` 同级；`sessionData` 不会移动到缓存目录。
- 覆盖安装只替换程序文件，不复制、合并或移动上述两个目录。
- 默认卸载保留 `user-data` 和 `MineradioCache`；只有明确勾选“删除用户数据”时才删除。
- 旧目录存在但 `user-data` 缺失或不可写时，安装器会明确停止，不会创建空白数据冒充原用户资料。

## 核心能力

- 小云、小Q、小狗、小汽和 Spotify 账号、搜索及歌单接入
- 本地文件夹音乐库、二级歌单、内嵌/同目录封面与歌词
- 本地歌曲在线匹配、持久歌词缓存和当前歌曲定位
- 智能过渡、倍速/音调、均衡器、节奏分析和电影镜头
- 歌词舞台、桌面歌词、歌词布局、粒子视觉和 3D 歌单架
- Wallpaper Engine 原生联动、桌面锁定、托盘和悬浮遥控器
- Home、继续听、每日推荐、听歌画像、平台歌单和长列表虚拟化
- GitHub Releases 更新检测、完整安装包和安全安装/卸载流程

## 已知边界

- 第三方接口、账号状态、地区版权或会员权限不可用时，搜索、歌单、歌词或在线播放可能失败。
- Spotify 不直接提供可播放音频，Mineradio 仅使用其官方 Web API 同步账号资料、歌单和匹配信息，播放会自动换到可用来源。
- 桌面歌词、透明窗口、Wallpaper Engine 和桌面锁定受 Windows、显卡驱动、桌面软件和安全软件影响。
- 安装包目前未做商业代码签名，Windows SmartScreen 可能显示未知发布者，请只从当前维护仓库下载。

## 项目来源、维护与使用边界

- **当前项目与维护：** [HackenLeung/Mineradio](https://github.com/HackenLeung/Mineradio) 是 Mineradio 的 Windows Electron 社区维护版；当前功能融合、Windows 构建、版本发布和问题处理由 [@HackenLeung](https://github.com/HackenLeung) 负责。
- **原项目与原作者：** 本项目基于 [XxHuberrr/Mineradio](https://github.com/XxHuberrr/Mineradio) 继续开发，原作者为 [@XxHuberrr](https://github.com/XxHuberrr)，仓库保留原始署名和版权信息。
- **同步与参考：** v1.3.1 延续了原项目后续模块化架构和部分功能，并融合当前维护版既有实现；Wallpaper Engine 与完整桌面/Home 方向还参考了 [ww085213/Mineradio-LX-Music](https://github.com/ww085213/Mineradio-LX-Music)。具体来源与边界见 [NOTICE.md](./NOTICE.md) 和 [THIRD_PARTY_PORTS.md](./docs/THIRD_PARTY_PORTS.md)。
- **版本关系：** 当前仓库发布的修改版不是原项目作者发布或维护的官方版本；本仓库的修改、说明和发布行为不代表原作者或参考项目维护者认可、授权、担保或背书。
- **内容与账号边界：** 仓库不分发歌曲、歌词库、专辑封面库、平台歌单数据库、壁纸素材或账号凭据，也不提供绕过付费、会员、地区或版权限制的能力。
- **隐私与反馈：** 登录状态和 Cookie 仅保存在用户本机。详见 [PRIVACY.md](./PRIVACY.md) 与 [SECURITY.md](./SECURITY.md)；问题请提交到当前仓库的 [GitHub Issues](https://github.com/HackenLeung/Mineradio/issues)。

## 开发运行

```powershell
npm install
npm start
npm run build:win
```

桌面版由 Electron 主进程加载本地服务。前端运行时代码位于 `public/js/modules/`，入口由 `public/js/index-loader.js` 按顺序加载；不要再把当前模块化实现回退成旧版单文件架构。

常用检查：

```powershell
git diff --check
node scripts/quick-check.js
npm run build:win
```

## 用户数据与隐私

登录 Cookie（`.cookie`、`.qq-cookie`、`.kugou-cookie` 等）、搜索历史、自定义封面、自定义歌词、播放会话、听歌统计和本地节奏分析缓存只应保存在安装目录的 `user-data` 或 `MineradioCache` 中，不应提交到仓库。

更多说明见 [PRIVACY.md](./PRIVACY.md)。

## 版权与授权

Copyright (C) 2026 XxHuberrr and contributors.

本项目采用 GPL-3.0 授权。详见 [LICENSE](./LICENSE)。

MR Logo、Mineradio 名称、界面视觉设计与原创视觉表达归原权利人所有；第三方依赖、第三方服务、平台名称、歌曲内容、歌词、封面和商标分别遵循其各自授权、版权规则和服务条款。
