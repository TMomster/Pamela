// `.mpe` 简写方言的编译。
// Pamela — the `.mpe` shorthand dialect.
// 关键字不可作为赋值目标，解析阶段直接报错。

import { BUILTIN_GLOBALS, BUILTIN_METHODS, BULK_METHODS, englishNameFor } from "./pamela.js";

/** The suffix of a shorthand script. */
export const MPE_SUFFIX = ".mpe";

/** The keyword a shorthand line may open with and still carry a whole call. */
const CUE = "cue";

/**
 * A line that opens with `cue`, either bare or with its time in brackets.
 *
 * `cue` alone is not enough: `cuePoint` is a name like any other, and a line
 * starting with it is an ordinary shorthand call.
 */
const CUE_LINE = new RegExp(`^${CUE}(?=\\s|\\()`);

/**
 * The head of a cue line: the keyword, and its time when it was bracketed.
 *
 * A bracketed time is the full syntax (`cue(3000) { … }`), so it is matched as a
 * whole word — `(3000)` is part of the head rather than the first argument of
 * something called `cue`.
 */
const CUE_HEAD = new RegExp(`^${CUE}(?:\\((?:[^()]|\\([^()]*\\))*\\))?(?=\\s|$)`);

/** Whether a project-relative path names a shorthand script. */
export function isMpePath(path) {
  return String(path ?? "").toLowerCase().endsWith(MPE_SUFFIX);
}

/**
 * Words that open a statement of the full language.
 *
 * A line starting with one of these is handed to the `.pe` parser as it stands:
 * its braces, conditions and quoted labels are the full syntax, and the
 * shorthand has nothing to say about them. `cue` is the one that is also read
 * here — it may open a single statement rather than a block, and a single
 * statement is exactly one line of the dialect (see `compileCue`).
 */
const KEYWORDS = new Set([
  "cue",
  "wait",
  "func",
  "if",
  "else",
  "return",
  "choice",
  "include",
  "use",
  "while",
  "break",
  "continue",
  "for",
  "switch",
  "case",
  "default",
]);

/** One identifier, with the tokeniser's own rule (any Unicode letter to start). */
const NAME = /^[\p{L}_][\p{L}\p{N}_]*$/u;

/** A number a script would write, including the minus of a negative one. */
const NUMBER = /^-?\d+(?:\.\d+)?$/;

/** The literals that are not text even when they are not quoted. */
const LITERALS = new Set(["true", "false", "null"]);

/** The methods a group answers to: everything after them is an object. */
const GROUP_METHODS = new Set(["add", "del"]);

/**
 * Whether a shorthand call names objects rather than values.
 *
 * `Array ch1 ch2` builds a group and `ay1 add ch3` changes one, so an unquoted
 * word in either place is a name — the opposite of a line of dialogue, where
 * everything after the first word is prose. The same rule is what colours the
 * line, so the two cannot disagree.
 */
function readsNames(head, verb) {
  if (englishNameFor(head) === "Array") {
    return true;
  }
  return Boolean(verb) && GROUP_METHODS.has(englishNameFor(verb));
}

/**
 * Compiles a whole `.mpe` file to `.pe`.
 *
 * Line for line: the output has the same number of lines as the input, in the
 * same order, so a line number means the same thing before and after and an
 * error mark lands on the line the author wrote.
 *
 * A statement block — `cue { … } wait 5000`, or an `if` / `func` / loop block —
 * needs no special handling: its opening and closing lines are already full
 * syntax and pass through untouched, while every line between them is compiled
 * as a shorthand statement of its own. The closing `wait` keeps its number,
 * which the `.pe` parser reads as the time the block is held for.
 *
 * @param {string} source
 * @returns {string}
 */
