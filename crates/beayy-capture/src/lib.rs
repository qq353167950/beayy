//! 采集接口。各平台实现同一组能力，按平台分模块编译。
//! 两边记的事件和字段相同：键鼠、打字与发送、界面文字、切 app、窗口变化、在场与心跳、睡眠锁屏
//! （`macos::start`／`windows::start`）。判断逻辑（防抖、发送、操作者统计、黑名单、界面文字去重）在 `common`，两边共用。

mod common;
#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(target_os = "windows")]
pub mod windows;
#[cfg(target_os = "android")]
pub mod android;

#[cfg(target_os = "macos")]
use macos as platform_impl;
#[cfg(target_os = "windows")]
use windows as platform_impl;

/// 权限状态。Windows 上没有这些系统授权，一律视为已授权。
/// Android 的授权（无障碍、使用情况访问、通知使用权）由 Kotlin 侧管，
/// 状态也由 `MainActivity` 查；这里不下判断，交给平台。
#[derive(Debug, Clone, Copy, serde::Serialize)]
pub struct PermissionStatus {
    pub accessibility: bool,
    pub input_monitoring: bool,
    pub full_disk_access: bool,
}

/// Android 上「无障碍服务连没连上」由 Kotlin 侧用 JNI 告诉我们：
/// Rust 这边读不到系统服务状态，所以用一个可写的开关，由 `beayy-capture::android` 更新。
#[cfg(target_os = "android")]
mod android_perms {
    use std::sync::atomic::{AtomicBool, Ordering};
    pub static ACCESSIBILITY: AtomicBool = AtomicBool::new(false);
    pub fn set_accessibility(on: bool) {
        ACCESSIBILITY.store(on, Ordering::Relaxed);
    }
}

#[cfg(target_os = "android")]
pub use android_perms::set_accessibility;

pub fn permissions() -> PermissionStatus {
    #[cfg(target_os = "android")]
    {
        PermissionStatus {
            accessibility: android_perms::ACCESSIBILITY.load(std::sync::atomic::Ordering::Relaxed),
            // Android 没有「输入监控」这个授权概念：无障碍本身就能读到输入
            input_monitoring: true,
            // 也没有「完全磁盘访问」：应用自带私有目录
            full_disk_access: true,
        }
    }
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        platform_impl::permissions()
    }
    #[cfg(not(any(target_os = "android", target_os = "macos", target_os = "windows")))]
    {
        PermissionStatus { accessibility: true, input_monitoring: true, full_disk_access: true }
    }
}

/// 打开系统设置里对应的授权页：accessibility／input_monitoring／full_disk_access
///
/// Android 上跳转由 Kotlin 的 `MainActivity` 负责（`openSettings` 那排按钮），
/// Rust 这边没有 Context，跳不了，静默忽略。
pub fn open_permission(kind: &str) {
    #[cfg(target_os = "android")]
    {
        let _ = kind;
    }
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        platform_impl::open_permission(kind)
    }
    #[cfg(not(any(target_os = "android", target_os = "macos", target_os = "windows")))]
    {
        let _ = kind;
    }
}

pub fn platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "android") {
        "android"
    } else {
        "other"
    }
}

