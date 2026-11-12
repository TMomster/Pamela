//! 编辑器前端可调用的原生命令。
//! Native commands exposed to the editor front-end.

pub mod window;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{from_str, to_string_pretty};
use tauri::{AppHandle, Manager, State};

use crate::files;
use crate::project::{IntegrityReport, Project};

/// 一次打开请求被后发的请求取代时的报错；`ui/project-lifecycle.js` 按这段
/// 文案静默处理（那次加载已被作废，不该让用户以为项目打不开）。
pub const SUPERSEDED_OPEN: &str = "项目已被另一次打开操作取代";

/// 取过快照的工作结束时项目已被关闭或换掉的报错。
const PROJECT_SWITCHED: &str = "项目已切换，已取消这次写入";

/// 编辑器当前打开的项目；未打开时为 `None`。
///
/// `generation` 在每次替换/关闭项目时递增。取根目录做磁盘写入的命令会先
/// 取一份快照，落盘前确认代次没变：打开新项目与一次慢写入并发时，旧项目
/// 的写入不会悄悄落到新项目的目录里。
///
/// `opening` 是改变项目身份的请求（打开、新建、关闭）的票据。加载在锁外
/// 进行，可能比后发的请求更晚结束；只有手里还是最新票据的请求可以装进
/// 状态，否则界面会被一个早该作废的加载结果覆盖。
#[derive(Default)]
pub struct ProjectState {
    project: Mutex<Option<Project>>,
    generation: AtomicU64,
    opening: AtomicU64,
}

impl ProjectState {
    /// 当前项目的根目录；未打开项目时报告该状态。
    ///
    /// 读/写命令只要根目录，取到就释放锁，磁盘 IO 在锁外进行：一次几十 MB
    /// 的资源编码不该让 `current_project` 等其它命令排在它后面。
    fn root(&self) -> Result<String, String> {
        self.snapshot().map(|(root, _)| root)
    }

    /// 根目录、项目名与项目代次；`check` 需要项目名，写入命令只需要前两者。
    fn snapshot_named(&self) -> Result<(String, String, u64), String> {
        // A panic elsewhere must not brick every later command: the Option is
        // still a consistent value, so recovering a poisoned guard is safe.
        let guard = self
            .project
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let current = guard
            .as_ref()
            .ok_or_else(|| "尚未打开项目".to_string())?;
        Ok((
            current.root.clone(),
            current.name.clone(),
            self.generation.load(Ordering::SeqCst),
        ))
    }

    /// 根目录与项目代次；写入命令在落盘前用代次确认项目没有被换掉。
    fn snapshot(&self) -> Result<(String, u64), String> {
        self.snapshot_named()
            .map(|(root, _, generation)| (root, generation))
    }

    /// 落盘命令的入口：取到根目录，并确认取快照时项目仍在使用。
    ///
    /// 拿到根目录后锁就释放了，写入紧接着发生；调用方在写完之后还要再调一次
    /// `ensure`：写的过程中项目被关闭或换掉时，这次写入落进的是旧项目目录，
    /// 应当如实报错，而不是让前端以为存进了当前项目。
    fn write_target(&self) -> Result<(String, u64), String> {
        let (root, generation) = self.snapshot()?;
        self.ensure(generation)?;
        Ok((root, generation))
    }

    /// 项目在取快照后被换掉时拒绝继续。
    fn ensure(&self, generation: u64) -> Result<(), String> {
        if self.generation.load(Ordering::SeqCst) == generation {
            Ok(())
        } else {
            Err(PROJECT_SWITCHED.to_string())
        }
    }

    /// 无条件替换当前打开的项目。带准入判断的调用方用 `install` / `set_if_current`。
    fn set(&self, project: Project) -> Project {
        let mut guard = self
            .project
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *guard = Some(project.clone());
        self.generation.fetch_add(1, Ordering::SeqCst);
        project
    }