export function transpile(source) {
  const text = String(source ?? "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  return text.split("\n").map(transpileLine).join("\n");
}

/**
 * Compiles one line, answering it unchanged when it is not shorthand.
 *
 * @param {string} line
 * @returns {string}
 */
function transpileLine(line) {
  const trimmedStart = line.trimStart();
  // Blank lines, comment lines and the middle of a block comment: nothing to
  // read, and rewriting them could only break the comment.
  if (!trimmedStart.trim() || isCommentLine(trimmedStart)) {
    return line;
  }

  const indent = line.slice(0, line.length - trimmedStart.length);
  // The trailing note is the author's, not an argument: it is split off before
  // the line is read, so `ch blur 200 // 淡入` does not pass its note to `blur`
  // as a string. A line the shorthand does not rewrite keeps its note where it
  // was written, comment and all.
  const { args: written } = splitTrailingComment(trimmedStart.trimEnd());
  // A trailing semicolon is a separator in the full syntax; the compiled call is
  // one statement per line, so it has nothing left to separate.
  const statement = written.replace(/;$/, "");

  const compiled = compileStatement(indent, statement);
  return compiled === null ? line : compiled;
}

/**
 * The `.pe` a shorthand statement compiles to, or `null` when it is not one.
 *
 * `indent` is written back in front of the call, and `statement` is the line
 * without its comment.
 *
 * @param {string} indent
 * @param {string} statement
 * @returns {string | null}
 */
function compileStatement(indent, statement) {
  // `小帕 = 角色 帕梅拉.png`: an assignment whose right side is a shorthand call
  // compiles that call and keeps the assignment. Without it the one line every
  // script begins with would still need brackets and quotes — and an unquoted
  // name inside brackets is an identifier, not text.
  const assignment = /^([\p{L}_][\p{L}\p{N}_]*)\s*=\s*(\S[\s\S]*)$/u.exec(statement);
  if (assignment) {
    const [, name, value] = assignment;
    const called = firstWord(value);
    if (NAME.test(called) && BUILTIN_GLOBALS.has(englishNameFor(called))) {
      const call = compileCall(called, "", value.slice(called.length).trim(), {
        names: readsNames(called, ""),
      });
      return `${indent}${name} = ${call}`;
    }
    return null;
  }

  // `cue 3000 ch scale 0.5 . move 0 -300`: a cue is the one keyword whose line
  // can carry a whole shorthand statement, since it may open a single one
  // instead of a block. Everything else a keyword starts is full syntax. Read
  // before the head is taken, because `cue(3000)` is one word to `firstWord`.
  if (CUE_LINE.test(statement)) {
    return compileCue(indent, statement);
  }

  const head = firstWord(statement);
  if (!head || !NAME.test(head)) {
    return null;
  }
  // A block opener or a keyword: the rest of the line is full syntax.
  if (KEYWORDS.has(head) || statement.endsWith("{")) {
    return null;
  }

  const rest = statement.slice(head.length).trim();
  if (!rest) {
    return null;
  }

  const verb = firstWord(rest);
  const asMethod = NAME.test(verb) && BUILTIN_METHODS.has(englishNameFor(verb));

  // `dialog say …` — a receiver that shares a name with a constructor is still a
  // receiver, so the method reading wins whenever both could apply.
  if (asMethod && NAME.test(head)) {
    const tail = rest.slice(verb.length).trim();
    // `stage enable ch bg`: the stage is the receiver that speaks for several
    // objects, so its argument list is a list of names rather than prose. A
    // group's `add` / `del` name objects for the same reason.
    const bulk =
      (englishNameFor(head) === "stage" && Object.hasOwn(BULK_METHODS, englishNameFor(verb))) ||
      readsNames(head, verb);
    return `${indent}${compileCall(head, verb, tail, { names: bulk })}`;
  }

  // `背景 房间.png`, `说 你好`: the first word names a call on the stage with
  // the receiver left out — `stage.Background(…)`, `stage.say(…)` — and
  // everything after it is its argument list. Read before the second word is
  // judged, since a constructor's first argument is usually a file name —
  // dots, spaces and all. `Array ch1 ch2` is the exception: its words are
  // objects, so they are read as names.
  if (BUILTIN_GLOBALS.has(englishNameFor(head))) {
    return `${indent}${compileCall(head, "", rest, { names: readsNames(head, "") })}`;
  }

  // `enable ch bg`: a stage-wide call with the stage left out. The word names a
  // method the stage makes on several objects, so the rest of the line is its
  // argument list — `enable(ch, bg)`, which is `stage.enable(ch, bg)`.
  if (rest && Object.hasOwn(BULK_METHODS, englishNameFor(head))) {
    return `${indent}${compileCall(head, "", rest, { names: true })}`;
  }

  // `count = 1`, `count += 1`, `foo(1)`: the second word is not a name, so the
  // line already says what it means.
  if (!NAME.test(verb)) {
    return null;
  }

  // An unknown method name is still a method: the object may be a dictionary a
  // script filled with its own functions. The parser has the last word.
  const tail = rest.slice(verb.length).trim();
  return `${indent}${compileCall(head, verb, tail)}`;
}

/** The run of non-space characters `text` starts with. */
function firstWord(text) {
  const match = /^\S+/.exec(text);
  return match ? match[0] : "";
}

/** Whether a line, already left-trimmed, opens a comment rather than a statement. */
function isCommentLine(trimmedStart) {
  return (
    trimmedStart.startsWith("//") ||
    trimmedStart.startsWith("#") ||
    trimmedStart.startsWith("/*") ||
    trimmedStart.startsWith("*")
  );
}

/**
 * The shorthand call on `line`, with the position of every part of it.
 *
 * `transpile` answers what a line compiles to; this answers *where* it says it:
 * which call it is, where its name starts and ends, where its argument text
 * begins and ends, and what trailer — a comment — a rewrite has to keep. That
 * is what an editor needs to drop an asset onto `背景 教室.png` and replace the
 * one thing the line names, and to draw the box that shows what the drop will
 * hit.
 *
 * The reading rules are the compiler's, in its order: an assignment whose right
 * side starts with a builtin name compiles that name as a call; then
 * `target method`, then a bare builtin, then a stage-wide call with the stage
 * left out (`enable ch bg`), then anything else with a name in the second place
 * is still a method. A line of the full syntax — a keyword, a brace, a comment,
 * a plain assignment — answers `null`, since the shorthand does not rewrite it
 * and neither should an editor helper.
 *
 * A line may go on with `. method …`; `args` is still the whole run under the
 * call, while `firstArgsEnd` marks where its first call stops, which is the part
 * a drop onto the line replaces.
 *
 * @param {string} line
 * @returns {{ indent: string, assignee: string, head: string, verb: string,
 *   name: string, nameStart: number, nameEnd: number, args: string,
 *   argsStart: number, argsEnd: number, firstArgsEnd: number, names: boolean,
 *   comment: string } | null}
 */
export function shorthandCallIn(line) {
  const text = String(line ?? "");
  const trimmedStart = text.trimStart();
  if (!trimmedStart.trim() || isCommentLine(trimmedStart)) {
    return null;
  }
  const indent = text.slice(0, text.length - trimmedStart.length);
  // Only the end is trimmed, so every offset below is still an offset into
  // `line`. The trailing `;` is a separator the compiled call no longer needs.
  const trimmed = trimmedStart.trimEnd().replace(/;$/, "");
  const base = indent.length;
  const statementEnd = base + trimmed.length;

  // `小帕 = 角色 帕梅拉.png`: the call stands on the right of the equals sign.
  let assignee = "";
  let body = trimmed;
  let bodyStart = base;
  const assignment = /^([\p{L}_][\p{L}\p{N}_]*)\s*=\s*(\S[\s\S]*)$/u.exec(trimmed);
  if (assignment) {
    const called = firstWord(assignment[2]);
    if (!NAME.test(called) || !BUILTIN_GLOBALS.has(englishNameFor(called))) {
      return null;
    }
    assignee = assignment[1];
    body = assignment[2];
    bodyStart = base + trimmed.length - body.length;
  }

  const head = firstWord(body);
  if (!head || !NAME.test(head)) {
    return null;
  }
  if (KEYWORDS.has(head) || body.trimEnd().endsWith("{")) {
    return null;
  }
  const afterHead = body.slice(head.length);
  const rest = afterHead.trim();

  const verb = rest ? firstWord(rest) : "";
  const verbStart = bodyStart + head.length + (afterHead.length - afterHead.trimStart().length);
  const asMethod = Boolean(rest) && NAME.test(verb) && BUILTIN_METHODS.has(englishNameFor(verb));
  const asGlobal = BUILTIN_GLOBALS.has(englishNameFor(head));
  const asBulk = Boolean(rest) && Object.hasOwn(BULK_METHODS, englishNameFor(head));
  // Which reading the compiler takes, in its order: a known method wins over a
  // name that is also a constructor; a bare builtin is a call with no receiver;
  // a stage-wide method with the stage left out is a call whose every argument
  // is an object; and an unknown method is still a method — the parser has the
  // last word.
  //
  // `背景` on its own is a builtin call whose name has not been written yet, and
  // it is exactly the line a drop is aimed at; a bare receiver with no method is
  // not a call, so `小帕` answers null.
  let method = false;
  if (!rest) {
    if (!asGlobal) {
      return null;
    }
  } else if (!assignee && asMethod) {
    method = true;
  } else if (!assignee && !asGlobal && asBulk) {
    // `enable ch bg` → `enable(ch, bg)`, i.e. `stage.enable(ch, bg)`. The head
    // is the whole call: `ch` is the first target, not the method of `enable`.
    // A numeric first argument (`scale 2.0 300`) is a bulk call too, so this
    // branch has to come before the `NAME.test(verb)` check below.
    method = false;
  } else if (!assignee && !asGlobal) {
    if (!NAME.test(verb)) {
      return null;
    }
    method = true;
  }

  const nameStart = bodyStart;
  const nameEnd = method ? verbStart + verb.length : bodyStart + head.length;
  let argsStart = nameEnd;
  while (argsStart < text.length && /\s/.test(text[argsStart])) {
    argsStart += 1;
  }
  argsStart = Math.min(argsStart, statementEnd);

  const { args, comment } = splitTrailingComment(text.slice(argsStart, statementEnd));
  // Whether the arguments name objects rather than values — the compiler's own
  // reading, so a colour and a compiled line can never disagree. A call read
  // without a verb is a builtin call (`Array ch1 ch2`) or a stage-wide call
  // with the stage left out (`enable ch bg`); an assignment with a builtin on
  // the right is a builtin call too.
  const names =
    (method
      ? englishNameFor(head) === "stage" && Object.hasOwn(BULK_METHODS, englishNameFor(verb))
      : !assignee && Object.hasOwn(BULK_METHODS, englishNameFor(head))) ||
    readsNames(head, method ? verb : "");
  // Where the arguments of the *first* call end. A chained line goes on with
  // `. move 0 -300`, and that belongs to the call rather than to its first
  // argument: a drop onto `背景 教室.png . 模糊 200` names the file, and the
  // chain the author wrote stays where it is — spaces and all.
  const chain = nextChainStart(args, 0);
  return {
    indent,
    assignee,
    head,
    verb: method ? verb : "",
    name: method ? `${head} ${verb}` : head,
    nameStart,
    nameEnd,
    args,
    argsStart,
    argsEnd: argsStart + args.length,
    firstArgsEnd: argsStart + (chain < 0 ? args.length : trimEndAt(args, chain)),
    names,
    comment,
  };
}

/**
 * Where the head of a shorthand `cue` line ends, and where the statement it
 * starts begins.
 *
 * The head is the keyword and its time — `cue 3000`, written by the compiler as
 * `cue(3000)` — and everything after it is a statement of the dialect, which is
 * exactly how the line is compiled and so exactly how an editor should colour
 * it. A line the compiler does not rewrite answers `null`.
 *
 * @param {string} line
 * @returns {{ headEnd: number, time: string } | null}
 */
export function cueStatementIn(line) {
  const text = String(line ?? "");
  const trimmedStart = text.trimStart();
  if (!trimmedStart.trim() || isCommentLine(trimmedStart)) {
    return null;
  }
  const indent = text.length - trimmedStart.length;
  const trimmed = trimmedStart.trimEnd().replace(/;$/, "");
  const cue = splitCue(trimmed);
  if (!cue) {
    return null;
  }
  return { headEnd: indent + cue.bodyStart, time: cue.head.slice(CUE.length) };
}

/**
 * Splits an argument list into its arguments and the comment that trails them.
 *
 * A comment starts at `//` or `/*` that follows a space, as it does everywhere
 * else in the dialect — but not inside a quoted argument or a `{ … }`
 * expression, where the two characters are the author's text. Splitting rather
 * than discarding is what lets a rewrite keep the note the writer left.
 *
 * @param {string} text
 * @returns {{ args: string, comment: string }}
 */
function splitTrailingComment(text) {
  let quote = "";
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === "\\") {
        index += 1;
      } else if (char === quote) {
        quote = "";
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "“" || char === "‘") {
      quote = char === "“" ? "”" : char === "‘" ? "’" : char;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    const opens = char === "/" && (text[index + 1] === "/" || text[index + 1] === "*");
    if (opens && depth === 0 && index > 0 && /\s/.test(text[index - 1])) {
      return { args: text.slice(0, index).trimEnd(), comment: text.slice(index).trim() };
    }
  }
  return { args: text.trimEnd(), comment: "" };
}

