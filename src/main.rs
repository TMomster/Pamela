// 在 Windows 发行构建中隐藏控制台窗口。
// Hide the console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;

fn main() {
    pamela_lib::run(initial_project());
}

/// 从命令行读取 `--open-project <path>` 参数。
fn initial_project() -> Option<PathBuf> {
    let mut args = std::env::args_os().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--open-project" {
            return args.next().map(PathBuf::from);
        }
    }
    None
}
