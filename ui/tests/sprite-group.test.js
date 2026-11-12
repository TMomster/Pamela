import test from "node:test";
import assert from "node:assert/strict";
import {
  SPRITE_FPS_MAX,
  SPRITE_FPS_MIN,
  createSpritePlayer,
  spriteFrameAt,
  spriteFrameRate,
  spriteIndex,
  spritePath,
} from "../sprite-group.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A player whose pictures are only remembered, so timing is all it does. */
function player(kind = "Character") {
  const seen = [];
  const it = createSpritePlayer({ kind, show: (path) => seen.push(path) });
  return { it, seen };
}

// --- the shared rules every backend reads ---

test("a member must be a picture path", () => {
  assert.equal(spritePath("Character", " a.png "), "a.png");
  assert.throws(() => spritePath("Character", ""), /需要一个图片路径/);
  assert.throws(() => spritePath("Character", "   "), /需要一个图片路径/);
  assert.throws(() => spritePath("Character", 3), /需要一个图片路径/);
});

test("the frame rate is 1–144, and 0 is refused rather than read as paused", () => {
  assert.equal(spriteFrameRate(16), 16);
  assert.equal(spriteFrameRate("24"), 24, "a numeric text is still a rate");
  assert.equal(spriteFrameRate(SPRITE_FPS_MIN), SPRITE_FPS_MIN);
  assert.equal(spriteFrameRate(SPRITE_FPS_MAX), SPRITE_FPS_MAX);
  assert.throws(() => spriteFrameRate(0), /1–144/);
  assert.throws(() => spriteFrameRate(145), /1–144/);
  assert.throws(() => spriteFrameRate(undefined), /1–144/);
});

test("a member is named by position or by its own picture path", () => {
  const paths = ["a.png", "b.png", "c.png"];
  assert.equal(spriteIndex(paths, 1), 1);
  assert.equal(spriteIndex(paths, "b.png"), 1);
  assert.throws(() => spriteIndex(paths, 3), /超出范围/);
  assert.throws(() => spriteIndex(paths, -1), /超出范围/);
  assert.throws(() => spriteIndex(paths, 1.5), /超出范围/);
  assert.throws(() => spriteIndex(paths, "nope.png"), /找不到图片/);
  assert.throws(() => spriteIndex(paths, true), /序号或图片名/);
});

test("spriteFrameAt ends a one-shot on its last picture and wraps a loop", () => {
  // 10 fps: 0–99 ms is the first picture, 100–199 the second.
  assert.equal(spriteFrameAt(0, 10, 3, false), 0);
  assert.equal(spriteFrameAt(99, 10, 3, false), 0);
  assert.equal(spriteFrameAt(100, 10, 3, false), 1);
  assert.equal(spriteFrameAt(250, 10, 3, false), 2, "一遍播完停在最后一张");
  assert.equal(spriteFrameAt(250, 10, 3, true), 2);
  assert.equal(spriteFrameAt(300, 10, 3, true), 0, "循环绕回第一张");
  assert.equal(spriteFrameAt(400, 10, 3, true), 1);
  assert.equal(spriteFrameAt(-100, 10, 3, false), 0, "起播之前算第一张");
  assert.equal(spriteFrameAt(0, 10, 0, true), -1, "空组没有帧");
});

// --- the player ---

test("setting a group shows its first picture", () => {
  const { it, seen } = player();
  it.setGroup(["a.png", "b.png"]);
  assert.deepEqual(seen, ["a.png"]);
  assert.equal(it.index(), 0);
});

test("a one-shot plays every picture and settles on the last one", async () => {
  const { it, seen } = player();
  it.setGroup(["a.png", "b.png", "c.png"]);
  // 100 fps: 10 ms a picture, three pictures including the first one's interval.
  await it.play(100);
  assert.deepEqual(seen, ["a.png", "b.png", "c.png"]);
  assert.equal(it.isPlaying(), false);
  assert.equal(it.index(), 2);
});

test("a one-shot before any group is an error", () => {
  const { it } = player();
  assert.throws(() => it.play(16), /还没有设置 group/);
});

