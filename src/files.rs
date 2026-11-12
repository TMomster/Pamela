//! 已打开项目内的文件读写与资源路径解析。
//! Reading and writing files inside the open project.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::project;
use crate::project::ASSETS_DIR;

/// 编辑器允许加载的最大剧本体积（字节），用于防止误打开超大文件。
pub const MAX_TEXT_BYTES: u64 = 8 * 1024 * 1024;

/// 同一进程内并发的原子写各自使用不同的临时文件名。
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// 读取项目相对路径下的文本文件。
pub fn read_text(root: &str, relative: &str) -> io::Result<String> {
    let path = project::resolve(root, relative)?;

    // 文件缺失时以文件名报告，而非直接返回操作系统错误码，便于前端定位资源。
    let metadata =
        fs::metadata(&path).map_err(|_| project::invalid(&format!("找不到文件：{relative}")))?;
    if metadata.is_dir() {
        return Err(project::invalid(&format!("{relative} 是目录，不是文件")));
    }
    if metadata.len() > MAX_TEXT_BYTES {
        return Err(project::invalid(&format!(
            "文件过大（{} 字节），编辑区上限为 {MAX_TEXT_BYTES} 字节",
            metadata.len()
        )));
    }

    fs::read_to_string(&path)
        .map_err(|e| project::invalid(&format!("无法读取 {relative}（可能不是 UTF-8 文本）：{e}")))
}

/// 通过同目录临时文件写入，保证中断时旧内容仍然完整。
///
/// Windows 的 `rename` 不覆盖已存在文件，所以先把旧文件改名为 `.bak`，
/// 新文件就位后再删备份；任一步失败都回滚到旧文件。
pub(crate) fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".to_string());
    let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temporary = parent.join(format!(
        ".{name}.tmp-{}-{sequence}",
        std::process::id()
    ));
    {
        let mut file = fs::File::create(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }

    let backup = parent.join(format!("{name}.bak"));
    let had_old = path.exists();
    if had_old {
        let _ = fs::remove_file(&backup);
        if let Err(error) = fs::rename(path, &backup) {
            let _ = fs::remove_file(&temporary);
            return Err(error);
        }
    }

    match fs::rename(&temporary, path) {
        Ok(()) => {
            if had_old {
                let _ = fs::remove_file(&backup);
            }
            Ok(())
        }
        Err(error) => {
            if had_old {
                let _ = fs::rename(&backup, path);
            }
            let _ = fs::remove_file(&temporary);
            Err(error)
        }
    }
}

/// 写入项目相对路径下的文本文件，自动创建父目录。
pub fn write_text(root: &str, relative: &str, contents: &str) -> io::Result<()> {
    let path = project::resolve(root, relative)?;
    atomic_write(&path, contents.as_bytes())
}

/// 把 `data:` URL 或裸 base64 字符串解码后写入项目相对路径下的图片文件。
pub fn write_asset_data_url(root: &str, relative: &str, data: &str) -> io::Result<()> {
    let name = relative.trim();
    if name.is_empty() {
        return Err(project::invalid("图片路径不能为空"));
    }
    // Writing only needs the first spelling: a bare name lands in `assets/`,
    // and a path that already names a folder is taken as written.
    let target = asset_candidates(name, "")
        .into_iter()
        .next()
        .ok_or_else(|| project::invalid("图片路径不能为空"))?;
    let path = project::resolve(root, &target)?;

    let bytes = base64_decode(strip_data_url(data))?;
    if bytes.len() as u64 > MAX_ASSET_BYTES {
        return Err(project::invalid(&format!(
            "图片过大（{} 字节），上限为 {MAX_ASSET_BYTES} 字节",
            bytes.len()
        )));
    }

    atomic_write(&path, &bytes)
}

/// 去除 `data:<mime>;base64,` 前缀，保留有效载荷。
fn strip_data_url(data: &str) -> &str {
    let trimmed = data.trim_start();
    if !trimmed.starts_with("data:") {
        return trimmed;
    }
    match trimmed.find("base64,") {
        Some(index) => &trimmed[index + "base64,".len()..],
        None => trimmed,
    }
}

