//! 项目模型：清单结构、目录约定与完整性检查。
//! Project model: manifest structure, directory conventions and integrity checks.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// 标记目录为 Pamela 项目的清单文件名。
pub const MANIFEST_FILE: &str = "pamela.json";

/// 新建项目时创建的剧本目录。
pub const SCRIPTS_DIR: &str = "scripts";

/// 新建项目时创建的资源目录，存放图片、音频等资源。
pub const ASSETS_DIR: &str = "assets";

/// 完整性检查保证存在的 `assets/` 子目录，供资源选择器使用。
pub const ASSET_SUBFOLDERS: [&str; 6] = [
    "Background",
    "Character",
    "Audio",
    "Video",
    "templates",
    "ui",
];

/// 新建项目时创建的可视化编程地图目录。
pub const MAPS_DIR: &str = "maps";

/// 新建项目时创建的数据目录，存放关键帧与其它运行时数据。
pub const DATA_DIR: &str = "data";

/// 新建项目时创建的存档目录（节点侧存档）。
pub const SAVES_DIR: &str = "saves";

/// 导出 MP4 的产物目录。由导出会话写入，提前建好以便资源树从一开始就有位置。
pub const EXPORTS_DIR: &str = "exports";

/// Pamela 剧本文件的扩展名。
pub const SCRIPT_SUFFIX: &str = ".pe";

/// 简写方言剧本的扩展名。
pub const SHORT_SCRIPT_SUFFIX: &str = ".mpe";

/// 新建项目时创建的对白样式模板目录。
pub const TEMPLATES_DIR: &str = "templates";

/// 对白样式文件的扩展名，按前端拼写定义；后端只用于识别，不解析内容。
const DIALOG_SUFFIX: &str = ".dialog.json";

/// `templates/` 为空时载入的默认样式文件。
pub const DEFAULT_STYLE_FILE: &str = "default.dialog.json";

/// 项目尚无剧本时写入的默认剧本。
const DEFAULT_SCRIPT_FILE: &str = "main.pe";

/// 默认剧本内容取可运行的最小集合，使新建项目可直接启动。
const DEFAULT_SCRIPT_SOURCE: &str = r#"# Pamela — 默认脚本。
# 按 Ctrl+Enter（演出 → 运行当前脚本）试跑。

say("这是项目里的第一个脚本。")
"#;

/// `pamela.json` 清单的数据结构。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    /// 清单格式版本，用于兼容旧项目。
    pub version: u32,
    /// 项目的显示名称。
    pub name: String,
    /// 运行项目时首先打开的剧本；尚无剧本时为空。
    pub entry: String,
    /// 舞台排版所用的对白样式，按项目相对路径指向 `templates/` 下的样式文件。
    #[serde(default)]
    pub style: String,
    /// 对话框默认的文本呈现方式：`off`（整行直接出现，不逐字）/ `fast` /
    /// `medium` / `slow`（打字机逐字显示，速度递增）。旧清单缺此字段时加载
    /// 为空，前端一律当作 `off`。
    #[serde(default)]
    pub typewriter: String,
}

/// 资源树中的单个条目。
#[derive(Debug, Clone, Serialize)]
pub struct TreeNode {
    pub name: String,
    /// 相对项目根目录的路径，统一使用正斜杠，供前端直接展示。
    pub path: String,
    pub is_dir: bool,
    /// 标识条目是否为 `.pe` 剧本，以区别于资源与清单。
    pub is_script: bool,
    pub children: Vec<TreeNode>,
}

/// 一个已打开的项目。
#[derive(Debug, Clone, Serialize)]
pub struct Project {
    pub name: String,
    /// 项目根目录的绝对路径。
    pub root: String,
    pub entry: String,
    /// 舞台载入的对白样式的项目相对路径；为空时使用默认样式。
    pub style: String,
    /// 对话框默认打字机档位，镜像 `Manifest::typewriter`。
    pub typewriter: String,
    pub tree: Vec<TreeNode>,
}

/// 创建新的项目目录并返回项目对象。
pub fn create(parent: &Path, name: &str) -> io::Result<Project> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(invalid("项目名不能为空"));
    }
    // 项目名会用作目录名，需拒绝路径分隔符与目录穿越。
    if trimmed.contains(['/', '\\']) || trimmed == "." || trimmed == ".." {
        return Err(invalid("项目名不能包含路径分隔符"));
    }

    // Windows 保留名（CON、NUL、COM1…）无法作为目录名创建。
    let stem = trimmed
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end_matches(' ')
        .to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit()
            && stem.as_bytes()[3] != b'0');
    if reserved || trimmed.ends_with('.') || trimmed.ends_with(' ') {
        return Err(invalid("项目名不能是系统保留名称，也不能以点或空格结尾"));
    }

    let root = parent.join(trimmed);
    if root.join(MANIFEST_FILE).is_file() {
        return Err(invalid(&format!("项目“{trimmed}”已存在")));
    }
    // 目录已存在且不是空目录时拒绝写入，避免把新项目混进用户的旧文件里。
    if root.is_dir() && fs::read_dir(&root)?.next().is_some() {
        return Err(invalid(&format!("目录“{trimmed}”已存在且不为空")));
    }

    fs::create_dir_all(root.join(SCRIPTS_DIR))?;
    fs::create_dir_all(root.join(ASSETS_DIR))?;
    fs::create_dir_all(root.join(TEMPLATES_DIR))?;
    fs::create_dir_all(root.join(MAPS_DIR))?;
    fs::create_dir_all(root.join(DATA_DIR))?;
    fs::create_dir_all(root.join(SAVES_DIR))?;
    fs::create_dir_all(root.join(EXPORTS_DIR))?;
    // 按资源类型各建一个目录，另加两个模板目录，供资源选择器分类。
    for sub in ASSET_SUBFOLDERS {
        fs::create_dir_all(root.join(ASSETS_DIR).join(sub))?;
    }

    // 先写入样式文件名，样式文件本身由前端随后填充。
    let manifest = Manifest {
        version: 1,
        name: trimmed.to_string(),
        entry: String::new(),
        style: format!("{TEMPLATES_DIR}/{DEFAULT_STYLE_FILE}"),
        typewriter: "off".to_string(),
    };
    write_manifest(&root, &manifest)?;

    load(&root)
}