test("a loop does not settle by itself, and pause lets the wait go", async () => {
  const { it, seen } = player();
  it.setGroup(["a.png", "b.png"]);
  const playback = it.play(144, true);
  const raced = await Promise.race([
    playback.then(() => "settled"),
    wait(40).then(() => "still playing"),
  ]);
  assert.equal(raced, "still playing");
  assert.ok(seen.length > 2, "循环应当换过好几张");
  assert.equal(it.isPlaying(), true);

  it.pause();
  await playback;
  assert.equal(it.isPlaying(), false);
});

test("playing again resumes from the picture on screen", async () => {
  const { it, seen } = player();
  it.setGroup(["a.png", "b.png", "c.png"]);
  it.pause("b.png");
  assert.deepEqual(seen, ["a.png", "b.png"]);
  assert.equal(it.index(), 1);

  // A slow rate, paused at once: the point is which picture it starts from.
  const playback = it.play(1);
  assert.equal(it.index(), 1, "从 b.png 接着播，不回到第一张");
  it.pause();
  await playback;
});

test("pause with no argument keeps the frame on screen", () => {
  const { it, seen } = player();
  it.setGroup(["a.png", "b.png"]);
  it.pause(1);
  assert.deepEqual(seen, ["a.png", "b.png"]);
  it.pause();
  assert.deepEqual(seen, ["a.png", "b.png"], "不带参数不换图");
});

test("pause may hold a picture from outside the group, and the group stays", () => {
  const { it, seen } = player();
  it.setGroup(["a.png", "b.png"]);
  it.pause("extra.png");
  assert.equal(seen.at(-1), "extra.png");
  assert.deepEqual(it.paths(), ["a.png", "b.png"], "pause 不会把组外的图加进组里");

  // 继续播放时回到组内，与组外的图无关。
  const playback = it.play(1);
  assert.equal(seen.at(-1), "a.png");
  it.pause();
  return playback;
});

test("add inserts after the named member", () => {
  const { it } = player();
  it.setGroup(["a.png", "c.png"]);
  it.add("a.png", "b.png");
  assert.deepEqual(it.paths(), ["a.png", "b.png", "c.png"]);
  it.add(2, "d.png");
  assert.deepEqual(it.paths(), ["a.png", "b.png", "c.png", "d.png"]);
  assert.throws(() => it.add(9, "e.png"), /超出范围/);
  assert.throws(() => it.add(0, ""), /图片路径/);
});

test("remove takes a member out by position or name, and keeps the picture up", () => {
  const { it, seen } = player();
  it.setGroup(["a.png", "b.png", "c.png"]);
  it.remove("b.png");
  assert.deepEqual(it.paths(), ["a.png", "c.png"]);
  it.remove(0);
  assert.deepEqual(it.paths(), ["c.png"]);
  assert.deepEqual(seen, ["a.png"], "正在显示的那张仍留在画面上");
});

test("update replaces a member in place, and repaints the one on screen", () => {
  const { it, seen } = player();
  it.setGroup(["a.png", "b.png"]);
  it.update(1, "b2.png");
  assert.deepEqual(it.paths(), ["a.png", "b2.png"]);
  assert.deepEqual(seen, ["a.png"], "换的不是当前这张，画面不动");

  it.pause(1);
  assert.equal(seen.at(-1), "b2.png");
  it.update(0, "a2.png");
  assert.deepEqual(seen, ["a.png", "b2.png"], "b2 还在，a2 只是替换了组里的位置 0");
  it.pause(0);
  assert.equal(seen.at(-1), "a2.png");
});

test("element answers the picture path a constructor can take", () => {
  const { it } = player();
  it.setGroup(["a.png", "b.png"]);
  assert.equal(it.element(0), "a.png");
  assert.equal(it.element("b.png"), "b.png");
  assert.throws(() => it.element(2), /超出范围/);
});

test("stop is idempotent: no timer outlives the group", async () => {
  const { it, seen } = player();
  it.setGroup(["a.png", "b.png"]);
  const playback = it.play(144, true);
  it.stop();
  it.stop();
  await playback;
  const count = seen.length;
  await wait(30);
  assert.equal(seen.length, count, "停下之后不再换图");
});