/// 创建项目相对路径下的目录，自动补齐缺失的父目录。
pub fn create_dir(root: &str, relative: &str) -> io::Result<()> {
    if relative.trim().is_empty() {
        return Err(project::invalid("路径不能为空"));
    }
    let path = project::resolve(root, relative)?;
    if path.is_dir() {
        return Err(project::invalid(&format!("{relative} 已存在")));
    }
    fs::create_dir_all(&path)
}

/// 删除项目相对路径下的文件或目录；目录按递归方式删除。
pub fn remove(root: &str, relative: &str) -> io::Result<()> {
    if relative.trim().is_empty() {
        return Err(project::invalid("不能删除项目根目录"));
    }
    let path = project::resolve(root, relative)?;
    let metadata = fs::metadata(&path)?;
    if metadata.is_dir() {
        fs::remove_dir_all(&path)
    } else {
        fs::remove_file(&path)
    }
}

/// 把项目相对路径下的文件或目录复制到另一个项目相对路径。
pub fn copy(root: &str, from: &str, to: &str) -> io::Result<()> {
    if from.trim().is_empty() || to.trim().is_empty() {
        return Err(project::invalid("路径不能为空"));
    }

    let source = project::resolve(root, from)?;
    let destination = project::resolve(root, to)?;

    if !source.exists() {
        return Err(project::invalid(&format!("{from} 不存在")));
    }
    if source.is_dir() && destination.starts_with(&source) {
        return Err(project::invalid("不能把文件夹复制到它自己内部"));
    }
    if destination.exists() {
        return Err(project::invalid(&format!("{to} 已存在")));
    }

    copy_entry(&source, &destination)
}

/// 在同一目录内重命名项目相对路径下的文件或目录。
pub fn rename(root: &str, from: &str, to: &str) -> io::Result<()> {
    let name = to.trim();
    if from.trim().is_empty() || name.is_empty() {
        return Err(project::invalid("路径不能为空"));
    }
    if name.contains('/') || name.contains('\\') || name.contains(':') {
        return Err(project::invalid("新名称不能包含路径分隔符"));
    }
    if name == "." || name == ".." {
        return Err(project::invalid("新名称不能是 . 或 .."));
    }

    let source = project::resolve(root, from)?;
    if !source.exists() {
        return Err(project::invalid(&format!("{from} 不存在")));
    }
    let parent = source
        .parent()
        .ok_or_else(|| project::invalid("不能重命名项目根目录"))?;
    let destination = parent.join(name);
    if destination == source {
        // 重命名为同名时按空操作处理，不返回错误。
        return Ok(());
    }
    if destination.exists() {
        // Windows 的文件名不区分大小写：`ch.png` → `CH.PNG` 时目标"已存在"，
        // 但其实是同一个文件。先改名到临时名，再落到目标名。
        #[cfg(windows)]
        if source.parent() == destination.parent()
            && source
                .file_name()
                .zip(destination.file_name())
                .is_some_and(|(from, to)| from.eq_ignore_ascii_case(to))
        {
            let temporary = parent.join(format!(".{name}.rename-{}", std::process::id()));
            let _ = fs::remove_file(&temporary);
            fs::rename(&source, &temporary)?;
            if let Err(error) = fs::rename(&temporary, &destination) {
                let _ = fs::rename(&temporary, &source);
                return Err(error);
            }
            return Ok(());
        }
        return Err(project::invalid(&format!("{name} 已存在")));
    }

    fs::rename(&source, &destination)
}

/// 允许内联为 `data:` URL 的最大图片体积（字节）。
pub const MAX_ASSET_BYTES: u64 = 32 * 1024 * 1024;

/// 读取项目相对路径下的图片并按扩展名返回带 MIME 类型的 `data:` URL。
pub fn read_image_data_url(root: &str, relative: &str) -> io::Result<String> {
    read_image_candidates(root, &[relative.replace('\\', "/")])
}