    /// 代次仍是 `generation` 时把项目装回去。
    ///
    /// 与 `ensure` 之后紧跟 `set` 相比，校验和装入在同一把锁内完成：两次调用
    /// 之间被一次关闭或切换插进来时，旧项目不会又回到状态里。
    fn set_if_current(&self, generation: u64, project: Project) -> Result<Project, String> {
        let mut guard = self
            .project
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if self.generation.load(Ordering::SeqCst) != generation {
            return Err(PROJECT_SWITCHED.to_string());
        }
        *guard = Some(project.clone());
        self.generation.fetch_add(1, Ordering::SeqCst);
        Ok(project)
    }

    /// 登记一次改变项目身份的请求（打开、新建、关闭），返回它的票据。
    fn begin_open(&self) -> u64 {
        self.opening.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// 只有仍持最新票据的请求才把项目装进状态。
    ///
    /// 加载可能比后发的请求更晚结束，装入前必须确认自己没被作废；校验与
    /// 装入在同一把锁内完成，免得中间被一次关闭插进来。
    fn install(&self, ticket: u64, project: Project) -> Result<Project, String> {
        let mut guard = self
            .project
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if self.opening.load(Ordering::SeqCst) != ticket {
            return Err(SUPERSEDED_OPEN.to_string());
        }
        *guard = Some(project.clone());
        self.generation.fetch_add(1, Ordering::SeqCst);
        Ok(project)
    }

    /// 关闭当前项目；代次递增让在途写入失效，票据递增让在途打开失效。
    fn close(&self) {
        let mut guard = self
            .project
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *guard = None;
        self.opening.fetch_add(1, Ordering::SeqCst);
        self.generation.fetch_add(1, Ordering::SeqCst);
    }
}

/// 把项目载入托管状态，供启动与测试使用。
pub fn set_open_project(state: tauri::State<'_, ProjectState>, project: Project) {
    state.set(project);
}

/// 在 `parent` 下创建项目目录并打开。
// 建目录、写清单、遍历资源树都是磁盘操作，放主线程会冻住窗口；下同。
#[tauri::command(async)]
pub fn create_project(
    parent: PathBuf,
    name: String,
    state: State<'_, ProjectState>,
) -> Result<Project, String> {
    // 建目录并遍历资源树可能要几秒：先领票据，建完再确认没被更晚的请求取代。
    let ticket = state.begin_open();
    let project = crate::project::create(&parent, &name).map_err(|e| e.to_string())?;
    state.install(ticket, project)
}

/// 打开已有项目目录。
#[tauri::command(async)]
pub fn open_project(root: PathBuf, state: State<'_, ProjectState>) -> Result<Project, String> {
    // 大项目加载慢；期间用户可能又打开了别的项目，此时这次加载整体作废。
    let ticket = state.begin_open();
    let project = crate::project::load(&root).map_err(|e| e.to_string())?;
    state.install(ticket, project)
}

/// 重新扫描已打开的项目，用于磁盘文件发生变更后同步。
#[tauri::command(async)]
pub fn reload_project(state: State<'_, ProjectState>) -> Result<Project, String> {
    // 重新扫描前释放锁：遍历大型项目可能耗时，不得阻塞其他命令。
    let (root, generation) = state.snapshot()?;
    let reloaded = crate::project::load(Path::new(&root)).map_err(|e| e.to_string())?;
    // 扫描期间项目可能被关闭或换掉；此时不能把旧项目重新装回状态。
    state.set_if_current(generation, reloaded)
}

/// 返回当前打开的项目；编辑器尚无项目时返回 `None`。
#[tauri::command]
pub fn current_project(state: State<'_, ProjectState>) -> Result<Option<Project>, String> {
    // 与其它命令一样从中毒的锁里恢复：别的地方一次 panic 不该让编辑器
    // 此后读不到项目，而 `Option` 本身仍是可用的值。
    let guard = state
        .project
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    Ok(guard.clone())
}

/// 关闭当前打开的项目。
#[tauri::command]
pub fn close_project(state: State<'_, ProjectState>) -> Result<(), String> {
    state.close();
    Ok(())
}

/// 把清单的入口脚本指向指定路径；传入空路径表示清除入口。路径按项目相对路径解析，越界或绝对路径被拒绝。
#[tauri::command(async)]
pub fn set_entry(entry: String, state: State<'_, ProjectState>) -> Result<Project, String> {
    // 写入前释放锁；该写入会重新读取清单并重新遍历资源树。
    let (root, generation) = state.snapshot()?;
    // 写盘前先确认项目没被换掉，别把入口写进上一个项目的清单。
    state.ensure(generation)?;
    let updated =
        crate::project::set_entry(Path::new(&root), &entry).map_err(|e| e.to_string())?;
    // 遍历期间也可能被关闭或切换，确认后再回填状态。
    state.set_if_current(generation, updated)
}

/// 设置项目默认的对白打字机档位（`off` / `fast` / `medium` / `slow`），其它取值被拒绝。
#[tauri::command(async)]
pub fn set_typewriter(
    typewriter: String,
    state: State<'_, ProjectState>,
) -> Result<Project, String> {
    let (root, generation) = state.snapshot()?;
    state.ensure(generation)?;
    let updated =
        crate::project::set_typewriter(Path::new(&root), &typewriter).map_err(|e| e.to_string())?;
    state.set_if_current(generation, updated)
}

/// 检查已打开项目的目录结构，补齐缺失的目录与文件，并返回修复结果。
#[tauri::command(async)]
pub fn check_project(state: State<'_, ProjectState>) -> Result<IntegrityReport, String> {
    let (root, name, generation) = state.snapshot_named()?;
    let report = crate::project::check(Path::new(&root), &name).map_err(|e| e.to_string())?;
    // 检查期间项目可能被关闭或换掉，别把旧项目装回去。
    state.set_if_current(generation, report.project.clone())?;
    Ok(report)
}

/// 读取项目相对路径下的文本文件。
#[tauri::command(async)]
pub fn read_file(path: String, state: State<'_, ProjectState>) -> Result<String, String> {
    let root = state.root()?;
    files::read_text(&root, &path).map_err(|e| e.to_string())
}

/// 按项目相对路径读取图片并返回 `data:` URL，供舞台显示。依次尝试 `assets/` 下各类型目录、扁平根目录与点号展开路径；大小超过上限时拒绝。
#[tauri::command(async)]
pub fn read_asset(
    path: String,
    kind: Option<String>,
    state: State<'_, ProjectState>,
) -> Result<String, String> {
    let kind = kind.unwrap_or_default();
    let root = state.root()?;
    files::read_asset_data_url(&root, &path, &kind).map_err(|e| e.to_string())
}

/// 按项目相对路径读取任意图片并返回 `data:` URL，供图片查看器使用。
#[tauri::command(async)]
pub fn read_image(path: String, state: State<'_, ProjectState>) -> Result<String, String> {
    let root = state.root()?;
    files::read_image_data_url(&root, &path).map_err(|e| e.to_string())
}

/// 按项目相对路径读取音频并返回 `data:` URL，供舞台播放。
#[tauri::command(async)]
pub fn read_audio(path: String, state: State<'_, ProjectState>) -> Result<String, String> {
    let root = state.root()?;
    files::read_audio_data_url(&root, &path).map_err(|e| e.to_string())
}

/// 按项目相对路径读取视频并返回 `data:` URL，供舞台播放。
#[tauri::command(async)]
pub fn read_video(path: String, state: State<'_, ProjectState>) -> Result<String, String> {
    let root = state.root()?;
    files::read_video_data_url(&root, &path).map_err(|e| e.to_string())
}

/// 写入项目相对路径下的文本文件，自动创建父目录。
#[tauri::command(async)]
pub fn write_file(
    path: String,
    contents: String,
    state: State<'_, ProjectState>,
) -> Result<(), String> {
    let (root, generation) = state.write_target()?;
    files::write_text(&root, &path, &contents).map_err(|e| e.to_string())?;
    state.ensure(generation)
}

/// 把 `data:` URL 或裸 base64 字符串写入项目相对路径下的图片文件。
#[tauri::command(async)]
pub fn write_asset(
    path: String,
    contents: String,
    state: State<'_, ProjectState>,
) -> Result<(), String> {
    let (root, generation) = state.write_target()?;
    files::write_asset_data_url(&root, &path, &contents).map_err(|e| e.to_string())?;
    state.ensure(generation)
}

/// 列出系统已安装的字体族。
// Font enumeration walks every font directory on the machine, which is far too
// long to hold the main thread; the answer is cached for the process.
#[tauri::command(async)]
pub fn list_fonts() -> Result<Vec<String>, String> {
    Ok(crate::fonts::list_families())
}

/// 创建项目相对路径下的目录，自动补齐父目录。
#[tauri::command(async)]
pub fn create_dir(path: String, state: State<'_, ProjectState>) -> Result<(), String> {
    let (root, generation) = state.write_target()?;
    files::create_dir(&root, &path).map_err(|e| e.to_string())?;
    state.ensure(generation)
}

/// 删除项目相对路径下的文件或目录。
#[tauri::command(async)]
pub fn delete_entry(path: String, state: State<'_, ProjectState>) -> Result<(), String> {
    let (root, generation) = state.write_target()?;
    files::remove(&root, &path).map_err(|e| e.to_string())?;
    state.ensure(generation)
}

/// 把项目相对路径下的文件或目录复制到新路径。
#[tauri::command(async)]
pub fn copy_entry(from: String, to: String, state: State<'_, ProjectState>) -> Result<(), String> {
    let (root, generation) = state.write_target()?;
    files::copy(&root, &from, &to).map_err(|e| e.to_string())?;
    state.ensure(generation)
}

/// 在同一目录内重命名项目相对路径下的文件或目录。
#[tauri::command(async)]
pub fn rename_entry(
    from: String,
    to: String,
    state: State<'_, ProjectState>,
) -> Result<(), String> {
    let (root, generation) = state.write_target()?;
    files::rename(&root, &from, &to).map_err(|e| e.to_string())?;
    state.ensure(generation)
}

/// 上次导出 MP4 用的参数，浮窗下次打开时恢复。
///
/// 每个字段都可选：偏好文件可能是旧版本写的，缺字段时前端用自己的默认值，
/// 而不是把整份偏好判为损坏。
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
pub struct ExportPrefs {
    /// 画面尺寸，形如 `"1920x1080"`。
    #[serde(default)]
    pub resolution: Option<String>,
    #[serde(default)]
    pub fps: Option<u32>,
    #[serde(default)]
    pub bitrate: Option<u64>,
    /// 关键帧间隔，按秒记（与浮窗上的选项同一单位）。
    #[serde(default)]
    pub keyframe_seconds: Option<u32>,
    /// 选择支策略：`"first"` 固定第一项，`"recorded"` 沿用上次运行的记录。
    #[serde(default)]
    pub choice_mode: Option<String>,
    /// 上次选的入口脚本（项目相对路径）。
    #[serde(default)]
    pub entry: Option<String>,
}

/// 跨启动保留的编辑器级偏好设置。
#[derive(Serialize, Deserialize, Default, Clone)]
pub struct AppState {
    /// 最近一次打开的项目目录，下次启动时恢复。
    #[serde(default)]
    pub last_project: Option<String>,
    /// 窗口关闭时是否处于最大化状态。
    #[serde(default)]
    pub maximized: Option<bool>,
    /// 窗口内容宽度（像素），重启时按此恢复。
    #[serde(default)]
    pub width: Option<u32>,
    /// 窗口内容高度（像素）。
    #[serde(default)]
    pub height: Option<u32>,
    /// 上次导出 MP4 的参数。
    #[serde(default)]
    pub export: Option<ExportPrefs>,
    /// 自动保存间隔（秒）：0 关闭，其余取 30 / 60 / 180 / 300。
    #[serde(default)]
    pub auto_save: Option<u32>,
}

/// 偏好设置文件的存放位置，位于应用自身的配置目录下。
fn app_state_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("app-state.json"))
}