/// 打开已有项目目录。
pub fn load(root: &Path) -> io::Result<Project> {
    if !root.is_dir() {
        return Err(invalid(&format!("目录不存在：{}", root.display())));
    }
    if !root.join(MANIFEST_FILE).is_file() {
        return Err(invalid(&format!(
            "不是 Pamela 项目（缺少 {MANIFEST_FILE}）：{}",
            root.display()
        )));
    }

    let manifest = read_manifest(root)?;
    let mut tree = Vec::new();
    walk(root, root, 0, &mut tree)?;

    Ok(Project {
        name: manifest.name,
        root: root.display().to_string(),
        entry: manifest.entry,
        style: manifest.style,
        typewriter: manifest.typewriter.clone(),
        tree,
    })
}

/// 把清单入口指向 `entry`；`entry` 为空时清除入口。路径解析规则与其它路径一致。
pub fn set_entry(root: &Path, entry: &str) -> io::Result<Project> {
    let trimmed = entry.trim().replace('\\', "/");
    let mut manifest = read_manifest(root)?;

    if trimmed.is_empty() {
        manifest.entry = String::new();
    } else {
        // 绝对路径与目录穿越按统一规则拒绝，避免写入项目之外。
        let path = resolve(&root.display().to_string(), &trimmed)?;
        if !path.is_file() {
            return Err(invalid(&format!("找不到脚本：{trimmed}")));
        }
        manifest.entry = trimmed;
    }

    write_manifest(root, &manifest)?;
    load(root)
}

/// 设置对话框默认的打字机档位，改写清单里的 `typewriter` 字段并重新载入项目。
///
/// 只允许 `off` / `fast` / `medium` / `slow` 四档，其它值被拒，避免清单里落
/// 进无法识其它档位。改写走后端而非前端直接重写 `pamela.json`，以免丢掉清单
/// 的其它字段（同 `set_entry` 的考虑）。
pub fn set_typewriter(root: &Path, value: &str) -> io::Result<Project> {
    let trimmed = value.trim();
    match trimmed {
        "off" | "fast" | "medium" | "slow" => {}
        _ => return Err(invalid("打字机档位只能是 off / fast / medium / slow 之一")),
    }

    let mut manifest = read_manifest(root)?;
    manifest.typewriter = trimmed.to_string();
    write_manifest(root, &manifest)?;
    load(root)
}

/// 一次完整性检查的发现与修复结果。
#[derive(Debug, Clone, Serialize)]
pub struct IntegrityReport {
    /// 按发生顺序记录已执行的修复；无修复时为空。
    pub repairs: Vec<String>,
    /// `templates/` 缺少样式文件时，由前端载入内置默认样式。
    pub needs_template: bool,
    /// 清单指向运行时的样式文件，以项目相对路径记录。
    pub style: String,
    /// 修复完成后的项目状态。
    pub project: Project,
}

