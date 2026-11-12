// 剧本语言：词法分析、语法分析与解释器。
// Pamela — the script language: tokeniser, parser and interpreter.
// 标识符支持任意 Unicode 字母；数值保留完整精度，不隐式舍入。
/**
 * Characters that form a single token on their own.
 *
 * The first subset needed only `= ( ) . , ; { }`. Operators added the rest,
 * and `-` is one of them now: a leading minus is a unary operator applied to
 * the number beside it, never part of the number.
 */

const PUNCTUATION = new Set([
  "=", "(", ")", ".", ",", ";", "[", "]", "{", "}",
  "+", "-", "*", "/", "%", "<", ">", "!", ":",
]);

/**
 * Operators spelled with two characters.
 *
 * Matched before the single-character set, so `==` is one equality operator
 * rather than two assignments and `<=` is a comparison rather than `<` then
 * `=`. Both are read longest-first, so a longer operator added later needs
 * no reordering of the ones already here.
 *
 * The compound assignments are here for the same reason: `+=` has to be read
 * as one token, or `x += 1` would be an assignment of `+ 1` to `x`.
 */
const OPERATORS = ["==", "!=", "<=", ">=", "&&", "||", "??", "+=", "-=", "*=", "/=", "%="];

/**
 * The compound assignments, by the operator they apply before storing.
 *
 * `x += 1` is `x = x + 1` and nothing else: the right side is read once, the
 * operator follows the same type rules as it does anywhere else, and the
 * result is bound back to the same name.
 */
const COMPOUND = new Map([
  ["+=", "+"],
  ["-=", "-"],
  ["*=", "*"],
  ["/=", "/"],
  ["%=", "%"],
]);

/**
 * Chinese punctuation read as the ASCII mark it stands for.
 *
 * A writer typing a line in Chinese has a Chinese keyboard in front of them, and
 * `小帕.缩放（2.0，3000）` is what that keyboard produces. Refusing the comma and
 * the brackets would make every call a trip through the input-method switch, so
 * the tokeniser folds these five to their ASCII equivalents *before* it decides
 * what a character is. The folding happens at the token level, which is what
 * keeps it out of string contents: `说 “你好，世界”` keeps its full-width comma
 * because it is inside a literal by then.
 *
 * The two quote pairs are not in this table — a quote opens a string rather than
 * standing for punctuation — and are handled beside the ASCII quotes below.
 */
const PUNCTUATION_ALIASES = new Map([
  ["，", ","],
  ["（", "("],
  ["）", ")"],
  ["；", ";"],
  ["：", ":"],
]);

/**
 * The closing mark for each Chinese quote that opens a string.
 *
 * `“…”` and `‘…’` are directional: the opening mark and the closing mark are
 * different characters, unlike `"` which is both. A string opened by one of
 * these closes on its own partner, so Chinese quotes nested inside an ASCII
 * string stay text.
 */
const QUOTE_CLOSERS = new Map([
  ["“", "”"],
  ["‘", "’"],
]);

/** Identifier rules: any Unicode letter, plus digits and `_` after the first. */
const IDENT_START = /[\p{L}_]/u;
const IDENT_PART = /[\p{L}\p{N}_]/u;

/** Hoisted so the character loop does not build a regex per character. */
const DIGIT = /[0-9]/;

/** Property names that are never reachable from a script. */
const FORBIDDEN_PROPERTIES = new Set(["__proto__", "prototype", "constructor"]);

/**
 * The two words a `cue` block is written with.
 *
 * `cue` opens it and `wait` closes it. They were the language's first
 * keywords, so neither is usable as a variable name.
 */
const CUE = "cue";
const WAIT = "wait";

/** Opens a function declaration: `func name(a, b) { ... }`. */
const FUNC = "func";

/** Opens a conditional statement: `if condition { ... }`. */
const IF = "if";

/** Introduces the branch an `if` did not take. */
const ELSE = "else";

/** Leaves a function, with a value. */
const RETURN = "return";

/** Opens a question, with a block after each answer. */
const CHOICE = "choice";

/** Plays another script file where the statement stands. */
const INCLUDE = "include";

/** Switches the dialogue style the rest of the run performs in. */
const USE = "use";

/** Opens a loop: `while condition { ... }`. */
const WHILE = "while";

/** Leaves the loop it sits in. */
const BREAK = "break";

/** Skips to the next turn round the loop it sits in. */
const CONTINUE = "continue";

/** Opens a loop over a collection: `for name in list { ... }`. */
const FOR = "for";

/** Opens a multi-branch statement: `switch value { case v { ... } default { ... } }`. */
const SWITCH = "switch";

/** Introduces one arm of a `switch`. */
const CASE = "case";

/** The arm a `switch` falls back to when no case matches. */
const DEFAULT = "default";

/** The word between the loop variable and its collection in `for`. */
const IN = "in";

/** Word form of the logical-and operator. */
const AND = "and";

/** Word form of the logical-or operator. */
const OR = "or";

/** Word form of the logical-not operator. */
const NOT = "not";

/** The two boolean literals. */
const TRUE = "true";
const FALSE = "false";

/** The one empty value. */
const NULL = "null";

/**
 * Every word the language reserves.
 *
 * A keyword may not name a variable, a parameter or a function: a script that
 * bound one would be writing a name no line could read back, because the
 * statement parser reads the keyword first. `true` / `false` / `null` are
 * literals rather than names, so they are reserved for the same reason.
 */
export const KEYWORDS = new Set([
  CUE,
  WAIT,
  FUNC,
  IF,
  ELSE,
  RETURN,
  CHOICE,
  INCLUDE,
  USE,
  WHILE,
  BREAK,
  CONTINUE,
  FOR,
  SWITCH,
  CASE,
  DEFAULT,
  TRUE,
  FALSE,
  NULL,
]);

/**
 * The mark a function a script declared carries.
 *
 * A host method is a JavaScript function too — `stage.Character("x")` — and
 * the two are called differently: a host method is handed one value per
 * parameter, while a script function is run from its own statements with its
 * parameters bound. The mark is what tells a call site which of the two it is
 * holding. A symbol is used so the field stays out of a script's reach:
 * member access only ever names a string.
 */
const SCRIPT_FUNCTION = Symbol("pamela.function");

/**
 * Marks a value that is a Pamela list (`[a, b, c]`). A host object is a plain
 * JavaScript object too, so the mark is the only way to tell a list — which
 * indexes and slices — apart from a stage object a script built.
 */
const LIST = Symbol("pamela.list");

/**
 * Marks a value that is a Pamela dictionary (`{"hp": 3}`). Its entries live in a
 * `Map` so any value may serve as a key; the mark keeps it distinct from a host
 * object.
 */
const DICT = Symbol("pamela.dict");

/**
 * Marks a value that is a Pamela group — what `Array(ch, bg)` builds.
 *
 * A group is a *set* rather than a list: it stands for the objects in it, so a
 * batch call names it once instead of repeating every member at every call. A
 * `Set` is what makes that cheap: `add` / `del` are one hash lookup, and a batch
 * call walks the members by the set's own iterator — no indexing, no copying,
 * no scan for a duplicate that is already there.
 *
 * Insertion order is kept on purpose: it is the order the same call written out
 * by hand would have run in, so a group cannot change what a scene does.
 */
const ARRAY = Symbol("pamela.array");

/**
 * The methods a group answers to.
 *
 * Shared by every group as its prototype, so a scene that builds a dozen groups
 * pays for a dozen sets and no functions. `this` is the group itself, which is
 * what lets `add` / `del` answer the group back and chain.
 */
const ARRAY_METHODS = {
  /** `group.add(a, b)`: adds objects; one already in the group stays once. */
  add(...objects) {
    addToGroup(this, objects, "add");
    return this;
  },
  /** `group.del(a, b)`: removes objects; one not in the group is not an error. */
  del(...objects) {
    removeFromGroup(this, objects, "del");
    return this;
  },
  /**
   * `group.remove(a, 1)`: removes members by object or by 0-based position.
   *
   * A number is a position in the group's own order, which is the same order a
   * `for` walks; any other value is the object itself, and removing one that is
   * not there is not an error — the same deal `del` makes.
   */
  remove(...values) {
    removeFromGroupAt(this, values, "remove");
    return this;
  },
  /**
   * `group.update(old, next)`: replaces one member and keeps its position.
   *
   * `old` is a position or the member itself; the group's order does not change,
   * so a scene that walks the group finds the new object where the old one was.
   */
  update(from, to) {
    updateInGroup(this, from, to, "update");
    return this;
  },
};

/** Whether `value` is a group built by `Array(…)`. */
function isArray(value) {
  return Boolean(value) && typeof value === "object" && ARRAY in value;
}

/**
 * A new group holding `objects`.
 *
 * A group handed to a group stands for its members: nesting would only give
 * every batch call another level to walk through and nothing to gain, since a
 * group has no order of its own beyond the one it already keeps.
 */
function createArray(objects) {
  const group = Object.create(ARRAY_METHODS);
  group.kind = "Array";
  group[ARRAY] = new Set();
  addToGroup(group, objects, "Array");
  return group;
}

/** Adds `objects` to `group`, flattening a group into the members it stands for. */
function addToGroup(group, objects, callable) {
  for (const object of objects) {
    if (isArray(object)) {
      for (const member of object[ARRAY]) {
        group[ARRAY].add(member);
      }
      continue;
    }
    if (object === null || object === undefined || typeof object !== "object") {
      // `undefined` is not a value the language has; it reaches here only as a
      // missing argument, and the language calls that the empty value.
      throw new Error(`${callable} 的成员必须是对象，收到${typeOf(object ?? null)}`);
    }
    group[ARRAY].add(object);
  }
}

/**
 * Removes members from `group` by object or by 0-based position.
 *
 * The position is where the object sits in the group's own order — the set is
 * insertion-ordered, which is what `for` walks — so `remove(1)` takes the second
 * member the script put in. Removing an object that is not there is silent, the
 * way `del` already was.
 */
function removeFromGroupAt(group, values, callable) {
  for (const value of values) {
    if (typeof value === "number") {
      const members = [...group[ARRAY]];
      if (!Number.isInteger(value) || value < 0 || value >= members.length) {
        throw new Error(`${callable} 的位置 ${value} 超出范围（组里有 ${members.length} 个对象）`);
      }
      group[ARRAY].delete(members[value]);
      continue;
    }
    if (isArray(value)) {
      for (const member of value[ARRAY]) {
        group[ARRAY].delete(member);
      }
      continue;
    }
    if (value === null || value === undefined || typeof value !== "object") {
      throw new Error(`${callable} 需要 0 起的序号或对象，收到${typeOf(value ?? null)}`);
    }
    group[ARRAY].delete(value);
  }
}

/** Replaces one member of `group`, keeping its position. */
function updateInGroup(group, from, to, callable) {
  if (to === null || to === undefined || typeof to !== "object" || isArray(to)) {
    throw new Error(`${callable} 的新成员必须是对象，收到${typeOf(to ?? null)}`);
  }
  const members = [...group[ARRAY]];
  let at = -1;
  if (typeof from === "number") {
    if (!Number.isInteger(from) || from < 0 || from >= members.length) {
      throw new Error(`${callable} 的位置 ${from} 超出范围（组里有 ${members.length} 个对象）`);
    }
    at = from;
  } else if (typeof from === "object" && from !== null && !isArray(from)) {
    at = members.indexOf(from);
  }
  if (at < 0) {
    throw new Error(`${callable} 找不到要替换的成员`);
  }
  group[ARRAY] = new Set(members.map((member, index) => (index === at ? to : member)));
  return group;
}

/** Removes `objects` from `group`, flattening a group the same way it was added. */
function removeFromGroup(group, objects, callable) {
  for (const object of objects) {
    if (isArray(object)) {
      for (const member of object[ARRAY]) {
        group[ARRAY].delete(member);
      }
      continue;
    }
    if (object === null || object === undefined || typeof object !== "object") {
      throw new Error(`${callable} 的成员必须是对象，收到${typeOf(object ?? null)}`);
    }
    group[ARRAY].delete(object);
  }
}

/**
 * How deep calls may nest before the run gives up on them.
 *
 * A function that calls itself without a reason to stop is the first way this
 * language can be made not to finish, and it never hands control back to the
 * engine while it runs: the editor would simply stop answering. Nothing an
 * author writes on purpose comes close to this many frames, so the one that
 * does is reported instead of being allowed to hang the window.
 */
const MAX_CALL_DEPTH = 200;

/**
 * How deep `include` may nest before the run gives up.
 *
 * A file that includes itself is caught by name, but a long chain of files
 * each including the next has no cycle to catch; this is the bound that keeps
 * a mistaken chain from running away with the editor's stack.
 */
const MAX_INCLUDE_DEPTH = 16;

/**
 * How many statements one run may perform before it is stopped.
 *
 * A `while` loop is the second way a script can fail to finish — and unlike
 * runaway recursion, it does not run out of stack, it just keeps going. The
 * editor has no way to interrupt a run that never reaches a statement it can
 * check between, so the count is what turns "the window stopped answering" into
 * a reported error naming the loop.
 *
 * The budget is generous on purpose: a scene of a few thousand lines, with
 * loops over items, is nowhere near it. It counts statements performed, not
 * time, so it is deterministic — the same script stops at the same place on
 * every machine.
 */
const MAX_STATEMENTS = 100_000;

/**
 * Turns source text into tokens.
 *
 * Newlines are significant: they separate statements, like in most scripting
 * languages a writer would reach for. `;` works as a separator too.
 *
 * The exception is an unclosed `(` or `[`: inside one, a newline is layout
 * rather than a separator, so a long call or list may be spread over lines the
 * way Python allows. Braces are not on that list — a `{` opens a block, and the
 * newlines inside it still divide statements.
 *
 * Comments are dropped rather than turned into tokens: `#` and `//` run to the
 * end of the line — the newline after them is still a separator — and `/*`
 * opens a block comment that covers whatever it spans, newlines included.
 *
 * @param {string} source
 * @returns {{ tokens: Array<object> } | { error: { message: string, line: number, column: number } }}
 */
export function tokenize(source) {
  const text = String(source ?? "");
  const tokens = [];
  let index = 0;
  let line = 1;
  let lineStart = 0;

  const position = (start) => ({ start, end: index, line, column: start - lineStart + 1 });
  const fail = (message, start) => ({ error: { message, ...position(start) } });

  // How many `(` / `[` are open right now. Inside them a newline is layout, not
  // a statement break, so a call or a list may be written across lines.
  let openBrackets = 0;
  const trackBracket = (value) => {
    if (value === "(" || value === "[") {
      openBrackets += 1;
    } else if ((value === ")" || value === "]") && openBrackets > 0) {
      openBrackets -= 1;
    }
  };

  while (index < text.length) {
    const char = text[index];

    if (char === "\n") {
      // 括号里的换行只是排版：行号照常走，但不产出分句的记号。
      if (!openBrackets) {
        tokens.push({ type: "newline", value: "\n", ...position(index) });
      }
      index += 1;
      line += 1;
      lineStart = index;
      continue;
    }

    // A byte-order mark is skipped rather than reported: an editor on Windows
    // may write one, and it is invisible to the author either way.
    if (char === " " || char === "\t" || char === "\r" || char === "\uFEFF") {
      index += 1;
      continue;
    }

    // `#` and `//` run to the end of the line, so a script can document
    // itself. The newline is left where it is: it still separates statements.
    if (char === "#" || (char === "/" && text[index + 1] === "/")) {
      while (index < text.length && text[index] !== "\n") {
        index += 1;
      }
      continue;
    }

    // `/* ... */` covers whatever it spans, so the lines inside it have to be
    // counted: the line numbers of everything after it depend on them.
    if (char === "/" && text[index + 1] === "*") {
      const start = index;
      let closed = false;
      index += 2;

      while (index < text.length) {
        if (text[index] === "*" && text[index + 1] === "/") {
          index += 2;
          closed = true;
          break;
        }
        if (text[index] === "\n") {
          line += 1;
          lineStart = index + 1;
        }
        index += 1;
      }

      if (!closed) {
        return fail("块注释缺少 */", start);
      }
      continue;
    }

    // Chinese punctuation is folded to the ASCII mark it stands for, so a call
    // typed on a Chinese keyboard scans like the one typed on an English one.
    // Done before every other rule: `，` is a comma and nothing else, wherever it
    // appears outside a string.
    const folded = PUNCTUATION_ALIASES.get(char);
    if (folded) {
      tokens.push({ type: "punct", value: folded, ...position(index) });
      trackBracket(folded);
      index += 1;
      continue;
    }

    const quoteCloser = QUOTE_CLOSERS.get(char);
    if (char === '"' || char === "'" || quoteCloser) {
      const start = index;
      const quote = quoteCloser ?? char;
      let value = "";
      let closed = false;
      // `start` covers the opening quote, so the string token the highlighter
      // paints spans the whole `"…"` rather than starting after the quote.
      let stringStart = start;
      // Whether any interpolation has appeared, so the first (possibly empty)
      // literal run is kept as a real token — `""` is an empty string, not
      // nothing — while the empty runs between interpolations are skipped.
      let hadInterp = false;
      // Closes the literal run accumulated so far as a string token. An empty run
      // is kept only before the first interpolation: a pure `""` is an empty
      // literal, but the gap between `{a}` and `{b}` carries nothing.
      const flush = () => {
        if (value || !hadInterp) {
          tokens.push({ type: "string", value, ...position(stringStart) });
        }
        value = "";
        stringStart = index;
      };
      index += 1;

      while (index < text.length) {
        const current = text[index];
        if (current === "\\") {
          // `\{` and `\}` stay literal, so an author can write a brace without
          // starting an interpolation; everything else is the usual escape.
          const next = text[index + 1];
          if (next === "{" || next === "}") {
            value += next;
            index += 2;
            continue;
          }
          value += unescape(next);
          index += 2;
          continue;
        }
        // A Chinese string closes on its partner mark; the opening mark is
        // accepted too, so a writer who typed the same mark twice still gets a
        // line rather than an unterminated string.
        if (current === quote || (quoteCloser && current === char)) {
          index += 1;
          closed = true;
          break;
        }
        if (current === "\n") {
          break;
        }
        // `{expr}` opens an interpolation: the literal run so far is closed, the
        // expression between the braces is kept verbatim (the parser lexes and
        // evaluates it), and the literal run resumes after the closing brace.
        if (current === "{") {
          const braceAt = index;
          hadInterp = true;
          flush();
          // One for the brace that opened this interpolation; a matching `}` brings
          // it back to zero and closes it, so nested `{}` balance correctly.
          let depth = 1;
          let end = braceAt + 1;
          while (end < text.length) {
            const ch = text[end];
            if (ch === "(" || ch === "[" || ch === "{") {
              depth += 1;
            } else if (ch === ")" || ch === "]" || ch === "}") {
              depth -= 1;
              if (depth === 0) {
                break;
              }
            }
            end += 1;
          }
          const expr = text.slice(braceAt + 1, end);
          index = end + 1;
          tokens.push({ type: "interp", value: expr, ...position(braceAt) });
          stringStart = index;
          continue;
        }
        value += current;
        index += 1;
      }

      flush();
      if (!closed) {
        return fail("字符串缺少结束引号", start);
      }
      continue;
    }

    // A number is digits, optionally followed by a fractional part. A minus in
    // front of one is a unary operator the parser applies, not part of the
    // literal, so `x - 1` and `x = -1` are read by the same rule and neither
    // depends on where the writer put a space.
    if (DIGIT.test(char)) {
      const start = index;
      while (index < text.length && DIGIT.test(text[index])) {
        index += 1;
      }
      if (text[index] === "." && DIGIT.test(text[index + 1] ?? "")) {
        index += 1;
        while (index < text.length && DIGIT.test(text[index])) {
          index += 1;
        }
      }
      const raw = text.slice(start, index);
      tokens.push({ type: "number", value: Number(raw), ...position(start) });
      continue;
    }

    if (IDENT_START.test(char)) {
      const start = index;
      while (index < text.length && IDENT_PART.test(text[index])) {
        index += 1;
      }
      const word = text.slice(start, index);
      // `and` / `or` / `not` read as the word forms of `&&` / `||` / `!`, so a
      // writer may spell logic either way. They are operators, not names, so they
      // leave here as punctuation the parser already handles.
      if (word === AND || word === OR || word === NOT) {
        tokens.push({ type: "punct", value: word, ...position(start) });
      } else {
        tokens.push({ type: "ident", value: word, ...position(start) });
      }
      continue;
    }

    const pair = text.slice(index, index + 2);
    if (OPERATORS.includes(pair)) {
      tokens.push({ type: "punct", value: pair, ...position(index) });
      index += 2;
      continue;
    }

    if (PUNCTUATION.has(char)) {
      tokens.push({ type: "punct", value: char, ...position(index) });
      trackBracket(char);
      index += 1;
      continue;
    }

    return fail(`无法识别的字符“${char}”`, index);
  }

  tokens.push({ type: "eof", value: "", line, column: 1 });
  return { tokens };
}

