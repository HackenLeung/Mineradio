# Mineradio v1.3.3 发布说明

## 本次版本定位

`v1.3.3` 是播放、歌词和桌面启动稳定性更新。重点处理本地歌曲起播卡顿、暂停时歌词跳错歌、魔方隐藏窗口被重新显示，以及冷启动慢时误报主窗口加载失败的问题。

当前维护仓库：`https://github.com/HackenLeung/Mineradio`

## 用户可见更新

- 本地歌曲播放前会先准备输出设备和 WebAudio 音频图，再开始播放；不再在起播后重复切换输出设备。
- 修复部分本地歌曲已经有大量缓冲、但进度卡在 `0:00` 数秒的问题；本地文件遇到媒体时钟冻结时会更快进入恢复，不影响在线歌曲原有等待策略。
- 修复暂停时歌词偶尔跳到别的歌或显示错误“暂无歌词”标题的问题。网络、缓存、本地歌词匹配、延迟兜底和翻译补偿都会确认仍属于当前歌曲，旧请求晚到会被丢弃。
- 修复从魔方或托盘主动隐藏主窗口后，启动页加载完成又把窗口显示出来的问题；主动从托盘、魔方或第二次启动应用时仍可正常打开主窗口。
- 修复页面已可用、但个别资源加载慢时被 15 秒导航超时误判为“主窗口加载失败”的问题；真正未进入可用状态或渲染进程异常时仍会显示错误。
- 启动模块由浏览器逐个同步请求 111 个文件改为服务端并行读取、一次返回，缩短冷启动的本地请求往返。合并端点异常时会自动退回原加载方式。

## 覆盖升级和用户数据

- 已安装用户应直接覆盖安装到原目录，例如 `D:\Mineradio`。
- `<安装目录>\user-data` 继续保存完整 Electron profile，含设置、Cookies、localStorage、IndexedDB、登录分区、账号凭据、队列和本地库。
- `<安装目录>\MineradioCache` 继续保存可重新生成缓存。
- 覆盖安装不复制、合并、移动或删除以上两个目录；默认卸载同样保留它们，只有用户主动勾选“删除用户数据”才会删除。

## 发布前检查

- 确认 `package.json`、`package-lock.json`、运行时版本、更新弹窗和内测配置均为 `1.3.3`。
- 确认更新与发布仓库为 `HackenLeung/Mineradio`。
- 确认 `.cookie`、`.qq-cookie`、`.kugou-cookie`、`user-data/`、`MineradioCache/`、`dist/`、`node_modules/`、`tmp/` 和 `工作区备份/` 未进入 Git。
- 运行 `git diff --check` 和所有 `tests/*.test.js`；本次共 58 个测试文件逐个执行，全部通过。
- 验证本地歌连续切换、暂停/继续、魔方隐藏/打开、启动恢复和歌词异步回填。
- 使用一份旧正式版 `user-data` 副本执行覆盖升级测试，确认设置、完整队列、本地库、平台登录、桌面歌词、托盘和下载设置继续保留。
- 执行 `npm run build:win`，生成 Windows NSIS 安装包。

## 预期发布资产

- `dist/Mineradio-1.3.3-Setup.exe`
- `dist/Mineradio-1.3.3-Setup.exe.blockmap`
- `dist/Mineradio-1.3.3-SHA256SUMS.txt`
- `dist/latest.yml`

Release tag：

```text
v1.3.3
```

Release 标题：

```text
Mineradio v1.3.3 播放、歌词与启动稳定性更新
```

## 发布边界

- 本版本必须通过完整安装包交付，不能只发布快速补丁。
- 不复用旧 `dist/` 或历史 packaged build，发布资产必须从当前源码重新构建。
- `scripts/quick-check.js` 中歌词滚动性能检查有历史基线失败：`space/button pause resume must use a fast paused-audio path...`；该失败在未修改基线同样存在，不属于本版本改动。
- 当前修改版不是原项目作者发布或维护的官方版本；来源、署名和第三方移植边界见 README、NOTICE 与 `docs/THIRD_PARTY_PORTS.md`。