/// 返回 `candidates` 中首个实际存在的文件，内容为 `data:` URL。
fn read_image_candidates(root: &str, candidates: &[String]) -> io::Result<String> {
    let (normalized, path, metadata) = first_existing(root, candidates, "图片")?;
    if metadata.is_dir() {
        return Err(project::invalid(&format!("{normalized} 是目录，不是文件")));
    }
    if metadata.len() > MAX_ASSET_BYTES {
        return Err(project::invalid(&format!(
            "图片过大（{} 字节），上限为 {MAX_ASSET_BYTES} 字节",
            metadata.len()
        )));
    }

    let mime = image_mime(&normalized)
        .ok_or_else(|| project::invalid(&format!("不支持的图片格式：{normalized}")))?;
    let bytes = fs::read(&path)?;
    Ok(format!("data:{mime};base64,{}", base64_encode(&bytes)))
}

/// 读取项目相对路径下的资源图片并按候选顺序返回 `data:` URL。
pub fn read_asset_data_url(root: &str, relative: &str, kind: &str) -> io::Result<String> {
    let mut candidates = asset_candidates(relative, kind);
    let bare = relative.replace('\\', "/");
    let bare = bare.trim_start_matches("./");
    if kind.is_empty()
        && !bare.is_empty()
        && bare != "assets"
        && !bare.starts_with("assets/")
        && !bare.contains('/')
    {
        for candidate in scan_subfolders(root, bare) {
            push_candidate(&mut candidates, candidate);
        }
        if let Some(dotted) = dotted_path_variant(bare) {
            for candidate in scan_subfolders(root, &dotted) {
                push_candidate(&mut candidates, candidate);
            }
        }
    }
    read_image_candidates(root, &candidates)
}

/// 允许内联为 `data:` URL 的最大音频体积（字节）。
///
/// The bytes are held three times at peak (file, base64, decoded data URL), so
/// this is a memory budget rather than a statement about what audio is valid.
pub const MAX_AUDIO_BYTES: u64 = 32 * 1024 * 1024;

/// 读取项目相对路径下的音频并按扩展名返回带 MIME 类型的 `data:` URL。
pub fn read_audio_data_url(root: &str, relative: &str) -> io::Result<String> {
    let candidates = asset_candidates(relative, "Audio");
    let (normalized, path, metadata) = first_existing(root, &candidates, "音频")?;
    if metadata.is_dir() {
        return Err(project::invalid(&format!("{normalized} 是目录，不是文件")));
    }
    if metadata.len() > MAX_AUDIO_BYTES {
        return Err(project::invalid(&format!(
            "音频过大（{} 字节），上限为 {MAX_AUDIO_BYTES} 字节",
            metadata.len()
        )));
    }

    let mime = audio_mime(&normalized)
        .ok_or_else(|| project::invalid(&format!("不支持的音频格式：{normalized}")))?;
    let bytes = fs::read(&path)?;
    Ok(format!("data:{mime};base64,{}", base64_encode(&bytes)))
}

/// 允许内联为 `data:` URL 的最大视频体积（字节）。
///
/// 视频比图片大得多，base64 还会再涨约三分之一，且读入、编码、解码三份会
/// 同时在内存里。256 MB 的上限在低内存机器上足以把窗口压垮，所以先收到
/// 64 MB；真正的大文件应改走 asset protocol 流式加载。
pub const MAX_VIDEO_BYTES: u64 = 64 * 1024 * 1024;

/// 读取项目相对路径下的视频并按扩展名返回带 MIME 类型的 `data:` URL。
pub fn read_video_data_url(root: &str, relative: &str) -> io::Result<String> {
    let candidates = asset_candidates(relative, "Video");
    let (normalized, path, metadata) = first_existing(root, &candidates, "视频")?;
    if metadata.is_dir() {
        return Err(project::invalid(&format!("{normalized} 是目录，不是文件")));
    }
    if metadata.len() > MAX_VIDEO_BYTES {
        return Err(project::invalid(&format!(
            "视频过大（{} 字节），上限为 {MAX_VIDEO_BYTES} 字节",
            metadata.len()
        )));
    }

    let mime = video_mime(&normalized)
        .ok_or_else(|| project::invalid(&format!("不支持的视频格式：{normalized}")))?;
    let bytes = fs::read(&path)?;
    Ok(format!("data:{mime};base64,{}", base64_encode(&bytes)))
}