/**
 * The arguments of one statement, as spans of `text`.
 *
 * Read left to right: a number, a literal or a bracketed expression is one
 * argument each. The first run of characters that is none of those starts the
 * free text, which takes the rest of the line — so `说 你好，世界` keeps its
 * comma, and a line of dialogue needs no quoting.
 *
 * The spans are what both the compiler and the highlighter need, and they are
 * asked the same question here so the colour is consistent with the run:
 * `compileArgs` turns each span into a `.pe` expression, and
 * `highlightMpe` colours each span by the kind it already has.
 *
 * A dot on its own ends the call it follows and begins the next one, and is
 * read as two spans: `chain` for the dot and `method` for the name after it —
 * `ch scale 2.0 . move 0 -300` is one call, a dot, and another call.
 *
 * `kind` is one of `number`, `literal`, `string`, `expression`, `text`, `chain`,
 * `method`, and `raw` for the tail of a `{` or a quote that was never closed —
 * which the compiler passes through as written rather than repairing.
 *
 * @param {string} text
 * @returns {{ start: number, end: number, kind: string }[]}
 */
export function scanArguments(text, { names = false } = {}) {
  const source = String(text ?? "");
  const spans = [];
  let index = 0;
  // After a `:` the arguments are object names rather than values: `stage scale
  // 2.0 : ch bg` names two objects to scale, and the rest of the line is not a
  // line of dialogue.
  let inObjects = false;

  while (index < source.length) {
    while (index < source.length && /\s/.test(source[index])) {
      index += 1;
    }
    if (index >= source.length) {
      break;
    }

    // `. move 0 -300`: the dot ends the call before it. Only a method name may
    // follow, which is what keeps the full stop in `说 你好 . 世界` inside the
    // line of dialogue — `世界` is not a call, so the dot is just a dot.
    const method = chainMethodAt(source, index);
    if (method) {
      spans.push({ start: index, end: index + 1, kind: "chain" });
      spans.push({ start: method.start, end: method.end, kind: "method" });
      index = method.end;
      continue;
    }

    // The colon ends the fixed arguments. It only means that in a stage-wide
    // call — the one place the arguments are names — and only where an argument
    // starts, so a line of dialogue that begins with one (`说 : 他说`) stays
    // text and a colon inside it (`说 你好：世界`) was never looked at.
    if (names && !inObjects && source[index] === ":") {
      spans.push({ start: index, end: index + 1, kind: "colon" });
      inObjects = true;
      index += 1;
      continue;
    }

    // A comma separates objects too: `: ch, bg` reads as `: ch bg`.
    if (inObjects && source[index] === ",") {
      index += 1;
      continue;
    }

    if (inObjects) {
      const value = scanObjectName(source, index);
      spans.push(value);
      if (value.kind === "raw") {
        break;
      }
      index = value.end;
      continue;
    }

    // `x=300`, `横 = -300`: a parameter named as it is given. It is one
    // argument, and what follows the `=` is read by the same rules as any other
    // value — so `说 台词=你好，世界` keeps its comma and `倍率={n * 2}` can
    // compute the value.
    const named = namedArgumentAt(source, index);
    if (named) {
      const value = scanValue(source, named.valueStart, names);
      spans.push({
        start: index,
        end: value.end,
        kind: "named",
        name: named.name,
        valueStart: value.start,
        valueKind: value.kind,
      });
      // Free text ends the line unless a `名字=值` follows it, in which case the
      // text was one argument and the name is the next.
      if (value.kind === "raw" || (value.kind === "text" && value.end >= source.length)) {
        break;
      }
      index = value.end;
      continue;
    }

    const value = scanValue(source, index, names);
    spans.push(value);
    if (value.kind === "raw" || (value.kind === "text" && value.end >= source.length)) {
      break;
    }
    index = value.end;
  }

  return spans;
}

