import test from "node:test";
import assert from "node:assert/strict";
import { findMatches, replaceOne } from "../find.js";

test("plain search finds every occurrence", () => {
  const matches = findMatches("cat cat cat", "cat");
  assert.equal(matches.length, 3);
  assert.deepEqual(matches[0], [0, 3]);
  assert.deepEqual(matches[2], [8, 11]);
});

test("empty query yields no matches", () => {
  assert.deepEqual(findMatches("anything", ""), []);
});

test("case sensitivity is honoured", () => {
  assert.equal(findMatches("Cat cat CAT", "cat", { caseSensitive: false }).length, 3);
  assert.equal(findMatches("Cat cat CAT", "cat", { caseSensitive: true }).length, 1);
});

test("regex search finds patterns", () => {
  const matches = findMatches("a1 b2 c3", "\\d", { regex: true });
  assert.equal(matches.length, 3);
  assert.deepEqual(matches[1], [4, 5]);
});

test("invalid regex yields no matches instead of throwing", () => {
  assert.doesNotThrow(() => findMatches("abc", "(", { regex: true }));
  assert.deepEqual(findMatches("abc", "(", { regex: true }), []);
});

test("multi-line regex matches are skipped for navigation", () => {
  // A pattern that spans a newline should not produce a per-line mark.
  const matches = findMatches("ab\ncd", "a[\\s\\S]*d", { regex: true });
  assert.deepEqual(matches, []);
});

test("replaceOne replaces literally for plain search", () => {
  const text = "cat cat";
  const next = replaceOne(text, [0, 3], "cat", "dog", {});
  assert.equal(next, "dog cat");
});

test("replaceOne honours regex capture groups", () => {
  const text = "name: hero";
  const next = replaceOne(text, [6, 10], "(\\w+)", "$1_2", { regex: true });
  assert.equal(next, "name: hero_2");
});

test("replaceOne keeps the rest of the text intact", () => {
  const text = "x = 1\ny = 2";
  const next = replaceOne(text, [4, 5], "1", "10", {});
  assert.equal(next, "x = 10\ny = 2");
});