/// 返回首个在磁盘上存在的候选路径及其解析结果。
fn first_existing(
    root: &str,
    candidates: &[String],
    what: &str,
) -> io::Result<(String, PathBuf, fs::Metadata)> {
    for candidate in candidates {
        let path = project::resolve(root, candidate)?;
        if let Ok(metadata) = fs::metadata(&path) {
            return Ok((candidate.clone(), path, metadata));
        }
    }
    Err(project::invalid(&missing_message(candidates, what)))
}

/// 构造所有候选路径均不存在时的错误提示。
fn missing_message(candidates: &[String], what: &str) -> String {
    match candidates {
        [] => format!("找不到{what}"),
        [first] => format!("找不到{what}：{first}"),
        [first, rest @ ..] => format!("找不到{what}：{first}（也没有 {}）", rest.join("、")),
    }
}

/// 按优先级列出资源名可能对应的项目相对路径：类型目录优先，其次扁平根目录，再尝试点号展开与 `assets/` 子目录扫描。
fn asset_candidates(relative: &str, kind: &str) -> Vec<String> {
    let normalized = relative.replace('\\', "/");
    let trimmed = normalized.trim_start_matches("./");
    let mut variants = vec![trimmed.to_string()];
    if let Some(dotted) = dotted_path_variant(trimmed) {
        variants.push(dotted);
    }

    let mut candidates = Vec::new();
    for variant in variants {
        if variant == "assets" || variant.starts_with("assets/") {
            push_candidate(&mut candidates, variant);
            continue;
        }
        if !variant.contains('/') {
            if !kind.is_empty() {
                push_candidate(&mut candidates, format!("assets/{kind}/{variant}"));
            }
            push_candidate(&mut candidates, format!("assets/{variant}"));
            continue;
        }
        if !kind.is_empty() {
            push_candidate(&mut candidates, format!("assets/{kind}/{variant}"));
        }
        push_candidate(&mut candidates, format!("assets/{variant}"));
        push_candidate(&mut candidates, variant.clone());
        if !kind.is_empty() {
            push_candidate(&mut candidates, format!("{kind}/{variant}"));
        }
    }
    candidates
}

/// 把点号写法 `ori.si.png` 展开为子目录路径 `ori/si.png`。
fn dotted_path_variant(name: &str) -> Option<String> {
    if name.contains('/') {
        return None;
    }
    let parts: Vec<&str> = name.split('.').collect();
    if parts.len() < 3 {
        return None;
    }
    let extension = parts[parts.len() - 1];
    if extension.is_empty()
        || extension.len() > 8
        || !extension.bytes().all(|byte| byte.is_ascii_alphanumeric())
    {
        return None;
    }
    let stem = &parts[..parts.len() - 1];
    if stem
        .iter()
        .any(|part| part.is_empty() || *part == "." || *part == "..")
    {
        return None;
    }
    let file = parts[parts.len() - 2];
    let mut out = parts[..parts.len() - 2].join("/");
    if !out.is_empty() {
        out.push('/');
    }
    out.push_str(file);
    out.push('.');
    out.push_str(extension);
    Some(out)
}

/// 仅当前面的写法未指向同一路径时，才追加一个候选路径。
fn push_candidate(candidates: &mut Vec<String>, candidate: String) {
    if !candidates.iter().any(|existing| existing == &candidate) {
        candidates.push(candidate);
    }
}

/// 按字母序列出 `assets/` 各直属子目录下的同名文件候选。
fn scan_subfolders(root: &str, name: &str) -> Vec<String> {
    let Ok(assets) = project::resolve(root, ASSETS_DIR) else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(&assets) else {
        return Vec::new();
    };
    let mut folders: Vec<String> = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        // 点号目录属于项目自身的簿记数据，不作为美术资源扫描。
        .filter(|folder| !folder.starts_with('.'))
        .collect();
    folders.sort();
    folders
        .into_iter()
        .map(|folder| format!("{ASSETS_DIR}/{folder}/{name}"))
        .collect()
}