/** Resolves the character after a backslash in a string literal. */
function unescape(char) {
  switch (char) {
    case "n":
      return "\n";
    case "t":
      return "\t";
    case "r":
      return "\r";
    case "\\":
      return "\\";
    case '"':
      return '"';
    case "'":
      return "'";
    default:
      // An unknown escape keeps the character as written, so a Windows path
      // such as "assets\\bg.png" survives without needing every slash doubled.
      return char ?? "";
  }
}

/**
 * Builds an AST from tokens.
 *
 * @returns {{ program: { statements: Array<object> } } | { error: object }}
 */
export function parse(tokens) {
  let index = 0;
  const peek = (offset = 0) => tokens[index + offset] ?? tokens[tokens.length - 1];
  const at = (type, value) => peek().type === type && (value === undefined || peek().value === value);
  const advance = () => tokens[index++];
  const fail = (message, token = peek()) => ({
    error: { message, line: token.line, column: token.column },
  });

  const skipSeparators = () => {
    while (at("newline") || at("punct", ";")) {
      advance();
    }
  };

  function parseProgram() {
    const statements = [];
    skipSeparators();
    while (!at("eof")) {
      const statement = parseStatement();
      if (statement.error) {
        return statement;
      }
      statements.push(statement.node);

      if (at("eof")) {
        break;
      }
      if (at("newline") || at("punct", ";")) {
        skipSeparators();
      } else {
        return fail("语句之间需要换行或分号");
      }
    }
    return { program: { statements } };
  }

  function parseStatement() {
    const token = peek();
    // 关键字不可作为赋值目标，因此在词法阶段报错。
    // 关键字不可作为赋值目标，因此在词法阶段报错。
    // letting `if = 1` fail somewhere inside the condition it looks like it
    // opens.
    if (
      token.type === "ident" &&
      KEYWORDS.has(token.value) &&
      peek(1).type === "punct" &&
      peek(1).value === "="
    ) {
      return fail(`不能把关键字 ${token.value} 用作变量名`, token);
    }
    if (token.type === "ident" && token.value === CUE) {
      return parseCue();
    }
    // `wait` closes a `cue` block, and on a line of its own it is a pause:
    // `wait 500` holds the script for half a second. Both readings are the same
    // word doing the same thing — waiting — and which one is meant is decided
    // by where it stands: before the end of the line it opens a statement of
    // its own, which needs a time to be a pause.
    if (token.type === "ident" && token.value === WAIT) {
      return parseWait();
    }
    if (token.type === "ident" && token.value === FUNC) {
      return parseFunction();
    }
    if (token.type === "ident" && token.value === IF) {
      return parseIf();
    }
    if (token.type === "ident" && token.value === RETURN) {
      return parseReturn();
    }
    if (token.type === "ident" && token.value === CHOICE) {
      return parseChoice();
    }
    if (token.type === "ident" && token.value === INCLUDE) {
      return parseInclude();
    }
    if (token.type === "ident" && token.value === USE) {
      return parseUse();
    }
    if (token.type === "ident" && token.value === WHILE) {
      return parseWhile();
    }
    if (token.type === "ident" && token.value === FOR) {
      return parseFor();
    }
    if (token.type === "ident" && token.value === SWITCH) {
      return parseSwitch();
    }
    if (token.type === "ident" && token.value === BREAK) {
      return parseJump(BREAK);
    }
    if (token.type === "ident" && token.value === CONTINUE) {
      return parseJump(CONTINUE);
    }

    // `==` is its own token, so this only ever matches an assignment.
    if (token.type === "ident" && peek(1).type === "punct" && peek(1).value === "=") {
      const name = advance().value;
      advance();
      const value = parseExpression();
      if (value.error) {
        return value;
      }
      return { node: { type: "assign", name, value: value.node, line: token.line } };
    }

    // A compound assignment is read as one token, so `x += 1` never looks like
    // an assignment of `+ 1` to `x`. The operator it folds in is kept on the
    // node, so the interpreter reports a type error the way the plain operator
    // would, at the line the compound one was written on.
    if (
      token.type === "ident" &&
      peek(1).type === "punct" &&
      COMPOUND.has(peek(1).value)
    ) {
      const name = advance().value;
      const operator = advance().value;
      const value = parseExpression();
      if (value.error) {
        return value;
      }
      return {
        node: {
          type: "assign",
          name,
          op: COMPOUND.get(operator),
          value: value.node,
          line: token.line,
        },
      };
    }

    const value = parseExpression();
    if (value.error) {
      return value;
    }
    return { node: { type: "expression", value: value.node, line: token.line } };
  }

  /**
   * Parses `wait 500`, a pause on a line of its own.
   *
   * The number is read at parse time because a pause is a length, not a value:
   * nothing in the language can compute one, and letting it be an expression
   * would invite `wait x` where a script meant `wait 500`. It may be written in
   * brackets too — `wait(500)` — since the word also closes a `cue` block, and
   * the two spellings mean the same thing wherever it appears. A `wait` with no
   * number is the block's end written on the wrong line, and says so.
   */
  function parseWait() {
    const token = advance();
    const ms = waitTime(token);
    if (ms.error) {
      return ms;
    }
    if (ms.none) {
      return fail(`${WAIT} 要么跟在语句块的 } 后面，要么写成 ${WAIT} 毫秒数`, token);
    }
    return { node: { type: "wait", ms: ms.value, line: token.line } };
  }

  /**
   * The milliseconds a `wait` names: `wait 500`, `wait(500)`.
   *
   * Answers `{ value }`, `{ none: true }` when the word names no time — the
   * `wait` that only closes a block — or `{ error }` when a bracketed time is
   * malformed. A number and nothing else: a pause is a length, not a computed
   * value, exactly as it is on a line of its own.
   */
  function waitTime(token) {
    if (at("punct", "(")) {
      advance();
      if (peek().type !== "number") {
        return fail(`${WAIT} 的括号里需要毫秒数`, token);
      }
      const ms = advance();
      if (!at("punct", ")")) {
        return fail(`${WAIT} 的毫秒数后需要一个 )`, token);
      }
      advance();
      return { value: ms.value };
    }
    if (peek().type === "number") {
      return { value: advance().value };
    }
    return { none: true };
  }

  /**
   * Parses `cue { ... }`, optionally closed off with `wait`.
   *
   * The block is only about the moment its statements start: they all begin
   * at once, and the calls inside them do too. How long the script is held
   * before the statements after the block begin is the block's time, written
   * either as the keyword's argument (`cue(3000) { … }`) or as the closing
   * `wait` (`} wait 3000`, `} wait(3000)`). The two are the same thing, and a
   * `wait` that names a time wins when both are written. A `wait` with no
   * number is the old spelling of "hold until the block is over"; with neither
   * time nor `wait` the block starts its group and moves on at once.
   *
   * `wait` has to sit on the same line as the closing brace. On a line of its
   * own it would read as a statement of its own, since a newline separates
   * statements everywhere else in the language.
   *
   * A `cue` may also carry a single statement instead of a block:
   * `cue(3000) ch.scale(0.5).move(0, -300)`. One statement is where a chain
   * lives, and a chain inside a cue starts together — which is the one way to
   * make `ch.scale(2, 2000).blur(20, 2000)` take two seconds instead of four.
   * The time is written either in parentheses or straight after the keyword
   * (`cue 3000 …`), the way the shorthand dialect writes it.
   */
  function parseCue() {
    const token = advance();
    // Optional time argument: `cue(3000) { ... }`. A number (may be negative, so
    // -1 is allowed) or any expression; the meaning is read off the value at run
    // time — a positive time holds exactly that long, -1 waits for everything,
    // 0 / none starts the group and moves on at once.
    let time = null;
    if (at("punct", "(")) {
      advance();
      const expr = parseExpression();
      if (expr.error) {
        return expr;
      }
      if (!at("punct", ")")) {
        return fail(`${CUE} 的时间参数后需要一个 )`, token);
      }
      advance();
      time = expr.node;
    } else if (at("number") || (at("punct", "-") && peek(1).type === "number")) {
      // `cue 3000 …`: the same time without the parentheses, as the shorthand
      // dialect writes it. Only a number is read this way — a name here would
      // make `cue ch.hide()` impossible to tell from a cue waiting on `ch`.
      const sign = at("punct", "-") ? advance() : null;
      const ms = advance();
      const literal = { type: "literal", value: ms.value, line: ms.line };
      time = sign
        ? { type: "unary", op: sign.value, operand: literal, line: sign.line }
        : literal;
    }

    // Without a brace the rest of the line is the one statement the cue starts.
    if (!at("punct", "{")) {
      if (at("newline") || at("punct", ";") || at("eof")) {
        return fail(`${CUE} 后面需要一条语句或一个语句块`, token);
      }
      const single = parseStatement();
      if (single.error) {
        return single;
      }
      const { wait, waitMs, error } = parseCueWait(token);
      if (error) {
        return { error };
      }
      return {
        node: {
          type: "cue",
          statements: [single.node],
          wait,
          waitMs,
          time,
          line: token.line,
        },
      };
    }
    advance();

    const block = parseBlock();
    if (block.error) {
      return block;
    }

    const { wait, waitMs, error } = parseCueWait(token);
    if (error) {
      return { error };
    }
    return {
      node: { type: "cue", statements: block.statements, wait, waitMs, time, line: token.line },
    };
  }

  /**
   * The `wait` written after a `cue`'s statement or block.
   *
   * Answers the flag (`wait` is there at all), the time it names — `null` when
   * it names none — and an error when a bracketed time is malformed. The flag
   * and the time are both kept: a bare `wait` is the block's end and holds the
   * script for the whole of it, while `wait 3000` holds it for three seconds
   * whatever the block is doing.
   */
  function parseCueWait(token) {
    if (!at("ident", WAIT)) {
      return { wait: false, waitMs: null };
    }
    const waited = advance();
    const ms = waitTime(token);
    if (ms.error) {
      return { error: ms.error };
    }
    if (ms.none) {
      return { wait: true, waitMs: null };
    }
    return {
      wait: true,
      waitMs: { type: "literal", value: ms.value, line: waited.line },
    };
  }

  /**
   * Parses `func name(a, b) { ... }`.
   *
   * A declaration is a statement like any other: it binds the name where it is
   * written, at the moment it runs. Nothing is hoisted, so a call written above
   * the declaration is a name the script has not bound yet, and one written
   * inside the body is how a function calls itself.
   *
   * A keyword is not a usable name here — `func cue() { }` would bind a name no
   * line could ever call, since the statement parser reads the keyword first.
   */
  function parseFunction() {
    const token = advance();
    if (!at("ident")) {
      return fail(`${FUNC} 后面需要一个函数名`, token);
    }
    const name = advance().value;
    if (KEYWORDS.has(name)) {
      return fail(`不能把关键字 ${name} 用作函数名`, token);
    }

    if (!at("punct", "(")) {
      return fail("函数名后面需要参数列表");
    }
    advance();

    const params = [];
    if (!at("punct", ")")) {
      for (;;) {
        if (!at("ident")) {
          return fail("参数需要一个名字");
        }
        const param = advance().value;
        if (KEYWORDS.has(param)) {
          return fail(`不能把关键字 ${param} 用作参数名`);
        }
        if (params.includes(param)) {
          return fail(`参数名重复：${param}`);
        }
        params.push(param);

        if (at("punct", ",")) {
          advance();
          continue;
        }
        if (at("punct", ")")) {
          break;
        }
        return fail("参数之间需要逗号，或以 ) 结束");
      }
    }
    advance();

    if (!at("punct", "{")) {
      return fail("函数体需要一个语句块");
    }
    advance();

    const block = parseBlock();
    if (block.error) {
      return block;
    }
    return {
      node: { type: "func", name, params, statements: block.statements, line: token.line },
    };
  }

  /**
   * Parses `if condition { ... }`, with an optional `else` or `else if`.
   *
   * A condition has to be a boolean; the interpreter says so with an error
   * rather than treating other values as truthy, because a typo that quietly
   * picks a branch is worse than one that stops the script.
   *
   * A newline separates statements everywhere else, so `else` has to be found
   * by looking ahead over the separators without consuming them: moved past
   * them, a block with no `else` would leave the following statement looking
   * like it was written without a separator. Only a real `else` moves the
   * cursor.
   */
  function parseIf() {
    const token = advance();
    const test = parseExpression();
    if (test.error) {
      return test;
    }
    if (!at("punct", "{")) {
      return fail(`${IF} 需要在条件后面跟一个语句块`);
    }
    advance();

    const block = parseBlock();
    if (block.error) {
      return block;
    }

    let otherwise = null;
    const next = elseAhead();
    if (next !== -1) {
      index = next;
      advance();
      if (at("ident", IF)) {
        const nested = parseIf();
        if (nested.error) {
          return nested;
        }
        otherwise = [nested.node];
      } else {
        if (!at("punct", "{")) {
          return fail(`${ELSE} 后面需要另一个 ${IF} 或一个语句块`);
        }
        advance();
        const other = parseBlock();
        if (other.error) {
          return other;
        }
        otherwise = other.statements;
      }
    }

    return {
      node: { type: "if", test: test.node, then: block.statements, otherwise, line: token.line },
    };
  }

  /**
   * The index of an `else` after the statement separators that follow a block,
   * or `-1` when the block has none. Read-only: the caller moves the cursor.
   */
  function elseAhead() {
    let cursor = index;
    while (
      tokens[cursor] &&
      (tokens[cursor].type === "newline" ||
        (tokens[cursor].type === "punct" && tokens[cursor].value === ";"))
    ) {
      cursor += 1;
    }
    return tokens[cursor]?.type === "ident" && tokens[cursor].value === ELSE ? cursor : -1;
  }

  /**
   * Parses `return`, with an optional value.
   *
   * `return` alone — end of line, or straight into the closing brace — answers
   * the empty value, which is what a function that only stops early needs.
   */
  function parseReturn() {
    const token = advance();
    if (at("newline") || at("punct", "}") || at("punct", ";") || at("eof")) {
      return { node: { type: "return", value: null, line: token.line } };
    }
    const value = parseExpression();
    if (value.error) {
      return value;
    }
    return { node: { type: "return", value: value.node, line: token.line } };
  }

  /**
   * Parses `while condition { ... }`.
   *
   * The condition follows the same rule as `if`: it has to be a boolean, and
   * the interpreter says so rather than treating other values as truthy. The
   * block is the loop's body, performed again for as long as the condition
   * holds.
   *
   * A loop is the one shape a script can write that never ends, so the
   * interpreter also counts the statements it performs (see `MAX_STATEMENTS`):
   * a body that never changes the condition is reported instead of hanging the
   * window.
   */
  function parseWhile() {
    const token = advance();
    const test = parseExpression();
    if (test.error) {
      return test;
    }
    if (!at("punct", "{")) {
      return fail(`${WHILE} 需要在条件后面跟一个语句块`);
    }
    advance();

    const block = parseBlock();
    if (block.error) {
      return block;
    }
    return {
      node: { type: "while", test: test.node, statements: block.statements, line: token.line },
    };
  }

  /**
   * Parses `for name in collection { ... }`.
   *
   * The variable bound each turn is the only new name a loop introduces, and it
   * shadows nothing — a `for` simply assigns into the current scope each round.
   * The collection may be a list, a dictionary (the keys are walked) or a string
   * (its characters are). Anything else is reported rather than coerced.
   */
  function parseFor() {
    const token = advance();
    if (!at("ident")) {
      return fail(`${FOR} 后面需要循环变量名`, token);
    }
    const name = advance().value;
    if (!at("ident", IN)) {
      return fail(`${FOR} 需要 "${IN}" 关键字`, token);
    }
    advance();
    const source = parseExpression();
    if (source.error) {
      return source;
    }
    if (!at("punct", "{")) {
      return fail(`${FOR} 需要在集合后面跟一个语句块`, token);
    }
    advance();
    const block = parseBlock();
    if (block.error) {
      return block;
    }
    return {
      node: { type: "for", name, source: source.node, statements: block.statements, line: token.line },
    };
  }

  /**
   * Parses `switch value { case test { ... } ... default { ... } }`.
   *
   * Each case is tried in order with `==`; the first that matches runs, and a
   * `default` arm runs when none do. The value and each case test are evaluated
   * where the `switch` stands, once.
   */
  function parseSwitch() {
    const token = advance();
    const value = parseExpression();
    if (value.error) {
      return value;
    }
    if (!at("punct", "{")) {
      return fail(`${SWITCH} 后面需要一个选项块`, token);
    }
    advance();
    const cases = [];
    let otherwise = null;
    skipSeparators();
    while (!at("punct", "}")) {
      if (at("eof")) {
        return fail("选项块缺少 }");
      }
      if (at("ident", CASE)) {
        advance();
        const test = parseExpression();
        if (test.error) {
          return test;
        }
        if (!at("punct", "{")) {
          return fail("case 后面需要一个语句块");
        }
        advance();
        const block = parseBlock();
        if (block.error) {
          return block;
        }
        cases.push({ test: test.node, statements: block.statements, line: test.node.line });
      } else if (at("ident", DEFAULT)) {
        advance();
        if (!at("punct", "{")) {
          return fail("default 后面需要一个语句块");
        }
        advance();
        const block = parseBlock();
        if (block.error) {
          return block;
        }
        otherwise = block.statements;
      } else {
        return fail("switch 块里只能有 case 或 default", token);
      }
      skipSeparators();
    }
    advance();
    if (!cases.length) {
      return fail(`${SWITCH} 至少需要一个 case`, token);
    }
    return {
      node: { type: "switch", value: value.node, cases, otherwise, line: token.line },
    };
  }

  /**
   * Parses `break` and `continue`.
   *
   * Both are statements on their own, with nothing after them on the line: a
   * `break` carrying a value would be a `return` by another name, and this
   * language keeps the two apart. Whether either is inside a loop is the
   * interpreter's to say — the parser cannot know, since a function body may be
   * written inside one and called from outside it.
   */
  function parseJump(word) {
    const token = advance();
    return { node: { type: word, line: token.line } };
  }

  /**
   * Parses `choice { "label" { ... } ... }`.
   *
   * Each answer is an expression a player reads and a block of statements that
   * runs when they pick it. The label was a string literal when the language
   * had no way to turn a number into text; now that `str()` exists, a label may
   * be anything that evaluates to text, so a choice can say what it costs
   * (`"付 100 元（剩 " + str(gold) + "）"`). It is still evaluated where the
   * question is put up, once, and only shown — nothing computed from a label
   * reaches a branch.
   *
   * The block waits for the pick before doing anything else — that is what the
   * statement is for — so it takes no trailing `wait` the way `cue` does.
   */
  function parseChoice() {
    const token = advance();
    if (!at("punct", "{")) {
      return fail(`${CHOICE} 后面需要一个选项块`, token);
    }
    advance();

    const options = [];
    skipSeparators();
    while (!at("punct", "}")) {
      if (at("eof")) {
        return fail("选项块缺少 }");
      }
      const label = parseExpression();
      if (label.error) {
        return label;
      }
      if (!at("punct", "{")) {
        return fail("选项标签后面需要一个语句块");
      }
      advance();
      const block = parseBlock();
      if (block.error) {
        return block;
      }
      options.push({ label: label.node, statements: block.statements, line: label.node.line });
      skipSeparators();
    }
    advance();

    if (!options.length) {
      return fail(`${CHOICE} 至少需要一个选项`, token);
    }
    return { node: { type: "choice", options, line: token.line } };
  }
  /**
   * Parses `include "path"`.
   *
   * The named file is played where the statement stands, as if its statements
   * had been written there: a scene kept in its own file can be called from a
   * chapter, and a branch can send the story into a different file. The path
   * is a string literal because it is a name, not a value a script works out.
   */
  function parseInclude() {
    const token = advance();
    if (!at("string")) {
      return fail(`${INCLUDE} 后面需要一个文本路径`, token);
    }
    const path = advance().value;
    if (!path.trim()) {
      return fail(`${INCLUDE} 的路径不能是空的`, token);
    }
    return { node: { type: "include", path, line: token.line } };
  }

  /**
   * Parses `use <表达式>`.
   *
   * The path is an expression, not a bare string, so a script can compute it —
   * a variable, a join, a function's return — and point at a style file's
   * project-relative path. The host reads and applies the style at runtime.
   */
  function parseUse() {
    const token = advance();
    const target = parseExpression();
    if (target.error) {
      return target;
    }
    if (!target.node) {
      return fail(`${USE} 后面需要一个样式文件路径表达式`, token);
    }
    return { node: { type: "use", target: target.node, line: token.line } };
  }

  /**
   * Parses the statements between braces, closing one included.
   *
   * The opening brace has already been read by the caller, which is the one
   * that knows what the block belongs to. The body of a `func` and the body of
   * a `cue` are the same thing to everything but the keyword in front of them.
   */
  function parseBlock() {
    const statements = [];
    skipSeparators();
    while (!at("punct", "}")) {
      if (at("eof")) {
        return fail("语句块缺少 }");
      }
      const statement = parseStatement();
      if (statement.error) {
        return statement;
      }
      statements.push(statement.node);

      if (at("punct", "}")) {
        break;
      }
      if (at("newline") || at("punct", ";")) {
        skipSeparators();
      } else {
        return fail("语句之间需要换行或分号");
      }
    }
    advance();
    return { statements };
  }

  /**
   * Expression parsing, one function per precedence level.
   *
   * Each level reads the one below it and then loops on the operators it owns,
   * which makes precedence a property of the nesting rather than a table
   * consulted at run time. `||` binds loosest, `&&` next, then equality,
   * comparison, `+ -`, `* / %`, unary operators, and last member access and
   * calls, which are the only postfix forms.
   */
  function parseExpression() {
    return parseNullish();
  }

  /**
   * Nullish coalescing sits below `||`: `a ?? b` is `a` unless `a` is null, in
   * which case it is `b`. It is the loosest binding of the binary operators.
   */
  function parseNullish() {
    return parseBinaryLevel(parseOr, ["??"]);
  }

  function parseOr() {
    return parseBinaryLevel(parseAnd, ["||", "or"]);
  }

  function parseAnd() {
    return parseBinaryLevel(parseEquality, ["&&", "and"]);
  }

  function parseEquality() {
    return parseBinaryLevel(parseComparison, ["==", "!="]);
  }

  function parseComparison() {
    return parseBinaryLevel(parseAdditive, ["<", ">", "<=", ">="]);
  }

  function parseAdditive() {
    return parseBinaryLevel(parseMultiplicative, ["+", "-"]);
  }

  function parseMultiplicative() {
    return parseBinaryLevel(parseUnary, ["*", "/", "%"]);
  }

  /**
   * Reads one left-associative level: a lower level, then any run of the given
   * operators, each folding the next lower level into the node on its left.
   */
  function parseBinaryLevel(lower, operators) {
    let node = lower();
    if (node.error) {
      return node;
    }
    while (at("punct") && operators.includes(peek().value)) {
      const token = advance();
      const right = lower();
      if (right.error) {
        return right;
      }
      const op = token.value === AND ? "&&" : token.value === OR ? "||" : token.value;
      node = {
        node: { type: "binary", op, left: node.node, right: right.node, line: node.node.line },
      };
    }
    return node;
  }

  /**
   * Unary `!` and `-`, which bind tighter than any binary operator but looser
   * than member access and calls: `-a.b()` negates the result of the call.
   */
  function parseUnary() {
    if (at("punct", "!") || at("punct", NOT)) {
      const token = advance();
      const operand = parseUnary();
      if (operand.error) {
        return operand;
      }
      return { node: { type: "unary", op: "!", operand: operand.node, line: token.line } };
    }
    if (at("punct", "-")) {
      const token = advance();
      const operand = parseUnary();
      if (operand.error) {
        return operand;
      }
      return { node: { type: "unary", op: token.value, operand: operand.node, line: token.line } };
    }
    return parsePostfix();
  }

  function parsePostfix() {
    let node = parsePrimary();
    if (node.error) {
      return node;
    }

    for (;;) {
      if (at("punct", ".")) {
        advance();
        if (!at("ident")) {
          return fail("点号后面需要一个名称");
        }
        const name = advance().value;
        node = { node: { type: "member", object: node.node, name, line: node.node.line } };
        continue;
      }
      if (at("punct", "(")) {
        const args = parseArguments();
        if (args.error) {
          return args;
        }
        node = {
          node: {
            type: "call",
            callee: node.node,
            args: args.nodes,
            // Both are left off when empty, so a call written positionally keeps
            // the shape it always had: only the new spellings grow a field.
            ...(args.named && args.named.length ? { named: args.named } : {}),
            ...(args.objects && args.objects.length ? { objects: args.objects } : {}),
            line: node.node.line,
          },
        };
        continue;
      }
      if (at("punct", "[")) {
        // `[i]` indexes, `[a:b]` slices; the colon marks a slice and either bound
        // may be omitted (`[:3]`, `[1:]`, `[:]`).
        advance();
        let lower = null;
        let upper = null;
        let isSlice = false;
        if (at("punct", ":")) {
          isSlice = true;
          advance();
          if (!at("punct", "]")) {
            const upperPart = parseExpression();
            if (upperPart.error) {
              return upperPart;
            }
            upper = upperPart.node;
          }
        } else {
          const lowerPart = parseExpression();
          if (lowerPart.error) {
            return lowerPart;
          }
          lower = lowerPart.node;
          if (at("punct", ":")) {
            isSlice = true;
            advance();
            if (!at("punct", "]")) {
              const upperPart = parseExpression();
              if (upperPart.error) {
                return upperPart;
              }
              upper = upperPart.node;
            }
          }
        }
        if (!at("punct", "]")) {
          return fail("下标或切片需要以 ] 结束");
        }
        advance();
        node = {
          node: {
            type: isSlice ? "slice" : "index",
            object: node.node,
            lower,
            upper,
            line: node.node.line,
          },
        };
        continue;
      }
      break;
    }

    return node;
  }

  function parseArguments() {
    advance();
    const nodes = [];
    const named = [];
    // The expressions after a `:` — the objects a stage-wide call acts on.
    // Written `stage.scale(2.0 : ch, bg)`, the colon ends the fixed arguments
    // early: everything after it is a target, so a middle parameter the author
    // does not want (`time`) never has to be filled with a placeholder.
    const objects = [];
    let inObjects = false;
    if (at("punct", ")")) {
      advance();
      return { nodes, named, objects };
    }

    for (;;) {
      if (at("punct", ":")) {
        if (inObjects) {
          return fail("一次调用里只能有一个冒号");
        }
        advance();
        inObjects = true;
        if (at("punct", ")")) {
          return fail("冒号后面需要对象");
        }
        continue;
      }
      if (inObjects) {
        const object = parseExpression();
        if (object.error) {
          return object;
        }
        objects.push(object.node);
        if (at("punct", ",")) {
          advance();
          continue;
        }
        if (at("punct", ")")) {
          advance();
          return { nodes, named, objects };
        }
        return fail("对象之间需要逗号，或以 ) 结束");
      }
      // `名字 = 值` inside the brackets is a named argument, not an
      // assignment: `Character("ch.png", x = 300)`. Assignment is a statement
      // form in this language, so an `=` here can only mean the name of the
      // argument being given — which is what lets a call skip the ones it does
      // not want (`Character("ch.png", y = -500)`).
      const nameToken = peek();
      const equals = peek(1);
      if (nameToken.type === "ident" && equals.type === "punct" && equals.value === "=") {
        advance();
        advance();
        const value = parseExpression();
        if (value.error) {
          return value;
        }
        named.push({ name: nameToken.value, value: value.node, line: nameToken.line });
        if (at("punct", ",")) {
          advance();
          continue;
        }
        // A colon is the seam between the fixed arguments and the objects, and
        // the loop reads it at the top: a named argument may sit in front of it.
        if (at("punct", ":")) {
          continue;
        }
        if (at("punct", ")")) {
          advance();
          return { nodes, named, objects };
        }
        return fail("参数之间需要逗号，或以 ) 结束");
      }
      if (named.length) {
        // Positional arguments must all come first: once a name is given, a
        // bare value would be ambiguous about which parameter it fills.
        return fail(`命名参数 ${named[named.length - 1].name} 之后不能再写位置参数`);
      }
      const argument = parseExpression();
      if (argument.error) {
        return argument;
      }
      nodes.push(argument.node);

      if (at("punct", ",")) {
        advance();
        continue;
      }
      // The colon ends the fixed arguments; the loop reads it at the top, so a
      // positional argument may sit in front of it.
      if (at("punct", ":")) {
        continue;
      }
      if (at("punct", ")")) {
        advance();
        return { nodes, named, objects };
      }
      return fail("参数之间需要逗号，或以 ) 结束");
    }
  }

  function parsePrimary() {
    const token = peek();

    if (token.type === "string" || token.type === "interp") {
      // A run of string and interpolation tokens reads as one template: literal
      // fragments stay text, interpolation fragments are parsed and evaluated as
      // expressions, and the result is their concatenation. A lone string token
      // (the common case) is the plain literal it always was.
      const parts = [];
      const line = token.line;
      while (peek().type === "string" || peek().type === "interp") {
        const part = advance();
        if (part.type === "string") {
          parts.push({ literal: part.value });
          continue;
        }
        const scanned = tokenize(part.value);
        if (scanned.error) {
          return { error: scanned.error };
        }
        const parsed = parse(scanned.tokens);
        if (parsed.error) {
          return { error: parsed.error };
        }
        const statement = parsed.program.statements[0];
        if (!statement || statement.type !== "expression") {
          return fail("插值 {…} 里必须是表达式", token);
        }
        parts.push({ expr: statement.value });
      }
      if (parts.length === 1 && parts[0].literal !== undefined) {
        return { node: { type: "literal", value: parts[0].literal, line } };
      }
      return { node: { type: "template", parts, line } };
    }

    if (token.type === "number") {
      advance();
      return { node: { type: "literal", value: token.value, line: token.line } };
    }

    if (token.type === "ident") {
      advance();
      if (token.value === TRUE || token.value === FALSE) {
        return { node: { type: "literal", value: token.value === TRUE, line: token.line } };
      }
      if (token.value === NULL) {
        return { node: { type: "literal", value: null, line: token.line } };
      }
      if (KEYWORDS.has(token.value)) {
        return fail(`${token.value} 不能当作值使用`, token);
      }
      return { node: { type: "identifier", name: token.value, line: token.line } };
    }

    if (token.type === "punct" && token.value === "[") {
      // A list literal: `[a, b, c]`. An empty `[]` is allowed.
      advance();
      const elements = [];
      if (!at("punct", "]")) {
        for (;;) {
          const element = parseExpression();
          if (element.error) {
            return element;
          }
          elements.push(element.node);
          if (at("punct", ",")) {
            advance();
            continue;
          }
          if (at("punct", "]")) {
            advance();
            break;
          }
          return fail("列表元素之间需要逗号，或以 ] 结束");
        }
      } else {
        advance();
      }
      return { node: { type: "list", elements, line: token.line } };
    }

    if (token.type === "punct" && token.value === "{") {
      // A dictionary literal: `{"hp": 3, "mp": 2}`. An empty `{}` is allowed; it
      // is only ambiguous with a block in a statement position, where blocks are
      // parsed by the control-flow statements, never here.
      advance();
      const entries = [];
      if (!at("punct", "}")) {
        for (;;) {
          const key = parseExpression();
          if (key.error) {
            return key;
          }
          if (!at("punct", ":")) {
            return fail("字典的键与值之间需要 :");
          }
          advance();
          const value = parseExpression();
          if (value.error) {
            return value;
          }
          entries.push({ key: key.node, value: value.node });
          if (at("punct", ",")) {
            advance();
            continue;
          }
          if (at("punct", "}")) {
            advance();
            break;
          }
          return fail("字典项之间需要逗号，或以 } 结束");
        }
      } else {
        advance();
      }
      return { node: { type: "dict", entries, line: token.line } };
    }

    if (token.type === "punct" && token.value === "(") {
      advance();
      const inner = parseExpression();
      if (inner.error) {
        return inner;
      }
      if (!at("punct", ")")) {
        return fail("缺少右括号");
      }
      advance();
      return inner;
    }

    return fail("这里需要一个值", token);
  }

  return parseProgram();
}

