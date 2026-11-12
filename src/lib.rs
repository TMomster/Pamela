//! Pamela —— 视觉小说引擎与创作环境。
//! Pamela — a visual-novel engine and authoring environment.

pub mod commands;
pub mod export;
pub mod files;
pub mod fonts;
pub mod mp4;
pub mod project;

use std::path::PathBuf;

use tauri::Manager;

use commands::ProjectState;

/// 构建并运行 Pamela 应用。
pub fn run(initial_project: Option<PathBuf>) {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(ProjectState::default())
        .manage(export::ExportState::default())
        .setup(move |app| {
            // 此处的失败仅上报而不终止进程，编辑器仍可启动。
            if let Some(root) = initial_project.as_deref() {
                match project::load(root) {
                    Ok(loaded) => commands::set_open_project(app.state(), loaded),
                    Err(error) => eprintln!("[pamela] 无法打开项目：{error}"),
                }
            }
            if let Some(saved) = commands::load_app_state(app.handle()) {
                restore_window(app.handle(), &saved);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::window::minimize,
            commands::window::toggle_maximize,
            commands::window::close,
            commands::window::is_maximized,
            commands::window::set_fullscreen,
            commands::window::is_fullscreen,
            commands::create_project,
            commands::open_project,
            commands::reload_project,
            commands::current_project,
            commands::close_project,
            commands::set_entry,
            commands::set_typewriter,
            commands::check_project,
            commands::read_file,
            commands::read_asset,
            commands::read_image,
            commands::read_audio,
            commands::read_video,
            commands::write_file,
            commands::write_asset,
            commands::list_fonts,
            commands::create_dir,
            commands::delete_entry,
            commands::copy_entry,
            commands::rename_entry,
            commands::read_app_state,
            commands::write_app_state,
            commands::export_begin,
            commands::export_append,
            commands::export_finish,
            commands::export_abort,
            commands::reveal_path,
        ])
        .run(tauri::generate_context!())
        .expect("failed to start the Pamela application");
}

/// 按上次退出时的偏好恢复窗口大小与最大化状态。
///
/// 尺寸只在看起来合理时采用：偏好文件可以被手工改坏，而一个 0 宽的窗口会让
/// 编辑器再也打不开。
fn restore_window(app: &tauri::AppHandle, saved: &commands::AppState) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if let (Some(width), Some(height)) = (saved.width, saved.height) {
        if width >= 640 && height >= 480 {
            let _ = window.set_size(tauri::LogicalSize::new(f64::from(width), f64::from(height)));
        }
    }
    if saved.maximized == Some(true) {
        let _ = window.maximize();
    }
}
