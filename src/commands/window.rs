//! 窗口标题栏相关命令。
//! Window chrome commands.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{Runtime, WebviewWindow};

/// 最小化窗口。
#[tauri::command]
pub fn minimize<R: Runtime>(window: WebviewWindow<R>) -> tauri::Result<()> {
    window.minimize()
}

/// 还原态时最大化窗口，最大化态时还原窗口。
#[tauri::command]
pub fn toggle_maximize<R: Runtime>(window: WebviewWindow<R>) -> tauri::Result<()> {
    if window.is_maximized()? {
        window.unmaximize()
    } else {
        window.maximize()
    }
}

/// 关闭窗口。
#[tauri::command]
pub fn close<R: Runtime>(window: WebviewWindow<R>) -> tauri::Result<()> {
    window.close()
}

/// 返回窗口当前是否最大化。
#[tauri::command]
pub fn is_maximized<R: Runtime>(window: WebviewWindow<R>) -> tauri::Result<bool> {
    window.is_maximized()
}

/// 进入全屏前的窗口最大化状态，退出全屏时据此恢复。
static FULLSCREEN_WAS_MAXIMIZED: AtomicBool = AtomicBool::new(false);

/// 使窗口进入系统级全屏，或退出全屏。切换需先记录最大化状态，并在退出时恢复。
#[tauri::command]
pub fn set_fullscreen<R: Runtime>(
    window: WebviewWindow<R>,
    fullscreen: bool,
) -> tauri::Result<bool> {
    if fullscreen {
        let was_maximized = window.is_maximized()?;
        if was_maximized {
            window.unmaximize()?;
        }
        window.set_fullscreen(true)?;
        FULLSCREEN_WAS_MAXIMIZED.store(was_maximized, Ordering::Relaxed);
    } else {
        window.set_fullscreen(false)?;
        if FULLSCREEN_WAS_MAXIMIZED.swap(false, Ordering::Relaxed) {
            window.maximize()?;
        }
    }
    window.is_fullscreen()
}

/// 返回窗口当前是否处于全屏。
#[tauri::command]
pub fn is_fullscreen<R: Runtime>(window: WebviewWindow<R>) -> tauri::Result<bool> {
    window.is_fullscreen()
}