/**
 * A function a script declared, as a value.
 *
 * Kept as a plain object rather than wrapped in a JavaScript function: a host
 * factory is a JavaScript function already, and the two are called differently.
 * The mark is the whole of the difference.
 */
function scriptFunction(node) {
  return {
    [SCRIPT_FUNCTION]: true,
    name: node.name,
    params: node.params,
    statements: node.statements,
    line: node.line,
  };
}

/** Whether `value` is a function a script declared, rather than a host value. */
function isScriptFunction(value) {
  return typeof value === "object" && value !== null && value[SCRIPT_FUNCTION] === true;
}

/**
 * The functions the language itself provides, by the name a script calls.
 *
 * These are not host objects: `str` is about values, not about the stage, so it
 * lives here rather than among the stage's methods. Keeping it in the language
 * is what lets `run()` be tested on its own, and what makes a host that offers
 * no stage at all still able to turn a number into text. `callStage` answers
 * them too, so `stage.str(7)` is the same call as `str(7)`.
 *
 * A name here is looked up after the script's own bindings, so a script that
 * declares `func str(...)` gets its own — the same rule a variable follows.
 */
/** A builtin throws this to ask the interpreter to jump to another file. */
const JUMP_SIGNAL = Symbol("jump");

const BUILTINS = {
  /**
   * Turns a value into the text a line can show.
   *
   * The language has no implicit conversion — `"得分：" + 7` is an error rather
   * than a silent join — so this is the one explicit way across, and every
   * error that would have wanted a conversion points here.
   *
   * `str(7 / 3, 2)` answers `"2.33"`: a game shows a score, not sixteen digits
   * of it. The second argument is the number of decimals to keep, 0–10.
   */
  str: (value, digits) => {
    if (value === undefined) {
      // The language has no `undefined`, so the only way to get here is a call
      // with no argument at all — which is a mistake worth naming as one.
      throw new Error("str 需要一个值");
    }
    if (digits !== undefined) {
      if (typeof value !== "number") {
        throw new Error(`str 的小数位数只能用在数字上，收到${typeOf(value)}`);
      }
      if (!Number.isInteger(digits) || digits < 0 || digits > 10) {
        throw new Error("str 的小数位数需要 0–10 的整数");
      }
      return value.toFixed(digits);
    }
    if (typeof value === "string") {
      return value;
    }
    if (typeof value === "number") {
      // `String` already drops a trailing `.0`, which is what a writer means by
      // `str(7)` — and a long decimal is left whole rather than rounded behind
      // the author's back.
      return String(value);
    }
    if (typeof value === "boolean") {
      return value ? "true" : "false";
    }
    if (value === null) {
      return "null";
    }
    throw new Error(`str 需要数字、文本、布尔或空值，收到${typeOf(value)}`);
  },

  /**
   * Ends the current run and starts the named file from its top, as a fresh run —
   * a transition between scenes, not an inline splice like `include`. The path is
   * any expression that yields a non-empty string, so a script can compute it
   * (`jump("scene_" + name)`). Written as a call: `jump("file.pe")`.
   */
  jump: (path) => {
    if (typeof path !== "string" || !path.trim()) {
      throw new Error("jump 需要一个非空的文本路径");
    }
    const signal = new Error("jump");
    signal[JUMP_SIGNAL] = path;
    throw signal;
  },

  /**
   * The length of a list (its element count), a dictionary (its key count), or a
   * string (its character count). Anything else is named, never guessed at.
   */
  len: (value) => {
    if (value && typeof value === "object" && LIST in value) {
      return value[LIST].length;
    }
    if (value && typeof value === "object" && DICT in value) {
      return value[DICT].size;
    }
    if (isArray(value)) {
      return value[ARRAY].size;
    }
    if (typeof value === "string") {
      return value.length;
    }
    throw new Error(`len 需要列表、字典、对象组或文本，收到${typeOf(value)}`);
  },

  /**
   * A group of objects: `Array(ch1, ch2, bg1)`.
   *
   * The point of the type is a batch call written once — `stage.blur(200 : ay1)`
   * — so a script that sets up dozens of objects the same way does not have to
   * list them at every call. `add` / `del` change the membership later, and
   * `for name in group` walks it.
   */
  Array: (...objects) => createArray(objects),
};