/**
 * The `名字=` opening a named argument at `start`, or null.
 *
 * The `=` must stand alone: `==` is a comparison the author may have put inside
 * an expression, and a name is required before it, so `x==1` is not a name.
 *
 * @param {string} source
 * @param {number} start
 * @returns {{ name: string, valueStart: number } | null}
 */
function namedArgumentAt(source, start) {
  const match = /^([\p{L}_][\p{L}\p{N}_]*)\s*=/u.exec(source.slice(start));
  if (!match) {
    return null;
  }
  const after = start + match[0].length;
  if (source[after] === "=") {
    return null;
  }
  return { name: match[1], valueStart: after };
}

/**
 * One value at `start`: a `{ … }` expression, a quoted string, a number, a
 * literal, or free text running to the end of the line.
 *
 * @param {string} source
 * @param {number} start Offset of the first character, already left-trimmed.
 * @param {boolean} [names] Read a bare word as an object name, not as text.
 * @returns {{ start: number, end: number, kind: string }}
 */
function scanValue(source, start, names = false) {
  let index = start;
  while (index < source.length && /\s/.test(source[index])) {
    index += 1;
  }
  if (index >= source.length) {
    return { start, end: source.length, kind: "raw" };
  }

  const char = source[index];

  // `{ … }` hands an expression through, so a variable — or anything
  // computed — can be passed without quoting it as text.
  if (char === "{") {
    const end = matchingBrace(source, index);
    if (end < 0) {
      return { start: index, end: source.length, kind: "raw" };
    }
    return { start: index, end: end + 1, kind: "expression" };
  }

  if (char === '"' || char === "'" || char === "“" || char === "‘") {
    const end = matchingQuote(source, index);
    if (end < 0) {
      return { start: index, end: source.length, kind: "raw" };
    }
    return { start: index, end: end + 1, kind: "string" };
  }

  let end = index;
  while (end < source.length && !/[\s{}]/.test(source[end])) {
    end += 1;
  }
  const word = source.slice(index, end);
  if (NUMBER.test(word)) {
    return { start: index, end, kind: "number" };
  }
  if (LITERALS.has(word)) {
    return { start: index, end, kind: "literal" };
  }

  // A stage-wide call names objects, never a line of dialogue: `enable ch bg`
  // is two targets, so the word ends at the whitespace instead of taking the
  // rest of the line.
  if (names) {
    return scanObjectName(source, index);
  }

  // Anything else begins the text, and the text is the rest of the line — up to
  // the first `名字=值` word, which starts another argument rather than being
  // part of the line: `角色 ch.png 横=300`. A writer who wants that word in the
  // text itself quotes it, and then it is never read as a name.
  const named = /\s+(?=[\p{L}_][\p{L}\p{N}_]*\s*=(?!=))/u.exec(source.slice(index));
  let textEnd = named ? index + named.index : source.length;
  // A chain dot ends the text too: `背景 教室.png . 模糊 200` names one file and
  // then calls a method on it. `说 你好 . 世界` keeps its full stop, since the
  // word after it is not a call the dialect knows.
  const chain = nextChainStart(source, index);
  if (chain >= 0 && chain < textEnd) {
    textEnd = trimEndAt(source, chain);
  }
  return { start: index, end: textEnd, kind: "text" };
}

