# Pamela

作者：Momster（<https://github.com/TMomster>）。English documentation: [`README.md`](README.md)。

视觉小说引擎与创作环境。Rust + Tauri 2 提供宿主与文件系统，前端是原生 ES 模块，
没有打包器、没有运行时依赖，由 Tauri 直接内嵌。

- **剧本语言**：`.pe` / `.mpe` 脚本，词法、语法与解释器全部在 `ui/pamela.js`，
  简写形式由 `ui/mpe.js` 处理。
- **创作环境**：代码编辑器（高亮、查找替换、行内错误、整行快捷键）、对话设计器、
  图片与音频编辑器、`.pmap` 节点画布（flowmap）、关键帧编辑器、资源树与多标签。
- **演出对象**：`Character` 角色、`Background` 背景、`Text` 文字、`Audio` 音频、
  `Video` 视频、`Effect` 粒子特效、`Light` 光源（2.5D 光照，含环境亮度与排除），
  以及它们共用的三维空间与滤镜调用。
- **运行与预览**：舞台演出、存读档、快进 / 自动 / 回看、全屏，以及成品的
  「编辑器 ⇄ 播放器」模式切换。
- **成片导出**：离屏逐帧把剧本演一遍，画面经 WebCodecs 编成 H.264，声音用
  `OfflineAudioContext` 混成 48 kHz 立体声 AAC，由手写的 MP4 多轨封装写进 `exports/`；
  `Video` 素材声画、粒子、滤镜调色同样进成片。可选入口脚本、帧率与选择支策略，
  参数跨启动记住。
- **收尾功能**：可选的 `stage.pamela()` 开场动画；自动保存在「关 / 30 秒 / 1 分钟 /
  3 分钟 / 5 分钟」五档之间切换，选择跨启动记住。

## 目录

| 路径 | 内容 |
| --- | --- |
| `src/` | Rust 后端：项目模型（`project.rs`）、文件与路径安全（`files.rs`）、Tauri 命令（`commands/`）、MP4 多轨封装（`mp4.rs`，视频 + 音频 `mdat`）与流式写盘（`export.rs`） |
| `ui/` | 前端模块；`main.js` 是唯一的组合根，其余为纯逻辑模块与控件工厂（导出链路在 `ui/export-*.js`，含 `export-audio.js` 的离线混音） |
| `ui/tests/` | `node:test` 单元测试，纯函数与手写假 DOM |
| `docs/` | 本机工作留档，不入库：设计定稿与分阶段记录 |
| `tools/` | 图标生成、真浏览器冒烟（`smoke-*.mjs`）与导出链路离线微基准（`bench-export.mjs`） |
| `scripts/` | 构建辅助（Windows SDK 路径等） |
| `capabilities/` | Tauri 权限，只开窗口拖动、最大化切换与文件夹选择 |

## 当前状态

版本 `1.0.0`。导出已支持画面与声音完整的成片；自动化基线全绿：JavaScript 语法、
前端单元测试、后端测试、`cargo fmt --check`、`clippy -D warnings` 与 `tsc` 类型检查。
需要真实窗口的人工项——全屏、声音、存读档、导出播放——在本机执行，不在仓库里。

用户可见的说明以软件内「帮助 → 导出 MP4」等手册为准。设计留档与各阶段的验证记录放在
本机的 `docs/` 目录，不随仓库发布。

## 构建与检查

```bat
cargo run --offline                :: 构建 debug 并启动编辑器
cargo build --release --offline    :: 发布构建（target\release\pamela.exe）

node --test "ui/tests/*.test.js"   :: 前端单元测试
cargo test --offline               :: 后端测试
cargo fmt --check
cargo clippy --offline --all-targets -- -D warnings
npx tsc -p tsconfig.json           :: 静态类型
```

Windows 构建需要 Windows SDK 的 `rc.exe` 在 `PATH` 上：tauri-build 用它嵌入资源文件。
为本机准备这些环境的脚本与手动验收清单都留在作者本机，刻意不入仓库。

`tsc` 需要先跑一次 `npm install`；TypeScript 只是开发期依赖，不进产物。

## 约定

- **零依赖、无打包器**：`ui/` 下的文件按浏览器的方式直接加载，`frontendDist: ./ui`。
- **单一组合根**：只有 `ui/main.js` 做跨模块装配；新功能优先写成可注入依赖的工厂，
  以便用假 DOM 测试。
- **文档留档**：每个阶段结束在 `docs/` 新增 `YYYY-MM-DD-<主题>.md`，并把结论回填
  `docs/progress.md` 与索引。
- **不写死测试条数**：文档只描述「全部通过」，不记固定数字，新增用例不会把一次通过
  变成假失败。

## 软件内帮助

工具栏的「帮助」与「关于」打开内置只读阅读器，首次启动、尚未创建项目时也可阅读：

- **帮助**：基础使用、代码（脚本语言总览），以及 Character 角色、Background 背景、
  Text 文字、Audio 音频、Video 视频、Effect 特效、Light 光源、三维空间、mpe 简写、
  中文写法、API 对照、flowmap、keyframes 帧组、模板编辑、导出 MP4 的专项讲解与示例
  （导出一篇含「与舞台一致 / 会画进画面的内容 / 当前限制」）。
- **关于**：声明（作者、作品所有权、免责与内容责任）、许可证、关于本软件、使用协议、
  隐私政策。

## 许可与所有权

Pamela 采用开放源代码协议发布：MIT 或 Apache-2.0，二选一，版权归作者
[Momster](https://github.com/TMomster) 所有。

- 英文原文：[`LICENSE-MIT`](LICENSE-MIT) 与 [`LICENSE-APACHE`](LICENSE-APACHE)
- 中文参考译本：[`LICENSE-ZH.md`](LICENSE-ZH.md)（与英文原文不一致时以英文原文为准）

使用 Pamela 编辑的剧本、图像、音频、模板与项目文件，其所有权（含著作权）全部归编辑者
本人所有。Pamela 与作者不对创作者的资产主张任何所有权，也不对其内容主张任何权利。

## 相关文件

- 英文说明：[`README.md`](README.md)（GitHub 首页展示，内容与本文一致）
- 许可证中文译本：[`LICENSE-ZH.md`](LICENSE-ZH.md)