/**
 * The Chinese name of every builtin a script can call by name.
 *
 * Two things are named here that the interpreter does not own: the objects the
 * stage builds (`Background`, `Character`, `Audio`, the global `dialog`) and the
 * methods those objects answer to. They live in `ui/stage.js`, but their Chinese
 * names are part of the language's surface — a script written in Chinese must not
 * have to know which file a name comes from — so the table is kept here, beside
 * the builtins, where one list is the whole vocabulary.
 *
 * The rule is a fallback, never an override: a name the script binds itself wins
 * first, and only then is the Chinese spelling translated and looked up again.
 * Nothing is renamed in the AST, so an error still quotes the word the author
 * wrote (`小帕 没有方法 跳`), not its English translation.
 */
const GLOBAL_ALIASES = [
  // The types a script builds are methods of the stage: `背景(...)` is
  // `stage.Background(...)` with the receiver left out. The aliases name what a
  // script may write, not a second registry the interpreter keeps.
  ["背景", "Background"],
  ["角色", "Character"],
  ["音频", "Audio"],
  // 舞台内置特效不带资源：`Effect("rain")` 的 source 是特效名而非路径。
  // 视频从 `assets/Video/` 读文件，并分出 media / audio 两条控制子轨。
  ["特效", "Effect"],
  ["视频", "Video"],
  // 文字：画面上的纯文本，不读素材，构造的第一个参数就是显示的内容。
  ["文本", "Text"],
  // 光源：打在画面上的灯，同样不读素材，第一个参数是颜色。
  ["光源", "Light"],
  ["灯", "Light"],
  // A group of objects. It is a constructor like the three above — `对象组(ch, bg)`
  // — and the name says what it is for: a batch call written once.
  ["对象组", "Array"],
  ["对话框", "dialog"],
  // The stage owns the calls that are not made on an object — the narrator's
  // line, for one. `舞台` is the object a script reaches them through, and a
  // bare `say` is the same call with the receiver left out (see
  // `evaluateCall`). It is created with the stage and lives as long as it does;
  // a script never builds one.
  ["舞台", "stage"],
  // A bare `say` is the narrator's line; a character's own `say` is a method, so
  // the same word is listed below as well. Both spellings answer `say`.
  ["说", "say"],
  // 点击位置（等待手动点击或自动计时）与无标记的自动计时等待，均属于舞台。
  ["点击", "click"],
  ["自动", "auto"],
  ["自动配音", "autoVoice"],
  ["转文本", "str"],
  ["跳转", "jump"],
  ["长度", "len"],
];

const METHOD_ALIASES = [
  // Membership of a group (`Array`).
  ["添加", "add"],
  ["删除", "del"],
  ["移除", "remove"],
  ["替换", "update"],
  ["更新", "update"],
  // Order and setup.
  ["启用", "enable"],
  ["禁用", "disable"],
  ["显示", "show"],
  ["隐藏", "hide"],
  // 渐入渐出就是画面淡入淡出，与 show / hide 同一调用，只是写法更贴近演出用语。
  ["渐入", "show"],
  ["渐出", "hide"],
  ["置前", "front"],
  ["置后", "back"],
  // Placement and size.
  ["移动", "move"],
  ["移动到", "moveTo"],
  ["旋转", "rotate"],
  ["旋转到", "rotateTo"],
  ["缩放", "scale"],
  ["缩放到", "scaleTo"],
  ["透明度", "alpha"],
  // 调试：每个对象自己的三维坐标轴，默认隐藏。
  ["坐标轴", "crood"],
  // 光照：这个对象挡不挡灯。默认角色挡、其余类型透。
  ["透光", "translucent"],
  // 光照：逆光时这个对象勾不勾边，强度 0–1。默认不勾。
  ["轮廓光", "rim"],
  // 抗锯齿：角色缩放时怎么取像素 —— 默认关（清晰的硬边）。`aa` 连内部一起
  // 柔化，`eaa` 只柔化轮廓。
  ["抗锯齿", "aa"],
  ["全图抗锯齿", "aa"],
  ["边缘抗锯齿", "eaa"],
  ["描边抗锯齿", "eaa"],
  ["交叉溶解", "crossFade"],
  ["变换", "transform"],
  // 开场动画：舞台自己的一段约 3 秒黑幕，写在剧本哪一行就在哪一行播放。
  ["开场", "pamela"],
  // 逐帧图片组：一组图按每秒张数播放，组内可以增删改。
  ["组", "group"],
  ["图片组", "group"],
  ["帧组", "group"],
  ["帧率", "fps"],
  ["帧速", "fps"],
  ["元素", "element"],
  // Animation and colour.
  ["动画", "key"],
  ["定格", "step"],
  ["调色", "rgb"],
  ["调色到", "rgbTo"],
  ["颜色", "hex"],
  ["模糊", "blur"],
  ["亮度", "brightness"],
  ["对比度", "contrast"],
  ["饱和度", "saturate"],
  // 光照：一盏灯的属性与朝向。`方向` 一次写两角，其余各写一个。
  ["强度", "intensity"],
  ["散射", "spread"],
  ["散射角", "spread"],
  ["张角", "spread"],
  ["距离", "range"],
  ["传播距离", "range"],
  ["衰减区间", "range"],
  ["泛光", "bloom"],
  ["辉光", "bloom"],
  ["柔光", "soft"],
  ["宽度", "width"],
  ["灯宽", "width"],
  ["深度", "z"],
  // 转出 W 面的两个角：H 面（水平面）与 V 面（正立面）。
  ["水平面", "rotateH"],
  ["水平角", "rotateH"],
  ["方位", "rotateH"],
  ["方位角", "rotateH"],
  ["正立面", "rotateV"],
  ["垂直角", "rotateV"],
  ["仰角", "rotateV"],
  ["俯仰", "rotateV"],
  ["方向", "direction"],
  // 环境亮度属于舞台：画面整体的乘算亮度，0–2。
  ["环境亮度", "ambient"],
  // 两个变长列表：冒号前是光源，冒号后是被排除的对象。`不排除` 是对称的撤销。
  ["排除", "exclude"],
  ["不排除", "unexclude"],
  // Speaking.
  ["说", "say"],
  ["姓名", "name"],
  // 文字：一次设置同时作用于中文与西文。
  ["字体", "font"],
  // 文字：字重是 CSS 的数值刻度，400 常规、700 粗体。
  ["字重", "weight"],
  // 文字：颜色。图片调色沿用 `hex`（中文「颜色」），文字改色是另一个方法，
  // 所以另起一个不会与图片抢名字的中文写法；「颜色」在文字上仍然可用，
  // 见 `MULTI_ALIASES`。
  ["文字颜色", "color"],
  ["文字色", "color"],
  // Sound.
  ["播放", "play"],
  ["停止", "stop"],
  ["循环", "loop"],
  ["单次", "once"],
  ["音量", "volume"],
  ["时长", "duration"],
  // Playback state. `pause` freezes at the current position; `play` resumes
  // from there, and `enable` is the one that restarts from the beginning.
  ["暂停", "pause"],
  ["静音", "mute"],
  // Effect / Video playback rate, with the same relative / absolute split as
  // `scale` and `scaleTo`. Effect also sizes its particles and their density.
  ["速度", "speed"],
  ["速度到", "speedTo"],
  ["尺寸", "size"],
  ["尺寸到", "sizeTo"],
  ["密度", "density"],
  ["密度到", "densityTo"],
  // A Video's two control sub-tracks. These are namespaces read through a dot
  // (`v.media.enable()`), the way `ch.transform.upleft()` already is.
  ["画面轨", "media"],
  ["声音轨", "audio"],
  // The eight points of a free transform, relative and absolute: `左上(…)`
  // moves that corner, `左上到(…)` puts it somewhere on the stage.
  ["左上", "upleft"],
  ["左上到", "upleftTo"],
  ["上", "up"],
  ["上到", "upTo"],
  ["右上", "upright"],
  ["右上到", "uprightTo"],
  ["右", "right"],
  ["右到", "rightTo"],
  ["右下", "downright"],
  ["右下到", "downrightTo"],
  ["下", "down"],
  ["下到", "downTo"],
  ["左下", "downleft"],
  ["左下到", "downleftTo"],
  ["左", "left"],
  ["左到", "leftTo"],
];

/** Chinese name → the name the runtime answers to. */
export const BUILTIN_ALIASES = new Map([...GLOBAL_ALIASES, ...METHOD_ALIASES]);

/**
 * Chinese names that stand for more than one English call.
 *
 * 「颜色」 is the picture's `hex` and a text's `color`. A receiver only answers
 * one of the two, so the lookup tries each in turn and the first the object
 * has wins — `hero.颜色(…)` reaches `hex`, `title.颜色(…)` reaches `color`.
 * The single-valued table above stays the canonical spelling (the one the
 * completion list and the canvas show): `hex` is called 「颜色」 as it always
 * was, and `color` is 「文字颜色」.
 */
const MULTI_ALIASES = new Map([
  ["颜色", ["hex", "color"]],
  ["色值", ["hex", "color"]],
]);

/**
 * The names a script may call without a receiver in front of them — every one
 * of them a call the stage owns, whether it is a type, the narrator or a stage
 * wide method. The set is only the language's vocabulary: `callStage` resolves
 * the name on the stage itself.
 */
export const BUILTIN_GLOBALS = new Set(GLOBAL_ALIASES.map(([, english]) => english));

/** The names an object may answer to after a dot. */
export const BUILTIN_METHODS = new Set(METHOD_ALIASES.map(([, english]) => english));

/**
 * The calls `stage` can make on behalf of several objects at once.
 *
 * `stage.enable(ch, bg)` is `ch.enable()` and `bg.enable()` written once: the
 * stage is the only receiver that stands for a *set* of objects, so a script
 * that sets up a scene does not have to repeat the same call per character.
 *
 * The value is the method's own fixed parameters, in order — the arguments
 * before the objects. They are what a named argument is matched against, so
 * `stage.scale(value = 2.0 : ch, bg)` reads as it would on a character. An
 * empty list means the method takes no parameters of its own, so every argument
 * is a target.
 *
 * The table is the contract: a word not in it is not a stage-wide call, which is
 * what keeps `stage.say(…)` — the narrator — out of it.
 *
 * A group built by `Array(…)` stands where the objects would: it is expanded
 * into its members, so `stage.blur(200 : ay1)` and `ay1.blur(200)` reach every
 * object the group holds.
 */
export const BULK_METHODS = Object.freeze({
  // Presence and order: no parameter of their own.
  enable: [],
  front: [],
  back: [],
  // A fade may name its duration, and that is all it takes.
  show: ["time"],
  hide: ["time"],
  // One number, and how long it takes to get there.
  scale: ["value", "time"],
  scaleTo: ["value", "time"],
  alpha: ["value", "time"],
  rotate: ["degrees", "time"],
  rotateTo: ["degrees", "time"],
  blur: ["value", "time"],
  brightness: ["value", "time"],
  contrast: ["value", "time"],
  saturate: ["value", "time"],
  // 三个坐标与一个时长：`moveTo(x, y, z, time)`，z 可以省略。
  move: ["x", "y", "z", "time"],
  moveTo: ["x", "y", "z", "time"],
  // Three channels, and a duration.
  rgb: ["r", "g", "b", "time"],
  rgbTo: ["r", "g", "b", "time"],
  // Sound: the object is the track, so the call has nothing else to say.
  play: [],
  stop: [],
  loop: [],
  once: [],
  // Playback and particle state shared by Effect and Video.
  pause: [],
  mute: ["value"],
  speed: ["value", "time"],
  speedTo: ["value", "time"],
  size: ["value", "time"],
  sizeTo: ["value", "time"],
  density: ["value", "time"],
  densityTo: ["value", "time"],
});

/**
 * The stage calls that take two variadic lists instead of parameters.
 *
 * `stage.exclude(灯1, 灯2 : ch, bg)` is the colon the language already uses for
 * a batch call, read one step further: the list before it is the set of lights
 * this call is about, and the list after it is what those lights leave alone.
 * Neither side may be empty — a light that lights nothing is not a light — so
 * the call always names both.
 *
 * The value is the name of the first list, for the message a writer sees when
 * they put the colon in the wrong place. A method in this table is answered
 * before `BULK_METHODS` and before the stage's own methods, because its first
 * list is objects rather than parameters.
 */
export const VARIADIC_CALLS = Object.freeze({
  exclude: "光源",
  unexclude: "光源",
});

/**
 * Whether `value` is one of the engine's objects rather than a plain value.
 *
 * Every host object carries a `kind` naming what it is (`Character`,
 * `Background`, `Audio`, `Stage`, `Dialog`, and `Array` for a group of them);
 * nothing a script computes itself has one. That is what lets a target be told
 * from a parameter without counting positions — `stage.hide(ch, bg)` has no
 * `time`, and nothing has to stand in for it.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isHostObject(value) {
  return Boolean(value) && typeof value === "object" && typeof value.kind === "string";
}

/**
 * The English name a builtin is known by, or `name` itself when it is already
 * English (or is not a builtin at all).
 *
 * @param {string} name
 * @returns {string}
 */
export function englishNameFor(name) {
  return BUILTIN_ALIASES.get(name) ?? name;
}

/**
 * The parameter names of every call a script can make by name.
 *
 * This is what makes a named argument — `Character("ch.png", x = 300)` —
 * mean something: the name is turned into a position in this list, and the
 * call is then made exactly as if the arguments had been written in order with
 * the gaps left empty. The first name is always the one positional argument
 * that stays in place (`source` for a constructor, the text for `say`), which
 * is why `Character("ch.png")` means what it always did.
 *
 * A dotted key (`Character.say`) is used when the same method name means
 * different things on different receivers: `say` takes a name slot on `dialog`
 * and none on a character. The bare key is the fallback.
 *
 * Order is the call's own order, not an alphabetical one — the two must agree
 * or a named argument would land on the wrong parameter.
 */
export const PARAM_SPECS = {
  // --- constructors (methods of the stage) ---
  // A bare `Character(…)` and `stage.Character(…)` share this one spec: the
  // stage is the receiver, and the constructor is the method it answers to.
  //
  // `x` / `y` place the object on the stage (the origin is its centre). There is
  // no `xTo` / `yTo` here: a fresh object is already at (0, 0), so offsetting it
  // would be the same number as placing it — two spellings of one thing.
  Background: [
    "source", "x", "y", "scale", "scaleTo",
    "rotation", "rotateTo", "alpha", "blur", "brightness", "contrast", "saturate", "time",
    "z", "rotateH", "rotateV",
  ],
  Character: [
    "source", "x", "y", "scale", "scaleTo",
    "rotation", "rotateTo", "alpha", "blur", "brightness", "contrast", "saturate", "time", "name",
    "z", "rotateH", "rotateV",
  ],
  Audio: ["source", "volume", "loop"],
  // An effect's first argument is a built-in kind (`rain` / `snow`), not a path.
  Effect: ["source", "scale", "size", "density", "speed", "alpha"],
  // A video reads `assets/Video/`. It starts muted so a script-driven start is
  // not refused by the webview's autoplay policy; `mute = false` opts in.
  Video: ["source", "volume", "loop", "mute"],
  // 文字不读素材：第一个参数就是显示的文本，随后是位置、字号、颜色，
  // 以及与图片共用的缩放 / 旋转 / 透明度。文本里的换行直接写 `\n`。
  Text: [
    "text", "x", "y", "size", "color",
    "scale", "scaleTo", "rotation", "rotateTo", "alpha", "time",
    "z", "rotateH", "rotateV",
  ],
  // 光源不读素材：第一个参数是颜色，随后是强度、位置与演出参数。顺序即位置
  // 参数的顺序，所以最常写的四个排在最前面，其余用参数名写更清楚。
  Light: [
    "color", "intensity", "x", "y",
    "alpha", "spread", "range", "bloom", "soft",
    "z", "rotateH", "rotateV", "rotate", "width", "time",
  ],

  // --- globals ---
  say: ["text", "time", "audio"],
  "Stage.say": ["text", "time", "audio"],
  "Dialog.say": ["text", "name", "time", "audio"],
  // 舞台的点击位置与自动计时等待：都只有一个时间参数。
  "Stage.click": ["time"],
  "Stage.auto": ["time"],
  // 自动配音开关与播放速度：true 时为没有显式配音的 say 自动配一段合成效果音；
  // 整数参数表示播放速度（次/秒，1–10，默认 10），0 表示关闭。
  autoVoice: ["on"],
  "Stage.autoVoice": ["on"],

  // --- stage objects ---
  enable: [],
  disable: [],
  hide: ["time"],
  show: ["time"],
  alpha: ["value", "time"],
  // HVD 三轴：H 平轴（横向）、V 升轴（纵向）、D 推轴（深度）。参数名沿用
  // `dx/dy/dz` 与 `x/y/z`，`h/hTo/v/vTo/z/zTo` 是同一批调用更精确的拼写。
  move: ["dx", "dy", "dz", "time"],
  moveTo: ["x", "y", "z", "time"],
  rotate: ["degrees", "time"],
  rotateTo: ["degrees", "time"],
  scale: ["value", "time"],
  scaleTo: ["value", "time"],
  rgb: ["r", "g", "b", "time"],
  rgbTo: ["r", "g", "b", "time"],
  hex: ["hex", "time"],
  blur: ["value", "time"],
  brightness: ["value", "time"],
  contrast: ["value", "time"],
  saturate: ["value", "time"],
  crossFade: ["path", "time"],
  step: ["frame"],
  key: ["file", "time"],

  // --- 逐帧图片组：背景与角色共用这几个名字 ---
  // `group` 是变长的（`group("a.png", "b.png", …)`），所以没有签名，参数一个一个
  // 按位置传；`add` / `remove` / `update` / `pause` 同理，位置或图名都由运行时读。
  fps: ["value", "loop"],
  element: ["index"],
  front: [],
  back: [],
  name: ["value"],
  // 文字字体：一个名字同时作用于中文与西文，空字符串回到内置的默认字体。
  font: ["family"],
  // 文字字重：CSS 的数值刻度，400 是常规，700 是粗体。
  weight: ["value"],
  // 文字颜色：任何 CSS 颜色字符串，可带时长过渡。与图片的 `hex`（染色滤镜）
  // 是两回事，所以两个名字分开，参数表里也各自独立。
  color: ["value", "time"],
  transform: [],
  // 光照：每盏灯自己的数值，写法与滤镜一致——一个值，一个时长。
  intensity: ["value", "time"],
  spread: ["value", "time"],
  range: ["value", "time"],
  bloom: ["value", "time"],
  soft: ["value", "time"],
  // 三轴的单轴控制：相对用 `x` / `y` / `z`，绝对用 `xTo` / `yTo` / `zTo`。
  // `z` 已从「绝对深度」改为「相对深度」，原来的 `hero.z(200)` 请用 `zTo(200)`。
  x: ["dx", "time"],
  y: ["dy", "time"],
  z: ["dz", "time"],
  xTo: ["x", "time"],
  yTo: ["y", "time"],
  zTo: ["z", "time"],
  // HVD 拼写：H = x（平轴）、V = y（升轴）、D = z（推轴）。参数槽位与 x/y 共用，
  // 所以 `h(h = 10)`、`h(横 = 10)`、`h(x = 10)` 都落在同一个位置。
  h: ["dx", "time"],
  v: ["dy", "time"],
  hTo: ["x", "time"],
  vTo: ["y", "time"],
  // 每个对象自己的三维坐标轴：默认 false，`crood(true)` 打开。
  crood: ["value"],
  // 透光：默认按类型定（角色 false，其余 true），`translucent(true)` 打开。
  translucent: ["value"],
  // 轮廓光强度 0–1，默认 0：`rim(0.8)` 才勾边。
  rim: ["value"],
  // 抗锯齿：角色缩放时怎么取像素。强度 0–2，默认 0（关）：`aa(1)` 连内部一起
  // 柔化，`eaa(1)` 只柔化轮廓。
  aa: ["value"],
  eaa: ["value"],
  // 转角：`rotate` 在 W 面里转，`rotateH` / `rotateV` 转出 W 面。
  // 前两个对象与灯共用；图片还有 `...To` 那种绝对写法。
  rotateH: ["degrees", "time"],
  rotateV: ["degrees", "time"],
  rotateHTo: ["degrees", "time"],
  rotateVTo: ["degrees", "time"],
  // 两个角一起写：`方向(35, 60)` 是 H 面角与 V 面角。
  direction: ["rotateH", "rotateV", "time"],
  // 环境亮度是舞台自己的一个数，没有对象。
  ambient: ["value"],
  // 舞台的两把空间尺子：透视开关，以及参考线的开关与间隔。
  "Stage.perspective": ["value"],
  perspective: ["value"],
  "Stage.guideline": ["value", "interval"],
  guideline: ["value", "interval"],
  // 开场动画不接受参数，时长固定；它是舞台自己的一次动作而不是对象方法。
  "Stage.pamela": [],
  pamela: [],

  // --- sound ---
  play: ["time"],
  stop: ["time"],
  loop: [],
  once: [],
  volume: ["value", "time"],
  duration: [],

  // --- effect / video ---
  // Unlike `Audio.play(time)`, these take no argument: `play` resumes from the
  // current position and `enable` is what restarts from the beginning.
  "Effect.play": [],
  "Video.play": [],
  "VideoMedia.play": [],
  "VideoAudio.play": [],
  pause: [],
  mute: ["value"],
  speed: ["value", "time"],
  speedTo: ["value", "time"],
  size: ["value", "time"],
  sizeTo: ["value", "time"],
  density: ["value", "time"],
  densityTo: ["value", "time"],

  // --- free transform ---
  upleft: ["dx", "dy", "time"], upleftTo: ["x", "y", "time"],
  up: ["dx", "dy", "time"], upTo: ["x", "y", "time"],
  upright: ["dx", "dy", "time"], uprightTo: ["x", "y", "time"],
  right: ["dx", "dy", "time"], rightTo: ["x", "y", "time"],
  downright: ["dx", "dy", "time"], downrightTo: ["x", "y", "time"],
  down: ["dx", "dy", "time"], downTo: ["x", "y", "time"],
  downleft: ["dx", "dy", "time"], downleftTo: ["x", "y", "time"],
  left: ["dx", "dy", "time"], leftTo: ["x", "y", "time"],
};