/** `index`, with the whitespace before it stepped back over. */
function trimEndAt(source, index) {
  let end = index;
  while (end > 0 && /\s/.test(source[end - 1])) {
    end -= 1;
  }
  return end;
}

/**
 * The chain dot at `index`, with the method name that follows it.
 *
 * A dot is one only when it stands alone — `2.0` and `ch1.png` are words, not a
 * dot and a call — and when the word after it is a method of the dialect. That
 * second rule is what an editor needs to colour the dot before it knows whether
 * a call follows, and what keeps prose intact: a full stop in a line of
 * dialogue is text unless a call is written after it.
 *
 * @param {string} source
 * @param {number} index
 * @returns {{ start: number, end: number, name: string } | null}
 */
function chainMethodAt(source, index) {
  if (source[index] !== ".") {
    return null;
  }
  // Alone: a space on each side, or the end of the line.
  if (index > 0 && !/\s/.test(source[index - 1])) {
    return null;
  }
  const following = /^[ \t]+([\p{L}_][\p{L}\p{N}_]*)/u.exec(source.slice(index + 1));
  if (!following) {
    return null;
  }
  const name = following[1];
  if (!BUILTIN_METHODS.has(englishNameFor(name))) {
    return null;
  }
  // The match began one character after the dot, so the name sits at its end.
  const start = index + 1 + following[0].length - name.length;
  return { start, end: start + name.length, name };
}