/// 按编辑器预期检查项目结构，补齐缺失的目录、清单、剧本与样式底板，并报告全部修复。
pub fn check(root: &Path, name: &str) -> io::Result<IntegrityReport> {
    if !root.is_dir() {
        return Err(invalid(&format!("目录不存在：{}", root.display())));
    }

    let mut repairs = Vec::new();

    for dir in [
        ASSETS_DIR,
        TEMPLATES_DIR,
        SCRIPTS_DIR,
        MAPS_DIR,
        DATA_DIR,
        SAVES_DIR,
        EXPORTS_DIR,
    ] {
        let path = root.join(dir);
        if path.is_dir() {
            continue;
        }
        // 目录位置被文件占用时保持原状，不删除作者数据。
        if path.exists() {
            return Err(invalid(&format!(
                "{dir} 被一个同名文件占用了，无法作为目录"
            )));
        }
        fs::create_dir_all(&path)?;
        repairs.push(format!("已创建 {dir}/"));
    }

    // 每次检查都会确保类型目录与模板目录存在，不限于新建项目。
    for sub in ASSET_SUBFOLDERS {
        let path = root.join(ASSETS_DIR).join(sub);
        if !path.is_dir() {
            fs::create_dir_all(&path)?;
            repairs.push(format!("已创建 {ASSETS_DIR}/{sub}/"));
        }
    }

    let needs_template = !contains_file(&root.join(TEMPLATES_DIR), 0, is_style)?;
    if needs_template {
        repairs.push(format!("{TEMPLATES_DIR}/ 没有样式文件，等待装载默认样式"));
    }

    // 按字母序读取目录内已有样式，供清单修复时选用。底板由运行时按样式
    // 文件里的 layers 直接绘制，检查阶段不再需要核对任何图片文件。
    let styles = collect_files(root, &root.join(TEMPLATES_DIR), 0, is_style)?;

    if !contains_file(&root.join(SCRIPTS_DIR), 0, is_script)? {
        crate::files::atomic_write(
            &root.join(SCRIPTS_DIR).join(DEFAULT_SCRIPT_FILE),
            DEFAULT_SCRIPT_SOURCE.as_bytes(),
        )?;
        repairs.push(format!("已创建 {SCRIPTS_DIR}/{DEFAULT_SCRIPT_FILE}"));
    }

    // 清单自身的修复：存在但无法解析时先备份，再按默认结构重建。
    let manifest_path = root.join(MANIFEST_FILE);
    let manifest_readable = manifest_path.is_file() && read_manifest_file(&manifest_path).is_ok();
    let current = if manifest_path.is_file() {
        read_manifest(root).ok()
    } else {
        None
    };
    let named = current
        .as_ref()
        .map(|manifest| manifest.style.clone())
        .unwrap_or_default();
    // 作者选定的样式在其文件确实存在时予以保留。
    let style = if !named.is_empty() && file_in_project(root, &named) {
        named
    } else if needs_template {
        // 该样式文件即将由前端写入，清单可先行指向它。
        format!("{TEMPLATES_DIR}/{DEFAULT_STYLE_FILE}")
    } else {
        styles.first().cloned().unwrap_or_default()
    };

    match current {
        Some(mut manifest) => {
            // 主文件坏了、内容来自 .bak：把恢复出来的清单写回主文件。
            if !manifest_readable {
                write_manifest(root, &manifest)?;
                repairs.push(format!("已从 {MANIFEST_FILE}.bak 恢复清单"));
            }
            if manifest.style != style {
                manifest.style = style.clone();
                write_manifest(root, &manifest)?;
                repairs.push(format!("已记录样式文件：{style}"));
            }
        }
        None => {
            if manifest_path.is_file() {
                // 保留坏文件供人工取证；覆盖上一次的 .broken。
                let broken = root.join(format!("{MANIFEST_FILE}.broken"));
                let _ = fs::remove_file(&broken);
                let _ = fs::copy(&manifest_path, &broken);
                repairs.push(format!(
                    "已备份损坏的 {MANIFEST_FILE} 为 {MANIFEST_FILE}.broken"
                ));
            }
            write_manifest(
                root,
                &Manifest {
                    version: 1,
                    name: name.to_string(),
                    entry: first_script(root).unwrap_or_default(),
                    style: style.clone(),
                    typewriter: "off".to_string(),
                },
            )?;
            repairs.push(format!("已重建 {MANIFEST_FILE}"));
        }
    }

    Ok(IntegrityReport {
        repairs,
        needs_template,
        style,
        project: load(root)?,
    })
}

/// 判断 `dir` 下任意深度是否存在满足 `matches` 的文件。
fn contains_file(dir: &Path, depth: usize, matches: fn(&str) -> bool) -> io::Result<bool> {
    if depth >= MAX_DEPTH {
        return Ok(false);
    }

    for entry in fs::read_dir(dir)?.filter_map(Result::ok) {
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            // A name the webview cannot round-trip would later open a different
            // file after the lossy conversion; skip it here.
            continue;
        };
        if is_hidden(&name) {
            continue;
        }
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            if contains_file(&entry.path(), depth + 1, matches)? {
                return Ok(true);
            }
        } else if matches(&name) {
            return Ok(true);
        }
    }

    Ok(false)
}

/// 返回 `dir` 下任意深度满足 `matches` 的全部文件，以项目相对路径表示。
fn collect_files(
    root: &Path,
    dir: &Path,
    depth: usize,
    matches: fn(&str) -> bool,
) -> io::Result<Vec<String>> {
    let mut out = Vec::new();
    collect_into(root, dir, depth, matches, &mut out)?;
    out.sort();
    Ok(out)
}

fn collect_into(
    root: &Path,
    dir: &Path,
    depth: usize,
    matches: fn(&str) -> bool,
    out: &mut Vec<String>,
) -> io::Result<()> {
    if depth >= MAX_DEPTH {
        return Ok(());
    }

    for entry in fs::read_dir(dir)?.filter_map(Result::ok) {
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            // A name the webview cannot round-trip would later open a different
            // file after the lossy conversion; skip it here.
            continue;
        };
        if is_hidden(&name) {
            continue;
        }
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            if file_type.is_symlink() {
                continue;
            }
            collect_into(root, &entry.path(), depth + 1, matches, out)?;
        } else if matches(&name) {
            out.push(relative_path(root, &entry.path()));
        }
    }

    Ok(())
}