/**
 * Every spelling of a parameter name, mapped to the names it may stand for.
 *
 * A parameter name is matched against the spec of the call it is written in, so
 * one table can serve both `Character(x = 1)` and `move(dx = 1)`: `横` heads
 * for the absolute slot when the call has one and for the relative slot when it
 * does not, which is exactly the `move` / `moveTo` split the language already
 * makes with its method names.
 */
const PARAM_ALIASES = new Map([
  ["源", ["source"]], ["资源", ["source"]], ["路径", ["source", "path"]],
  ["类型", ["source"]], ["特效名", ["source"]],
  ["图片", ["source"]], ["文件", ["source", "file"]], ["立绘", ["source"]],
  ["速度", ["speed", "value"]], ["速率", ["speed", "value"]],
  ["尺寸", ["size", "value"]], ["密度", ["density", "value"]],
  ["字号", ["size"]], ["字体大小", ["size"]],
  ["文件名", ["source", "file"]],
  ["source", ["source"]], ["src", ["source"]],
  ["横", ["x", "dx"]], ["横坐标", ["x", "dx"]], ["水平", ["x", "dx"]],
  ["纵", ["y", "dy"]], ["纵坐标", ["y", "dy"]], ["垂直", ["y", "dy"]],
  ["横向", ["dx"]], ["纵向", ["dy"]],
  // HVD 拼写：H = 横向（x / dx）、V = 纵向（y / dy）、D = 深度（z / dz）。
  // 与方法名 `h` / `v` / `z` 对齐，`move(h = 10)` 与 `move(dx = 10)` 同义。
  ["h", ["x", "dx"]], ["horizontal", ["x", "dx"]],
  ["v", ["y", "dy"]], ["vertical", ["y", "dy"]],
  ["depth", ["z", "dz"]],
  ["缩放", ["scale", "value"]], ["倍率", ["scale", "value", "scaleTo"]],
  ["缩放到", ["scaleTo"]],
  ["旋转", ["rotation", "degrees"]], ["角度", ["degrees", "rotation"]],
  ["旋转到", ["rotateTo"]],
  ["透明度", ["alpha", "value"]], ["不透明度", ["alpha", "value"]],
  ["opacity", ["alpha"]],
  ["模糊", ["blur"]], ["模糊度", ["blur"]],
  ["亮度", ["brightness"]], ["对比度", ["contrast"]], ["饱和度", ["saturate"]],
  ["时间", ["time"]], ["时长", ["time"]], ["毫秒", ["time"]],
  ["台词", ["text"]], ["文本", ["text"]], ["内容", ["text"]],
  // 逐帧图片组：序号从 0 起，既能写数字也能写图片名。
  ["序号", ["index", "value"]], ["索引", ["index", "value"]],
  ["位置", ["index", "value"]], ["顺序", ["index", "value"]],
  ["循环", ["loop"]],
  ["姓名", ["name", "value"]], ["名字", ["name", "value"]],
  ["音量", ["volume"]],
  ["红", ["r"]], ["绿", ["g"]], ["蓝", ["b"]],
  // 图片用 `hex` 调色，文字用 `color` 定颜色：同一个中文名在两种参数表里
  // 各落到自己有的那一个上。`Text.color` 管自己的颜色叫 `value`（与方法表
  // 一致），所以这两个名字最后还要能落到 `value`。
  ["颜色", ["color", "hex", "value"]], ["色值", ["hex", "color", "value"]],
  ["帧", ["frame"]],
  ["音频", ["audio"]],
  // 光照：参数名与上面的方法名一一对应，另有 `光色` 专指灯的颜色。
  ["光色", ["color"]],
  ["灯色", ["color"]],
  ["强度", ["intensity"]],
  ["散射", ["spread"]], ["散射角", ["spread"]], ["张角", ["spread"]],
  ["距离", ["range"]], ["传播距离", ["range"]], ["衰减区间", ["range"]],
  ["泛光", ["bloom"]], ["辉光", ["bloom"]],
  ["柔光", ["soft"]],
  ["宽度", ["width"]], ["灯宽", ["width"]],
  ["深度", ["z"]],
  ["水平面", ["rotateH"]], ["水平角", ["rotateH"]],
  ["方位", ["rotateH"]], ["方位角", ["rotateH"]],
  ["正立面", ["rotateV"]], ["垂直角", ["rotateV"]],
  ["仰角", ["rotateV"]], ["俯仰", ["rotateV"]],
]);

/**
 * The canonical name of a parameter as written, or null when the call has no
 * such parameter.
 *
 * A name that is already in the spec is taken as it is, so the English spelling
 * always works; anything else is looked up in `PARAM_ALIASES` and the first
 * candidate the spec actually has wins. Answering null rather than guessing is
 * what lets a typo be reported instead of silently filling a neighbour.
 *
 * @param {string} name The name as the script wrote it.
 * @param {string[]} spec The parameter names of the call.
 * @returns {string | null}
 */
export function canonicalParam(name, spec) {
  const written = String(name ?? "").trim();
  if (!written) return null;
  if (spec.includes(written)) return written;
  const candidates = PARAM_ALIASES.get(written);
  if (!candidates) return null;
  for (const candidate of candidates) {
    if (spec.includes(candidate)) return candidate;
  }
  return null;
}

/**
 * The parameter names of a call, for a receiver that knows its own kind.
 *
 * `kind` is the `kind` field a host object carries (`Character`, `Audio`,
 * `Dialog`, `Stage`); a dotted key is used when the method means something else
 * on that kind. Answering the bare method name as a fallback is what keeps
 * `move` one table for every object that has it.
 *
 * @param {unknown} receiver
 * @param {string} method
 * @returns {string[] | null}
 */
export function paramSpecOf(receiver, method) {
  const kind = receiver && typeof receiver === "object" ? receiver.kind : null;
  if (typeof kind === "string" && PARAM_SPECS[`${kind}.${method}`]) {
    return PARAM_SPECS[`${kind}.${method}`];
  }
  return PARAM_SPECS[method] ?? null;
}

/**
 * 布尔参数的读法：`true` / `1` 是开，`false` / `0` 是关。
 *
 * 写 `aa(1)` 与写 `aa(true)` 是一回事——布尔位置上的数字只可能是这两个意思，
 * 而写下 `1` 比数一遍 `true` 的字母省事。其余写法按真值判（`null`、空文本、
 * 没给值都算关），这样 `undefined` 仍然走各调用自己的默认值。
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function boolArg(value) {
  if (value === 1) return true;
  if (value === 0) return false;
  return Boolean(value);
}

/**
 * Turns a call's arguments into the positional list the host expects.
 *
 * A positional argument stays where it is; a named one is written into the slot
 * its name has in the spec, and the slots in between are left empty (the host
 * reads a missing argument as "not given"). Giving a name twice, or naming a
 * parameter that comes before a positional argument already written, is
 * reported rather than guessed at.
 *
 * @param {string[] | null} spec
 * @param {unknown[]} args Positional arguments, already evaluated.
 * @param {{ name: string, value: unknown }[]} named Named arguments.
 * @param {string} callable The name to report in an error.
 * @param {{ line: number, column?: number }} node
 * @returns {{ args: unknown[] } | { error: object }}
 */
export function applyNamedArgs(spec, args, named, callable, node) {
  // The message only: the interpreter adds the file and the position, which it
  // is the only one that knows.
  const fail = (message) => ({ error: { message } });
  if (!named || named.length === 0) {
    return { args };
  }
  if (!spec) {
    return fail(`${callable} 不接受参数名`);
  }
  const out = args.slice();
  const taken = new Set();
  for (const entry of named) {
    const canonical = canonicalParam(entry.name, spec);
    if (!canonical) {
      return fail(`${callable} 没有参数名 ${entry.name}（可用：${spec.join("、")}）`);
    }
    const at = spec.indexOf(canonical);
    if (at < args.length) {
      return fail(`${callable} 的第 ${at + 1} 个参数已经按位置给出，不能再写 ${entry.name} = …`);
    }
    if (taken.has(at)) {
      return fail(`${callable} 的参数 ${entry.name} 重复给出`);
    }
    taken.add(at);
    // Padding keeps the slots that were skipped empty rather than shifting the
    // ones after them: `f(y = 1)` must not become `f(1)`.
    while (out.length < at) out.push(undefined);
    out[at] = entry.value;
  }
  return { args: out };
}

/**
 * Runs a parsed program.
 *
 * @param {{ statements: Array<object> }} program
 * @param {object} [runtime]
 * @param {Record<string, (args: unknown[], context: object) => unknown>} [runtime.constructors]
 *   Factories a host may still inject, such as `Background`. The stage adopts
 *   them as its own methods for this run, so a host that supplies `globals.stage`
 *   (as `createStageGlobals` does) need not pass them at all. Kept for hosts and
 *   tests that build a run without a stage object.
 * @param {Record<string, unknown> | ((context: object) => Record<string, unknown>)} [runtime.globals]
 *   Values visible as bare names; the `stage` global owns every call that has no
 *   receiver, including the type constructors.
 * @param {(labels: string[], context: object) => Promise<number>} [runtime.choose]
 *   Shows a question and answers the index picked; `-1` means the run was
 *   dropped before anyone answered. A script that asks for a choice without
 *   one is reported rather than guessed at.
 * @param {(path: string) => Promise<string>} [runtime.readScene]
 *   Reads another script file for `include`, by the path as written. Without
 *   it an `include` is reported rather than skipped silently.
 * @param {string} [runtime.source]
 *   Where the script being run was written, reported on every error and
 *   replaced, while an included file plays, by that file's path.
 * @param {(node: { file: string | null, path: Array<number | string>,
 *   canSave: boolean }) => void} [runtime.onNode]
 *   Reports each node as it is reached, so a host can offer to save there.
 *   Called only once the run is live, never during a replay.
 * @param {(answer: { file: string | null, path: Array<number | string>,
 *   labels: string[], picked: number }) => void} [runtime.onChoice]
 *   Reports each answer the player gives, so a later save can replay it.
 * @param {{ target: string, choices: Array<{ key: string, picked: number }> }}
 *   [runtime.replay]
 *   Resumes at a saved node: the script is performed silently from the top
 *   until `target` is reached, following the recorded answers, and this run
 *   becomes live there. See `setReplay` on the stage.
 * @param {(node: object) => void} [runtime.onLive]
 *   Called at the moment a replay reaches its node and turns live.
 * @param {object} [runtime.context] The context the stage's globals are built
 *   with, and the one passed to every constructor. `assignee` is set to the
 *   variable being assigned before each statement runs, so a constructor can
 *   key itself on the name the script is binding it to.
 *   `pending` is the list the statements running right now report into:
 *   whatever a script starts through a host object — an image moving, for
 *   instance — is pushed there, and the interpreter waits for it before going
 *   on. The interpreter never looks inside those values, it only waits.
 * @param {() => boolean} [runtime.stopped] Asked before each statement; once it
 *   answers true the run gives up where it stands. A newer run uses it to end
 *   one that is part-way through a wait.
 * @param {(ms: number) => Promise<void>} [runtime.sleep]
 *   Waits `ms` milliseconds for a `cue`'s time and `wait(ms)`. A host may
 *   supply a controllable timer (tests release it by hand instead of waiting on
 *   the clock); the default is the platform timer, so a normal performance is
 *   unchanged.
 * @returns {Promise<{ value?: unknown, error?: object, stopped?: boolean }>}
 */
