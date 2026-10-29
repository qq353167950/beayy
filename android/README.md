# beayy-android

Android 宿主工程骨架。Rust 侧（`mobile/` + `crates/`）已经完成并通过编译，这里补上让它在 Android 上跑起来的胶水。

> **状态：Android debug APK 已在本机完成 Gradle 编译；尚未连接真机验证。**
> Kotlin／Gradle 代码已通过 `assembleDebug`，Rust 侧也已通过 workspace 测试；当前 ADB 没有连接设备。

## 结构

```
android/
├── settings.gradle.kts
├── build.gradle.kts
├── app/
│   ├── build.gradle.kts
│   └── src/main/
│       ├── AndroidManifest.xml
│       ├── kotlin/app/beayy/android/
│       │   ├── MainActivity.kt          承载 ui/ 网页界面
│       │   ├── BeayyBridge.kt           JNI 桥（调 Rust）
│       │   ├── CaptureAccessibility.kt  无障碍服务（界面文字/点击/打字）
│       │   ├── UsageCollector.kt        UsageStatsManager（前台时长）
│       │   ├── NotifyListener.kt        通知监听
│       │   └── SystemEvents.kt          电量/网络/屏幕/耳机/装卸
│       └── res/xml/accessibility_service_config.xml
```

## 构建

```bash
# 1. 装 NDK 与目标
rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android
# 2. 编 Rust 静态库（Android 必须用 rustls，NDK 没有系统 TLS 库）
cargo ndk -t arm64-v8a -t armeabi-v7a -t x86_64 \
  -o android/app/src/main/jniLibs \
  build --release -p beayy-mobile --no-default-features --features rustls
# 3. 打 APK
cd android && ./gradlew assembleDebug
```

## 权限说明

| 权限 | 用途 | 用户是否需手动开 |
|---|---|---|
| `BIND_ACCESSIBILITY_SERVICE` | 读界面文字、点击、打字（语义摘要的主料） | **是**，设置 → 无障碍里手动启用 |
| `PACKAGE_USAGE_STATS` | 每个 app 的前台时长 | **是**，设置 → 使用情况访问权限 |
| `BIND_NOTIFICATION_LISTENER_SERVICE` | 谁发了什么通知（正文默认不记） | **是**，设置 → 通知使用权 |
| `READ_PHONE_STATE` | 通话状态（可选） | 是 |

不授予任何权限时应用仍可运行，只是采不到对应事件。设置页有每项的状态与开关。

## 与桌面的对应关系

采集事件名、字段与 macOS／Windows **完全一致**，这是刻意的：摘要引擎（`beayy-summary`）不用改就能吃 Android 的数据。

| 桌面 | Android |
|---|---|
| `app.activated` / `window.changed` | 无障碍 `TYPE_WINDOW_STATE_CHANGED` |
| `ui.text` | 无障碍节点树拍平 |
| `mouse.click` / `mouse.scroll` | `TYPE_VIEW_CLICKED` / `TYPE_VIEW_SCROLLED` |
| `keyboard.text_input` / `submit` | `TYPE_VIEW_TEXT_CHANGED`（密码框置 `[REDACTED]`） |
| `presence` / `heartbeat` | 屏幕状态 + 空闲 |

Android 独有、桌面没有的（一并记，摘要暂不读）：`notify.posted`、`media.play`、`call.state`、`battery.state`、`network.state`、`audio.route`、`screen.on`/`screen.off`、`device.unlock`、`app.install`/`app.uninstall`、`doze.state`。

## 数据与同步

- 采集写在 `devices/android-<id>/segments/<UTC 10 分>/events.jsonl`，与桌面同格式
- 手机身份是 `androidapp-<id>`（见 `mobile/src/lib.rs` 的 `device_id`），摘要引擎用 `Summarizer::with_device` 指定 `android-<id>`
- 摘要写进 `<数据根>/summaries/`，随现有同步逻辑上传（`sum.<文件名>` 块）
- 同步只上传手机自己的数据；别的设备的数据只下载不回转

## 隐私

- 密码框：无障碍 `isPassword` 为真时，文本在**写盘之前**就替换为 `[REDACTED]`
- 通知：默认只记「谁发的 + 标题」，正文要用户显式打开
- 黑名单 app（密码管理器等）只记「切到了它」，页面内容不记
- API Key 只存本机，永不随账号同步（见 `crates/beayy-core/src/model_config.rs`）