/** Where the next chain dot at or after `from` is, or `-1` for none. */
function nextChainStart(source, from) {
  for (let at = from; at < source.length; at += 1) {
    if (source[at] === "." && chainMethodAt(source, at)) {
      return at;
    }
  }
  return -1;
}

/**
 * One object name after a `:`.
 *
 * Words here are identifiers, not free text: `ch bg` is two objects, so the scan
 * stops at the whitespace instead of taking the line. `{ … }` still passes an
 * expression through, and a quoted name is taken as written.
 *
 * @param {string} source
 * @param {number} start Offset of the first character, already left-trimmed.
 * @returns {{ start: number, end: number, kind: string }}
 */
function scanObjectName(source, start) {
  const char = source[start];
  if (char === "{") {
    const end = matchingBrace(source, start);
    if (end < 0) {
      return { start, end: source.length, kind: "raw" };
    }
    return { start, end: end + 1, kind: "expression" };
  }
  if (char === '"' || char === "'" || char === "“" || char === "‘") {
    const end = matchingQuote(source, start);
    if (end < 0) {
      return { start, end: source.length, kind: "raw" };
    }
    return { start, end: end + 1, kind: "string" };
  }
  let end = start;
  while (end < source.length && !/[\s,]/.test(source[end])) {
    end += 1;
  }
  if (end === start) {
    return { start, end: start + 1, kind: "raw" };
  }
  return { start, end, kind: "name" };
}

