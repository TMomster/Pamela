fn main() {
    // 前端在编译期嵌入可执行文件；构建脚本只负责把 `ui/` 目录注册为资源依赖。
    // The front-end is embedded into the executable at compile time; this script registers the `ui/` directory as a build dependency.
    println!("cargo:rerun-if-changed=ui");
    tauri_build::build()
}