/// 判断项目相对路径是否指向磁盘上真实存在的文件。
fn file_in_project(root: &Path, relative: &str) -> bool {
    resolve(&root.display().to_string(), relative).is_ok_and(|path| path.is_file())
}

/// 返回 `scripts/` 目录下按字母序排在首位的 `.pe` 文件，以项目相对路径表示。
fn first_script(root: &Path) -> Option<String> {
    let mut names: Vec<String> = fs::read_dir(root.join(SCRIPTS_DIR))
        .ok()?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .filter_map(|entry| entry.file_name().to_str().map(str::to_owned))
        .filter(|name| !is_hidden(name) && is_script(name))
        .collect();
    names.sort();
    names.first().map(|name| format!("{SCRIPTS_DIR}/{name}"))
}

/// 读取并解析项目目录下的清单；主文件损坏时回退到上一次的 `.bak`。
fn read_manifest(root: &Path) -> io::Result<Manifest> {
    let path = root.join(MANIFEST_FILE);
    match read_manifest_file(&path) {
        Ok(manifest) => Ok(manifest),
        Err(primary) => {
            let backup = root.join(format!("{MANIFEST_FILE}.bak"));
            if backup.is_file() {
                return read_manifest_file(&backup).map_err(|_| primary);
            }
            Err(primary)
        }
    }
}

/// 读取并解析一个具体的清单文件，不尝试回退。
fn read_manifest_file(path: &Path) -> io::Result<Manifest> {
    let text = fs::read_to_string(path)?;
    serde_json::from_str(&text).map_err(|e| invalid(&format!("{} 解析失败：{e}", path.display())))
}

/// 把清单序列化写回磁盘；原子写保证中断时旧清单仍可读。
fn write_manifest(root: &Path, manifest: &Manifest) -> io::Result<()> {
    let path = root.join(MANIFEST_FILE);
    let text = serde_json::to_string_pretty(manifest).map_err(io::Error::other)?;
    crate::files::atomic_write(&path, text.as_bytes())
}

/// 构建资源树时允许遍历的最大目录深度，用于防止符号链接造成的无限递归。
const MAX_DEPTH: usize = 16;

fn walk(root: &Path, dir: &Path, depth: usize, out: &mut Vec<TreeNode>) -> io::Result<()> {
    if depth >= MAX_DEPTH {
        return Ok(());
    }

    let mut entries: Vec<_> = fs::read_dir(dir)?
        .filter_map(Result::ok)
        .filter(|entry| !is_hidden(&entry.file_name().to_string_lossy()))
        .collect();

    // 目录在前、文件在后，各自按字母序排列，保证资源树顺序稳定。
    entries.sort_by_key(|entry| {
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        (!is_dir, entry.file_name())
    });

    for entry in entries {
        let path = entry.path();
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            // A name the webview cannot round-trip would later open a different
            // file after the lossy conversion; skip it here.
            continue;
        };
        let relative = relative_path(root, &path);

        // 符号链接目录在条目类型上可能表现为文件，需单独处理。
        let file_type = entry.file_type()?;
        let is_dir = if file_type.is_symlink() {
            false
        } else {
            file_type.is_dir()
        };

        if is_dir {
            let mut children = Vec::new();
            walk(root, &path, depth + 1, &mut children)?;
            out.push(TreeNode {
                name,
                path: relative,
                is_dir: true,
                is_script: false,
                children,
            });
        } else {
            out.push(TreeNode {
                name: name.clone(),
                path: relative,
                is_dir: false,
                is_script: is_script(&name),
                children: Vec::new(),
            });
        }
    }

    Ok(())
}

/// 判断是否为剧本文件，扩展名匹配不区分大小写。
fn is_script(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(SCRIPT_SUFFIX)
        || lower.ends_with(SHORT_SCRIPT_SUFFIX)
        || lower.ends_with(".pamela")
}

/// 判断是否为 `.dialog.json` 对白样式，匹配不区分大小写。
fn is_style(name: &str) -> bool {
    name.to_ascii_lowercase().ends_with(DIALOG_SUFFIX)
}

/// 隐藏 `.git` 等点文件与点目录。
fn is_hidden(name: &str) -> bool {
    name.starts_with('.')
}

/// 把 `path` 表示为相对 `root` 的路径并使用正斜杠，供前端展示。
fn relative_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .components()
        .map(|c| c.as_os_str().to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join("/")
}

/// 构造面向用户的 `InvalidInput` 错误。
pub(crate) fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