/// 读取持久化的偏好，供启动时恢复窗口；没有或读不出来时返回 `None`。
pub fn load_app_state(app: &AppHandle) -> Option<AppState> {
    let path = app_state_path(app)?;
    let text = std::fs::read_to_string(path).ok()?;
    from_str(&text).ok()
}

/// 读取持久化的编辑器偏好；尚无存储记录时返回 `None`。
#[tauri::command(async)]
pub fn read_app_state(app: AppHandle) -> Result<Option<AppState>, String> {
    let Some(path) = app_state_path(&app) else {
        return Ok(None);
    };
    if !path.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    // 解析失败不再伪装成「没有偏好」：那会让下一次保存把损坏的内容整体抹掉。
    from_str(&text)
        .map(Some)
        .map_err(|e| format!("偏好文件无法解析：{e}"))
}

/// 把编辑器偏好写入磁盘，覆盖此前取值。
#[tauri::command(async)]
pub fn write_app_state(state: AppState, app: AppHandle) -> Result<(), String> {
    let Some(path) = app_state_path(&app) else {
        return Ok(());
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = to_string_pretty(&state).map_err(|e| e.to_string())?;
    // 先写临时文件再改名：写到一半崩溃时留下的是旧文件，而不是半个 JSON。
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, text).map_err(|e| e.to_string())?;
    std::fs::rename(&temporary, &path).map_err(|e| e.to_string())
}