export async function interpret(program, runtime = {}) {
  const environment = new Map();
  const context = runtime.context ?? {};
  const constructors = runtime.constructors ?? {};
  /**
   * Factories a host still injects, adopted by the stage for this run.
   *
   * The stage's own types are already methods (see `createStageGlobals`), each
   * taking one value per parameter and closing over the context. An injected
   * factory keeps its old `(args, context)` shape, so it is wrapped into that
   * same method shape here: from this point every call — bare or dotted — is
   * one stage method resolved by one dispatch (`callStage`).
   */
  const stageTypes = new Map(
    Object.entries(constructors)
      .filter(([, factory]) => typeof factory === "function")
      .map(([name, factory]) => [name, (...args) => factory(args, context)]),
  );
  const choose = runtime.choose;
  const readScene = runtime.readScene;

  /**
   * The files `include` has entered, outermost first.
   *
   * Kept as the chain rather than a set so a cycle can name the way round it
   * took, which is what tells a writer which two files point at each other.
   */
  const includes = [];

  /**
   * Programs `include` has already entered, by path.
   *
   * A scene included from inside a loop used to be read from disk, tokenized and
   * parsed once per pass. One performance reads a file's text once, so the
   * parsed program is kept for the rest of the run; the cycle check above still
   * runs on every entry, because what it guards is the nesting, not the file.
   *
   * `run` hands its own map down, so a `jump` that lands back in a file the
   * performance already parsed reuses that parse instead of building it again.
   */
  const scenes = runtime.scenes instanceof Map ? runtime.scenes : new Map();

  /**
   * Where the statements running right now were written.
   *
   * The last name is what an error reports; a run that never includes anything
   * keeps the one the host gave, and one with no name still reports its line.
   */
  const sources = [runtime.source ?? null];
  const globals =
    typeof runtime.globals === "function" ? runtime.globals(context) : runtime.globals ?? {};
  const stopped = runtime.stopped ?? (() => false);
  let value;

  /**
   * Whether the statements running right now are meant to start together.
   *
   * A `cue` block asks for it, and a call made from one hands it on: the body
   * of a function called inside a block belongs to that block, so the block's
   * `wait` covers the body's actions like any others. It is kept here rather
   * than threaded through every expression, since no expression can change it.
   */
  let simultaneous = false;

  /** How many calls the statement running right now is nested inside. */
  let depth = 0;

  /**
   * How many `cue` blocks the statement running right now sits inside.
   *
   * A node inside one is not a place to save at: its statements start
   * together, so the position is a set of actions rather than one of them.
   */
  let cueDepth = 0;

  /** Numbers the calls made so far, to name a call's nodes. */
  let callSerial = 0;

  /** Reports each node reached, once the run is live. */
  const onNode = runtime.onNode ?? null;

  /**
   * The timer a `cue`'s time or `wait(ms)` holds on. Kept injectable so a test
   * can release it deterministically; without a host timer it is the platform
   * one, and the show waits for real as before.
   */
  const sleep = (ms) =>
    runtime.sleep ? runtime.sleep(ms) : new Promise((resolve) => setTimeout(resolve, ms));

  /** Reports each answer the player gives, so a save can replay it. */
  const onChoice = runtime.onChoice ?? null;

  /**
   * The node a loaded save resumes at, or `null` while the run is live.
   *
   * A replay is a restore that serialises nothing but the position: the script
   * is performed again from the top, silently and instantly (the stage knows
   * to skip lines and to take no time, see `setReplay`), until the node is
   * reached. Everything the earlier statements set — variables included — is
   * therefore already right when the run goes live.
   */
  let replay = runtime.replay ?? null;

  /** How many recorded answers a replay has consumed. */
  let replayed = 0;

  /** Whether the run has reached the saved node and is performing for real. */
  let live = !replay;

  /**
   * Whether this run is travelling to a moment to be looked at.
   *
   * The path editor runs a script up to the statement it is editing, and the
   * things a script does to *hold* a player — pausing, asking a question,
   * waiting for a click — are exactly what must not happen on the way there:
   * no user is present, and a run parked on a click would never arrive. So a
   * preview performs the statements that build the picture and skips the ones
   * that only exist to pace a performance.
   */
  const previewing = runtime.preview === true;

  /** Called when the run reaches its node; the stage stops replaying there. */
  const onLive = runtime.onLive ?? null;

  /**
   * How many statements this run has performed, against `MAX_STATEMENTS`.
   *
   * Counted for the whole run rather than per list, so a loop that calls a
   * function each time round is bounded by the same budget as one that does
   * not. A replay counts too: it is the same work, and a script that cannot
   * finish does not finish any faster for being replayed.
   */
  let performed = 0;

  /**
   * How deep the loop the statement running right now sits inside.
   *
   * `break` and `continue` are statements, not expressions, so this is all the
   * context they need — and it is why one written outside a loop can be
   * reported rather than quietly ending the script.
   */
  let loopDepth = 0;

  /**
   * Whether a list of statements ended in something that has to travel up.
   *
   * A nested list can end in any of the four ways a statement leaves early:
   * an error, a dropped run, a `return`, or the `break` / `continue` a loop
   * answers. Every caller that runs a nested list has to hand all of them on —
   * one left behind is a `break` that quietly does nothing, which is the kind
   * of defect that is difficult to locate in a script.
   *
   * Declared before the run starts, because `execute` is what uses it and the
   * run begins on the line below.
   */
  const interrupted = (result) =>
    Boolean(
      result.error || result.stopped || result.jumped || result.returned || result.broke || result.continued,
    );

  /**
   * Whether an expression's result means "stop here and hand it up": an error, a
   * stopped run, or a `jump` signal. Unlike `interrupted`, this does NOT treat a
   * `return` / `break` / `continue` as an early exit — those are normal outcomes
   * at expression level and would be mis-read as an abort.
   */
  const aborted = (result) => Boolean(result.error || result.stopped || result.jumped);

  const result = await execute(program?.statements ?? [], [], false);
  if (result.error || result.stopped || result.jumped) {
    return result;
  }
  // Still replaying means the run ended before it reached the saved node: the
  // host reports that rather than pretending the load worked.
  return { value, replayMissed: Boolean(replay) };

  /**
   * Performs a list of statements, with everything they start reported into
   * `batch`.
   *
   * Statements are performed one at a time and each waits for what it started
   * before the next begins — except under `together`, which is what a `cue`
   * block asks for: statements there are meant to start at the same moment, so
   * none of them waits for its own actions.
   *
   * `env` is where the statements look a name up, which is the run's own
   * environment unless a call has bound parameters of its own.
   */
  async function execute(
    statements,
    batch,
    together,
    env = environment,
    inFunction = false,
    path = [],
  ) {
    const outer = context.pending;
    const outerTogether = simultaneous;
    context.pending = batch;
    simultaneous = together;

    // The batch and the flag are the run's own state, so they are put back
    // however this list ends — including on `return`, which leaves the list
    // early without ending the run.
    try {
      for (let index = 0; index < statements.length; index += 1) {
        const statement = statements[index];
        if (stopped()) {
          return { stopped: true };
        }
        performed += 1;
        if (performed > MAX_STATEMENTS) {
          return errorAt(
            `这一轮执行的语句太多（超过 ${MAX_STATEMENTS} 条），可能是死循环`,
            statement,
          );
        }

        // Where this statement is, for a save to remember and a replay to find.
        const here = [...path, index];
        const at = {
          file: sources[sources.length - 1],
          path: here,
          // A statement inside a call or a `cue` block is not a position the
          // script stands at, so it is not a place to save either.
          canSave: !inFunction && cueDepth === 0,
        };
        if (!live) {
          if (nodeKey(at.file, here) === replay.target) {
            live = true;
            replay = null;
            onLive?.(at);
          }
        }
        if (live) {
          // The statement goes along with its position: a caller that wants to
          // stop somewhere in the script — the path editor travelling to a key —
          // needs to know *what* is about to run, and the position alone says
          // only which list it came from. The save system reads `at` and must
          // not see the node, so it is a second argument rather than a field.
          onNode?.(at, statement);
        }

        if (statement.type === "cue") {
          // What the block starts is kept in its own list, rather than mixed in
          // with the surrounding statements'.
          const started = [];
          cueDepth += 1;
          let inner;
          try {
            inner = await execute(statement.statements, started, true, env, inFunction, [
              ...here,
              "cue",
            ]);
          } finally {
            cueDepth -= 1;
          }
          if (interrupted(inner)) {
            return inner;
          }
          // `cue` hands the block's end on to the statements after it according to
          // its time. The started promises are a list of their own rather than a
          // part of the surrounding batch, so an action the block stops waiting
          // for keeps running on the stage — we never cancel it.
          let time = null;
          if (statement.time) {
            const measured = await evaluate(statement.time, env, runtime);
            if (aborted(measured)) {
              return measured;
            }
            time = Number(measured.value);
          }
          let held = null;
          if (statement.waitMs) {
            const measured = await evaluate(statement.waitMs, env, runtime);
            if (aborted(measured)) {
              return measured;
            }
            held = Number(measured.value);
          }
          // The closing `wait` outranks the time on the keyword: `cue(3000) { … }
          // wait 5000` holds for five seconds. A `wait` that names no time is the
          // older spelling of "hold until the block is over", and so is -1.
          // A replay travels rather than performs and a preview has no
          // audience to pace, so neither waits for the group to finish.
          if (
            (statement.wait && held === null) ||
            (held === null && time === -1)
          ) {
            if (live && !previewing) {
              await Promise.all(started);
            }
          } else {
            const hold = held ?? time;
            if (Number.isFinite(hold) && hold > 0 && live && !previewing) {
              // The group is under way. The script waits exactly this long and
              // then goes on, whether the actions are over or not: one still
              // running is not cut short, it just plays on alongside what
              // follows. A replay travels rather than performs, and a preview
              // has no audience to pace, so neither pays the wait.
              await sleep(hold);
            }
          }
          // No time and no `wait`: start the group and move on at once.
          continue;
        }

        // A declaration binds the name where it is written, at the moment it
        // runs: nothing is hoisted, so a call above one is a name the script has
        // not bound yet, and a call inside the body is how a function reaches
        // itself.
        if (statement.type === "func") {
          environment.set(statement.name, scriptFunction(statement));
          continue;
        }

        // A branch is just more statements, performed where the `if` stands: in
        // a `cue` block they join that block's batch, so the block's `wait`
        // covers animations started inside the branch as well.
        if (statement.type === "if") {
          const tested = await evaluate(statement.test, env, runtime);
          if (aborted(tested)) {
            return tested;
          }
          if (typeof tested.value !== "boolean") {
            return errorAt(`if 的条件需要布尔值，得到${typeOf(tested.value)}`, statement);
          }
          const branch = tested.value ? statement.then : statement.otherwise;
          if (branch && branch.length) {
            const inner = await execute(branch, batch, together, env, inFunction, [
              ...here,
              tested.value ? "then" : "else",
            ]);
            // A branch can leave early in any of the four ways, and all of them
            // belong to whoever wrote the `if` — a `break` inside one breaks the
            // loop around the `if`, not the branch.
            if (interrupted(inner)) {
              return inner;
            }
          }
          continue;
        }

        // `return` leaves the function, not the run: the caller turns it into
        // the call's value. Outside a function there is nothing to leave, so it
        // is reported rather than quietly ending the script.
        if (statement.type === "return") {
          if (!inFunction) {
            return errorAt("return 只能写在函数里", statement);
          }
          const returned = statement.value
            ? await evaluate(statement.value, env, runtime)
            : { value: null };
          if (aborted(returned)) {
            return returned;
          }
          return { returned: { value: returned.value } };
        }

        // `include` plays another script file where the statement stands, as if
        // its statements were written here: names it declares stay declared, and
        // what it starts joins the batch this statement belongs to. The file's
        // own top level counts as a script top level, so a `return` in it is
        // reported rather than returning from whoever included it.
        if (statement.type === "include") {
          if (typeof readScene !== "function") {
            return errorAt("当前环境不能读取其他脚本，include 不可用", statement);
          }
          const path = statement.path;
          if (includes.includes(path)) {
            return errorAt(`脚本互相包含：${[...includes, path].join(" → ")}`, statement);
          }
          if (includes.length >= MAX_INCLUDE_DEPTH) {
            return errorAt(`脚本嵌套太深（超过 ${MAX_INCLUDE_DEPTH} 层）`, statement);
          }
          let parsed = scenes.get(path);
          if (!parsed) {
            let source;
            try {
              source = await readScene(path);
            } catch (error) {
              const reason = error instanceof Error ? error.message : String(error);
              return errorAt(`读不到脚本 ${path}：${reason}`, statement);
            }
            const scanned = tokenize(source);
            if (scanned.error) {
              return { error: { ...scanned.error, file: path } };
            }
            const built = parse(scanned.tokens);
            if (built.error) {
              return { error: { ...built.error, file: path } };
            }
            parsed = built.program;
            scenes.set(path, parsed);
          }
          includes.push(path);
          sources.push(path);
          // The included file's top level is a top level: a `break` written in
          // it belongs to a loop in that file, not to the loop the `include`
          // happens to sit inside. `inFunction` is reset for the same reason
          // (see the comment above), and the loop count follows it.
          const outerLoopDepth = loopDepth;
          loopDepth = 0;
          try {
            const inner = await execute(parsed.statements, batch, together, env, false, [
              ...here,
              "include",
            ]);
            if (interrupted(inner)) {
              return inner;
            }
          } finally {
            loopDepth = outerLoopDepth;
            includes.pop();
            sources.pop();
          }
          continue;
        }

        // `use` swaps the dialogue style the rest of the run performs in: the box
        // the player reads from changes from here on (a "voice" or "inner thought"
        // look, say). The path is an expression — a literal, a variable, a join —
        // evaluated to a non-empty string, then handed to the host, which reads and
        // applies the style. It is a side effect, not a value, so the run goes on.
        if (statement.type === "use") {
          const evaluated = await evaluate(statement.target, env, runtime);
          if (aborted(evaluated)) {
            return evaluated;
          }
          const target = evaluated.value;
          if (typeof target !== "string" || !target.trim()) {
            return errorAt("use 的目标必须是一个非空的样式文件路径", statement);
          }
          if (typeof runtime.useStyle !== "function") {
            return errorAt("当前环境不支持切换对话样式", statement);
          }
          try {
            await runtime.useStyle(target);
          } catch (error) {
            return errorAt(error instanceof Error ? error.message : String(error), statement);
          }
          continue;
        }

        // A question blocks the script until one answer is picked, then the
        // block under that answer runs where the `choice` stands, like an `if`
        // branch. The dialogue box is not touched: hiding it is the script's own
        // call, through `dialog.enable` / `dialog.disable`.
        if (statement.type === "choice") {
          // The labels are evaluated once, where the question is put up, and
          // only their text is shown. A replay still evaluates them: the
          // question is never drawn, but the branch taken has to be the one the
          // save recorded, and the labels are part of what the player was
          // choosing between.
          const labels = [];
          for (const option of statement.options) {
            const shown = await evaluate(option.label, env, runtime);
            if (aborted(shown)) {
              return shown;
            }
            if (typeof shown.value !== "string") {
              return errorAt(
                `选择支的标签需要文本，得到${typeOf(shown.value)}；数字请用 str(数字)`,
                option.label,
              );
            }
            labels.push(shown.value);
          }
          let picked;
          if (!live) {
            // A replay follows the answers the save recorded: the branch taken
            // then has to be the branch taken now, or the two scripts are not
            // the same script and resuming would land somewhere else.
            const record = replay.choices[replayed];
            if (!record || record.key !== nodeKey(at.file, here)) {
              return errorAt("存档与当前剧本对不上：选择支的位置不同", statement);
            }
            picked = record.picked;
            replayed += 1;
          } else {
            if (typeof choose !== "function") {
              return errorAt("当前环境不支持选择支", statement);
            }
            try {
              picked = await choose(labels, context);
            } catch (error) {
              return errorAt(error instanceof Error ? error.message : String(error), statement);
            }
            // The stage answered `-1`: the run was dropped while the question
            // was up, so there is nothing left to play.
            if (!(picked >= 0)) {
              return { stopped: true };
            }
            if (!Number.isInteger(picked) || picked >= statement.options.length) {
              return errorAt(`选择支回答了不存在的序号：${picked}`, statement);
            }
            // A save made later replays this answer, so the run keeps it.
            onChoice?.({ file: at.file, path: here, labels, picked });
          }
          const branch = statement.options[picked].statements;
          if (branch.length) {
            const inner = await execute(branch, batch, together, env, inFunction, [
              ...here,
              `option-${picked}`,
            ]);
            if (interrupted(inner)) {
              return inner;
            }
          }
          continue;
        }
        // A loop is the same shape as an `if` that repeats: the body is
        // performed where the `while` stands, in the same batch, so a `wait`
        // outside it still covers what the last round started. `break` and
        // `continue` is returned as a signal on the result, as `return` is,
        // and are answered here rather than by the loop's body.
        if (statement.type === "while") {
          loopDepth += 1;
          try {
            for (;;) {
              // An empty body — or one that stops early — never reaches the
              // per-statement check, so a turn round the loop is counted here
              // as well: `while true { }` has to be reported, not hang.
              performed += 1;
              if (performed > MAX_STATEMENTS) {
                return errorAt(
                  `这一轮执行的语句太多（超过 ${MAX_STATEMENTS} 条），可能是死循环`,
                  statement,
                );
              }
              if (stopped()) {
                return { stopped: true };
              }
              const tested = await evaluate(statement.test, env, runtime);
              if (aborted(tested)) {
                return tested;
              }
              if (typeof tested.value !== "boolean") {
                return errorAt(
                  `while 的条件需要布尔值，得到${typeOf(tested.value)}`,
                  statement,
                );
              }
              if (!tested.value) {
                break;
              }
              if (statement.statements.length) {
                const inner = await execute(statement.statements, batch, together, env, inFunction, [
                  ...here,
                  "loop",
                ]);
                if (inner.error || inner.stopped || inner.returned || inner.jumped) {
                  return inner;
                }
                // `continue` is the loop going round again, which is what the
                // top of `for (;;)` does — so nothing has to be done with it.
                if (inner.broke) {
                  break;
                }
              }
            }
          } finally {
            loopDepth -= 1;
          }
          continue;
        }

        if (statement.type === "for") {
          loopDepth += 1;
          try {
            const source = await evaluate(statement.source, env, runtime);
            if (aborted(source)) {
              return source;
            }
            const collection = source.value;
            const items = [];
            if (isArray(collection)) {
              for (const member of collection[ARRAY]) {
                items.push(member);
              }
            } else if (collection && typeof collection === "object" && LIST in collection) {
              for (const item of collection[LIST]) {
                items.push(item);
              }
            } else if (collection && typeof collection === "object" && DICT in collection) {
              for (const key of collection[DICT].keys()) {
                items.push(key);
              }
            } else if (typeof collection === "string") {
              for (const char of collection) {
                items.push(char);
              }
            } else {
              return errorAt(
                `for 需要一个列表、字典、对象组或文本，得到${typeOf(collection)}`,
                statement,
              );
            }
            for (const item of items) {
              performed += 1;
              if (performed > MAX_STATEMENTS) {
                return errorAt(
                  `这一轮执行的语句太多（超过 ${MAX_STATEMENTS} 条），可能是死循环`,
                  statement,
                );
              }
              if (stopped()) {
                return { stopped: true };
              }
              env.set(statement.name, item);
              if (statement.statements.length) {
                const inner = await execute(
                  statement.statements,
                  batch,
                  together,
                  env,
                  inFunction,
                  [...here, "loop"],
                );
                if (inner.error || inner.stopped || inner.returned || inner.jumped) {
                  return inner;
                }
                if (inner.broke) {
                  break;
                }
              }
            }
          } finally {
            loopDepth -= 1;
          }
          continue;
        }

        if (statement.type === "switch") {
          const value = await evaluate(statement.value, env, runtime);
          if (aborted(value)) {
            return value;
          }
          let branch = statement.otherwise ?? [];
          let matchedIndex = -1;
          for (let switchIndex = 0; switchIndex < statement.cases.length; switchIndex += 1) {
            const option = statement.cases[switchIndex];
            const test = await evaluate(option.test, env, runtime);
            if (aborted(test)) {
              return test;
            }
            const matched = applyOperator("==", value.value, test.value, statement);
            if (matched.error) {
              return matched;
            }
            if (matched.value === true) {
              branch = option.statements;
              matchedIndex = switchIndex;
              break;
            }
          }
          if (branch && branch.length) {
            const subPath = matchedIndex >= 0 ? `case-${matchedIndex}` : "default";
            const inner = await execute(
              branch,
              batch,
              together,
              env,
              inFunction,
              [...here, subPath],
            );
            if (interrupted(inner)) {
              return inner;
            }
          }
          continue;
        }

        // `break` and `continue` are only meaningful inside a loop, and the
        // parser cannot say so: a function body written inside a loop may be
        // called from outside one, and vice versa. The count is the loop it is
        // actually running in.
        if (statement.type === "break" || statement.type === "continue") {
          if (loopDepth === 0) {
            return errorAt(`${statement.type} 只能写在循环里`, statement);
          }
          if (statement.type === "break") {
            return { broke: true };
          }
          return { continued: true };
        }

        // A wait on its own is a pause, not a block: `wait 500` holds the script
        // for half a second. It joins the batch like any other action, so a
        // `cue` containing one starts it alongside its siblings rather than
        // inside them.
        if (statement.type === "wait") {
          if (!(Number.isFinite(statement.ms) && statement.ms >= 0)) {
            return errorAt("wait 需要一个不小于 0 的毫秒数", statement);
          }
          // A preview is travelling, not performing: a pause exists to pace a
          // scene for a player, and no user is present to pace it. The
          // statement still counts as performed; it just does not hold.
          if (statement.ms > 0 && !previewing) {
            batch.push(sleep(statement.ms));
          }
          if (!together && batch.length) {
            await Promise.all(batch.splice(0, batch.length));
          }
          continue;
        }

        // Objects a script builds may keep a stable identity: the name an
        // assignment binds to. Rebuilding the same variable therefore replaces
        // whatever the previous value put on the stage, rather than adding to it.
        context.assignee = statement.type === "assign" ? statement.name : undefined;
        const result = await evaluate(statement.value, env, runtime);
        if (aborted(result)) {
          return result;
        }
        if (statement.type === "assign") {
          if (statement.op) {
            // `x += 1` reads as `x = x + 1`, with the operator's own type rules
            // and its own error message. The name has to be bound already: a
            // compound assignment is a change to a value, not a way to make one.
            const where = binding(env, statement.name);
            if (!where) {
              return errorAt(`未定义的变量：${statement.name}`, statement);
            }
            const combined = applyOperator(
              statement.op,
              where.get(statement.name),
              result.value,
              statement,
            );
            if (combined.error) {
              return combined;
            }
            environment.set(statement.name, combined.value);
            // What the statement leaves behind is the combined value, not the
            // right-hand side: `x = 1; x += 1` is worth 2, not 1.
            value = combined.value;
            if (!together && batch.length) {
              await Promise.all(batch.splice(0, batch.length));
            }
            continue;
          }
          environment.set(statement.name, result.value);
        }
        value = result.value;

        if (!together && batch.length) {
          await Promise.all(batch.splice(0, batch.length));
        }
      }

      return {};
    } finally {
      context.pending = outer;
      simultaneous = outerTogether;
    }
  }

  /**
   * The environment a bare name is bound in, or `null` when nothing binds it.
   *
   * A call binds its own arguments in an environment of its own, and that is
   * looked in first; the run's environment stands behind it, so the body of a
   * function sees every name the script bound before the call. Those are the
   * only two: parameters are the only names in the language that can hide
   * anything, since nothing else opens a scope.
   */
  function binding(env, name) {
    if (env.has(name)) {
      return env;
    }
    return env !== environment && environment.has(name) ? environment : null;
  }

  /**
   * The binding of a name, or of the English builtin its Chinese spelling names.
   *
   * The script's own names are tried first and untouched: a writer who binds
   * `说 = 1` reads their own `说` back, and only a name nothing bound falls
   * through to the table. Answers the environment and the key to read, since the
   * two may differ (`说` reading the binding of `say`).
   */
  function bindingOf(env, name) {
    const direct = binding(env, name);
    if (direct) {
      return { where: direct, key: name };
    }
    const alias = BUILTIN_ALIASES.get(name);
    if (alias) {
      const other = binding(env, alias);
      if (other) {
        return { where: other, key: alias };
      }
    }
    return null;
  }

  async function evaluate(node, env, rt) {
    switch (node.type) {
      case "literal":
        return { value: node.value };

      case "template": {
        // A string with interpolations: each literal fragment is copied as-is, each
        // expression is evaluated and turned into text with `str` — the same rule a
        // `+ str(...)` join follows — so the language never converts silently.
        let text = "";
        for (const part of node.parts) {
          if (part.literal !== undefined) {
            text += part.literal;
          } else {
            const value = (await evaluate(part.expr, env, rt)).value;
            text += BUILTINS.str(value);
          }
        }
        return { value: text };
      }

      case "identifier": {
        const found = bindingOf(env, node.name);
        if (found) {
          return { value: found.where.get(found.key) };
        }
        if (Object.hasOwn(globals, node.name)) {
          return { value: globals[node.name] };
        }
        // A Chinese name may stand for a global the host offered in English —
        // `对话框` for `dialog` — so the spelling is translated before the miss
        // is reported.
        const alias = BUILTIN_ALIASES.get(node.name);
        if (alias && Object.hasOwn(globals, alias)) {
          return { value: globals[alias] };
        }
        return errorAt(`未定义的变量：${node.name}`, node);
      }

      case "member": {
        const object = await evaluate(node.object, env, rt);
        if (object.error || object.stopped) {
          return object;
        }
        return readMember(object.value, node.name, node);
      }

      case "list": {
        const items = [];
        for (const element of node.elements) {
          const value = await evaluate(element, env, rt);
          if (aborted(value)) {
            return value;
          }
          items.push(value.value);
        }
        return { value: { [LIST]: items } };
      }

      case "dict": {
        const map = new Map();
        for (const entry of node.entries) {
          const key = await evaluate(entry.key, env, rt);
          if (aborted(key)) {
            return key;
          }
          const value = await evaluate(entry.value, env, rt);
          if (aborted(value)) {
            return value;
          }
          map.set(key.value, value.value);
        }
        return { value: { [DICT]: map } };
      }

      case "index": {
        const object = await evaluate(node.object, env, rt);
        if (aborted(object)) {
          return object;
        }
        const lower = node.lower === null ? null : await evaluate(node.lower, env, rt);
        if (lower !== null && aborted(lower)) {
          return lower;
        }
        return readIndex(object.value, lower === null ? null : lower.value, node);
      }

      case "slice": {
        const object = await evaluate(node.object, env, rt);
        if (aborted(object)) {
          return object;
        }
        const lower = node.lower === null ? null : (await evaluate(node.lower, env, rt)).value;
        const upper = node.upper === null ? null : (await evaluate(node.upper, env, rt)).value;
        return readSlice(object.value, lower, upper, node);
      }

      case "call":
        return await evaluateCall(node, env, rt);

      case "binary":
        return await evaluateBinary(node, env, rt);

      case "unary":
        return await evaluateUnary(node, env, rt);

      default:
        return errorAt("不支持的表达式", node);
    }
  }

  /**
   * The member `name` on `object`, or the English method its Chinese name stands
   * for.
   *
   * Translated only on a miss, so an object that already answers to the word
   * keeps its own answer and the table can never shadow a value.
   */
  function methodNamed(object, name) {
    const direct = object?.[name];
    if (direct !== undefined) {
      return direct;
    }
    // A word that names more than one call: ask for each until one answers.
    const candidates = MULTI_ALIASES.get(name);
    if (candidates) {
      for (const candidate of candidates) {
        const method = object?.[candidate];
        if (method !== undefined) {
          return method;
        }
      }
      return undefined;
    }
    const alias = BUILTIN_ALIASES.get(name);
    return alias === undefined ? undefined : object?.[alias];
  }

  /**
   * One stage-wide call: the same method on every object it names.
   *
   * `stage.enable(ch, bg)` is `ch.enable()` and `bg.enable()` written once, and
   * `stage.scale(2.0, 3000, ch, bg)` is `ch.scale(2.0, 3000)` and the same on
   * `bg`. The objects come after a `:` when the author wants the fixed
   * parameters cut short — `stage.scale(2.0 : ch, bg)` leaves `time` out
   * without a placeholder — and, without a colon, they are the trailing
   * arguments that are objects. Reading the values rather than counting
   * positions is what makes `stage.hide(ch, bg)` work with no `time` at all.
   *
   * The stage is answered rather than the last object, so a scene's setup still
   * chains.
   */
  async function callOnEach(stageValue, name, english, args, named, node, env, rt) {
    const spec = BULK_METHODS[english];
    const resolved = applyNamedArgs(spec, args, named, `stage.${english}`, node);
    if (resolved.error) {
      return errorAt(resolved.error.message, node);
    }

    const sources = [];
    if (node.objects?.length) {
      for (const expression of node.objects) {
        const result = await evaluate(expression, env, rt);
        if (aborted(result)) {
          return result;
        }
        sources.push(result.value);
      }
      if (resolved.args.length > spec.length) {
        return errorAt(`stage.${english} 的冒号前面多给了参数`, node);
      }
    } else {
      // No colon: take the run of objects at the end. A number stays a
      // parameter, so `stage.scale(2.0, ch)` needs nothing in `time`'s place.
      for (let at = resolved.args.length; at > 0; at -= 1) {
        if (!isHostObject(resolved.args[at - 1])) break;
        sources.unshift(resolved.args.pop());
      }
    }

    return applyOnEach(
      stageValue,
      sources,
      name,
      english,
      resolved.args,
      node,
      `stage.${english}`,
    );
  }

  /**
   * Spreads a group into its members, leaving everything else alone.
   *
   * A group stands for its objects wherever one is named, so a call naming a
   * group of lights means every light in it. Groups are already flat (a group
   * handed to a group is opened at build time), but walking as if they were not
   * costs nothing and cannot be surprised.
   */
  function flattenObjects(values) {
    const out = [];
    for (const value of values ?? []) {
      if (isArray(value)) {
        out.push(...flattenObjects([...value[ARRAY]]));
      } else {
        out.push(value);
      }
    }
    return out;
  }

  /**
   * A call with two variadic lists: `stage.exclude(灯1, 灯2 : ch, bg)`.
   *
   * The colon is the seam between the two sets, which is what the language
   * already uses it for in a batch call — the difference is that here the seam
   * has objects on both sides. Neither side may be empty: a light that lights
   * nothing is not a light, so the call always names both, and `unexclude`
   * (not an empty list) is how an exclusion is taken back.
   *
   * Nothing is inferred from position: the first list is read as lights and the
   * second as objects, and anything else is reported rather than guessed at.
   */
  async function callTwoLists(stageApi, name, english, args, named, node, env, rt) {
    if (named.length) {
      return errorAt(`${name} 不接受参数名`, node);
    }
    const method = stageApi?.[english];
    if (typeof method !== "function") {
      return errorAt(`“舞台”没有方法 ${name}`, node);
    }
    if (!node.objects?.length) {
      return errorAt(
        `${name} 要用冒号分开两组对象：${name}(${VARIADIC_CALLS[english]}, … : 对象, …)`,
        node,
      );
    }
    const lights = flattenObjects(args);
    if (!lights.length) {
      return errorAt(`冒号前面需要${VARIADIC_CALLS[english] ?? "对象"}`, node);
    }
    for (const value of lights) {
      if (value?.kind !== "Light") {
        return errorAt(`${name} 的冒号前面只能是光源`, node);
      }
    }
    const targets = [];
    for (const expression of node.objects) {
      const result = await evaluate(expression, env, rt);
      if (aborted(result)) {
        return result;
      }
      targets.push(...flattenObjects([result.value]));
    }
    for (const value of targets) {
      if (!isHostObject(value)) {
        return errorAt(`${name} 的冒号后面只能是舞台对象`, node);
      }
    }
    method.call(stageApi, lights, targets);
    return stageApi;
  }

  /**
   * `group.blur(200)`: the same batch call, written on the group itself.
   *
   * A group stands for its members wherever an object is named, so naming it as
   * the receiver is the shortest spelling of `stage.blur(200 : group)`. The
   * colon is refused here rather than obeyed: the objects of this call are the
   * members, and a second list would have to be silently ignored to mean
   * anything.
   */
  function callOnGroup(group, name, english, args, named, node) {
    if (node.objects?.length) {
      return errorAt(`${name} 的对象就是组里的成员，冒号后面不用再写对象`, node);
    }
    const resolved = applyNamedArgs(BULK_METHODS[english], args, named, name, node);
    if (resolved.error) {
      return errorAt(resolved.error.message, node);
    }
    return applyOnEach(group, [group], name, english, resolved.args, node);
  }

  /**
   * Runs `name` on every object `sources` stand for, and answers `receiver`.
   *
   * This is the one place a group is opened, and it is opened as a walk rather
   * than a copy: a member is visited by the set's own iterator and the call is
   * made straight away, so a batch over N members costs N calls and no list
   * built for the occasion. A source that is not a group is one member, which
   * is what keeps `stage.enable(ch, bg, group)` — members and loose objects
   * mixed — no special case.
   *
   * The first failure stops the run, exactly as it would for the calls written
   * out by hand.
   *
   * `subject` is the call as an error names it (`stage.blur` for the stage's
   * own spelling, the method's name for a group's), and the one thing the two
   * spellings report differently.
   */
  function applyOnEach(receiver, sources, name, english, fixedArgs, node, subject = name) {
    let called = 0;
    const failure = forEachObject(sources, (target) => {
      called += 1;
      // The name the author wrote first, then its English twin: an object may
      // answer to either, exactly as it would for a direct `ch.启用()`.
      const method = methodNamed(target, name) ?? methodNamed(target, english);
      if (typeof method !== "function") {
        return errorAt(`“${describe(target)}”没有方法 ${name}`, node);
      }
      // The fixed arguments are re-used for every object: a call is a call, and
      // `invoke` never lets a host method change the list it was handed.
      const result = invoke(method, target, fixedArgs.slice(), node);
      return result.error || result.jumped || result.stopped ? result : null;
    });
    if (failure) {
      return failure;
    }
    if (!called) {
      return errorAt(`${subject} 需要至少一个对象`, node);
    }
    return { value: receiver };
  }

  /**
   * Visits every object `sources` stand for, one group at a time.
   *
   * A group contributes its members in the order they were added and nothing
   * else: no allocation, no flattening into a working list, and no duplicate
   * check — a member is in the set once by construction.
   *
   * @returns {object | null} The first failure `visit` reported, or null.
   */
  function forEachObject(sources, visit) {
    for (const source of sources) {
      if (!isArray(source)) {
        const failure = visit(source);
        if (failure) {
          return failure;
        }
        continue;
      }
      for (const member of source[ARRAY]) {
        const failure = visit(member);
        if (failure) {
          return failure;
        }
      }
    }
    return null;
  }

  /**
   * One call owned by the stage.
   *
   * `stage.say(…)` and `say(…)` are the same call, and so are
   * `stage.Character(…)` and `Character(…)`: the bare spelling only leaves the
   * receiver out. Every bare call comes here, and so does a member call whose
   * receiver is the stage, so the types, the narrator, the stage-wide calls and
   * the language's own functions are all resolved in one place — on the one
   * object with the runtime's permission to make them.
   *
   * `stageApi` is the run's stage object, or null when the host offered none (a
   * test that injects factories directly, for instance). It is the receiver of
   * the call, never a name a script has to bind first.
   *
   * @returns {Promise<object | null>} The call's result, or null when the stage
   *   answers no such name — the caller then reports the word as unknown.
   */
  async function callStage(stageApi, name, args, named, node, env, rt) {
    const alias = BUILTIN_ALIASES.get(name);
    for (const candidate of alias && alias !== name ? [name, alias] : [name]) {
      // A type the stage builds. Injected factories come first, so a host that
      // still supplies them keeps the precedence it always had.
      const type = stageTypes.get(candidate);
      if (type) {
        return callStageMethod(stageApi, type, candidate, args, named, node);
      }
      // Two variadic lists: the first list is objects (lights), not parameters,
      // so it is read before the batch table and before the stage's own methods.
      if (stageApi && Object.hasOwn(VARIADIC_CALLS, candidate)) {
        return callTwoLists(stageApi, name, candidate, args, named, node, env, rt);
      }
      // A bulk call needs a stage to answer on the objects' behalf, even when
      // the script left the receiver out: `enable(ch, bg)` is `stage.enable(…)`.
      if (stageApi && Object.hasOwn(BULK_METHODS, candidate)) {
        return callOnEach(stageApi, name, candidate, args, named, node, env, rt);
      }
      // The stage's own methods — the narrator, and the constructors it owns.
      const method = stageApi?.[candidate];
      if (typeof method === "function") {
        return callStageMethod(stageApi, method, candidate, args, named, node);
      }
      // The language's own functions are reachable through the stage as well:
      // `stage.str(7)` is `str(7)`, and `stage.Array(ch, bg)` builds a group.
      if (Object.hasOwn(BUILTINS, candidate)) {
        if (named.length) {
          return errorAt(`${candidate} 不接受参数名`, node);
        }
        return invoke(BUILTINS[candidate], undefined, args, node);
      }
    }
    return null;
  }

  /**
   * Calls one of the stage's methods, constructors included.
   *
   * A constructor's parameter names are its own (`Character`'s `source`, `x`…),
   * and a Chinese spelling is answered by the English method's spec. The stage
   * stays the receiver, so a method that chains answers the stage back.
   */
  function callStageMethod(stageApi, method, candidate, args, named, node) {
    const spec =
      (stageApi ? paramSpecOf(stageApi, candidate) : null) ??
      PARAM_SPECS[candidate] ??
      PARAM_SPECS[englishNameFor(candidate)] ??
      null;
    const resolved = applyNamedArgs(spec, args, named, candidate, node);
    if (resolved.error) {
      return errorAt(resolved.error.message, node);
    }
    return invoke(method, stageApi ?? undefined, resolved.args, node);
  }

  /**
   * A host function a script bound itself keeps the old factory shape: it is
   * handed the whole argument list and the run's context, not one value per
   * parameter. This is the one call shape the stage does not own.
   */
  function callHostFactory(factory, candidate, args, named, node) {
    const spec = PARAM_SPECS[candidate] ?? PARAM_SPECS[englishNameFor(candidate)] ?? null;
    const resolved = applyNamedArgs(spec, args, named, candidate, node);
    if (resolved.error) {
      return errorAt(resolved.error.message, node);
    }
    return invoke(factory, undefined, [resolved.args, context], node);
  }

  /**
   * One call made on an object — `obj.method(...)` — with `this` bound to it.
   *
   * Kept apart from `evaluateCall` so that a chain can wait between its links:
   * what a link starts is reported onto the batch, and the next link is only
   * made once that is over (see `settleStarted`).
   */
  async function callMember(callee, args, named, node, env, rt) {
    const receiver = await evaluate(callee.object, env, rt);
    if (aborted(receiver)) {
      return receiver;
    }
    const name = callee.name;
    if (FORBIDDEN_PROPERTIES.has(name)) {
      return errorAt(`不能调用 ${name}`, node);
    }
    // The stage owns every call made on it — the narrator, the type
    // constructors and the calls it makes for several objects — so the same
    // dispatch a bare call uses answers it here (see `callStage`).
    if (receiver.value?.kind === "Stage") {
      const called = await callStage(receiver.value, name, args, named, node, env, rt);
      return called ?? errorAt(`“${describe(receiver.value)}”没有方法 ${name}`, node);
    }
    // The Chinese name of a method is translated only when the object does not
    // answer to it directly, so a script's own member always wins.
    const method = methodNamed(receiver.value, name);
    const english =
      receiver.value?.[name] !== undefined ? name : (BUILTIN_ALIASES.get(name) ?? name);
    // `group.blur(200)`: a group is a set of objects, so a batch call made on
    // it is the same call made on each member. Only the calls the stage
    // performs on several objects at once are answered this way; `add` / `del`
    // are the group's own and are reached below.
    if (isArray(receiver.value) && Object.hasOwn(BULK_METHODS, english)) {
      return callOnGroup(receiver.value, name, english, args, named, node);
    }
    if (typeof method !== "function") {
      return errorAt(`“${describe(receiver.value)}”没有方法 ${name}`, node);
    }
    const spec = paramSpecOf(receiver.value, english);
    const resolved = applyNamedArgs(spec, args, named, english, node);
    if (resolved.error) {
      return errorAt(resolved.error.message, node);
    }
    return invoke(method, receiver.value, resolved.args, node);
  }

  /**
   * Waits for what one link of a chain started, so the next link can begin.
   *
   * A call reports what it starts onto the batch the statement ends in: an
   * animation, a line, a sound. The statement would wait for all of them
   * anyway, but waiting here, between two calls, is what makes a chain one
   * thing after another — `ch.scale(2, 2000).blur(20, 2000)` is four seconds,
   * not two. Under `together` — a `cue` block, or the single statement a `cue`
   * starts — the links are meant to start at the same moment, so nothing is
   * taken off the batch at all.
   */
  async function settleStarted(before) {
    if (simultaneous) {
      return;
    }
    const batch = context.pending;
    if (!Array.isArray(batch) || batch.length <= before) {
      return;
    }
    const started = batch.splice(before, batch.length - before);
    await Promise.all(started);
  }

  async function evaluateCall(node, env, rt) {
    const args = [];
    for (const argument of node.args) {
      const result = await evaluate(argument, env, rt);
      if (aborted(result)) {
        return result;
      }
      args.push(result.value);
    }
    // Named arguments are evaluated in the order they were written, after the
    // positional ones — which is also the order they are reported in when one
    // of them is wrong.
    const named = [];
    for (const entry of node.named ?? []) {
      const result = await evaluate(entry.value, env, rt);
      if (aborted(result)) {
        return result;
      }
      named.push({ name: entry.name, value: result.value });
    }

    // `obj.method(...)` — the receiver is kept as `this`.
    if (node.callee.type === "member") {
      // What this link of the chain starts is waited for before the next link
      // begins, so `ch.scale(2, 2000).blur(20, 2000)` takes four seconds rather
      // than running the two together. Inside a `cue` the links are meant to
      // start together, which is what makes the same line take two seconds there.
      const started = context.pending?.length ?? 0;
      const called = await callMember(node.callee, args, named, node, env, rt);
      if (aborted(called)) {
        return called;
      }
      await settleStarted(started);
      return called;
    }

    if (node.callee.type === "identifier") {
      const name = node.callee.name;
      if (FORBIDDEN_PROPERTIES.has(name)) {
        return errorAt(`不能调用 ${name}`, node);
      }
      // The word as written is tried first, then its English equivalent: a
      // script that declares `func 说(...)` keeps its own, and only a name
      // nothing claimed reaches the stage.
      const alias = BUILTIN_ALIASES.get(name);
      for (const candidate of alias ? [name, alias] : [name]) {
        const local = binding(env, candidate)?.get(candidate);
        // A function the script declared is called with one value per parameter,
        // unlike a host factory, which is handed the whole argument list.
        if (isScriptFunction(local)) {
          if (named.length) {
            return errorAt(`${candidate} 是脚本函数，只能用位置参数`, node);
          }
          return await callFunction(local, args, node);
        }
        if (typeof local === "function") {
          return callHostFactory(local, candidate, args, named, node);
        }
      }
      // Nothing the script bound claims the name, so the call belongs to the
      // stage: `Character(…)` is `stage.Character(…)`, `say(…)` is
      // `stage.say(…)`, and the same holds for a stage-wide call or a builtin.
      // One dispatch answers all of them — the receiver is all the sugar omits.
      const stageApi = globals.stage && typeof globals.stage === "object" ? globals.stage : null;
      const called = await callStage(stageApi, name, args, named, node, env, rt);
      if (called) {
        return called;
      }
      return errorAt(`未定义的对象或函数：${name}`, node);
    }

    return errorAt("只能调用对象的方法或具名对象", node);
  }

  /**
   * Runs the body of a function a script declared.
   *
   * The arguments are bound to its parameters in an environment of their own,
   * which is what lets a call be made while another one is still running — the
   * only way the language can say recursion today. What the body starts is
   * reported into the batch the call itself belongs to, so a `wait` reaches the
   * whole call rather than only its first statement.
   *
   * Calls nest strictly — a body is always over before the statement that made
   * the call goes on — so the count is taken and given back around the body
   * rather than needing to be carried along.
   */
  async function callFunction(fn, args, node) {
    if (args.length !== fn.params.length) {
      return errorAt(`${fn.name} 需要 ${fn.params.length} 个参数，收到 ${args.length} 个`, node);
    }
    if (depth >= MAX_CALL_DEPTH) {
      return errorAt(`调用层数过深（超过 ${MAX_CALL_DEPTH} 层）`, node);
    }

    const locals = new Map();
    fn.params.forEach((param, index) => locals.set(param, args[index]));

    depth += 1;
    callSerial += 1;
    // A body is a body of its own: a `break` written in one belongs to a loop
    // written in that body, not to a loop the call happens to sit inside. The
    // count is put back however the body ends, so a body that throws it about
    // leaves the caller's loops as they were.
    const outerLoopDepth = loopDepth;
    loopDepth = 0;
    let result;
    try {
      // A body's nodes are named inside this call, so none of them can look
      // like a top-level node a save could have been made at.
      result = await execute(fn.statements, context.pending ?? [], simultaneous, locals, true, [
        "call",
        callSerial,
      ]);
    } finally {
      loopDepth = outerLoopDepth;
      depth -= 1;
    }
    // A body that never wrote `return` still answers a value: the empty value,
    // not `undefined`, so what a script reads back is a kind the language has.
    if (result.returned) {
      return { value: result.returned.value };
    }
    if (result.jumped) {
      return result;
    }
    return result.error || result.stopped ? result : { value: null };
  }

  /**
   * Calls into host code, turning a thrown error into a script error.
   *
   * The engine's objects are ordinary JavaScript, so anything they throw would
   * otherwise escape the interpreter and skip the status-bar report.
   */
  function invoke(fn, thisArg, args, node) {
    try {
      return { value: fn.apply(thisArg, args) };
    } catch (error) {
      if (error && error[JUMP_SIGNAL]) {
        return { jumped: { path: error[JUMP_SIGNAL] } };
      }
      return errorAt(error instanceof Error ? error.message : String(error), node);
    }
  }

  /**
   * Applies one binary operator.
   *
   * `&&` and `||` answer from the left side alone when it settles the
   * expression, so `x != 0 && 10 / x > 1` never divides by zero: short-circuiting
   * belongs to these two operators, not to a separate statement.
   */
  async function evaluateBinary(node, env, rt) {
    const left = await evaluate(node.left, env, rt);
    if (aborted(left)) {
      return left;
    }

    if (node.op === "??") {
      if (left.value === null || left.value === undefined) {
        const right = await evaluate(node.right, env, rt);
        if (aborted(right)) {
          return right;
        }
        return { value: right.value };
      }
      return { value: left.value };
    }

    if (node.op === "&&" || node.op === "||") {
      if (typeof left.value !== "boolean") {
        return errorAt(`运算符 ${node.op} 需要布尔值，左边是${typeOf(left.value)}`, node);
      }
      if (node.op === "&&" && left.value === false) {
        return { value: false };
      }
      if (node.op === "||" && left.value === true) {
        return { value: true };
      }
      const right = await evaluate(node.right, env, rt);
      if (aborted(right)) {
        return right;
      }
      if (typeof right.value !== "boolean") {
        return errorAt(`运算符 ${node.op} 需要布尔值，右边是${typeOf(right.value)}`, node);
      }
      return { value: right.value };
    }

    const right = await evaluate(node.right, env, rt);
    if (aborted(right)) {
      return right;
    }
    return applyOperator(node.op, left.value, right.value, node);
  }

  /**
   * Applies one non-short-circuiting operator to two values.
   *
   * Kept apart from `evaluateBinary` because a compound assignment needs the
   * same rules without a second expression node: `x += 1` has to report a type
   * error exactly the way `x + 1` does, and the two may not drift apart. The
   * node is only used to place the error on the right line.
   */
  function applyOperator(op, a, b, node) {
    switch (op) {
      case "+":
        if (typeof a === "number" && typeof b === "number") {
          return { value: a + b };
        }
        if (typeof a === "string" && typeof b === "string") {
          return { value: a + b };
        }
        return errorAt(
          `+ 只能加两个数字或连接两段文本，收到${typeOf(a)}和${typeOf(b)}；` +
            "数字要接进文本请用 str(数字)",
          node,
        );

      case "-":
      case "*":
      case "/":
      case "%": {
        if (typeof a !== "number" || typeof b !== "number") {
          return errorAt(`${op} 需要两个数字，收到${typeOf(a)}和${typeOf(b)}`, node);
        }
        if ((op === "/" || op === "%") && b === 0) {
          return errorAt("不能除以 0", node);
        }
        const answer = op === "-" ? a - b : op === "*" ? a * b : op === "/" ? a / b : a % b;
        return { value: answer };
      }

      // Numbers compare by size; text compares by code point, which is the
      // order a dictionary uses for the Latin alphabet and a stable one for
      // anything else. Mixing the two is reported rather than guessed at, for
      // the same reason `+` refuses to mix them.
      case "<":
      case ">":
      case "<=":
      case ">=": {
        const numbers = typeof a === "number" && typeof b === "number";
        const texts = typeof a === "string" && typeof b === "string";
        if (!numbers && !texts) {
          return errorAt(
            `比较 ${op} 需要两个数字或两段文本，收到${typeOf(a)}和${typeOf(b)}`,
            node,
          );
        }
        const answer =
          op === "<" ? a < b : op === ">" ? a > b : op === "<=" ? a <= b : a >= b;
        return { value: answer };
      }

      // Equality is only for the value kinds that have one. `1 == "1"` is a
      // mistake almost every time, so it is reported instead of answering
      // `false`, and objects are left out because they have no equality a
      // script could mean.
      case "==":
      case "!=": {
        // Lists and dictionaries compare by content when both sides share the shape;
        // a collection against a bare value, or against the other shape, is still
        // reported rather than answered, so a slipped reference is not hidden.
        const aColl = a !== null && typeof a === "object" && (LIST in a || DICT in a);
        const bColl = b !== null && typeof b === "object" && (LIST in b || DICT in b);
        if (aColl || bColl) {
          const bothList =
            a !== null && typeof a === "object" && LIST in a &&
            b !== null && typeof b === "object" && LIST in b;
          const bothDict =
            a !== null && typeof a === "object" && DICT in a &&
            b !== null && typeof b === "object" && DICT in b;
          if (bothList || bothDict) {
            const same = valuesEqual(a, b);
            return { value: op === "==" ? same : !same };
          }
          return errorAt(`不能比较${typeOf(a)}和${typeOf(b)}`, node);
        }
        const leftKind = primitiveKind(a);
        if (leftKind === null) {
          return errorAt(`不能比较${typeOf(a)}`, node);
        }
        const rightKind = primitiveKind(b);
        if (rightKind === null) {
          return errorAt(`不能比较${typeOf(b)}`, node);
        }
        if (leftKind !== rightKind) {
          return errorAt(`${typeOf(a)}和${typeOf(b)}不能比较`, node);
        }
        const same = a === b;
        return { value: op === "==" ? same : !same };
      }

      default:
        return errorAt(`未知的运算符 ${op}`, node);
    }
  }

  /** Applies one unary operator: logical not, or a negative sign. */
  async function evaluateUnary(node, env, rt) {
    const operand = await evaluate(node.operand, env, rt);
    if (aborted(operand)) {
      return operand;
    }
    if (node.op === "!") {
      if (typeof operand.value !== "boolean") {
        return errorAt(`! 需要布尔值，收到${typeOf(operand.value)}`, node);
      }
      return { value: !operand.value };
    }
    if (typeof operand.value !== "number") {
      return errorAt(`负号需要数字，收到${typeOf(operand.value)}`, node);
    }
    return { value: -operand.value };
  }

  /**
 * Reads an element of a list, dictionary, or string by index. Negative indices
 * count from the end; an out-of-range read is reported rather than wrapping.
 */
function readIndex(collection, index, node) {
  if (collection && typeof collection === "object" && LIST in collection) {
    const at = normalizeIndex(index, collection[LIST].length, node, "列表");
    if (typeof at !== "number") {
      return at;
    }
    return { value: collection[LIST][at] };
  }
  if (collection && typeof collection === "object" && DICT in collection) {
    if (!collection[DICT].has(index)) {
      return errorAt(`字典中没有键 ${formatKey(index)}`, node);
    }
    return { value: collection[DICT].get(index) };
  }
  if (typeof collection === "string") {
    const at = normalizeIndex(index, collection.length, node, "文本");
    if (typeof at !== "number") {
      return at;
    }
    return { value: collection[at] };
  }
  return errorAt(`不能对${typeOf(collection)}取下标`, node);
}

/** Slices a list or string; either bound may be omitted and negatives count back. */
function readSlice(collection, lower, upper, node) {
  if (collection && typeof collection === "object" && LIST in collection) {
    const [start, end] = sliceBounds(lower, upper, collection[LIST].length);
    return { value: { [LIST]: collection[LIST].slice(start, end) } };
  }
  if (typeof collection === "string") {
    const [start, end] = sliceBounds(lower, upper, collection.length);
    return { value: collection.slice(start, end) };
  }
  return errorAt(`不能对${typeOf(collection)}做切片`, node);
}

/** Turns an index into a concrete position, or an error object when it is bad. */
function normalizeIndex(index, length, node, what) {
  if (typeof index !== "number" || !Number.isInteger(index)) {
    return errorAt(`${what}下标需要整数，收到${typeOf(index)}`, node);
  }
  const at = index < 0 ? index + length : index;
  if (at < 0 || at >= length) {
    return errorAt(`${what}下标 ${index} 越界（长度 ${length}）`, node);
  }
  return at;
}

/** Clamps an open-ended slice `[lower:upper]` against a length. */
function sliceBounds(lower, upper, length) {
  let start = lower === null ? 0 : lower < 0 ? lower + length : lower;
  let end = upper === null ? length : upper < 0 ? upper + length : upper;
  if (start < 0) {
    start = 0;
  }
  if (end > length) {
    end = length;
  }
  if (start > end) {
    start = end;
  }
  return [start, end];
}

/** Renders a dictionary key for an error message. */
function formatKey(key) {
  return typeof key === "string" ? `"${key}"` : BUILTINS.str(key);
}

function readMember(object, name, node) {
    if (object === null || object === undefined) {
      return errorAt(`无法读取 ${name}`, node);
    }
    if (FORBIDDEN_PROPERTIES.has(name)) {
      return errorAt(`不能读取 ${name}`, node);
    }
    // `ch.变换.左上` reads a Chinese member: the direct answer wins, and the
    // English one is only consulted when there is none.
    const direct = object[name];
    if (direct !== undefined) {
      return { value: direct };
    }
    const alias = BUILTIN_ALIASES.get(name);
    return { value: alias === undefined ? direct : object[alias] };
  }

  function errorAt(message, node) {
    return { error: { message, line: node.line, column: 0, file: sources[sources.length - 1] } };
  }
}