/// 把项目相对路径拼接到根目录，拒绝越出项目范围的路径。
pub fn resolve(root: &str, relative: &str) -> io::Result<PathBuf> {
    let relative = relative.replace('\\', "/");
    let candidate = Path::new(root);
    if relative.is_empty() {
        return Ok(candidate.to_path_buf());
    }
    if relative.starts_with('/') || relative.contains(':') {
        return Err(invalid("路径必须是项目内的相对路径"));
    }

    let mut out = candidate.to_path_buf();
    for segment in relative.split('/') {
        match segment {
            "" | "." => {}
            ".." => return Err(invalid("路径不能跳出项目目录")),
            other => {
                out.push(other);
                // 词法检查看不出符号链接：项目内的一个链接可以指向磁盘任意
                // 位置，读和写都会跟着它出去。逐段检查并拒绝链接；尚不存在
                // 的路径（即将写入的新文件）不算链接。
                let linked = fs::symlink_metadata(&out)
                    .map(|meta| meta.file_type().is_symlink())
                    .unwrap_or(false);
                if linked {
                    return Err(invalid("路径不能经过符号链接"));
                }
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_builds_a_project_with_a_manifest() {
        let temp = std::env::temp_dir().join(format!("pamela-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&temp);
        fs::create_dir_all(&temp).unwrap();

        let project = create(&temp, "demo").unwrap();

        assert_eq!(project.name, "demo");
        assert!(Path::new(&project.root).join(MANIFEST_FILE).is_file());
        assert!(Path::new(&project.root).join(SCRIPTS_DIR).is_dir());
        assert!(Path::new(&project.root).join(ASSETS_DIR).is_dir());
        assert!(Path::new(&project.root).join(TEMPLATES_DIR).is_dir());
        assert!(Path::new(&project.root).join(MAPS_DIR).is_dir());
        assert!(Path::new(&project.root).join(DATA_DIR).is_dir());
        assert!(Path::new(&project.root).join(SAVES_DIR).is_dir());
        assert!(Path::new(&project.root).join(EXPORTS_DIR).is_dir());
        // 完整性检查保证存在的每个 `assets/` 子目录都必须被覆盖。
        for sub in ASSET_SUBFOLDERS {
            assert!(
                Path::new(&project.root).join(ASSETS_DIR).join(sub).is_dir(),
                "{ASSETS_DIR}/{sub}/ should exist"
            );
        }

        // 目录排在文件之前；清单按普通文件同样列出。
        let names: Vec<_> = project.tree.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "assets",
                "data",
                "exports",
                "maps",
                "saves",
                "scripts",
                "templates",
                MANIFEST_FILE
            ]
        );

        let manifest = project
            .tree
            .iter()
            .find(|n| n.name == MANIFEST_FILE)
            .unwrap();
        assert!(!manifest.is_dir);
        assert!(!manifest.is_script, "the manifest is not a script");

        fs::remove_dir_all(&temp).unwrap();
    }

    #[test]
    fn create_is_idempotent_only_when_the_project_is_absent() {
        let temp = std::env::temp_dir().join(format!("pamela-test-dup-{}", std::process::id()));
        let _ = fs::remove_dir_all(&temp);
        fs::create_dir_all(&temp).unwrap();

        create(&temp, "demo").unwrap();
        let second = create(&temp, "demo");
        assert!(
            second.is_err(),
            "creating over an existing project is refused"
        );

        fs::remove_dir_all(&temp).unwrap();
    }

    #[test]
    fn create_rejects_a_name_with_separators() {
        let temp = std::env::temp_dir().join(format!("pamela-test-sep-{}", std::process::id()));
        let _ = fs::remove_dir_all(&temp);
        fs::create_dir_all(&temp).unwrap();

        assert!(create(&temp, "a/b").is_err());
        assert!(create(&temp, "..").is_err());
        assert!(create(&temp, "  ").is_err());

        fs::remove_dir_all(&temp).unwrap();
    }

    #[test]
    fn check_repairs_a_corrupt_manifest_and_keeps_a_backup() {
        let temp = std::env::temp_dir().join(format!("pamela-test-broken-{}", std::process::id()));
        let _ = fs::remove_dir_all(&temp);
        fs::create_dir_all(&temp).unwrap();
        let project = create(&temp, "demo").unwrap();
        let root = PathBuf::from(&project.root);

        fs::write(root.join(MANIFEST_FILE), "{ not json").unwrap();
        let report = check(&root, "demo").unwrap();

        assert!(root.join(MANIFEST_FILE).is_file(), "清单被重建");
        assert!(
            root.join(format!("{MANIFEST_FILE}.broken")).is_file(),
            "坏文件留了备份"
        );
        assert!(report.repairs.iter().any(|line| line.contains("重建")));
        load(&root).expect("修复后的项目能重新打开");

        fs::remove_dir_all(&temp).unwrap();
    }

    #[test]
    fn load_falls_back_to_the_manifest_backup() {
        let temp = std::env::temp_dir().join(format!("pamela-test-bak-{}", std::process::id()));
        let _ = fs::remove_dir_all(&temp);
        fs::create_dir_all(&temp).unwrap();
        let project = create(&temp, "demo").unwrap();
        let root = PathBuf::from(&project.root);

        let good = fs::read_to_string(root.join(MANIFEST_FILE)).unwrap();
        fs::write(root.join(format!("{MANIFEST_FILE}.bak")), good).unwrap();
        fs::write(root.join(MANIFEST_FILE), "{ broken").unwrap();

        let loaded = load(&root).expect("主清单损坏时从 .bak 恢复");
        assert_eq!(loaded.name, "demo");

        fs::remove_dir_all(&temp).unwrap();
    }

    #[test]
    fn load_rejects_a_folder_without_a_manifest() {
        let temp = std::env::temp_dir().join(format!("pamela-test-bare-{}", std::process::id()));
        let _ = fs::remove_dir_all(&temp);
        fs::create_dir_all(&temp).unwrap();

        assert!(load(&temp).is_err());

        fs::remove_dir_all(&temp).unwrap();
    }

    #[test]
    fn walk_marks_scripts_and_hides_dotfiles() {
        let temp = std::env::temp_dir().join(format!("pamela-test-walk-{}", std::process::id()));
        let _ = fs::remove_dir_all(&temp);
        let project = create(&temp, "demo").unwrap();
        let root = PathBuf::from(&project.root);

        fs::write(root.join("scripts").join("a.pe"), "").unwrap();
        fs::write(root.join("scripts").join("b.PE"), "").unwrap();
        // 简写方言同样属于剧本；后端不读取其内容，只按扩展名识别。
        fs::write(root.join("scripts").join("short.mpe"), "").unwrap();
        fs::write(root.join("scripts").join("SHORT2.MPE"), "").unwrap();
        // 旧版扩展名为 `.pamela`；旧项目仍需可打开且可运行。
        fs::write(root.join("scripts").join("legacy.pamela"), "").unwrap();
        fs::write(root.join("scripts").join("notes.txt"), "").unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join(".git").join("config"), "").unwrap();

        let reloaded = load(&root).unwrap();
        let scripts = reloaded
            .tree
            .iter()
            .find(|n| n.name == "scripts")
            .expect("scripts folder");

        let by_name = |name: &str| scripts.children.iter().find(|n| n.name == name).unwrap();
        assert!(by_name("a.pe").is_script);
        assert!(
            by_name("b.PE").is_script,
            "extension match is case-insensitive"
        );
        assert!(by_name("short.mpe").is_script, "the shorthand is a script");
        assert!(
            by_name("SHORT2.MPE").is_script,
            "the shorthand matches case-insensitively too"
        );
        assert!(by_name("legacy.pamela").is_script, "the old suffix is read");
        assert!(!by_name("notes.txt").is_script);

        assert!(
            !reloaded.tree.iter().any(|n| n.name == ".git"),
            "dot-directories are hidden"
        );

        fs::remove_dir_all(&temp).unwrap();
    }

    #[test]
    fn set_entry_records_a_script_and_survives_a_reload() {
        let temp = std::env::temp_dir().join(format!("pamela-test-entry-{}", std::process::id()));
        let _ = fs::remove_dir_all(&temp);
        let project = create(&temp, "demo").unwrap();
        let root = PathBuf::from(&project.root);
        fs::write(root.join("scripts").join("main.pe"), "").unwrap();

        let updated = set_entry(&root, "scripts/main.pe").unwrap();
        assert_eq!(updated.entry, "scripts/main.pe");
        assert_eq!(load(&root).unwrap().entry, "scripts/main.pe");

        // 传入空路径时清除入口，避免残留过期值。
        let cleared = set_entry(&root, "   ").unwrap();
        assert_eq!(cleared.entry, "");
        assert_eq!(load(&root).unwrap().entry, "");

        fs::remove_dir_all(&temp).unwrap();
    }

    #[test]
    fn set_entry_refuses_a_script_that_is_not_there() {
        let temp =
            std::env::temp_dir().join(format!("pamela-test-entry-bad-{}", std::process::id()));
        let _ = fs::remove_dir_all(&temp);
        let project = create(&temp, "demo").unwrap();
        let root = PathBuf::from(&project.root);

        assert!(set_entry(&root, "scripts/missing.pe").is_err());
        assert!(set_entry(&root, "../outside.pe").is_err());
        assert_eq!(
            load(&root).unwrap().entry,
            "",
            "a refused write leaves the manifest alone"
        );

        fs::remove_dir_all(&temp).unwrap();
    }

    #[test]
    fn check_leaves_a_complete_project_alone() {
        let temp =
            std::env::temp_dir().join(format!("pamela-test-check-ok-{}", std::process::id()));
        let _ = fs::remove_dir_all(&temp);
        let project = create(&temp, "demo").unwrap();
        let root = PathBuf::from(&project.root);

        // 带底板且路径与 `create` 一致时的样式检查结果。
        fs::write(
            root.join(TEMPLATES_DIR).join(DEFAULT_STYLE_FILE),
            r#"{"stamp":{"path":"assets/templates/default.png"}}"#,
        )
        .unwrap();
        fs::create_dir_all(root.join(ASSETS_DIR).join("templates")).unwrap();
        fs::write(
            root.join(ASSETS_DIR).join("templates").join("default.png"),
            "x",
        )
        .unwrap();
        fs::write(root.join(SCRIPTS_DIR).join("a.pe"), "").unwrap();

        let report = check(&root, "demo").unwrap();
        assert!(report.repairs.is_empty(), "nothing was missing");
        assert!(!report.needs_template);
        assert_eq!(
            report.style,
            format!("{TEMPLATES_DIR}/{DEFAULT_STYLE_FILE}")
        );
        assert_eq!(report.project.style, report.style);
        assert_eq!(report.project.name, "demo");

        // 未写入任何本已存在的内容。
        assert!(!root.join(SCRIPTS_DIR).join(DEFAULT_SCRIPT_FILE).exists());

        fs::remove_dir_all(&temp).unwrap();
    }

    #[test]
    fn check_repairs_a_missing_structure() {
        let temp =
            std::env::temp_dir().join(format!("pamela-test-check-repair-{}", std::process::id()));
        let _ = fs::remove_dir_all(&temp);
        let project = create(&temp, "demo").unwrap();
        let root = PathBuf::from(&project.root);

        // 模拟缺少 `data` / `saves` / `exports` 目录的旧项目或手工编辑过的项目。
        fs::remove_dir_all(root.join(DATA_DIR)).unwrap();
        fs::remove_dir_all(root.join(SAVES_DIR)).unwrap();
        fs::remove_dir_all(root.join(EXPORTS_DIR)).unwrap();
        fs::remove_dir_all(root.join(ASSETS_DIR).join("templates")).unwrap();
        fs::remove_dir_all(root.join(ASSETS_DIR).join("ui")).unwrap();

        let report = check(&root, "demo").unwrap();

        assert!(root.join(DATA_DIR).is_dir(), "data/ repaired");
        assert!(root.join(SAVES_DIR).is_dir(), "saves/ repaired");
        assert!(root.join(EXPORTS_DIR).is_dir(), "exports/ repaired");
        assert!(
            root.join(ASSETS_DIR).join("templates").is_dir(),
            "assets/templates/ repaired"
        );
        assert!(
            root.join(ASSETS_DIR).join("ui").is_dir(),
            "assets/ui/ repaired"
        );
        // 每个被修复的目录都需上报，供界面展示恢复内容。
        let joined = report.repairs.join("\n");
        assert!(joined.contains(&format!("{DATA_DIR}/")), "data/ reported");
        assert!(joined.contains(&format!("{SAVES_DIR}/")), "saves/ reported");
        assert!(
            joined.contains(&format!("{EXPORTS_DIR}/")),
            "exports/ reported"
        );
        assert!(
            joined.contains("assets/templates/"),
            "assets/templates/ reported"
        );
        assert!(joined.contains("assets/ui/"), "assets/ui/ reported");

        fs::remove_dir_all(&temp).unwrap();
    }

    #[test]
    fn check_asks_for_a_default_style_before_one_exists() {
        let temp =
            std::env::temp_dir().join(format!("pamela-test-check-style-{}", std::process::id()));
        let _ = fs::remove_dir_all(&temp);
        let project = create(&temp, "demo").unwrap();
        let root = PathBuf::from(&project.root);

        // `create` 会建立目录与清单，但不创建剧本与样式文件。
        let report = check(&root, "demo").unwrap();

        assert!(report.needs_template);
        assert!(root.join(SCRIPTS_DIR).join(DEFAULT_SCRIPT_FILE).is_file());
        assert!(report
            .repairs
            .iter()
            .any(|r| r.contains(DEFAULT_SCRIPT_FILE)));
        assert!(
            !report.repairs.iter().any(|r| r.contains(MANIFEST_FILE)),
            "the manifest was already there"
        );
        assert!(
            !report.repairs.iter().any(|r| r.ends_with('/')),
            "the folders were already there"
        );

        // 清单已指向前端即将写入的样式，检查时不重复改写。
        assert_eq!(
            report.style,
            format!("{TEMPLATES_DIR}/{DEFAULT_STYLE_FILE}")
        );
        assert_eq!(report.project.style, report.style);

        fs::remove_dir_all(&temp).unwrap();
    }

    #[test]
    fn check_leaves_style_files_alone() {
        let temp =
            std::env::temp_dir().join(format!("pamela-test-check-plate-{}", std::process::id()));
        let _ = fs::remove_dir_all(&temp);
        let project = create(&temp, "demo").unwrap();
        let root = PathBuf::from(&project.root);

        // 样式文件里的 layers 就是底板，检查阶段无需核对任何 PNG。
        fs::write(
            root.join(TEMPLATES_DIR).join("a.dialog.json"),
            r#"{"version":2,"styles":{"dialog":{"layers":[]},"narration":{"layers":[]}}}"#,
        )
        .unwrap();
        fs::write(root.join(TEMPLATES_DIR).join("b.dialog.json"), "{}").unwrap();
        fs::write(root.join(SCRIPTS_DIR).join("a.pe"), "").unwrap();

        let before = fs::read_to_string(root.join(TEMPLATES_DIR).join("b.dialog.json")).unwrap();
        let report = check(&root, "demo").unwrap();

        assert!(!report.needs_template, "there are style files");
        // 清单指向的样式不存在时，重新指向可用样式。
        assert_eq!(report.style, format!("{TEMPLATES_DIR}/a.dialog.json"));
        assert_eq!(report.project.style, report.style);
        assert!(report
            .repairs
            .iter()
            .any(|repair| repair.contains(&format!("{TEMPLATES_DIR}/a.dialog.json"))));

        // 样式文件由设计器负责，检查阶段只报告不修改。
        assert_eq!(
            fs::read_to_string(root.join(TEMPLATES_DIR).join("b.dialog.json")).unwrap(),
            before
        );

        fs::remove_dir_all(&temp).unwrap();
    }

    #[test]
    fn check_keeps_the_style_the_author_picked() {
        let temp =
            std::env::temp_dir().join(format!("pamela-test-check-pick-{}", std::process::id()));
        let _ = fs::remove_dir_all(&temp);
        let project = create(&temp, "demo").unwrap();
        let root = PathBuf::from(&project.root);

        // 存在两个样式且清单指向非首选项时的处理。
        for name in ["a.dialog.json", "z.dialog.json"] {
            fs::write(root.join(TEMPLATES_DIR).join(name), "{}").unwrap();
        }
        fs::write(root.join(SCRIPTS_DIR).join("a.pe"), "").unwrap();
        let mut manifest = read_manifest(&root).unwrap();
        manifest.style = format!("{TEMPLATES_DIR}/z.dialog.json");
        write_manifest(&root, &manifest).unwrap();

        let report = check(&root, "demo").unwrap();

        assert_eq!(report.style, format!("{TEMPLATES_DIR}/z.dialog.json"));
        assert_eq!(report.project.style, report.style);
        assert!(
            !report
                .repairs
                .iter()
                .any(|repair| repair.contains("已记录样式文件")),
            "the manifest already named a style that is there"
        );

        fs::remove_dir_all(&temp).unwrap();
    }

    #[test]
    fn check_rebuilds_what_was_removed_from_outside() {
        let temp =
            std::env::temp_dir().join(format!("pamela-test-check-bare-{}", std::process::id()));
        let _ = fs::remove_dir_all(&temp);
        let project = create(&temp, "demo").unwrap();
        let root = PathBuf::from(&project.root);

        for dir in [ASSETS_DIR, TEMPLATES_DIR, SCRIPTS_DIR] {
            fs::remove_dir_all(root.join(dir)).unwrap();
        }
        fs::remove_file(root.join(MANIFEST_FILE)).unwrap();
        assert!(
            load(&root).is_err(),
            "a project without a manifest will not open"
        );

        let report = check(&root, "demo").unwrap();

        assert!(root.join(ASSETS_DIR).is_dir());
        assert!(
            root.join(TEMPLATES_DIR).is_dir(),
            "an empty templates folder is not enough"
        );
        assert!(root.join(SCRIPTS_DIR).join(DEFAULT_SCRIPT_FILE).is_file());
        assert!(root.join(MANIFEST_FILE).is_file());

        assert!(
            report.needs_template,
            "the folder is there, but no style file is"
        );
        assert!(report
            .repairs
            .iter()
            .any(|r| r.contains(DEFAULT_SCRIPT_FILE)));
        assert!(report.repairs.iter().any(|r| r.contains(MANIFEST_FILE)));

        // 重建后的清单需包含项目名并指向一个剧本。
        assert_eq!(report.project.name, "demo");
        assert_eq!(
            report.project.entry,
            format!("{SCRIPTS_DIR}/{DEFAULT_SCRIPT_FILE}")
        );

        fs::remove_dir_all(&temp).unwrap();
    }

    #[test]
    fn check_refuses_a_file_where_a_directory_belongs() {
        let temp =
            std::env::temp_dir().join(format!("pamela-test-check-clash-{}", std::process::id()));
        let _ = fs::remove_dir_all(&temp);
        let project = create(&temp, "demo").unwrap();
        let root = PathBuf::from(&project.root);

        fs::remove_dir_all(root.join(ASSETS_DIR)).unwrap();
        fs::write(root.join(ASSETS_DIR), "").unwrap();

        assert!(
            check(&root, "demo").is_err(),
            "the author's file is not deleted to make room"
        );

        fs::remove_dir_all(&temp).unwrap();
    }

    #[test]
    fn resolve_keeps_paths_inside_the_project() {
        let root = r"C:\projects\demo";

        assert_eq!(
            resolve(root, "scripts/a.pe").unwrap(),
            PathBuf::from(r"C:\projects\demo\scripts\a.pe")
        );
        assert!(resolve(root, "../outside.txt").is_err());
        assert!(resolve(root, "/etc/passwd").is_err());
        assert!(resolve(root, "C:/windows").is_err());
        assert!(resolve(root, "a/../../b").is_err());
    }

    #[test]
    fn resolve_refuses_a_path_through_a_symlink() {
        let temp = std::env::temp_dir().join(format!("pamela-link-{}", std::process::id()));
        let _ = fs::remove_dir_all(&temp);
        fs::create_dir_all(temp.join("real")).unwrap();
        fs::write(temp.join("real").join("a.pe"), "").unwrap();
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_dir(temp.join("real"), temp.join("link"));
        #[cfg(not(windows))]
        let linked = std::os::unix::fs::symlink(temp.join("real"), temp.join("link"));
        // Without the privilege to create a link (Windows without developer mode)
        // there is nothing to check; the guard itself is exercised where it can
        // be, and its absence here is a permission fact rather than a behaviour.
        if linked.is_ok() {
            let root = temp.display().to_string();
            assert!(resolve(&root, "link/a.pe").is_err());
            assert_eq!(
                resolve(&root, "real/a.pe").unwrap(),
                temp.join("real").join("a.pe")
            );
        }
        let _ = fs::remove_dir_all(&temp);
    }
}
