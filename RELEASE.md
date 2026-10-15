# Mineradio v1.4.1 发布说明

## 本次版本定位

`v1.4.1` 是维护更新，主体是小云音源换到维护中的上游包，以及由此恢复的取播放地址、评论发布和收藏歌单。红心数作为新增信息进入歌曲详情、底栏、搜索结果和搜索墙，音质档位同时补齐「臻音全景」。

当前维护仓库：`https://github.com/HackenLeung/Mineradio`

## 用户可见更新

- 小云音源统一到 `@neteasecloudmusicapienhanced/api` 4.41.1，停更的旧包 `NeteaseCloudMusicApi@4.32.0` 已移除。
- 修复升级后取播放地址失败。上游 `song/url/v1` 走 xeapi 通道，需要临时目录里的公钥；服务启动即生成，缺失时在 8 秒上限内重试一次。就绪判定读真实落盘的公钥，等待不再越过取地址的 4800ms 预算。
- 修复评论发布、回复评论和收藏歌单。上游换成 eapi v2 写入，收藏歌单的 checkToken 从布尔值改为 `v2`。
- 新增红心数。歌曲详情弹窗、底栏爱心按钮、搜索结果行与搜索墙卡片都显示，切歌与红心时一起刷新。
- 新增「臻音全景」档。上游把 `jyeffect` 从高清环绕声改叫高清臻音，此前会被归一成 `hires`，现在单独成档，降级判定按真实档位记账。
- 修复详情弹窗串歌、红心数取数无上限堆积、红心数显示口径不一致。

## 已知边界

- 红心数只有小云音源提供，小Q 与小狗没有该接口，不显示而不是留空。
- 红心数接口带 60 秒短缓存，含数字 0 的负缓存和请求限时；上游无响应时红心按钮照常恢复。
- 取播放地址的等待预算仍是 4800ms，公钥就绪重试上限 8 秒，超出后走既有音源回退路径。

## 覆盖升级和用户数据

- 已安装用户应直接覆盖安装到原目录，例如 `D:\Mineradio`。
- `<安装目录>\user-data` 继续保存完整 Electron profile，含设置、Cookies、localStorage、IndexedDB、登录分区、账号凭据、队列和本地库。
- `<安装目录>\MineradioCache` 继续保存可重新生成缓存。
- 覆盖安装不复制、合并、移动或删除以上两个目录；默认卸载同样保留它们，只有用户主动勾选「删除用户数据」才会删除。
- 本次不新增用户数据结构，旧版本的设置、队列和本地库快照直接沿用。

## 发布前检查

- 确认 `package.json`、`package-lock.json`、运行时版本、更新弹窗和内测配置均为 `1.4.1`。
- 确认更新与发布仓库为 `HackenLeung/Mineradio`。
- 确认 `.cookie`、`.qq-cookie`、`.kugou-cookie`、`user-data/`、`MineradioCache/`、`dist/`、`node_modules/`、`tmp/` 和 `工作区备份/` 未进入 Git。
- 运行 `git diff --check` 和 `node scripts/quick-check.js`；`tests/*.test.js` 逐个执行，避开遥控测试抢同一个首选端口。
- 验证小云：搜索、取播放地址、切歌、音质档位、歌单收藏、评论发布与回复、红心与红心数刷新。
- 验证红心数：详情弹窗开着 A 歌时给 B 歌点红心不串数字，滚动长列表时请求队列不超过 200。
- 验证小Q 与小狗：不显示红心数，其余播放功能不受影响。
- 使用一份旧正式版 `user-data` 副本执行覆盖升级测试，确认设置、完整队列、本地库、平台登录、桌面歌词、托盘和下载设置继续保留。
- 执行 `npm run build:win`，生成 Windows NSIS 安装包。

## 预期发布资产

- `dist/Mineradio-1.4.1-Setup.exe`
- `dist/Mineradio-1.4.1-Setup.exe.blockmap`
- `dist/Mineradio-1.4.1-SHA256SUMS.txt`
- `dist/latest.yml`

Release tag：

```text
v1.4.1
```

Release 标题：

```text
Mineradio v1.4.1 小云音源接口统一与红心数
```

## 发布边界

- 本版本必须通过完整安装包交付，不能只发布快速补丁。
- 不复用旧 `dist/` 或历史 packaged build，发布资产必须从当前源码重新构建。
- `scripts/quick-check.js` 中歌词滚动性能检查有历史基线失败：`space/button pause resume must use a fast paused-audio path...`；该失败在未修改基线同样存在，不属于本版本改动。
- `tests/remote-listener-lifecycle.test.js` 与另外三个遥控测试共用持久化的首选端口，用 `node --test` 并发执行时会互相抢端口而失败。逐个执行全部通过，属于既有的测试隔离问题，不是本版本引入。
- `/api/video` 与既有 `/api/audio` 一样不校验目标主机。本地服务端默认只监听 `127.0.0.1`，遥控监听器上的请求按外部来源处理、拿不到这两个端点。
- 当前修改版不是原项目作者发布或维护的官方版本；来源、署名和第三方移植边界见 README、NOTICE 与 `docs/THIRD_PARTY_PORTS.md`。
