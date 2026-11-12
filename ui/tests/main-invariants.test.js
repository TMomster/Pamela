// `ui/main.js` DOM 接线的静态守卫。
// Static guards for the DOM wiring in `ui/main.js`.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { iconNames } from "../icons.js";
import { behaviorNodeKeys, paramControl } from "../api-spec.js";

const ui = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (name) => readFileSync(path.join(ui, name), "utf8");
const has = (name, needle) => read(name).includes(needle);
// 反解后端改用共享 API 表后，不再自带一份方法清单；这里改验它确实接上了表，
// 且方法仍按表流通（参数名为 value、类型为布尔）。
const reverseUsesTable = (map) => map.includes('from "./graph-editor.js"');

test("a guard actually detects a missing string", () => {
  assert.equal(has("main.js", "__this_string_is_not_in_main_js__"), false);
  assert.equal(has("main.js", "function updateErrorMarks("), true);
});

test("crood is wired through both backends and every language table", () => {
  const stage = read("stage.js");
  const video = read("video.js");
  const recording = read("export-stage.js");
  const rendering = read("export-render.js");
  const language = read("pamela.js");
  const help = read("reader.js");
  const completion = read("completion.js");
  const map = read("map-parse.js");
  const graph = read("graph-editor.js");
  const css = read("styles/panels.css");

  // 舞台：共享模块、第九层覆盖层、默认隐藏的开关集合、清场时收起。
  assert.match(stage, /import \{ axesOf, createAxesLayer \} from "\.\/axes\.js";/);
  assert.match(stage, /const croodOn = new Set\(\);/);
  assert.match(stage, /const setCrood = \(key, visible\) =>/);
  assert.match(stage, /axesLayer\.node,/);
  assert.match(stage, /croodOn\.clear\(\);/);
  assert.match(stage, /object\.crood = \(value = true\) =>/);
  assert.match(video, /factory\.axisPose = \(slot\) =>/);

  // 导出：默认隐藏的录制状态、enable 重放、Canvas2D 共用同一套画法。
  assert.match(recording, /crood: false,/);
  assert.match(recording, /crood: state\.crood,/);
  assert.match(rendering, /import \{ axesOf, paintAxes \} from "\.\/axes\.js";/);
  assert.match(rendering, /paintAxes\(ctx, axesFramesOf\(groups\)/);

  // 语言：别名、参数表、补全、帮助、图形编辑器一处都不能漏。
  assert.match(language, /\["坐标轴", "crood"\]/);
  assert.match(language, /crood: \["value"\]/);
  assert.match(help, /\| 坐标轴 \| crood \|/);
  assert.match(completion, /label: "crood"/);
  assert.ok(reverseUsesTable(map), "反解后端必须接上共享 API 表");
  assert.ok(behaviorNodeKeys().includes("crood"), "反解后端必须识别 crood");
  assert.equal(paramControl("value", "crood").type, "bool");
  assert.match(graph, /crood: \{ title: "坐标轴"/);
  assert.match(css, /\.stage__axes \{[\s\S]*?pointer-events: none;/);
});

test("translucent is wired through both backends and every language table", () => {
  const stage = read("stage.js");
  const recording = read("export-stage.js");
  const rendering = read("export-render.js");
  const light = read("light.js");
  const language = read("pamela.js");
  const help = read("reader.js");
  const completion = read("completion.js");
  const map = read("map-parse.js");
  const graph = read("graph-editor.js");

  // 舞台：与坐标轴同一套键、按类型给默认、清场时收起，灯层读同一个判据。
  assert.match(stage, /const lightPass = new Map\(\);/);
  assert.match(stage, /const translucentOf = \(key\) =>/);
  assert.match(stage, /const setTranslucent = \(key, value\) =>/);
  assert.match(stage, /object\.translucent = \(value = true\) =>/);
  assert.match(stage, /const cast = !translucentOf\(key\);/);
  assert.match(stage, /lightPass\.clear\(\)/);

  // 导出：录制状态、enable 重放与 Canvas2D 的判据三处都要带上。
  assert.match(recording, /lightPass: kind !== "Character",/);
  assert.match(recording, /lightPass: state\.lightPass,/);
  assert.match(rendering, /cast: !passLight,/);

  // 灯层：cast 为假就跳过深度遮挡（「透光」的全部实现）。
  assert.match(light, /object\.cast === false/);

  // 语言：别名、参数表、补全、帮助、图形编辑器一处都不能漏。
  assert.match(language, /\["透光", "translucent"\]/);
  assert.match(language, /translucent: \["value"\]/);
  assert.match(help, /\| 透光 \| translucent \|/);
  assert.match(completion, /label: "translucent"/);
  assert.ok(reverseUsesTable(map), "反解后端必须接上共享 API 表");
  assert.ok(behaviorNodeKeys().includes("translucent"), "反解后端必须识别 translucent");
  assert.equal(paramControl("value", "translucent").type, "bool");
  assert.match(graph, /translucent: \{ title: "透光"/);
});

test("rim is wired through both backends and every language table", () => {
  const stage = read("stage.js");
  const recording = read("export-stage.js");
  const rendering = read("export-render.js");
  const light = read("light.js");
  const language = read("pamela.js");
  const help = read("reader.js");
  const completion = read("completion.js");
  const map = read("map-parse.js");
  const graph = read("graph-editor.js");

  // 舞台：与透光同一套键、默认 0、清场时收起，剪影里带上强度。
  assert.match(stage, /const rimOf = new Map\(\);/);
  assert.match(stage, /const rimLightOf = \(key\) =>/);
  assert.match(stage, /const setRim = \(key, value\) =>/);
  assert.match(stage, /object\.rim = \(value = 1\) =>/);
  assert.match(stage, /const rim = rimLightOf\(key\);/);
  assert.match(stage, /rimOf\.clear\(\)/);

  // 灯层：只有 `paintRim` 一条路径会画它，三个条件都在那里判断。
  assert.match(light, /function paintRim\(/);
  assert.match(light, /paintRim\(ctx, light, \{ size, scale, objects, scratch, geometry, halo: field \}\)/);
  assert.match(light, /scratch\?\.rim/);
  assert.match(light, /const back = 1 - lightFaceAt\(light, object\.z\);/);

  // 导出：录制状态、enable 重放与 Canvas2D 的判据三处都要带上。
  assert.match(recording, /rim: 0,/);
  assert.match(recording, /rim: state\.rim,/);
  assert.match(rendering, /rim: Number\(picture\.rim\) \|\| 0,/);

  // 语言：别名、参数表、补全、帮助、图形编辑器一处都不能漏。
  assert.match(language, /\["轮廓光", "rim"\]/);
  assert.match(language, /rim: \["value"\]/);
  assert.match(help, /\| 轮廓光 \| rim \|/);
  assert.match(completion, /label: "rim"/);
  assert.ok(reverseUsesTable(map), "反解后端必须接上共享 API 表");
  assert.ok(behaviorNodeKeys().includes("rim"), "反解后端必须识别 rim");
  assert.equal(paramControl("value", "rim").type, "number");
  assert.match(graph, /rim: \{ title: "轮廓光"/);
});

test("every editor repaint also refreshes the error marks", () => {
  const main = read("main.js");
  // Typing defers the underline, every other repaint draws it at once; both
  // routes end in `updateErrorMarks`, so a repaint can never leave a stale mark.
  assert.match(main, /function updateHighlight\(\{ deferErrors = false \} = \{\}\)/);
  assert.match(main, /if \(deferErrors\) \{\s*scheduleErrorMarks\(scanned\);[\s\S]*?flushErrorMarks\(scanned\);/);
  assert.match(main, /function flushErrorMarks\([\s\S]*?updateErrorMarks\(scanned\);/);
  assert.match(main, /function scheduleErrorMarks\([\s\S]*?updateErrorMarks\(pending\);/);
  assert.match(main, /addEventListener\("scroll"[\s\S]*?syncErrorScroll\(\);/);
  assert.match(main, /dom\.editorErrorInner = document\.getElementById\("editor-error-inner"\)/);
  assert.match(main, /import \{ errorMarkRect, syntaxErrorIn/);
});

test("a repaint skips what did not change", () => {
  const main = read("main.js");
  // The gutter is rewritten only when the line count moves, and a scroll slides
  // the colour strip instead of rebuilding every swatch.
  assert.match(main, /if \(lineCount !== gutterLines\) \{/);
  assert.match(main, /const lineCount = lineCountOf\(dom\.editorText\.value\);/);
  assert.match(main, /if \(text === tintText && host === tintHost && hidden === tintHidden\) \{/);
  assert.match(
    main,
    /addEventListener\("scroll", \(\) => \{\s*syncGutterScroll\(\);\s*syncTintScroll\(\);/,
  );
  assert.match(main, /host\.style\.transform = `translateY\(\$\{-dom\.editorText\.scrollTop\}px\)`/);
});

test("滚动同步：行号与高亮层靠平移跟随，不把滚动量抄给图层", () => {
  const main = read("main.js");
  const html = read("index.html");
  const panels = read("styles/panels.css");
  // 两层的可滚动范围都比文本框小（文本框有滚动条，值以换行结尾时还多一个空行
  // 盒子）。把 `scrollTop` 抄过去，滚到底部时图层会先被夹住，渲染的文字与行号
  // 错开一行——所以两层都是「裁切框 + 内层平移」。
  assert.match(html, /id="editor-gutter-inner"/);
  assert.match(html, /id="editor-highlight-inner"/);
  assert.match(main, /function syncGutterScroll\(\) \{\s*const host = dom\.editorGutterInner;/);
  assert.match(main, /function syncHighlightScroll\(\) \{\s*const host = dom\.editorHighlightInner;/);
  assert.match(main, /host\.style\.transform = `translateY\(\$\{-dom\.editorText\.scrollTop\}px\)`/);
  assert.match(
    main,
    /host\.style\.transform =\s*`translate\(\$\{-dom\.editorText\.scrollLeft\}px, \$\{-dom\.editorText\.scrollTop\}px\)`/,
  );
  assert.doesNotMatch(main, /dom\.editorGutter\.scrollTop =/);
  assert.doesNotMatch(main, /dom\.editorHighlight\.scrollTop =/);
  // 字体度量跟着文字走，所以搬到了内层；外层只负责裁切。
  assert.match(panels, /\.editor__gutter-inner \{[\s\S]*?white-space: pre;/);
  assert.match(panels, /\.editor__highlight-inner \{[\s\S]*?white-space: pre;/);
});

test("the error overlay and its CSS exist, inert placeholders do not", () => {
  const html = read("index.html");
  const panels = read("styles/panels.css");
  const graph = read("styles/graph.css");
  assert.match(html, /id="editor-error-inner"/);
  assert.match(panels, /\.editor__error-mark \{/);
  assert.match(panels, /\.editor__error-overlay \{[\s\S]*?pointer-events: none;/);
  for (const id of ["dialog-view", "image-edit-view", "audio-edit-view", "graph-view"]) {
    assert.equal(html.includes(`id="${id}"`), false, `inert placeholder ${id} must stay removed`);
  }
  // The CSS classes stay: `syncEditors()` gives the per-tab containers these names.
  for (const cls of ["dialog-view", "image-edit", "audio-edit", "graph-view"]) {
    assert.ok(
      panels.includes(`.${cls}`) || graph.includes(`.${cls}`),
      `CSS class .${cls} is still needed by the dynamic containers`,
    );
  }
});

test("renderView still guards containers that no longer exist at startup", () => {
  const main = read("main.js");
  for (const name of ["dialogView", "imageEditView", "audioEditView", "graphView"]) {
    assert.match(main, new RegExp(`if \\(dom\\.${name}\\)`));
  }
});

test("removed exports and stale about text are not restored", () => {
  const actions = read("project-actions.js");
  assert.equal(actions.includes("MANIFEST_FILE"), false);
  assert.equal(actions.includes('quit: "window.close"'), false);
  assert.equal(read("main.js").includes("脚本语言尚未定稿"), false);
});

test("预览播放：起点是当前关键帧组的第一帧，且只读一次", () => {
  const editor = read("path-editor.js");
  // 预览播放永远从当前关键帧组的第一个关键帧开始，与当前选中了哪一帧无关——预览播放的定义
  // 就是「整组从头播放」。`path.start` 就是第一帧的绝对位置，用它作起点时
  // shiftedPointAt 不加任何偏移，对象正好落在第 0 帧。只在此读取一次：
  // applyPreviewState 每帧都在移动对象，若在 step() 里重读会被行走本身漂走。
  assert.match(editor, /const origin = path\?\.start/);
  assert.match(editor, /const step = \(\) => \{/);
  assert.match(editor, /shiftedPointAt\(path, elapsed, origin\)/);
  assert.match(editor, /shiftedPointAt\(path, 0, origin\)/);
  // The single interpolated pose is what both the real image and the on-canvas
  // outline read, so the box rides the walk. It must carry the frame's rotation
  // and scale, not just x/y.
  assert.match(editor, /previewStage\.applyPreviewState\(objectName, previewState\)/);
  assert.match(editor, /previewState = \{\s*x: at\.x,[\s\S]*?frame\.rotation \?\? live\.rotation/);
});

test("对称拖动：Shift 接线没有被摘掉", () => {
  const editor = read("path-editor.js");
  assert.match(editor, /mirror: Boolean\(event\.shiftKey\)/);
  assert.match(editor, /mirrorBends\(link\.bends, drag\.run, at, midpointOf\(drag\.index\)\)/);
  assert.match(editor, /Shift 拖弯曲点：两侧对称/);
  assert.match(editor, /Shift 拖动：两侧对称/);
});

test("运行按钮：只留播放图标，并按当前文件可执行性亮灭", () => {
  const main = read("main.js");
  assert.match(main, /playButton\.append\(createIcon\("play"\)\)/, "按钮内只放播放图标");
  assert.match(main, /runPlayButton = playButton/, "按钮引用挂到模块级，供刷新函数使用");
  assert.doesNotMatch(main, /▶ 运行/, "按钮内不再有「运行」文字");
  assert.match(main, /runPlayButton\.disabled = !runnable/, "不可运行时按钮禁用（熄灭）");
  assert.match(
    main,
    /isScriptPath\(session\.openPath\) \|\| isMapPath\(session\.openPath\)/,
    "亮起的条件是当前打开 .pe 或 .flowmap",
  );
  assert.match(main, /refreshRunButton\(\);/, "打开/关闭文件、切策略、运行结束都会刷新按钮");
  // 悬停只说「执行」，不再堆「当前不是 .pe / .flowmap 不能运行」这类长解释。
  assert.match(main, /runPlayButton\.title = "执行"/);
  assert.doesNotMatch(main, /runPlayButton\.title = runnable/);
});

test("对话设计器工具栏：按钮全部图标化，文案退到 title", () => {
  const dialog = read("dialog-editor.js");
  assert.match(dialog, /button\.append\(createIcon\(SLOT_ICONS\[slot\]/, "槽位按钮用图标");
  assert.match(dialog, /add\.append\(createIcon\(LAYER_ICONS\[type\]/, "添加图层按钮用图标");
  assert.match(dialog, /button\.append\(createIcon\(icon\)\)/, "动作按钮用图标");
  assert.doesNotMatch(dialog, /textContent = `＋/, "旧的「＋矩形」文字按钮已移除");
  assert.match(dialog, /setAttribute\("aria-label", label\)/, "文案保留在无障碍名里");
});

test("对话设计器：图层右键、标题栏操作、可折叠面板、预览自适应", () => {
  const dialog = read("dialog-editor.js");
  const css = read("styles/panels.css");
  // 1. 图层栏右键菜单
  assert.match(dialog, /openContextMenu\(\{/);
  assert.match(dialog, /addEventListener\("contextmenu"/);
  // 2. 四个操作移到图层栏标题
  assert.match(dialog, /layerActionButton\("arrow-up", "上移", "up"\)/);
  assert.match(dialog, /layerActionButton\("arrow-down", "下移", "down"\)/);
  assert.match(dialog, /layerActionButton\("copy", "复制", "duplicate"\)/);
  assert.match(dialog, /layerActionButton\("trash", "删除", "remove"\)/);
  assert.doesNotMatch(dialog, /action\("arrow-up"/, "上移不再存储于工具栏上");
  assert.doesNotMatch(dialog, /action\("trash"/, "删除不再存储于工具栏上");
  // 3. 图层 / 属性栏可收起展开
  assert.match(dialog, /function togglePanel\(side\)/);
  assert.match(dialog, /is-\$\{side\}-collapsed/);
  assert.match(css, /\.dialog-editor__body\.is-layers-collapsed \{/);
  assert.match(css, /\.dialog-editor__layers\.is-collapsed \.dialog-editor__panel-body/);
  // 4. 预览按可用空间自适应缩放
  assert.match(dialog, /function fitFrame\(\)/);
  assert.match(dialog, /previewObserver = new ResizeObserver\(\(\) => fitFrame\(\)\)/);
  assert.match(dialog, /previewObserver\.observe\(viewer\)/);
  assert.match(dialog, /previewObserver\?\.disconnect\(\)/, "关闭标签时释放观察器");
});

test("对话设计器用到的图标都在图标集里", () => {
  for (const name of [
    "message-square",
    "message-square-quote",
    "copy",
    "arrow-up",
    "arrow-down",
    "arrow-right",
    "square",
    "circle",
    "polygon",
    "image",
    "line",
    "trash",
  ]) {
    assert.ok(iconNames.includes(name), `图标集缺少 ${name}`);
  }
});

test("轮廓：位图解码后的重画通知链接线完整", () => {
  assert.match(read("stage.js"), /onObjectBox = \(\) => \{\}/);
  assert.match(read("stage.js"), /onObjectBox\(name\);/);
  assert.match(read("stage.js"), /adopt\(entry, loaded, slot\)/);
  assert.match(read("path-editor.js"), /refresh: \(\) => \{/);
  assert.match(read("main.js"), /onObjectBox: \(\) => pathEditor\?\.refresh\(\)/);
});

test("关键帧复制/重命名：树操作接上了 id 重建与引用改写", () => {
  const main = read("main.js");
  const tree = read("tree-ops.js");
  const keyframes = read("keyframe-ops.js");
  // 树命令在 `tree-ops.js`，关键帧身份在 `keyframe-ops.js`；`main.js` 只剩装配。
  assert.match(main, /import \{ createKeyframeOps \} from "\.\/keyframe-ops\.js"/);
  assert.match(main, /import \{ canPaste, createTreeOps, targetDirectory \} from "\.\/tree-ops\.js"/);
  // 别名已收口（§8.5）：调用点直接点名所属模块，`main.js` 里不再有转手别名。
  assert.match(main, /const treeOps = createTreeOps\(\{/);
  assert.match(main, /treeOps\.onResourceContextMenu\(event\.detail\)/);
  assert.match(main, /treeOps\.handlers\["tree\.(copy|paste|delete)"\]/);
  assert.doesNotMatch(main, /const treeHandlers = /);
  assert.match(tree, /copyNameFor\(clip\.name, names\)/);
  assert.match(tree, /rehomeKeyframesFile\(to\)/);
  assert.match(tree, /rehomeKeyframesFile\(renamed, fromPath\)/);
  assert.match(tree, /rekeyReferences\(fromPath, renamed\)/);
  assert.match(tree, /rehomeKeyTab\(fromPath, renamed, renamedDoc\)/);
  assert.match(tree, /rehomeKeyTab\(renamed, fromPath, originalDoc\)/);
  assert.match(keyframes, /pathEditor\.rehome\(doc\.id, doc\.name\)/);
  assert.match(tree, /replayTexts\(refChanges, "after"\)/);
  assert.match(tree, /replayTexts\(refChanges, "before"\)/);
  assert.match(tree, /validateKeyframesName\(name\)/);
  // 剪贴板要真的交给 `canPaste`：漏了它粘贴项永远灰着，点不动。
  assert.match(main, /disabled: !canPaste\(session\.clipboard, targetDirectory\(target\)\)/);
  assert.match(tree, /export function canPaste\(clip, dir\)/);
});

test("查找替换：栏在 find-bar.js，main.js 只做装配与接线", () => {
  const main = read("main.js");
  const find = read("find-bar.js");
  assert.match(main, /import \{ createFindBar \} from "\.\/find-bar\.js"/);
  assert.match(main, /const findBar = createFindBar\(\{ dom, editorRangeRect \}\)/);
  assert.doesNotMatch(main, /const runFind = /);
  // 输入时只重算匹配、不抢光标；滚动与字体就绪时都要跟着重画。
  assert.match(main, /if \(findBar\.isOpen\(\)\) \{\s*findBar\.run\(false\);/);
  assert.match(main, /if \(findBar\.isOpen\(\)\) \{\s*findBar\.syncScroll\(\);/);
  assert.match(main, /if \(findBar\.isOpen\(\)\) \{\s*findBar\.renderMarks\(\);/);
  // 错误下划线与查找标记共用同一次测量。
  assert.match(main, /const rect = errorMarkRect\(source, error, findBar\.geometry\(\)\)/);
  assert.match(find, /findMatches\(dom\.editorText\.value, state\.query, options\)/);
  assert.match(find, /inner\.appendChild\(mark\)/);
  assert.match(find, /editor__find-mark--active/);
  assert.match(find, /function lineColAt/);
});

test("播放控件：状态在 playback-bar.js，main.js 只做装配与读取", () => {
  const main = read("main.js");
  const playback = read("playback-bar.js");
  assert.match(main, /import \{ createPlaybackBar \} from "\.\/playback-bar\.js"/);
  assert.match(main, /playback\.refreshMenu\(\)/);
  assert.match(main, /playback\.toggleFullscreen\(\)/);
  assert.doesNotMatch(main, /const refreshStageMenu = /);
  assert.match(main, /if \(playback\.isBacklogOpen\(\)\)/);
  assert.match(main, /if \(event\.key !== "Escape" \|\| event\.defaultPrevented \|\| !playback\.isFullscreen\(\)\)/);
  assert.match(main, /playback\.setFullscreen\(on\)/);
  assert.match(
    playback,
    /wheelOpensBacklog\(\{ open: backlogOpen, onStage, covered: slotsOpen\(\), deltaY: event\.deltaY \}\)/,
  );
  assert.match(playback, /app\?\.classList\.toggle\("is-stage-fullscreen", Boolean\(on\)\)/);
});

test("舞台内退出确认：卡片在 stage-exit.js，main.js 只负责装配与问一句话", () => {
  const main = read("main.js");
  const card = read("stage-exit.js");
  assert.match(main, /import \{ createStageExitConfirm \} from "\.\/stage-exit\.js"/);
  // 卡片是舞台自己的一层：宿主和存档格子、设置面板同级，盖住画面而不是窗口。
  assert.match(main, /document\.getElementById\("stage-exit"\)/);
  assert.match(read("index.html"), /<div class="stage-exit" id="stage-exit" hidden><\/div>/);
  assert.match(card, /export const STAGE_EXIT_TITLE = "退出演出"/);
  assert.match(card, /document\.addEventListener\("keydown", onKeyDown, true\)/);
  assert.match(card, /event\.stopPropagation\(\)/);

  // Esc 的两条入口都先问一句：全屏那条，以及舞台在屏上的普通那条。
  assert.match(main, /function askToLeaveStage\(\)/);
  assert.match(main, /event\.preventDefault\(\);\s*askToLeaveStage\(\);/);
  assert.match(main, /if \(stageOnScreen\(\) && askToLeaveStage\(\)\) \{/);
  // 问过之后不能再落到「悄悄停运行」上。
  assert.match(
    main,
    /if \(stageOnScreen\(\) && askToLeaveStage\(\)\) \{\s*event\.preventDefault\(\);\s*return;\s*\}\s*if \(!session\.running\)/,
  );
  // 舞台收摊时卡片一起收起，否则会留在下一场戏上。
  assert.match(main, /discardStageSafely\(\(\) => stageExit\?\.close\(\)\);/);
  // 确认之后关的是舞台本身，播放器模式连外壳一起退。
  assert.match(main, /onConfirm: \(\) => \{[\s\S]*?closeStage\(\);[\s\S]*?setPlayerMode\(false\);/);
});

test("项目生命周期：偏好与打开流程住在 project-lifecycle.js", () => {
  const main = read("main.js");
  const life = read("project-lifecycle.js");
  assert.match(main, /const lifecycle = createProjectLifecycle\(\{/);
  assert.match(main, /lifecycle\.withProject\(/);
  assert.doesNotMatch(main, /const withProject = /);
  assert.match(main, /lifecycle\.save\(\)/);
  assert.match(main, /lifecycle\.restore\(\)/);
  assert.match(main, /lifecycle\.openRemembered\(/);
  // 偏好对象只住在一个地方：`main.js` 里不该再有第二份可写的副本。
  assert.doesNotMatch(main, /\blet appState\b/);
  assert.match(life, /stateOnDisk = \{ \.\.\.stateOnDisk, \.\.\.next \}/);
});

test("播放器模式不写进偏好：每次启动都回编辑器", () => {
  const main = read("main.js");
  const life = read("project-lifecycle.js");
  const rust = readFileSync(path.join(ui, "..", "src", "commands", "mod.rs"), "utf8");

  // 模式只是这一次运行里的状态，不进偏好文件。
  assert.match(main, /let playerMode = false;/);
  assert.match(main, /playerMode = Boolean\(on\);/);
  assert.doesNotMatch(main, /state\.mode/);
  assert.doesNotMatch(life, /state\.mode/);
  // 后端的偏好结构里也没有这一项了：老偏好文件里的 `mode` 会被忽略，
  // 下一次写盘时自然消失。
  assert.doesNotMatch(rust, /pub mode: Option<String>/);
  // 切模式不再写盘。
  assert.doesNotMatch(main, /playerMode = Boolean\(on\);\s*lifecycle\.save\(\);/);
});

test("播放器里那条 Esc 提示只停 1.5 秒", () => {
  const main = read("main.js");
  assert.match(main, /const TOAST_ESC_HINT_MS = 1500;/);
  assert.match(
    main,
    /pushToast\(\{ text: "按Esc以返回编辑器", duration: TOAST_ESC_HINT_MS \}\)/,
  );
});

test("帮助与关于：工具栏直接进内置阅读器，面板改称目录", () => {
  const menus = read("menus.js");
  const main = read("main.js");
  const html = read("index.html");

  // 两个入口都是直接动作，不是下拉菜单：点一次就到文章。
  assert.match(menus, /command: "app\.help"/);
  assert.match(menus, /command: "app\.about"/);
  assert.match(menus, /export const TOOLBAR_ACTIONS/);

  // 命令落到阅读器，而不是一个只说明版本的弹窗。阅读器实现在 `ui/reader-panel.js`。
  assert.match(main, /"app\.help": \(\) => readerPanel\.open\("help"\)/);
  assert.match(main, /"app\.about": \(\) => readerPanel\.open\("about"\)/);
  assert.match(main, /import \{ createReaderPanel \} from "\.\/reader-panel\.js"/);

  // 阅读时左侧资源栏变成目录，标题随之改变。
  assert.match(main, /dom\.resourceTitle\.textContent = reading \? "目录" : "资源"/);
  assert.match(main, /readerPanel\.toc\(/);
  assert.match(read("reader-panel.js"), /createReaderToc\(/);

  assert.match(html, /id="resource-title"/);
  assert.match(html, /id="reader-view"/);
  assert.match(html, /styles\/reader\.css/);
});

test("运行/导出出错：跳标签、高亮行、右下角常驻气泡", () => {
  const main = read("main.js");
  const html = read("index.html");
  assert.match(main, /import \{ classifyError, pushErrorBubble(, pushToast)? \} from "\.\/error-notify\.js"/);
  // 运行期错误与导出错误都走统一上报，而不是只写状态栏。
  assert.match(main, /function reportScriptError\(error, \{ path \} = \{\}\)/);
  assert.match(main, /reportScriptError\(result\.error, \{ path \}\)/);
  assert.match(main, /reportScriptError\(error, \{ path: entry \}\)/);
  // 行高亮与气泡都已接线。
  assert.match(main, /function revealErrorLine\(line\)/);
  assert.match(main, /function revealErrorInScript\(path, line\)/);
  assert.match(main, /void revealErrorInScript\(target, info\.line\)/);
  assert.match(main, /dom\.errorBubbles = document\.getElementById\("error-bubbles"\)/);
  // 气泡容器与样式存在。
  assert.match(html, /id="error-bubbles"/);
  assert.match(read("styles/app.css"), /\.error-bubble \{/);
  assert.match(read("styles/app.css"), /\.editor__run-error \{/);
});

test("mpe：三个入口都先编译，保存指纹仍按原文", () => {
  const main = read("main.js");

  // 运行时：当前文件、include 读入的文件、编辑器里的错误标记。
  assert.match(main, /const program = isMpePath\(path\) \? transpile\(source\) : source/);
  assert.match(main, /return isMpePath\(resolved\) \? transpile\(text\) : text/);
  // 错误标记与高亮共用同一次扫描：`.pe` 复用 token，`.mpe` 先编译再检查。
  assert.match(main, /const text = mpe \? transpile\(source\) : source/);
  assert.match(main, /syntaxErrorInTokens\(scanned\.tokens, text\)/);
  assert.match(main, /result = await run\(program,/);

  // 存档指纹是对文件本身的哈希，存的是作者写的原文，不是编译结果。
  assert.match(main, /session\.texts = new Map\(\[\[path, source\]\]\)/);
  assert.match(main, /session\.texts\.set\(resolved, text\)/);

  // 前端与后端都得认这个后缀，否则树里、运行按钮和入口判定会判定结果不一致。
  const actions = read("project-actions.js");
  assert.match(actions, /SHORT_SCRIPT_SUFFIX = "\.mpe"/);
  assert.match(actions, /lower\.endsWith\(SHORT_SCRIPT_SUFFIX\)/);

  const rust = readFileSync(path.join(ui, "..", "src", "project.rs"), "utf8");
  assert.match(rust, /SHORT_SCRIPT_SUFFIX: &str = "\.mpe"/);
  assert.match(rust, /lower\.ends_with\(SHORT_SCRIPT_SUFFIX\)/);
});

test("舞台设置：舞台内的一层，只有节标题与四个档位", () => {
  const settings = read("stage-settings.js");
  const css = read("styles/panels.css");
  const html = read("index.html");

  assert.match(settings, /TEXT_SPEED_TITLE = "文本逐字显示模式"/);
  for (const label of ["关闭", "快速", "中速", "慢速"]) {
    assert.ok(settings.includes(`label: "${label}"`), `缺少档位 ${label}`);
  }

  assert.match(html, /id="stage-settings-panel"/);
  // 覆盖在取景框上而不是窗口上：设置属于演出，不属于编辑器。
  assert.match(css, /\.stage-settings \{[\s\S]*?position: absolute;/);
  assert.match(css, /\.stage-settings__options \{/);
});
