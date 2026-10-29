# Beayy — Be Authentic. Your Yesterdays.
> **来源说明：** 本项目是在 [`hengfengliya/beayy`](https://github.com/hengfengliya/beayy) 基础上修改和扩展的个人分支，包含 Android 客户端、跨平台界面及相关构建与同步改动。


<p align="center">
<a href="https://linux.do" alt="LINUX DO">
<img
src="https://img.shields.io/badge/LINUX-DO-FFB003.svg?logo=data:image/svg%2bxml;base64,DQo8c3ZnIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyIgd2lkdGg9IjEwMCIgaGVpZ2h0PSIxMDAiPjxwYXRoIGQ9Ik00Ni44Mi0uMDU1aDYuMjVxMjMuOTY5IDIuMDYyIDM4IDIxLjQyNmM1LjI1OCA3LjY3NiA4LjIxNSAxNi4xNTYgOC44NzUgMjUuNDV2Ni4yNXEtMi4wNjQgMjMuOTY4LTIxLjQzIDM4LTExLjUxMiA3Ljg4NS0yNS40NDUgOC44NzRoLTYuMjVxLTIzLjk3LTIuMDY0LTM4LjAwNC0yMS40M1EuOTcxIDY3LjA1Ni0uMDU0IDUzLjE4di02LjQ3M0MxLjM2MiAzMC43ODEgOC41MDMgMTguMTQ4IDIxLjM3IDguODE3IDI5LjA0NyAzLjU2MiAzNy41MjcuNjA0IDQ2LjgyMS0uMDU2IiBzdHlsZT0ic3Ryb2tlOm5vbmU7ZmlsbC1ydWxlOmV2ZW5vZGQ7ZmlsbDojZWNlY2VjO2ZpbGwtb3BhY2l0eToxIi8+PHBhdGggZD0iTTQ3LjI2NiAyLjk1N3EyMi41My0uNjUgMzcuNzc3IDE1LjczOGE0OS43IDQ5LjcgMCAwIDEgNi44NjcgMTAuMTU3cS00MS45NjQuMjIyLTgzLjkzIDAgOS43NS0xOC42MTYgMzAuMDI0LTI0LjM4N2E2MSA2MSAwIDAgMSA5LjI2Mi0xLjUwOCIgc3R5bGU9InN0cm9rZTpub25lO2ZpbGwtcnVsZTpldmVub2RkO2ZpbGw6IzE5MTkxOTtmaWxsLW9wYWNpdHk6MSIvPjxwYXRoIGQ9Ik03Ljk4IDcwLjkyNmMyNy45NzctLjAzNSA1NS45NTQgMCA4My45My4xMTNRODMuNDI2IDg3LjQ3MyA2Ni4xMyA5NC4wODZxLTE4LjgxIDYuNTQ0LTM2LjgzMi0xLjg5OC0xNC4yMDMtNy4wOS0yMS4zMTctMjEuMjYyIiBzdHlsZT0ic3Ryb2tlOm5vbmU7ZmlsbC1ydWxlOmV2ZW5vZGQ7ZmlsbDojZjlhZjAwO2ZpbGwtb3BhY2l0eToxIi8+PC9zdmc+" /></a>
</p>

在后台记下你一天在电脑和手机上做了什么，每 10 分钟写一段摘要、每小时合成一段、每晚写一份日总结；告诉你时间花在了哪些领域和项目上，对照你自己定的规矩。

*Beayy quietly records what you do on your Mac and iPhone, writes a summary every 10 minutes and a journal every evening, and shows where your time actually went. Everything stays on your machine; optional end-to-end encrypted sync between devices.*

## 能做什么

- **今天**：在电脑前多久、手机多久、切换了多少次；一天的形状（每小时电脑和手机的使用）；时间花在哪（领域 · 项目、类型，两级分类）。
- **时间线**：按小时看在做什么，点开看每 10 分钟的摘要、每次拿起手机用了哪些 app、手表录到的对话；全部、电脑、手机、手表分开看，每小时行首标当时在哪。
- **总结**：每天的日总结（今天的一句话、时间去向、做成了什么、规矩、偏离、明天），最近 14 天作息图。
- **规矩**：用自己的话写，比如「22:00 以后不开电脑」「手机每天不超过 3 小时」「抖音每天不超过 30 分钟」，当天就对照。
- **设备与同步**：多台电脑登录同一个账号，记录在本机加密后同步，服务器读不到内容。

## 记什么、存在哪

| | |
|---|---|
| 电脑 | 切到哪个 app 和窗口、打字和发出去的内容、点了什么、滚动、屏幕上的文字（macOS 辅助功能、Windows UI Automation 读取）、在不在电脑前、睡眠锁屏。密码框不记；可以指定某些 app 完全不记；可以随时暂停、删掉最近 15 分钟／1 小时／今天的记录 |
| 手机 | iPhone 经 iCloud 同步到 Mac 的屏幕使用时间：每个 app 什么时候在前台、用了多久（看不到 app 里的内容） |
| 手表（可选） | Apple Watch 全天录音，传到**你自己的**录音服务器转写、分说话人；这里只拉回文字（谁在几点说了什么），音频不经过这台电脑 |
| 位置（可选） | iPhone 记下的停留点（几点到、几点走、地名），同样经你自己的录音服务器拉回来；路上的轨迹不记 |
| 存储 | 全部在本机 `~/Library/Application Support/Beayy/`，按设备、每 10 分钟一个文件，只追加 |
| 摘要 | 把那 10 分钟的记录（有手表、位置时连同那 10 分钟的对话原文和地名）发给**你自己配置**的模型服务（任何 OpenAI 兼容接口），写回本机 |
| 同步（可选） | 本机压缩、XChaCha20-Poly1305 加密后上传；主密码只在设备上用（Argon2id 派生），服务器只存密文和登录校验值的哈希 |

## 安装

到 [Releases](../../releases) 下载 `Beayy-<版本>.dmg`（Windows 是 `Beayy-<版本>-windows-x64.zip`），拖进「应用程序」打开。装好以后会自动检查更新，有新版本时左下角菜单里出现「重启更新」。第一次打开会带你走一遍：授权（辅助功能、输入监控、可选的完全磁盘访问）、填模型、要不要同步。

要求 macOS 14 以上，或 Windows 10／11（64 位）。Windows 版记的和 Mac 一样（键鼠钩子＋UI Automation），还在试用：没有代码签名，第一次运行 SmartScreen 会拦，点「更多信息 → 仍要运行」；杀毒软件可能把键盘钩子当成键盘记录器，放行即可；以管理员身份运行的程序读不到（Beayy 不提权）。

## 让 AI 读你的记录（MCP）

Beayy 自带一个本机 MCP 服务，Claude Code、Claude 桌面版这类本机 AI 可以直接查你的记录，数据不出这台电脑（只读）：

```bash
claude mcp add beayy -- ~/Applications/Beayy.app/Contents/MacOS/beayy --mcp
```

工具：`list_days`（最近每天概况）、`get_day`（某天的时长、每小时在做什么、时间花在哪、日总结）、`search`（在 10 分钟摘要里搜关键词）、`get_rules_and_projects`。

## 自己部署服务端

同步和录音转写默认用官方服务器，也可以换成自己的：`server/` 用 Docker 在自己的电脑或 VPS 上跑（`docker compose up -d`，转写加 `--profile asr`），然后在「设置 → 连接」里把同步服务器、转写服务换成自己的地址。步骤见 [server/README.md](server/README.md)。

## 从源码编译

```bash
# Rust（rustup）和 Xcode 命令行工具
git clone https://github.com/hengfengliya/beayy && cd beayy
./build.sh            # 测试版：编译、签名（有 Developer ID 证书就用，没有就本机临时签名）、装成 Beayy-rs.app 并启动，写独立的影子目录，可以和正式版同时跑
./build.sh --install  # 装成 ~/Applications/Beayy.app（正式版，写正式数据目录；会覆盖已装的 Beayy）
./build.sh --dmg      # 打安装包 target/Beayy-<版本>.dmg；用 Developer ID 签名并给了公证凭据就自动公证
```

只看界面：用浏览器打开 `ui/index.html`，读 `ui/mock/` 里的虚构样例数据（`python3 ui/mock/make_mock.py` 重新生成）。

## 结构

| 目录 | 内容 |
|---|---|
| `crates/beayy-core` | 事件格式与写入（按设备、UTC 整 10 分分段、只追加）、设备名、数据目录 |
| `crates/beayy-capture` | 采集：键鼠、打字与发送、界面文字、切 app、在场与心跳、睡眠锁屏；macOS 用辅助功能和事件监听，Windows 用低级钩子和 UI Automation，判断逻辑两边共用（`common.rs`） |
| `crates/beayy-phone` | 读 iPhone 经 iCloud 同步来的屏幕使用时间（macOS） |
| `crates/beayy-remote` | 从录音服务器拉手表对话转写和 iPhone 停留点（HTTPS＋口令） |
| `crates/beayy-summary` | 10 分钟摘要、小时摘要、两级分类（类型、领域 · 项目）、项目名合并 |
| `crates/beayy-sync` | 多设备同步客户端：账号、加密、上传下载 |
| `src-tauri` | Tauri 2 外壳：菜单栏、主窗口、给网页的命令（`src-tauri/COMMANDS.md`）、定时任务、日总结 |
| `ui` | 网页界面：纯 HTML＋CSS＋JS |
| `server` | 服务端：同步（只存密文）＋录音转写＋可选的模型、地图代理，Python（FastAPI＋SQLite＋本地文件）。用 Docker 在自己的电脑或服务器上跑，见 [`server/README.md`](server/README.md)；官方实例跑的也是它 |
| `sync-server` | 同步服务的旧 Cloudflare 版（Workers＋R2＋D1），接口和 `server` 相同，不再维护 |

## 许可

MIT，见 [LICENSE](LICENSE)。用到的第三方代码见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