/**
 * A `cue` line and the one statement it starts, as `.pe` text.
 *
 * `cue 3000 ch scale 0.5 . move 0 -300` is
 * `cue(3000) ch.scale(0.5).move(0, -300)`: the keyword and its time are the full
 * syntax, and everything after them is one shorthand statement — the compiler
 * reads it with the same rules as a line of its own, so a chain, a named
 * argument or a piece of dialogue all work there unchanged.
 *
 * A trailing `wait` belongs to the cue rather than to the call before it
 * (`cue 3000 ch hide wait`), so it is taken off before the statement is read
 * and written back after it.
 *
 * @param {string} indent
 * @param {string} statement A line that begins with `cue`.
 * @returns {string | null} `null` when the line is the full syntax — a block —
 *   or when what follows the keyword is not a shorthand call.
 */
function compileCue(indent, statement) {
  const cue = splitCue(statement);
  if (!cue) {
    return null;
  }
  let body = cue.body;
  let waited = false;
  const trailing = /\s+wait$/.exec(body);
  if (trailing) {
    body = body.slice(0, trailing.index);
    waited = true;
  }
  const compiled = body.trim() ? compileStatement("", body) : null;
  if (compiled === null) {
    return null;
  }
  return `${indent}${cue.head} ${compiled}${waited ? " wait" : ""}`;
}

/**
 * The head of a `cue` line — the keyword and its time — and the statement after it.
 *
 * The time may be written in parentheses (`cue(3000)`) or straight after the
 * keyword (`cue 3000`); both answer `cue(3000)`, so the compiled line always
 * says the same thing. A line that opens a block (`cue {`, `cue 3000 {`) is not
 * split: its braces, conditions and quoted labels are the full syntax.
 *
 * @param {string} statement A line, already without its indent or comment.
 * @returns {{ head: string, body: string, bodyStart: number } | null}
 *   `head` is the `.pe` head, `body` the statement after it, and `bodyStart`
 *   where that statement begins as an offset into `statement`.
 */
function splitCue(statement) {
  const opener = CUE_HEAD.exec(statement);
  if (!opener) {
    return null;
  }
  let rest = statement.slice(opener[0].length).trimStart();
  if (!rest) {
    return null;
  }
  // A block opener is the full syntax, as it is for every other keyword.
  if (rest.trimEnd().endsWith("{")) {
    return null;
  }

  // `cue(3000)` already carries its time; `cue 3000` is rewritten to match, so
  // the compiled line always spells it the same way.
  let written = opener[0].slice(CUE.length);
  if (!written) {
    const number = /^-?\d+(?:\.\d+)?(?=\s|$)/.exec(rest);
    if (number) {
      written = `(${number[0]})`;
      rest = rest.slice(number[0].length).trimStart();
    }
  }
  const bodyStart = statement.length - rest.length;
  return { head: `${CUE}${written}`, body: rest, bodyStart };
}

