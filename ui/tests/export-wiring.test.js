// 导出接线的静态守卫：菜单 → 命令分派 → IPC → Rust 注册表必须同步。
// Static guard for the export wiring, one of the project's audit invariants.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ui = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const root = path.dirname(ui);
const read = (relative) => readFileSync(path.join(root, relative), "utf8");

test("the export command is wired from the menu through to the Rust handler", () => {
  const menus = read("ui/menus.js");
  const main = read("ui/main.js");
  const lib = read("src/lib.rs");
  const commands = read("src/commands/mod.rs");

  assert.match(menus, /command: "export\.mp4"/);
  assert.match(menus, /command === "export\.mp4"/, "导出按钮应只在项目打开时可用");
  assert.match(main, /"export\.mp4": \(\) => exportMp4\(\)/);
  assert.match(main, /invokeBridge = invoke/);
  assert.match(main, /createExportSession\(/);
  assert.match(main, /createExportPerformance\(/);
  assert.match(main, /makePreloader\(/);

  for (const name of ["export_begin", "export_append", "export_finish", "export_abort"]) {
    assert.ok(commands.includes(`pub fn ${name}`), `缺少命令 ${name}`);
    assert.ok(lib.includes(`commands::${name}`), `${name} 没有注册到 invoke handler`);
  }
  assert.ok(lib.includes("export::ExportState::default()"), "导出会话状态没有注入");
  assert.match(
    read("ui/export-session.js"),
    /duration: \(\) => timelineDuration\(timeline\)/,
    "帧循环没有接到时间线末端，裸 cue 的动画会被裁掉",
  );
  assert.match(
    read("ui/export-session.js"),
    /frameSource: \(state, t\) => renderer\.render\(state, t\)/,
    "虚拟时间没有传给渲染器，GIF 会一直是首帧",
  );
});

test("the exporter uses the codec the M0 probe proved works at 1080p", () => {
  assert.match(read("ui/export-mp4.js"), /EXPORT_CODEC = "avc1\.640028"/);
  assert.match(read("ui/export-mp4.js"), /avc: \{ format: "avc" \}/);
});

test("the reveal command is registered and guarded by the project root", () => {
  const commands = read("src/commands/mod.rs");
  const lib = read("src/lib.rs");

  assert.match(commands, /pub fn reveal_path\(path: String, state: State<'_, ProjectState>\)/);
  assert.match(commands, /project::resolve\(&root, &path\)/, "reveal 必须走同一条路径安全规则");
  assert.ok(lib.includes("commands::reveal_path"), "reveal_path 没有注册到 invoke handler");
  // 前端只在导出结果页用它，参数名要与命令签名一致。
  assert.match(read("ui/main.js"), /invokeBridge\("reveal_path", \{ path \}\)/);
});

test("the export preferences survive a restart through AppState", () => {
  const commands = read("src/commands/mod.rs");
  const main = read("ui/main.js");
  const panel = read("ui/export-panel.js");

  assert.match(commands, /pub struct ExportPrefs/, "缺少导出偏好的结构");
  assert.match(commands, /pub export: Option<ExportPrefs>/);
  // 上一条偏好文件的旧版本没有 `export` 字段，必须能读回来而不是判为损坏。
  assert.match(commands, /#\[serde\(default\)\]\s*pub export: Option<ExportPrefs>/);

  assert.match(main, /lifecycle\.state\.export = prefs/, "偏好没有写回生命周期");
  assert.match(panel, /keyframe_seconds: state\.keyframeSeconds/, "字段名要与后端一致");
});

test("sound runs from the recording stage all the way into the finish command", () => {
  const main = read("ui/main.js");
  const session = read("ui/export-session.js");
  const mp4 = read("ui/export-mp4.js");
  const stage = read("ui/export-stage.js");
  const audio = read("ui/export-audio.js");
  const commands = read("src/commands/mod.rs");
  const exportRs = read("src/export.rs");
  const mp4rs = read("src/mp4.rs");

  // 前端：导出打开音频、读文件、报阶段；会话自己建录制器并交给混音器。
  assert.match(main, /audio: true/, "导出没有打开声音");
  // 素材是 `data:` URL，必须就地解 base64：webview 的 CSP 没有给 connect-src
  // 开 `data:`，`fetch(url)` 会被拒绝，让成片静音却没有任何报错。
  assert.match(main, /import \{ arrayBufferFromDataUrl \} from "\.\/data-url\.js"/);
  assert.doesNotMatch(main, /await fetch\(/, "导出素材不能用 fetch(data:)");
  assert.match(main, /loadAudio: async \(path\) => arrayBufferFromDataUrl\(await actions\.readAudio\(path\)\)/, "没有把音频读进内存");
  assert.match(main, /actions\.readAudio\(path\)/);
  assert.match(main, /onStatus: \(text\) => panel\.setPhase\(text\)/);
  assert.match(session, /createAudioRecorder\(\{ clock \}\)/);
  assert.match(session, /buildAudioTrack\(\{/);
  assert.match(stage, /audioRecorder\.audio\(args, context\)/, "录制舞台没有接管 Audio");
  assert.match(stage, /onVoice: audioRecorder/, "say 的配音没有接上");

  // 视频：声轨读字节交给同一个混音器，画面读 data: URL 逐帧 seek。
  assert.match(main, /loadVideo: async \(path\) => arrayBufferFromDataUrl\(await actions\.readVideo\(path\)\)/, "没有把视频读进内存");
  assert.match(main, /actions\.readVideo\(path\)/);
  assert.match(main, /resolveVideo: \(path\) => actions\.readVideo\(path\)/, "没有接上视频画面");
  assert.match(session, /createVideoRecorder\(\{ clock \}\)/);
  assert.match(session, /createVideoFrames\(\{ resolveVideo \}\)/);
  assert.match(session, /frames: videoFrames, playheads: videoRecorder/);
  assert.match(session, /video: videoRecorder/);
  assert.match(stage, /videoRecorder\.video\(args, context\)/, "录制舞台没有接管 Video");
  assert.match(audio, /export const AUDIO_CODEC = "mp4a\.40\.2"/);

  // 输出侧：音轨与 avcC 一起在 finish 里交给后端。
  assert.match(mp4, /asc: bytesToBase64\(audio\.description\)/);
  assert.match(mp4, /sampleRate: audio\.sampleRate/);

  // 后端：命令、会话与封装都认识音轨。
  assert.match(commands, /pub struct ExportAudioArg/);
  assert.match(commands, /audio: Option<ExportAudioArg>/);
  assert.match(exportRs, /audio: Option<AudioTrackInput>/);
  assert.match(exportRs, /mp4::moov_with_audio/);
  assert.match(mp4rs, /pub fn moov_with_audio/);
  assert.match(mp4rs, /pub fn mux_streaming_audio/);
  assert.match(mp4rs, /pub fn audio_mdat_offset/);
  assert.match(mp4rs, /b"soun"/, "音轨的 handler 必须是 soun");
  assert.match(mp4rs, /b"esds"/, "AAC 需要 esds 描述");
});

test("exports/ is part of the project layout, not an afterthought", () => {
  const project = read("src/project.rs");
  assert.match(project, /pub const EXPORTS_DIR: &str = "exports"/);
  assert.match(project, /fs::create_dir_all\(root\.join\(EXPORTS_DIR\)\)/);
  assert.match(project, /SAVES_DIR,\s*EXPORTS_DIR,/);
});

test("export_begin payload keys match Tauri's camelCase argument names", () => {
  const rust = read("src/commands/mod.rs");
  const js = read("ui/export-mp4.js");

  // Tauri v2 把 Rust 的 snake_case 参数暴露成 camelCase；`State<'_, _>` 由后端注入。
  const signature = rust.match(/pub fn export_begin\(([\s\S]*?)\)\s*->/);
  assert.ok(signature, "找不到 export_begin 的参数声明");
  const expected = [...signature[1].matchAll(/^[ \t]*([a-z][a-z0-9_]*):[ \t]*([^\r\n]+)/gm)]
    .filter(([, , type]) => !type.trim().startsWith("State<"))
    .map(([, name]) => name.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()))
    .sort();

  const payload = js.match(/invoke\(commands\.begin, \{([\s\S]*?)\}\)/);
  assert.ok(payload, "找不到 export_begin 的调用参数");
  const actual = [...payload[1].matchAll(/^[ \t]*([A-Za-z_$][\w$]*)[ \t]*[:,]/gm)]
    .map(([, key]) => key)
    .sort();

  assert.deepEqual(actual, expected);
});

test("export_finish audio keys match the nested Rust struct", () => {
  const rust = read("src/commands/mod.rs");
  const js = read("ui/export-mp4.js");

  // Tauri only renames top-level command arguments. The fields of `audio` are
  // a nested object, so the struct has to ask serde for camelCase itself —
  // otherwise `sampleRate` is dropped and the rate silently reads as 0.
  assert.match(rust, /#\[serde\(rename_all = "camelCase"\)\]\s*pub struct ExportAudioArg/);

  const struct = rust.match(/pub struct ExportAudioArg \{([\s\S]*?)\n\}/);
  assert.ok(struct, "找不到 ExportAudioArg 的字段声明");
  const expected = [...struct[1].matchAll(/^[ \t]*pub ([a-z][a-z0-9_]*):/gm)]
    .map(([, name]) => name.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()))
    .sort();

  const payload = js.match(/audio: audio\s*\?\s*\{([\s\S]*?)\}\s*:\s*null/);
  assert.ok(payload, "找不到 export_finish 的 audio 参数");
  const actual = [...payload[1].matchAll(/^[ \t]*([A-Za-z_$][\w$]*)[ \t]*:/gm)]
    .map(([, key]) => key)
    .sort();

  assert.deepEqual(actual, expected);
});