// --- 离屏逐帧 MP4 导出 ---
// 前端逐帧把 WebCodecs 的编码结果 base64 送过来；会话负责累积 sample table，
// 收尾时回填 mdat 长度、写 moov 并原子改名。路径由 `export::validate_relative`
// 限制在项目内的 `exports/*.mp4`，再过一次 `project::resolve` 防逃逸。

/// 开始一次导出，返回任务 id。
#[tauri::command(async)]
pub fn export_begin(
    path: String,
    width: u16,
    height: u16,
    timescale: u32,
    sample_delta: u32,
    state: State<'_, ProjectState>,
    exports: State<'_, crate::export::ExportState>,
) -> Result<String, String> {
    // 会话随后会一直往这个目录写：开始时先确认项目还是打开它的那个。
    let root = state.write_target()?.0;
    exports.begin(
        &root,
        &path,
        crate::mp4::Mp4Config {
            width,
            height,
            timescale,
            sample_delta,
            avcc: Vec::new(),
        },
    )
}

/// 追加一帧编码数据；`keyframe` 决定它是否进 `stss`。
#[tauri::command(async)]
pub fn export_append(
    id: String,
    data: String,
    keyframe: bool,
    exports: State<'_, crate::export::ExportState>,
) -> Result<(), String> {
    let bytes = files::base64_decode(&data).map_err(|e| e.to_string())?;
    exports.append(&id, &bytes, keyframe)
}