/**
 * One call, and the calls chained onto it, as `.pe` text.
 *
 * `ch scale 2.0 . move 0 -300` is `ch.scale(2.0).move(0, -300)`: the dot ends
 * the call before it, so what follows is another call made on its answer —
 * which is why every stage method answers the object it was made on.
 *
 * `verb` is empty for a call spelled by its head alone (`背景 教室.png`,
 * `enable ch bg`), and `names` is the reading of the line, applied to every
 * call in it: a stage-wide line names objects all the way down.
 *
 * @param {string} head The receiver, or the builtin being called.
 * @param {string} verb The method, or empty when the head is the call.
 * @param {string} text The argument text, chain and all.
 * @param {{ names?: boolean }} [options]
 * @returns {string} A `.pe` expression.
 */
function compileCall(head, verb, text, { names = false } = {}) {
  const [first, ...chained] = splitChain(text);
  const called = verb ? `${head}.${verb}` : head;
  let out = `${called}(${compileArgList(first.args, { names })})`;
  for (const call of chained) {
    out += `.${call.method}(${compileArgList(call.args, { names })})`;
  }
  return out;
}

/**
 * The calls an argument text is made of, split at its chain dots.
 *
 * The first entry is the call the head and verb already name, so its `method`
 * is empty; every later one carries the method its dot introduced.
 *
 * @param {string} text
 * @returns {{ method: string, args: string }[]}
 */
function splitChain(text) {
  const source = String(text ?? "");
  const calls = [{ method: "", args: "", from: 0 }];
  for (const span of scanArguments(source)) {
    const current = calls[calls.length - 1];
    if (span.kind === "chain") {
      current.args = source.slice(current.from, span.start);
      calls.push({ method: "", args: "", from: span.end });
      continue;
    }
    if (span.kind === "method") {
      current.method = source.slice(span.start, span.end);
      current.from = span.end;
    }
  }
  const last = calls[calls.length - 1];
  last.args = source.slice(last.from);
  return calls.map(({ method, args }) => ({ method, args }));
}

/**
 * Compiles the argument list of one statement, seam and all.
 *
 * The colon is written back with a space on each side and joins what follows
 * without a comma — `2.0 : ch, bg` — which is how the `.pe` side reads a stage
 * call that skips its middle parameters.
 *
 * @param {string} text
 * @returns {string} A `.pe` argument list.
 */
function compileArgList(text, { names = false } = {}) {
  const source = String(text ?? "");
  let out = "";
  for (const span of scanArguments(source, { names })) {
    if (span.kind === "colon") {
      out += out ? " : " : ": ";
      continue;
    }
    const value =
      span.kind === "named"
        ? `${span.name} = ${compileValue(source.slice(span.valueStart, span.end), span.valueKind)}`
        : compileValue(source.slice(span.start, span.end), span.kind);
    out += out && !out.endsWith(" ") ? `, ${value}` : value;
  }
  return out;
}

/** One value span as a `.pe` expression. */
function compileValue(raw, kind) {
  if (kind === "expression") {
    return raw.slice(1, -1).trim();
  }
  if (kind === "text") {
    return textLiteral(raw);
  }
  return raw;
}

/**
 * Wraps free text in a string literal, dropping a trailing comment first.
 *
 * `//` and `/*` after a space start a comment, as they do everywhere else in the
 * dialect; a dialogue line that genuinely contains them is written in quotes,
 * where nothing is inspected.
 */
function textLiteral(raw) {
  let text = raw;
  const commentAt = text.search(/\s\/[/*]/);
  if (commentAt >= 0) {
    text = text.slice(0, commentAt);
  }
  text = text.trimEnd();
  // Only the backslash and the double quote need escaping: a brace is left
  // alone on purpose, so `你的血量是 {hp}` still interpolates.
  const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/** The index of the `}` matching the `{` at `start`, or -1. */
function matchingBrace(source, start) {
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"' || char === "'" || char === "“" || char === "‘") {
      const end = matchingQuote(source, index);
      if (end < 0) {
        return -1;
      }
      index = end;
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

/** The index just past the quote opened at `start`, or -1. */
function matchingQuote(source, start) {
  const open = source[start];
  const close = open === "“" ? "”" : open === "‘" ? "’" : open;
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === close) {
      return index;
    }
  }
  return -1;
}
