// 离线微基准：量化状态游标「全量 filter+sort」与「增量事件消费」的规模差异。
// Pamela — offline micro-benchmark for the export state cursor.
//
// 不需要浏览器、素材或 Tauri，只跑纯逻辑，用来说明长剧本下为什么 O(N²) 值得改。
// 用法：node tools/bench-export.mjs [事件数=4000] [帧数=3000]
//
// 注意：这不是 `docs/2026-11-08.md` §2.3 P1-2 的真机门槛用例。真机用例要在
// 应用里跑 35 秒成片并从结果页读分项耗时；本脚本只回答「游标这一刀值不值」。

import { performance } from "node:perf_hooks";
import { addSet, createStateCursor, createTimeline } from "../ui/export-timeline.js";

const eventCount = Math.max(1, Number(process.argv[2]) || 4000);
const frameCount = Math.max(1, Number(process.argv[3]) || 3000);

function buildTimeline() {
  const timeline = createTimeline();
  for (let i = 0; i < eventCount; i += 1) {
    // 8 个角色轮流换图：模拟长剧本里事件持续追加、状态反复被覆盖。
    addSet(timeline, i * 2, `character:h${i % 8}`, { path: `p${i}.png`, x: i });
  }
  return timeline;
}

/** 改造前的朴素算法：每帧对全部历史事件 filter + sort。 */
function legacyCursor(timeline) {
  const state = {};
  const consumed = new Set();
  return (t) => {
    const arrived = timeline.events
      .filter((event) => !consumed.has(event.seq) && event.t <= t)
      .sort((a, b) => a.t - b.t || a.seq - b.seq);
    for (const event of arrived) {
      consumed.add(event.seq);
      for (const [prop, value] of Object.entries(event.patch)) {
        if (!state[event.target]) {
          state[event.target] = {};
        }
        state[event.target][prop] = value;
      }
    }
    const copy = {};
    for (const [target, props] of Object.entries(state)) {
      copy[target] = { ...props };
    }
    return copy;
  };
}

function run(at) {
  const start = performance.now();
  let checksum = 0;
  for (let frame = 0; frame < frameCount; frame += 1) {
    const state = at(frame * 2);
    // 读一点结果，避免引擎把整个循环优化掉。
    for (const props of Object.values(state)) {
      checksum += Number(props.x) || 0;
    }
  }
  return { ms: performance.now() - start, checksum };
}

// 先在同一份时间线上验证两者逐点等价，再分别计时。
{
  const timeline = buildTimeline();
  const legacy = legacyCursor(timeline);
  const cursor = createStateCursor(timeline);
  for (let frame = 0; frame < frameCount; frame += 97) {
    const expected = JSON.stringify(legacy(frame * 2));
    const actual = JSON.stringify(cursor.at(frame * 2));
    if (expected !== actual) {
      throw new Error(`游标与旧算法在 frame ${frame} 分歧\n${expected}\n${actual}`);
    }
  }
}

const legacyCursorAt = legacyCursor(buildTimeline());
const fresh = createStateCursor(buildTimeline());
const legacyResult = run(legacyCursorAt);
const incrementalResult = run((t) => fresh.at(t));

const ratio = legacyResult.ms / Math.max(incrementalResult.ms, 0.001);
console.log(`事件 ${eventCount} / 帧 ${frameCount}`);
console.log(`旧算法（每帧全量 filter+sort）：${legacyResult.ms.toFixed(1)} ms`);
console.log(`增量游标（已扫描指针 + 有序队列）：${incrementalResult.ms.toFixed(1)} ms`);
console.log(`倍率：${ratio.toFixed(1)}x`);
console.log(`校验和：${legacyResult.checksum} / ${incrementalResult.checksum}`);
if (legacyResult.checksum !== incrementalResult.checksum) {
  throw new Error("两种算法的最终状态不一致");
}