/// 把文件扩展名映射为图片 MIME 类型；非图片扩展名返回 `None`。
fn image_mime(path: &str) -> Option<&'static str> {
    let extension = Path::new(path)
        .extension()?
        .to_string_lossy()
        .to_ascii_lowercase();
    Some(match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        _ => return None,
    })
}

/// 把文件扩展名映射为音频 MIME 类型；非音频扩展名返回 `None`。
fn audio_mime(path: &str) -> Option<&'static str> {
    let extension = Path::new(path)
        .extension()?
        .to_string_lossy()
        .to_ascii_lowercase();
    Some(match extension.as_str() {
        "mp3" => "audio/mpeg",
        "ogg" | "oga" => "audio/ogg",
        "opus" => "audio/opus",
        "wav" => "audio/wav",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "flac" => "audio/flac",
        _ => return None,
    })
}

/// 把文件扩展名映射为视频 MIME 类型；非视频扩展名返回 `None`。
///
/// 只列 WebView2 能原生解码的容器：mp4 (H.264/AAC)、webm、ogg。
/// mov 常见于素材库但编解码依赖系统组件，先接受并在前端文档里说明。
fn video_mime(path: &str) -> Option<&'static str> {
    let extension = Path::new(path)
        .extension()?
        .to_string_lossy()
        .to_ascii_lowercase();
    Some(match extension.as_str() {
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "ogv" => "video/ogg",
        "mov" => "video/quicktime",
        _ => return None,
    })
}

/// 标准 base64 字母表；编码在本模块内实现，不引入额外依赖。
const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// 按标准 base64 编码字节，保留 `=` 填充。
fn base64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;

        out.push(BASE64[(triple >> 18) as usize & 0x3f] as char);
        out.push(BASE64[(triple >> 12) as usize & 0x3f] as char);
        out.push(if chunk.len() > 1 {
            BASE64[(triple >> 6) as usize & 0x3f] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            BASE64[triple as usize & 0x3f] as char
        } else {
            '='
        });
    }
    out
}

/// 解码标准 base64，忽略 `=` 填充与空白字符。
pub(crate) fn base64_decode(text: &str) -> io::Result<Vec<u8>> {
    base64_decode_named(text, "图片")
}

/// 同上；`label` 让错误信息说明是哪类数据损坏（图片、导出帧等）。
pub(crate) fn base64_decode_named(text: &str, label: &str) -> io::Result<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let mut buffer = 0u32;
    let mut bits = 0u32;

    for byte in text.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' | b'\r' | b'\n' | b' ' | b'\t' => continue,
            _ => {
                return Err(project::invalid(&format!(
                    "{label}数据不是有效的 base64"
                )))
            }
        } as u32;

        buffer = (buffer << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }

    Ok(out)
}

