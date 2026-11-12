// 基于语言词法器的剧本语法高亮。
// Syntax highlighting for Pamela scripts, built on the language lexer.
// 词法器跳过空白与注释，高亮器单独处理这些区间。

import { cueStatementIn, scanArguments, shorthandCallIn } from "./mpe.js";
import {
  BUILTIN_GLOBALS,
  BUILTIN_METHODS,
  BULK_METHODS,
  KEYWORDS,
  englishNameFor,
  tokenize,
} from "./pamela.js";

/** Escapes the characters that matter inside HTML text. */
function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** One coloured run of text; the empty string stays empty rather than a bare span. */
function span(className, text) {
  return text ? `<span class="${className}">${escapeHtml(text)}</span>` : "";
}

/**
 * Escapes `text` but wraps any comment runs in a `tok-comment` span first, so
 * the comments between tokens get their own colour instead of reading as code.
 */
function escapeWithComments(text) {
  let html = "";
  let scan = 0;
  while (scan < text.length) {
    const char = text[scan];
    const lineComment = char === "#" || (char === "/" && text[scan + 1] === "/");
    if (lineComment) {
      let end = scan;
      while (end < text.length && text[end] !== "\n") end += 1;
      html += `<span class="tok-comment">${escapeHtml(text.slice(scan, end))}</span>`;
      scan = end;
      continue;
    }
    if (char === "/" && text[scan + 1] === "*") {
      let end = scan + 2;
      while (end < text.length && !(text[end] === "*" && text[end + 1] === "/")) {
        end += 1;
      }
      end = Math.min(end + 2, text.length);
      html += `<span class="tok-comment">${escapeHtml(text.slice(scan, end))}</span>`;
      scan = end;
      continue;
    }
    // A plain run up to the next comment start.
    let end = scan;
    while (
      end < text.length &&
      text[end] !== "#" &&
      !(text[end] === "/" && (text[end + 1] === "/" || text[end + 1] === "*"))
    ) {
      end += 1;
    }
    html += escapeHtml(text.slice(scan, end));
    scan = end;
  }
  return html;
}

/**
 * Whether the identifier at `index` is calling a builtin.
 *
 * A name is only API in the position that calls one: `说(` and `hero.说(` are
 * the `say` builtin, while `说 = 1` is the author's own variable — and the
 * Chinese method aliases (`上`, `左`, `移动`) are ordinary words a script may
 * well want to use as names. Both spellings are checked, so a script written in
 * Chinese colours the same as the one it compiles to.
 */
function callsBuiltin(tokens, index) {
  const next = tokens[index + 1];
  if (!next || next.type !== "punct" || next.value !== "(") {
    return false;
  }
  const name = englishNameFor(tokens[index].value);
  return BUILTIN_GLOBALS.has(name) || BUILTIN_METHODS.has(name);
}

/** The token colour class, or `null` to leave it in the default text colour. */
function classForToken(token, tokens, index) {
  switch (token.type) {
    case "string":
    case "interp":
      return "tok-string";
    case "number":
      return "tok-number";
    case "punct":
      return "tok-operator";
    case "ident":
      if (KEYWORDS.has(token.value)) {
        return "tok-keyword";
      }
      return callsBuiltin(tokens, index) ? "tok-builtin" : "tok-ident";
    default:
      return null;
  }
}

/**
 * Returns HTML for `source`, with Pamela tokens and comments wrapped in colour
 * spans. The text itself is always present (never dropped) and HTML-escaped, so
 * the painted layer is a faithful, safe copy of the source. On a lexer error
 * (e.g. an unterminated string) it falls back to plain escaped text.
 *
 * @param {string} source
 * @returns {string}
 */
export function highlightPamela(source) {
  const scanned = tokenize(source);
  return highlightTokens(scanned.error ? null : scanned.tokens, source);
}

/**
 * Paints an already-tokenized script.
 *
 * The editor scans a script to paint it *and* to underline its first error; the
 * caller keeps the tokens so the second pass does not tokenize the same text
 * again. Passing `null` (a lexer error) falls back to escaped plain text.
 *
 * @param {{ start?: number, end?: number, value?: string, type: string }[] | null} tokens
 * @param {string} source
 * @returns {string}
 */
export function highlightTokens(tokens, source) {
  const text = String(source ?? "");
  if (!tokens) {
    return escapeWithComments(text);
  }
  let html = "";
  let cursor = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.start === undefined) {
      continue;
    }
    if (token.start > cursor) {
      html += escapeWithComments(text.slice(cursor, token.start));
    }
    if (token.start < cursor) {
      cursor = token.start;
    }
    const length = token.end > token.start
      ? token.end - token.start
      : String(token.value ?? "").length;
    const end = token.start + length;
    const cls = classForToken(token, tokens, index);
    const chunk = escapeHtml(text.slice(token.start, end));
    html += cls ? `<span class="${cls}">${chunk}</span>` : chunk;
    cursor = end;
  }
  if (cursor < text.length) {
    html += escapeWithComments(text.slice(cursor));
  }
  return html;
}

/**
 * Returns HTML for a shorthand (`.mpe`) script.
 *
 * The dialect is one statement per line and writes calls without brackets, so it
 * is coloured a line at a time rather than token by token: the line's own reader
 * (`shorthandCallIn`) says which word is the call and where its arguments begin,
 * and the arguments are read with the very scanner that compiles them
 * (`scanArguments`). What the author sees is therefore what the compiler reads —
 * the call in the API colour, its numbers and literals as themselves, and the
 * free text at the end of a line (`说 你好，世界`) in the string colour it
 * compiles to.
 *
 * A line the dialect does not rewrite — a keyword statement, a brace, a comment,
 * a line already in the full syntax — is coloured by the `.pe` highlighter, which
 * is exactly how such a line is read.
 *
 * @param {string} source
 * @returns {string}
 */
