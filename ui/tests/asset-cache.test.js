// 每运行一次的资源缓存测试。
// Tests for the per-run asset cache.

import assert from "node:assert/strict";
import test from "node:test";

import { createAssetCache } from "../asset-cache.js";

/** A reader that counts its calls and answers a URL naming the path. */
function countingReader() {
  const asked = [];
  return {
    asked,
    read: (path) => {
      asked.push(path);
      return Promise.resolve(`data:,${path}`);
    },
  };
}

test("a path is read once, however many times it is asked for", async () => {
  const { asked, read } = countingReader();
  const cache = createAssetCache(read);

  assert.equal(await cache.resolve("bg.png"), "data:,bg.png");
  assert.equal(await cache.resolve("bg.png"), "data:,bg.png");
  assert.equal(await cache.resolve("bg.png"), "data:,bg.png");

  assert.deepEqual(asked, ["bg.png"], "the file was read once");
  assert.equal(cache.size(), 1);
});

test("two callers asking at the same moment share one read", async () => {
  const { asked, read } = countingReader();
  const cache = createAssetCache(read);

  // Neither await has happened yet, so both are asking before the answer lands.
  const [first, second] = await Promise.all([cache.resolve("bg.png"), cache.resolve("bg.png")]);

  assert.equal(first, second);
  assert.deepEqual(asked, ["bg.png"], "the second call waited on the first rather than starting one");
});

test("different paths are read separately", async () => {
  const { asked, read } = countingReader();
  const cache = createAssetCache(read);

  await cache.resolve("a.png");
  await cache.resolve("b.png");
  await cache.resolve("a.png");

  assert.deepEqual(asked, ["a.png", "b.png"]);
  assert.equal(cache.size(), 2);
});

test("a failed read is not remembered, so the next call tries again", async () => {
  let attempts = 0;
  const cache = createAssetCache((path) => {
    attempts += 1;
    return attempts === 1
      ? Promise.reject(new Error(`读不到 ${path}`))
      : Promise.resolve("data:,ok");
  });

  await assert.rejects(() => cache.resolve("bg.png"), /读不到 bg.png/);
  assert.equal(cache.size(), 0, "the failure left nothing behind");

  // The file may have been put there in the meantime; a cached rejection would
  // make it unreadable for the rest of the run.
  assert.equal(await cache.resolve("bg.png"), "data:,ok");
  assert.equal(attempts, 2);
});

test("clearing the cache forces the next run to read from disk", async () => {
  const { asked, read } = countingReader();
  const cache = createAssetCache(read);

  await cache.resolve("bg.png");
  cache.clear();
  assert.equal(cache.size(), 0);

  await cache.resolve("bg.png");
  assert.deepEqual(asked, ["bg.png", "bg.png"], "the second run read the file again");
});

test("different spellings of one file share a read", async () => {
  const { asked, read } = countingReader();
  const cache = createAssetCache(read);

  await cache.resolve("./bg.png");
  await cache.resolve("bg.png");
  await cache.resolve("  bg.png  ");
  await cache.resolve("assets\\bg.png");

  assert.deepEqual(asked, ["bg.png", "assets/bg.png"]);
  assert.equal(cache.size(), 2);
});

test("an explicit assets path is not split by kind", async () => {
  const { asked, read } = countingReader();
  const cache = createAssetCache(read);

  // The host ignores `kind` for a path that already starts with `assets/`, so
  // both objects name the same bytes and should share the one data URL.
  await cache.resolve("assets/bg.png", "Background");
  await cache.resolve("assets/bg.png", "Character");

  assert.deepEqual(asked, ["assets/bg.png"]);
  assert.equal(cache.size(), 1);
});

test("a missing path is still a path, not a wildcard", async () => {
  const { asked, read } = countingReader();
  const cache = createAssetCache(read);

  await cache.resolve("");
  await cache.resolve(null);
  await cache.resolve(undefined);

  // All three name the same thing — nothing — so they share one entry.
  assert.equal(asked.length, 1);
  assert.equal(cache.size(), 1);
});

test("the cache evicts the oldest read once it is full", async () => {
  const { asked, read } = countingReader();
  const cache = createAssetCache(read, { limit: 2 });

  await cache.resolve("a.png");
  await cache.resolve("b.png");
  await cache.resolve("c.png");

  assert.equal(cache.size(), 2, "the cache stays bounded");
  assert.deepEqual(asked, ["a.png", "b.png", "c.png"]);

  // `a.png` was dropped, so it is read again; the size stays bounded.
  await cache.resolve("a.png");
  assert.deepEqual(asked, ["a.png", "b.png", "c.png", "a.png"]);
});

test("a hit refreshes the entry so the busiest picture survives", async () => {
  const { asked, read } = countingReader();
  const cache = createAssetCache(read, { limit: 2 });

  await cache.resolve("a.png");
  await cache.resolve("b.png");
  await cache.resolve("a.png"); // a hit: a becomes the most recent entry
  await cache.resolve("c.png"); // so b is evicted, not a

  await cache.resolve("a.png");
  assert.deepEqual(asked, ["a.png", "b.png", "c.png"], "a stayed cached");
});
