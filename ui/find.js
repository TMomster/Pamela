// @ts-check
// 编辑器查找与替换逻辑，不依赖 DOM 以便单元测试。
// Editor find/replace logic, kept free of the DOM so it can be unit-tested
/**
 * Returns every match of `query` in `text` as `[start, end]` index pairs.
 * An empty query yields no matches. A syntactically invalid regex yields no
 * matches rather than throwing, so the bar can stay live while typing a pattern.
 *
 * @param {string} text
 * @param {string} query
 * @param {{ caseSensitive?: boolean, regex?: boolean }} [options]
 * @returns {Array<[number, number]>}
 */

export function findMatches(text, query, options = {}) {
  const { caseSensitive = false, regex = false } = options;
  /** @type {Array<[number, number]>} */
  const matches = [];
  if (!query) {
    return matches;
  }

  if (regex) {
    let re;
    try {
      re = new RegExp(query, caseSensitive ? "g" : "gi");
    } catch {
      return matches;
    }
    let match;
    while ((match = re.exec(text)) !== null) {
      const value = match[0];
      if (value.length === 0) {
        re.lastIndex += 1; // Guard against zero-width matches looping forever.
        continue;
      }
      if (value.includes("\n")) {
        // Match marks are drawn per line, so multi-line hits can't be shown as
        // one rectangle. Replace-all still honours them via String.replace.
        re.lastIndex = match.index + value.indexOf("\n") + 1;
        continue;
      }
      matches.push([match.index, match.index + value.length]);
    }
    return matches;
  }

  const haystack = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  let from = 0;
  let index;
  while ((index = haystack.indexOf(needle, from)) !== -1) {
    matches.push([index, index + needle.length]);
    from = index + needle.length;
  }
  return matches;
}

/**
 * Returns `text` with the single `match` replaced. For plain search the
 * replacement is literal; for regex it honours capture-group references such as
 * `$1`. The rest of the string is untouched, so callers can assign the result
 * straight back to the textarea.
 *
 * @param {string} text
 * @param {[number, number]} match
 * @param {string} query
 * @param {string} replacement
 * @param {{ caseSensitive?: boolean, regex?: boolean }} [options]
 * @returns {string}
 */
export function replaceOne(text, match, query, replacement, options = {}) {
  const { caseSensitive = false, regex = false } = options;
  const [start, end] = match;
  const next = regex
    ? text.slice(start, end).replace(new RegExp(query, caseSensitive ? "" : "i"), replacement)
    : replacement;
  return text.slice(0, start) + next + text.slice(end);
}