/// 复制单个文件系统条目，目录按递归方式处理。
fn copy_entry(source: &Path, destination: &Path) -> io::Result<()> {
    // 不跟随链接：指向目录的链接会让递归绕圈，指向项目外的链接则会把外部
    // 文件复制进来。`symlink_metadata` 不跟随，正好用来识别它。
    let metadata = fs::symlink_metadata(source)?;
    if metadata.file_type().is_symlink() {
        return Err(project::invalid("不能复制符号链接"));
    }
    if metadata.is_dir() {
        fs::create_dir_all(destination)?;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            copy_entry(&entry.path(), &destination.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(source, destination).map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixture(label: &str) -> (PathBuf, String) {
        let base =
            std::env::temp_dir().join(format!("pamela-files-{label}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let project = crate::project::create(&base, "demo").unwrap();
        (base, project.root)
    }

    #[test]
    fn atomic_write_replaces_contents_and_leaves_no_debris() {
        let (base, root) = fixture("atomic");
        let path = PathBuf::from(&root).join("scripts").join("a.pe");

        atomic_write(&path, b"one").unwrap();
        atomic_write(&path, b"two").unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "two");
        assert!(
            !path.with_file_name("a.pe.bak").exists(),
            "成功写入不留下备份"
        );
        let debris = fs::read_dir(path.parent().unwrap())
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| entry.file_name().to_string_lossy().contains(".tmp-"));
        assert!(!debris, "临时文件必须被改名或清理");

        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn round_trips_text() {
        let (base, root) = fixture("roundtrip");

        write_text(&root, "scripts/a.pe", "scene 1\n").unwrap();
        assert_eq!(read_text(&root, "scripts/a.pe").unwrap(), "scene 1\n");

        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn write_creates_missing_directories() {
        let (base, root) = fixture("mkdir");

        write_text(&root, "scripts/deep/nested/a.pe", "x").unwrap();
        assert!(PathBuf::from(&root)
            .join("scripts")
            .join("deep")
            .join("nested")
            .join("a.pe")
            .is_file());

        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn reading_a_directory_fails() {
        let (base, root) = fixture("dir");

        assert!(read_text(&root, "scripts").is_err());

        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn reading_outside_the_project_fails() {
        let (base, root) = fixture("escape");

        assert!(read_text(&root, "../escape.txt").is_err());
        assert!(write_text(&root, "../escape.txt", "x").is_err());

        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn base64_matches_rfc_4648_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn base64_round_trips_and_rejects_junk() {
        for sample in [b"".as_slice(), b"f", b"fo", b"foo", b"foobar"] {
            let encoded = base64_encode(sample);
            assert_eq!(base64_decode(&encoded).unwrap(), sample);
        }

        // 解码时容许换行符与 URL 安全字母。
        assert_eq!(base64_decode("Zm9v\nYmFy").unwrap(), b"foobar");

        assert!(base64_decode("not base64!!").is_err());
    }

    #[test]
    fn write_asset_decodes_a_data_url() {
        let (base, root) = fixture("write-asset");

        write_asset_data_url(&root, "dialogs/default.png", "data:image/png;base64,YWJj").unwrap();
        assert_eq!(
            read_asset_data_url(&root, "dialogs/default.png", "").unwrap(),
            "data:image/png;base64,YWJj"
        );
        // 名称含子目录时，解析结果位于 `assets/` 下，而非项目根目录。
        assert!(PathBuf::from(&root)
            .join("assets/dialogs/default.png")
            .is_file());

        // 裸文件名与显式 `assets/` 前缀两种写法均受支持。
        write_asset_data_url(&root, "assets/other.png", "YWJj").unwrap();
        assert!(PathBuf::from(&root).join("assets/other.png").is_file());

        assert!(write_asset_data_url(&root, "bad.png", "!!!").is_err());

        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn read_asset_inlines_a_known_image() {
        let (base, root) = fixture("asset");

        // 字节内容不作校验，读取器只检查扩展名。
        write_text(&root, "assets/bg.png", "abc").unwrap();
        assert_eq!(
            read_asset_data_url(&root, "assets/bg.png", "").unwrap(),
            "data:image/png;base64,YWJj"
        );

        // 扩展名匹配不区分大小写。
        write_text(&root, "assets/photo.JPG", "x").unwrap();
        assert!(read_asset_data_url(&root, "assets/photo.JPG", "")
            .unwrap()
            .starts_with("data:image/jpeg;base64,"));

        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn read_audio_inlines_a_known_sound() {
        let (base, root) = fixture("audio");

        // 字节内容不作校验，读取器只检查扩展名。
        write_text(&root, "assets/Audio/bgm.mp3", "abc").unwrap();
        assert_eq!(
            read_audio_data_url(&root, "bgm.mp3").unwrap(),
            "data:audio/mpeg;base64,YWJj"
        );

        // 扩展名匹配不区分大小写；目录不按文件处理。
        write_text(&root, "assets/Audio/voice.OGG", "x").unwrap();
        assert!(read_audio_data_url(&root, "voice.OGG")
            .unwrap()
            .starts_with("data:audio/ogg;base64,"));
        assert!(read_audio_data_url(&root, "assets").is_err());

        // 图片不按音频解析；不读取项目目录之外的文件。
        write_text(&root, "assets/bg.png", "x").unwrap();
        assert!(read_audio_data_url(&root, "bg.png").is_err());
        assert!(read_audio_data_url(&root, "../outside.mp3").is_err());

        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn read_video_inlines_a_known_clip() {
        let (base, root) = fixture("video");

        // 裸名在 `assets/Video/` 下解析；字节内容不作校验，只看扩展名。
        write_text(&root, "assets/Video/opening.mp4", "abc").unwrap();
        assert_eq!(
            read_video_data_url(&root, "opening.mp4").unwrap(),
            "data:video/mp4;base64,YWJj"
        );

        // 扩展名不区分大小写，也接受显式路径。
        write_text(&root, "assets/Video/trailer.WEBM", "x").unwrap();
        assert!(read_video_data_url(&root, "trailer.WEBM")
            .unwrap()
            .starts_with("data:video/webm;base64,"));
        assert!(read_video_data_url(&root, "assets/Video/opening.mp4").is_ok());

        // 不认识的容器、目录和项目外的文件都被拒绝。
        write_text(&root, "assets/Video/clip.mkv", "x").unwrap();
        assert!(read_video_data_url(&root, "clip.mkv").is_err());
        assert!(read_video_data_url(&root, "assets").is_err());
        assert!(read_video_data_url(&root, "../outside.mp4").is_err());

        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn read_asset_falls_back_to_the_flat_assets_folder() {
        let (base, root) = fixture("asset-flat");

        // 早期项目把资源直接放在 `assets/` 根目录，仍需兼容该布局。
        write_text(&root, "assets/ch.png", "abc").unwrap();
        assert_eq!(
            read_asset_data_url(&root, "ch.png", "Character").unwrap(),
            "data:image/png;base64,YWJj"
        );
        // 同名文件同时存在时，类型专属目录优先于扁平根目录。
        write_text(&root, "assets/Character/ch.png", "xy").unwrap();
        assert_eq!(
            read_asset_data_url(&root, "ch.png", "Character").unwrap(),
            "data:image/png;base64,eHk="
        );

        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn a_bare_name_with_no_kind_finds_a_picture_in_a_subfolder() {
        let (base, root) = fixture("asset-subfolder");

        // 对白设计器按图层名引用图片，解析规则与脚本中的资源名一致。
        write_text(&root, "assets/templates/plate.png", "abc").unwrap();
        assert_eq!(
            read_asset_data_url(&root, "plate.png", "").unwrap(),
            "data:image/png;base64,YWJj"
        );

        // 扁平根目录的优先级仍高于同名子目录的扫描结果。
        write_text(&root, "assets/plate.png", "xy").unwrap();
        assert_eq!(
            read_asset_data_url(&root, "plate.png", "").unwrap(),
            "data:image/png;base64,eHk="
        );

        // 类型专属目录优先于扫描结果；显式路径只按字面解析。
        write_text(&root, "assets/Character/ch.png", "zz").unwrap();
        assert_eq!(
            read_asset_data_url(&root, "ch.png", "Character").unwrap(),
            "data:image/png;base64,eno="
        );
        assert_eq!(
            read_asset_data_url(&root, "assets/templates/plate.png", "").unwrap(),
            "data:image/png;base64,YWJj"
        );

        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn a_dotted_name_finds_a_picture_in_a_nested_folder() {
        let (base, root) = fixture("asset-dotted");

        // `ch = Character ori.si.png` 解析为 `assets/Character/ori/si.png`。
        write_text(&root, "assets/Character/ori/si.png", "abc").unwrap();
        assert_eq!(
            read_asset_data_url(&root, "ori.si.png", "Character").unwrap(),
            "data:image/png;base64,YWJj"
        );
        assert_eq!(
            read_asset_data_url(&root, "ori/si.png", "Character").unwrap(),
            "data:image/png;base64,YWJj"
        );

        // 优先尝试名称的原始写法，以兼容确实使用点号命名的旧项目。
        write_text(&root, "assets/Character/ori.si.png", "xy").unwrap();
        assert_eq!(
            read_asset_data_url(&root, "ori.si.png", "Character").unwrap(),
            "data:image/png;base64,eHk="
        );

        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn dotted_folders_nest_and_work_for_audio_and_the_designer() {
        let (base, root) = fixture("asset-dotted-more");

        // 扩展名之前的每个点号都视为一级目录，层数不限。
        write_text(&root, "assets/Character/a/b/c.png", "abc").unwrap();
        assert_eq!(
            read_asset_data_url(&root, "a.b.c.png", "Character").unwrap(),
            "data:image/png;base64,YWJj"
        );

        // 无类型前缀的点号名称同样参与 `assets/` 子目录扫描。
        write_text(&root, "assets/templates/ori/si.png", "xy").unwrap();
        assert_eq!(
            read_asset_data_url(&root, "ori.si.png", "").unwrap(),
            "data:image/png;base64,eHk="
        );

        // 音频资源使用同一套候选路径解析。
        write_text(&root, "assets/Audio/music/bgm.mp3", "zz").unwrap();
        assert_eq!(
            read_audio_data_url(&root, "music.bgm.mp3").unwrap(),
            "data:audio/mpeg;base64,eno="
        );

        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn a_name_with_a_folder_is_tried_under_the_kind_folder_first() {
        let (base, root) = fixture("asset-nested-kind");

        write_text(&root, "assets/Character/ori/si.png", "abc").unwrap();
        write_text(&root, "assets/ori/si.png", "xy").unwrap();
        // 从资源树拖出嵌套文件时，保留其在 `assets/` 下的相对路径。
        assert_eq!(
            read_asset_data_url(&root, "Character/ori/si.png", "Character").unwrap(),
            "data:image/png;base64,YWJj"
        );
        assert_eq!(
            read_asset_data_url(&root, "assets/Character/ori/si.png", "").unwrap(),
            "data:image/png;base64,YWJj"
        );
        // 显式给出的 `assets/` 路径按字面使用，不重新定位根目录。
        assert_eq!(
            read_asset_data_url(&root, "assets/ori/si.png", "Character").unwrap(),
            "data:image/png;base64,eHk="
        );

        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn a_missing_asset_names_both_places_it_looked() {
        let (base, root) = fixture("asset-missing");

        // 错误提示需指出类型目录与扁平目录，不暴露原始操作系统错误码。
        let message = read_asset_data_url(&root, "nope.png", "Character")
            .unwrap_err()
            .to_string();
        assert!(message.contains("assets/Character/nope.png"), "{message}");
        assert!(message.contains("assets/nope.png"), "{message}");
        assert!(!message.contains("os error"), "{message}");

        // 显式路径只指向其字面位置，不参与候选推导。
        let explicit = read_asset_data_url(&root, "assets/Character/nope.png", "Character")
            .unwrap_err()
            .to_string();
        assert!(explicit.contains("assets/Character/nope.png"), "{explicit}");

        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn a_missing_text_file_is_named_rather_than_an_os_error() {
        let (base, root) = fixture("text-missing");

        let message = read_text(&root, "data/key-ch.keyframes")
            .unwrap_err()
            .to_string();
        assert!(message.contains("data/key-ch.keyframes"), "{message}");
        assert!(!message.contains("os error"), "{message}");

        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn read_asset_defaults_to_the_kind_directory() {
        let (base, root) = fixture("asset-default");

        write_text(&root, "assets/Character/ch.png", "abc").unwrap();
        // 裸名称在所属类型目录内解析。
        assert_eq!(
            read_asset_data_url(&root, "ch.png", "Character").unwrap(),
            "data:image/png;base64,YWJj"
        );
        // 显式指定目录时按原样接受。
        assert_eq!(
            read_asset_data_url(&root, "assets/Character/ch.png", "Character").unwrap(),
            "data:image/png;base64,YWJj"
        );
        // 某类型的裸名称不会解析到另一类型的目录，两类目录相互隔离。
        assert!(read_asset_data_url(&root, "ch.png", "Background").is_err());

        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn read_asset_rejects_unknown_types_and_escapes() {
        let (base, root) = fixture("asset-bad");

        write_text(&root, "assets/notes.txt", "x").unwrap();
        assert!(read_asset_data_url(&root, "assets/notes.txt", "").is_err());
        assert!(read_asset_data_url(&root, "../outside.png", "").is_err());

        fs::remove_dir_all(&base).unwrap();
    }
}