/// 收尾时整段送来的 AAC 音轨。
///
/// Tauri v2 只把命令的**顶层参数名**从 snake_case 转成 camelCase（如
/// `export_begin` 的 `sampleDelta`）；`audio` 这个嵌套对象里的字段仍由 serde
/// 按此处声明的名字匹配，所以必须显式 `rename_all`。前端发的是 `sampleRate`，
/// 少了这一行时 `sample_rate` 会静默取 `default` 的 0，直到封装阶段才以
/// 「音轨的采样率或声道数无效」失败。
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExportAudioArg {
    /// 拼接好的 AAC 帧字节（base64）。
    pub data: String,
    /// 每个 AAC 帧的字节数，顺序与 `data` 一致。
    #[serde(default)]
    pub samples: Vec<u32>,
    /// 也接受 snake_case，便于工具与旧调用方直接复用这段结构。
    #[serde(alias = "sample_rate")]
    pub sample_rate: u32,
    pub channels: u16,
    #[serde(default)]
    pub bitrate: u32,
    /// AudioSpecificConfig（base64）。
    #[serde(default)]
    pub asc: String,
}

/// 结束导出，返回写好的项目相对路径。
#[tauri::command(async)]
pub fn export_finish(
    id: String,
    avcc: String,
    audio: Option<ExportAudioArg>,
    exports: State<'_, crate::export::ExportState>,
) -> Result<String, String> {
    let avcc = files::base64_decode(&avcc).map_err(|e| e.to_string())?;
    let audio = match audio {
        Some(arg) => {
            // Say what actually arrived rather than letting a zero sample rate
            // travel all the way into the muxer, where it reads as a broken MP4.
            if arg.sample_rate == 0 || arg.channels == 0 {
                return Err(format!(
                    "音轨的采样率或声道数无效：{} Hz / {} 声道",
                    arg.sample_rate, arg.channels
                ));
            }
            Some(crate::export::AudioTrackInput {
                data: files::base64_decode(&arg.data).map_err(|e| e.to_string())?,
                samples: arg.samples,
                sample_rate: arg.sample_rate,
                channels: arg.channels,
                bitrate: arg.bitrate,
                asc: files::base64_decode(&arg.asc).map_err(|e| e.to_string())?,
            })
        }
        None => None,
    };
    exports.finish(&id, avcc, audio)
}