/**
 * Runs source text end to end.
 *
 * The first error wins and is returned rather than thrown, so callers report it
 * in the status bar instead of catching an exception.
 *
 * @returns {Promise<{ value?: unknown, error?: { message: string, line?: number, column?: number },
 *   stopped?: boolean }>}
 */
export async function run(source, runtime = {}) {
  let currentSource = source;
  let currentFile = runtime.source ?? null;
  let result;
  // Parses are kept for the whole performance: a jump chain that lands in the
  // same file twice used to read and parse it twice, and a scene included from
  // both sides of a jump was parsed once per side.
  const scenes = runtime.scenes instanceof Map ? runtime.scenes : new Map();
  // A jump ends the current run and starts the named file from its top, as a
  // fresh run. We loop so a jumped-to file can jump again, chaining scenes until
  // one finishes (or the chain gets too deep to be anything but a cycle).
  for (let depth = 0; depth <= MAX_INCLUDE_DEPTH; depth += 1) {
    let program = currentFile ? scenes.get(currentFile) : null;
    if (!program) {
      const scanned = tokenize(currentSource);
      if (scanned.error) {
        return scanned;
      }
      const parsed = parse(scanned.tokens);
      if (parsed.error) {
        return parsed;
      }
      program = parsed.program;
      if (currentFile) {
        scenes.set(currentFile, program);
      }
    }
    result = await interpret(program, { ...runtime, source: currentFile, scenes });
    if (!result.jumped) {
      return result;
    }
    if (typeof runtime.readScene !== "function") {
      return { error: { message: "当前环境不能读取其他脚本，jump 不可用" } };
    }
    let targetSource;
    try {
      targetSource = await runtime.readScene(result.jumped.path);
    } catch (error) {
      return {
        error: {
          message: `读不到脚本 ${result.jumped.path}：${error instanceof Error ? error.message : String(error)}`,
          file: result.jumped.path,
        },
      };
    }
    currentFile = result.jumped.path;
    currentSource = targetSource;
  }
  return { error: { message: `脚本跳转层级太深（超过 ${MAX_INCLUDE_DEPTH} 层）` } };
}