export function highlightMpe(source) {
  return String(source ?? "")
    .split("\n")
    .map(highlightMpeLine)
    .join("\n");
}

/** One line of a shorthand script, coloured. @param {string} line */
function highlightMpeLine(line) {
  const call = shorthandCallIn(line);
  if (!call) {
    // `cue 3000 ch scale 0.5`: the keyword and its time are the full syntax and
    // the statement after them is shorthand, so the two halves are coloured by
    // their own readers — the same split the compiler makes.
    const cue = cueStatementIn(line);
    if (cue) {
      return highlightPamela(line.slice(0, cue.headEnd)) + highlightMpeLine(line.slice(cue.headEnd));
    }
    // A bare stage-wide method is a call the writer has only just begun: colour
    // it as the API even before its first object is typed, so `enable` is blue
    // from the first letters rather than only once the line is finished.
    const bare = /^(\s*)([\p{L}_][\p{L}\p{N}_]*)(\s*)$/u.exec(line);
    if (bare && Object.hasOwn(BULK_METHODS, englishNameFor(bare[2]))) {
      return escapeHtml(bare[1]) + span("tok-builtin", bare[2]) + escapeHtml(bare[3]);
    }
    return highlightPamela(line);
  }

  // The part before the call: the indent, and the receiver of an assignment
  // (`小帕 = `), which is a name like any other.
  let html = highlightPamela(line.slice(0, call.nameStart));

  const headEnd = call.nameStart + call.head.length;
  // With the stage left out (`enable ch bg`) the head *is* the call, so it
  // takes the builtin colour; otherwise it is the receiver and stays a name.
  const headIsBuiltin =
    BUILTIN_GLOBALS.has(englishNameFor(call.head)) ||
    (!call.verb && Object.hasOwn(BULK_METHODS, englishNameFor(call.head)));
  html += span(headIsBuiltin ? "tok-builtin" : "tok-ident", line.slice(call.nameStart, headEnd));

  if (call.verb) {
    const verbStart = call.nameEnd - call.verb.length;
    html += escapeHtml(line.slice(headEnd, verbStart));
    const verbIsBuiltin = BUILTIN_METHODS.has(englishNameFor(call.verb));
    html += span(verbIsBuiltin ? "tok-builtin" : "tok-ident", line.slice(verbStart, call.nameEnd));
  }

  // The space between the call and its first argument, kept as it was written.
  html += escapeHtml(line.slice(call.nameEnd, call.argsStart));
  // A stage-wide call or a group's own call names objects, so its arguments are
  // read — and coloured — as names rather than as a line of dialogue. The
  // reading is the compiler's, handed over with the call itself.
  html += highlightArguments(line.slice(call.argsStart, call.argsEnd), { names: call.names });
  // The comment, and whatever whitespace trails the line.
  html += escapeWithComments(line.slice(call.argsEnd));
  return html;
}

/**
 * Colours an argument list by the kinds the compiler gives each part.
 *
 * @param {string} text The argument text of one statement.
 * @returns {string}
 */
function highlightArguments(text, { names = false } = {}) {
  const source = String(text ?? "");
  let html = "";
  let cursor = 0;
  // `arg` rather than `span`, which is the name of the tag helper above: a loop
  // variable beside it would shadow the helper and make the coloured run throw.
  for (const arg of scanArguments(source, { names })) {
    const { start, end } = arg;
    if (start > cursor) {
      html += escapeHtml(source.slice(cursor, start));
    }
    if (arg.kind === "named") {
      // `x=300`: the name is a name, the value keeps the colour it would have had
      // on its own.
      const equals = source.indexOf("=", start);
      html += span("tok-ident", source.slice(start, Math.max(start, equals)).trimEnd());
      html += escapeHtml(source.slice(Math.max(start, equals), arg.valueStart));
      html += highlightArgument(source.slice(arg.valueStart, end), arg.valueKind);
    } else {
      html += highlightArgument(source.slice(start, end), arg.kind);
    }
    cursor = end;
  }
  if (cursor < source.length) {
    html += escapeHtml(source.slice(cursor));
  }
  return html;
}

/**
 * One argument, coloured by its kind.
 *
 * A `{ … }` expression is read with the `.pe` highlighter: what sits inside the
 * braces is the full syntax, and the author is writing it there. Free text is
 * the string it compiles to, so it takes the string colour.
 *
 * @param {string} raw
 * @param {string} kind
 * @returns {string}
 */
function highlightArgument(raw, kind) {
  switch (kind) {
    case "number":
      return span("tok-number", raw);
    case "literal":
      return span("tok-keyword", raw);
    case "string":
      return span("tok-string", raw);
    // The colon that ends the fixed arguments is punctuation, and the names
    // after it are identifiers — the same colours the full syntax gives them.
    case "colon":
      return span("tok-operator", raw);
    // `. move`: the dot is punctuation too, and the method it opens is a call.
    case "chain":
      return span("tok-operator", raw);
    case "method":
      return span("tok-builtin", raw);
    case "name":
      return span("tok-ident", raw);
    case "expression":
      return (
        span("tok-operator", "{") +
        highlightPamela(raw.slice(1, -1)) +
        span("tok-operator", "}")
      );
    default:
      // `text`, and the `raw` tail of a brace or quote that was never closed.
      return span("tok-string", raw);
  }
}