/// 取消导出并删除临时文件。
#[tauri::command(async)]
pub fn export_abort(
    id: String,
    exports: State<'_, crate::export::ExportState>,
) -> Result<(), String> {
    exports.abort(&id)
}

/// 在系统文件管理器里选中一个项目内文件。
///
/// 导出完成后「在文件夹中显示」用它：前端只给项目相对路径，解析规则与其它
/// 文件命令一致，越界路径与符号链接仍被 `project::resolve` 拒绝。目标必须
/// 已经存在——把作者带到空目录里毫无意义。
#[tauri::command(async)]
pub fn reveal_path(path: String, state: State<'_, ProjectState>) -> Result<(), String> {
    let root = state.root()?;
    let target = crate::project::resolve(&root, &path).map_err(|e| e.to_string())?;
    if !target.is_file() {
        return Err(format!("找不到文件：{path}"));
    }
    show_in_file_manager(&target)
}

/// 让文件管理器把 `path` 标成选中项。
///
/// Windows 上 `explorer /select,` 的退出码是 1（成功也如此），所以只看能否
/// 启动进程，不看退出码；`spawn` 不等待，窗口不会被文件管理器挡住。
#[cfg(target_os = "windows")]
fn show_in_file_manager(path: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    // `raw_arg` keeps the quotes around the path: with `arg`, a path containing
    // a comma or space is split by explorer's own parsing.
    std::process::Command::new("explorer.exe")
        .raw_arg(format!("/select,\"{}\"", path.display()))
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("无法打开文件管理器：{e}"))
}

