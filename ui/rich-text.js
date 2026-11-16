// 台词的行内颜色：`{红}…{/红}`、`{#000000}…{/}`。
// Pamela — the colour marks a dialogue line may carry.
//
// 标记只影响显示：`richTextRuns` 把一行拆成若干段「文字 + 颜色」，对话框按段
// 写成 span，导出成片按同样分段画到画布上。没有标记的行原样返回一段，
// 字数、排版与旧版逐字一致。

/**
 * 可以用 `{名字}` 写的 CSS 颜色关键字（按小写比较）。
 *
 * 只收录常见的那些：认不出来的一律当普通文字，宁可显示一行带花括号的字，
 * 也不要把作者写错的标记悄悄吞掉。
 */
const CSS_COLORS = new Set([
  "black", "silver", "gray", "grey", "white", "maroon", "red", "purple",
  "fuchsia", "magenta", "green", "lime", "olive", "yellow", "navy", "blue",
  "teal", "aqua", "cyan", "orange", "gold", "pink", "brown", "beige",
  "coral", "crimson", "indigo", "violet", "plum", "orchid", "khaki",
  "lavender", "salmon", "tan", "turquoise", "wheat", "azure", "ivory",
  "snow", "tomato", "chocolate", "skyblue", "royalblue",
  "deepskyblue", "dodgerblue", "steelblue", "seagreen", "forestgreen",
  "yellowgreen", "lightgreen", "darkgreen", "darkred", "darkblue",
  "darkgray", "darkgrey", "lightgray", "lightgrey", "whitesmoke",
  "gainsboro", "lightyellow", "lightblue", "lightpink", "hotpink",
  "deeppink", "orangered", "darkorange",
]);

/** 中文色名 → CSS 颜色。`红色` 这样的写法也认（见 `colorOf`）。 */
const CHINESE_COLORS = new Map([
  ["红", "red"],
  ["橙", "orange"],
  ["黄", "yellow"],
  ["绿", "green"],
  ["青", "teal"],
  ["蓝", "blue"],
  ["紫", "purple"],
  ["粉", "pink"],
  ["黑", "black"],
  ["白", "white"],
  ["灰", "gray"],
  ["金", "gold"],
  ["银", "silver"],
  ["棕", "brown"],
  ["褐", "brown"],
]);

/** `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa`。 */
const HEX = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** `rgb(…)` / `hsl(…)` 之类：括号里不嵌套，颜色交给浏览器自己解析。 */
const FUNCTIONAL = /^(?:rgb|rgba|hsl|hsla)\([^()]*\)$/i;

/**
 * 一个颜色写法 → 可以直接写给 CSS 的颜色文本；认不出来时是 null。
 *
 * @param {unknown} spec `{…}` 里的内容。
 * @returns {string | null}
 */
export function colorOf(spec) {
  const name = String(spec ?? "").trim();
  if (!name) {
    return null;
  }
  if (HEX.test(name) || FUNCTIONAL.test(name)) {
    return name;
  }
  // `红色` 与 `红` 一样：多写一个「色」字不该让整行变成普通文字。
  const chinese = CHINESE_COLORS.get(name) ?? CHINESE_COLORS.get(name.replace(/色$/, ""));
  if (chinese) {
    return chinese;
  }
  const lower = name.toLowerCase();
  return CSS_COLORS.has(lower) ? lower : null;
}

/**
 * `{…}` 里的内容是不是一个颜色标记（开始或结束）。
 *
 * 结束标记是 `/` 加可选色名：`{/}`、`{/red}`、`{/红}` 都算。
 *
 * @param {unknown} body 花括号里的原文。
 * @returns {boolean}
 */
export function isColorMark(body) {
  const spec = String(body ?? "").trim();
  if (!spec) {
    return false;
  }
  if (spec === "/") {
    return true;
  }
  return spec.startsWith("/")
    ? colorOf(spec.slice(1)) !== null
    : colorOf(spec) !== null;
}

/** 标记的解析结果：结束标记，或一个开始标记的颜色。 */
function markOf(body) {
  const spec = String(body ?? "").trim();
  if (spec === "/") {
    return { close: true };
  }
  if (spec.startsWith("/")) {
    return colorOf(spec.slice(1)) ? { close: true } : null;
  }
  const color = colorOf(spec);
  return color ? { close: false, color } : null;
}

/**
 * 把一行台词拆成若干段「文字 + 颜色」。
 *
 * 颜色可以嵌套，结束标记回到外层颜色；没闭合的标记一直生效到行尾——作者少写
 * 一个 `{/}` 时宁可后半行也是那个颜色，也不要报错拦住整句。不认识的 `{…}`
 * 原样留在文字里（它不是标记，就是作者想要的字）。
 *
 * @param {unknown} line 台词原文。
 * @returns {{ text: string, color: string | null }[]} 段列表；空行也有一段空的。
 */
export function richTextRuns(line) {
  const source = String(line ?? "");
  const runs = [];
  const stack = [];
  let color = null;
  let buffer = "";

  const flush = () => {
    if (buffer) {
      runs.push({ text: buffer, color });
      buffer = "";
    }
  };

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") {
      const end = source.indexOf("}", index + 1);
      if (end > index) {
        const mark = markOf(source.slice(index + 1, end));
        if (mark) {
          flush();
          if (mark.close) {
            stack.pop();
          } else {
            stack.push(mark.color);
          }
          color = stack.length ? stack[stack.length - 1] : null;
          index = end;
          continue;
        }
      }
    }
    buffer += char;
  }
  flush();
  if (runs.length === 0) {
    runs.push({ text: "", color: null });
  }
  return runs;
}

/**
 * 一行台词的可见文字：颜色标记被去掉，其余原样。
 *
 * @param {unknown} line 台词原文。
 * @returns {string}
 */
export function stripRichText(line) {
  return richTextRuns(line)
    .map((run) => run.text)
    .join("");
}

/**
 * 一行台词的字数（只数看得见的字）。
 *
 * 逐字显示的节奏、按字数计的停留时长都按这个数算：标记不该占用打字时间。
 *
 * @param {unknown} line 台词原文。
 * @returns {number}
 */
export function richTextLength(line) {
  return [...stripRichText(line)].length;
}