/** A short, script-friendly description of a value, for error messages. */
function describe(value) {
  if (value === null) {
    return "空值";
  }
  if (isArray(value)) {
    return "对象组";
  }
  if (Array.isArray(value)) {
    return "列表";
  }
  return typeof value === "object" ? "对象" : String(value);
}

/**
 * Names a value's type the way a script author would say it, for error
 * messages. The palette is exactly the value kinds the language has; anything
 * else came from the host and is called an object.
 */
function typeOf(value) {
  if (value === null) {
    return "空值";
  }
  if (typeof value === "number") {
    return "数字";
  }
  if (typeof value === "string") {
    return "文本";
  }
  if (typeof value === "boolean") {
    return "布尔";
  }
  if (isArray(value)) {
    return "对象组";
  }
  if (value && typeof value === "object" && LIST in value) {
    return "列表";
  }
  if (value && typeof value === "object" && DICT in value) {
    return "字典";
  }
  return "对象";
}

/**
 * The kind `==` may compare, or `null` for a value it never compares.
 *
 * Objects are left out on purpose: they have no equality a script could mean,
 * and answering `false` for two different pictures would hide that.
 */
function primitiveKind(value) {
  if (value === null) {
    return "null";
  }
  const kind = typeof value;
  return kind === "number" || kind === "string" || kind === "boolean" ? kind : null;
}

/**
 * Whether two values are equal by content — the rule `==` uses for lists and
 * dictionaries, which have no identity worth comparing. Recurses into nested
 * collections, so `[[1], [2]] == [[1], [2]]` is true; a list never equals a
 * dictionary of the same shape.
 */
function valuesEqual(a, b) {
  const kind = typeOf(a);
  if (kind !== typeOf(b)) {
    return false;
  }
  if (kind === "数字" || kind === "文本" || kind === "布尔" || kind === "空值") {
    return a === b;
  }
  if (kind === "列表") {
    const left = a[LIST];
    const right = b[LIST];
    if (left.length !== right.length) {
      return false;
    }
    return left.every((item, index) => valuesEqual(item, right[index]));
  }
  if (kind === "字典") {
    const left = a[DICT];
    const right = b[DICT];
    if (left.size !== right.size) {
      return false;
    }
    for (const [key, value] of left) {
      if (!right.has(key) || !valuesEqual(value, right.get(key))) {
        return false;
      }
    }
    return true;
  }
  return false;
}

/**
 * The name a script node is saved under.
 *
 * A node is a file plus the path of statement indices — and branch words —
 * that leads to it from that file's top level. A save writes this string and
 * a replay compares against it, so both go through here and cannot drift.
 *
 * @param {string | null} file
 * @param {Array<number | string>} path
 * @returns {string}
 */
export function nodeKey(file, path) {
  return `${file ?? ""}#${JSON.stringify(path ?? [])}`;
}

/**
 * Names the stage page opened for a script.
 *
 * `scripts/new.pe` becomes `new.stage`. The name is only a label for the
 * tab; the stage itself is not tied to a file on disk.
 *
 * @returns {string | null} `null` when the path has no usable name.
 */
export function stageNameFor(scriptPath) {
  const normalized = String(scriptPath ?? "").replace(/\\/g, "/");
  const name = normalized.slice(normalized.lastIndexOf("/") + 1);
  if (!name) {
    return null;
  }
  const base = name.replace(/\.(?:pe|pamela)$/i, "");
  return base ? `${base}.stage` : null;
}