#[cfg(target_os = "macos")]
fn show_in_file_manager(path: &Path) -> Result<(), String> {
    std::process::Command::new("open")
        .arg("-R")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("无法打开文件管理器：{e}"))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn show_in_file_manager(path: &Path) -> Result<(), String> {
    let dir = path.parent().unwrap_or(path);
    std::process::Command::new("xdg-open")
        .arg(dir)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("无法打开文件管理器：{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a_project(root: &str) -> Project {
        Project {
            name: "demo".to_string(),
            root: root.to_string(),
            entry: String::new(),
            style: String::new(),
            typewriter: "medium".to_string(),
            tree: Vec::new(),
        }
    }

    #[test]
    fn a_snapshot_goes_stale_when_the_project_is_replaced() {
        let state = ProjectState::default();
        state.set(a_project("C:/one"));
        let (root, generation) = state.write_target().unwrap();
        assert_eq!(root, "C:/one");

        state.set(a_project("C:/two"));

        // 旧项目取到的快照必须在落盘前失败，否则会写进上一个项目的目录。
        assert!(state.ensure(generation).is_err());
        let (root, generation) = state.write_target().unwrap();
        assert_eq!(root, "C:/two");
        assert!(state.ensure(generation).is_ok());
    }

    #[test]
    fn closing_a_project_invalidates_a_snapshot_that_was_already_taken() {
        let state = ProjectState::default();
        state.set(a_project("C:/one"));
        let (_, generation) = state.write_target().unwrap();

        state.close();

        assert!(state.ensure(generation).is_err());
        // 关闭之后既取不到根目录，也取不到快照。
        assert!(state.root().is_err());
        assert!(state.write_target().is_err());
    }

    #[test]
    fn a_late_finishing_open_cannot_replace_a_newer_one() {
        let state = ProjectState::default();
        let slow = state.begin_open();
        let fast = state.begin_open();

        // 先点开的那个后加载完：它已经过期，不该把后点开的顶掉。
        assert_eq!(
            state.install(slow, a_project("C:/slow")).unwrap_err(),
            SUPERSEDED_OPEN
        );
        assert!(state.snapshot().is_err(), "过期的加载不该装进状态");

        let installed = state.install(fast, a_project("C:/fast")).unwrap();
        assert_eq!(installed.root, "C:/fast");
    }

    #[test]
    fn closing_a_project_cancels_an_open_that_is_still_loading() {
        let state = ProjectState::default();
        let loading = state.begin_open();

        state.close();

        // 加载中点了关闭：加载完成后不能把项目又打开。
        assert_eq!(
            state.install(loading, a_project("C:/one")).unwrap_err(),
            SUPERSEDED_OPEN
        );
        assert!(state.snapshot().is_err());
    }

    #[test]
    fn a_stale_generation_cannot_put_the_old_project_back() {
        let state = ProjectState::default();
        state.set(a_project("C:/one"));
        let (_, generation) = state.snapshot().unwrap();

        state.set(a_project("C:/two"));

        assert_eq!(
            state.set_if_current(generation, a_project("C:/one"))
                .unwrap_err(),
            PROJECT_SWITCHED
        );
        assert_eq!(state.snapshot().unwrap().0, "C:/two");
    }

    #[test]
    fn an_old_preference_file_still_parses() {
        // 本次改动之前写出的偏好文件没有 `export` 字段，不能因此判为损坏：
        // 那会让下一次保存把已记住的项目一起抹掉。
        let text = r#"{"last_project":"C:/demo","maximized":true}"#;
        let state: AppState = from_str(text).unwrap();
        assert_eq!(state.last_project.as_deref(), Some("C:/demo"));
        assert!(state.export.is_none());
    }

    #[test]
    fn export_preferences_round_trip() {
        let export = ExportPrefs {
            resolution: Some("1280x720".to_string()),
            fps: Some(60),
            bitrate: Some(12_000_000),
            keyframe_seconds: Some(5),
            choice_mode: Some("recorded".to_string()),
            entry: Some("scripts/ch1.pe".to_string()),
        };
        let state = AppState {
            export: Some(export.clone()),
            ..AppState::default()
        };
        let text = to_string_pretty(&state).unwrap();
        let back: AppState = from_str(&text).unwrap();
        assert_eq!(back.export, Some(export));
        // 前端按 snake_case 读，改名等同于丢掉老偏好文件里的值。
        assert!(text.contains("\"keyframe_seconds\""));
    }

    #[test]
    fn export_audio_arg_reads_the_frontend_camel_case_fields() {
        // The exact shape `invoke("export_finish", { audio })` sends. Tauri
        // only renames top-level command arguments; without `rename_all` on
        // this nested struct, `sampleRate` was ignored and the sample rate
        // silently became 0, which the muxer rejected after all frames were
        // already written.
        let text = r#"{
            "data":"AQID","samples":[3,4],"sampleRate":48000,
            "channels":2,"bitrate":128000,"asc":"EZA="
        }"#;
        let arg: ExportAudioArg = from_str(text).unwrap();
        assert_eq!(arg.sample_rate, 48_000);
        assert_eq!(arg.channels, 2);
        assert_eq!(arg.samples, vec![3, 4]);
        assert_eq!(arg.bitrate, 128_000);
        assert_eq!(arg.data, "AQID");
    }

    #[test]
    fn export_audio_arg_still_accepts_snake_case_sample_rate() {
        let arg: ExportAudioArg =
            from_str(r#"{"data":"","sample_rate":44100,"channels":1}"#).unwrap();
        assert_eq!(arg.sample_rate, 44_100);
        assert_eq!(arg.channels, 1);
    }

    #[test]
    fn export_audio_arg_refuses_a_missing_sample_rate() {
        // A missing rate has to fail at the command boundary, not turn into a
        // 0 Hz track that only errors out during MP4 muxing.
        let result = from_str::<ExportAudioArg>(
            r#"{"data":"","samples":[1],"channels":2,"bitrate":128000,"asc":""}"#,
        );
        assert!(result.is_err());
    }
}
