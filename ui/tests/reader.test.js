// 内置阅读器测试。
// Tests for the built-in reader.

import assert from "node:assert/strict";
import test from "node:test";

import { BUILTIN_ALIASES } from "../pamela.js";
import { createReaderToc, readerArticle, readerSet, READER_SETS, renderMarkdown } from "../reader.js";

/** A stand-in element, enough for the reader to build its DOM in node. */
function fakeNode(tag = "div") {
  const classes = new Set();
  const listeners = new Map();
  const node = {
    tagName: tag.toUpperCase(),
    textContent: "",
    childNodes: [],
    attributes: {},
    dataset: {},
    get className() {
      return [...classes].join(" ");
    },
    set className(value) {
      classes.clear();
      for (const name of String(value ?? "").split(/\s+/)) {
        if (name) classes.add(name);
      }
    },
    classList: {
      add(name) {
        classes.add(name);
      },
      contains(name) {
        return classes.has(name);
      },
    },
    append(...children) {
      node.childNodes.push(...children);
    },
    replaceChildren(...children) {
      node.childNodes = [...children];
    },
    setAttribute(name, value) {
      node.attributes[name] = String(value);
    },
    getAttribute(name) {
      return node.attributes[name] ?? null;
    },
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    dispatch(type, event) {
      listeners.get(type)?.(event ?? { stopPropagation() {}, target: node });
    },
    /** Every descendant carrying `wanted`'s class, depth first. */
    findAll(wanted) {
      const out = [];
      const walk = (current) => {
        for (const child of current.childNodes ?? []) {
          if (child.classList?.contains(wanted)) out.push(child);
          walk(child);
        }
      };
      walk(node);
      return out;
    },
    /** All text below this node, concatenated. */
    text() {
      let out = "";
      const walk = (current) => {
        if (current.childNodes?.length) {
          for (const child of current.childNodes) walk(child);
          return;
        }
        out += current.textContent ?? "";
      };
      walk(node);
      return out;
    },
  };
  return node;
}

/** Runs `body` with a minimal `document`, so the reader can be built. */
function withFakeDom(body) {
  const previous = globalThis.document;
  globalThis.document = {
    createElement: (tag) => fakeNode(tag),
    createTextNode: (text) => ({ textContent: String(text) }),
  };
  try {
    return body();
  } finally {
    globalThis.document = previous;
  }
}

test("关于：五篇文章，顺序固定", () => {
  const set = readerSet("about");
  assert.deepEqual(
    set.articles.map((article) => article.title),
    ["声明", "许可证", "关于本软件", "使用协议", "隐私政策"],
  );
  for (const article of set.articles) {
    assert.ok(article.id, "每篇都要有 id");
    assert.ok(article.body.trim().length > 100, `${article.title} 不能是空壳`);
  }
});

test("帮助：十七篇文章，七类对象各有专项，覆盖基础使用到视频导出", () => {
  const set = readerSet("help");
  assert.deepEqual(
    set.articles.map((article) => article.title),
    [
      "基础使用", "代码", "三维空间",
      "Character 角色", "Background 背景", "Text 文字", "Audio 音频", "Video 视频",
      "Effect 特效", "Light 光源",
      "mpe 简写", "中文写法", "API 对照", "flowmap", "keyframes 帧组", "模板编辑", "导出 MP4",
    ],
  );
  assert.equal(READER_SETS.about.label, "关于");
  assert.equal(READER_SETS.help.label, "帮助");
});

test("三维空间：坐标标准、单轴方法与示意图都在", () => {
  const article = readerArticle("help", "space");
  assert.ok(article, "帮助里要有三维空间一文");
  for (const phrase of [
    "x 平轴", "y 升轴", "z 推轴", "深度", "moveTo", "xTo", "yTo", "zTo",
    "H 平轴", "V 升轴", "D 推轴", "Horizontal", "Vertical", "Depth",
    "hTo", "vTo", "stage.perspective", "stage.guideline", "参考线",
    "coordinate-system.svg",
  ]) {
    assert.ok(article.body.includes(phrase), `三维空间一文缺 ${phrase}`);
  }
  withFakeDom(() => {
    const root = renderMarkdown(article.body);
    const figures = root.findAll("reader__figure");
    assert.equal(figures.length, 1, "示意图要渲染成一个 figure");
    const image = root.findAll("reader__figure-image")[0];
    assert.ok(image.src.startsWith("data:image/svg+xml"), "示意图内联成 data: URI");
    assert.ok(!image.src.includes("help/"), "img 不再按路径去取文件");
    assert.ok(figures[0].findAll("reader__figure-caption").length === 1, "图下有说明文字");
  });
});

test("六类对象专项：构造器、全部方法、示例与速查表都在，且能渲染", () => {
  const specs = [
    ["character", ["Character(source", "enable()", "show(time?)", "hide(time?)", "alpha(value, time?)",
      "move(dx, dy, dz, time?)", "moveTo(x, y, z, time?)", "rotateTo", "scaleTo", "rgbTo", "hex(hex, time?)",
      "blur(value, time?)", "brightness(value, time?)", "saturate(value, time?)", "key(file?)",
      "step(frame?)", "front()", "back()", "name(value)", "say(text, time?, audio?)",
      "upleftTo", "downleftTo", "transform"]],
    ["background", ["Background(source", "enable()", "crossFade(path, time?)", "moveTo(x, y, z, time?)",
      "scaleTo", "rgbTo", "hex(hex, time?)", "blur(value, time?)", "brightness(value, time?)",
      "saturate(value, time?)", "key(file?)", "step(frame?)", "只有一个背景图层"]],
    ["audio", ["Audio(source", "play(time?)", "stop(time?)", "loop()", "once()",
      "volume(value, time?)", "duration()", "配音"]],
    ["video", ["Video(source", "mute = false", "media", "audio", "enable()", "disable()",
      "play()", "pause()", "loop()", "once()", "speedTo", "mute(value?)", "volume(value, time?)",
      "duration()", "show(time?)", "hide(time?)", "alpha(value, time?)", "moveTo(x, y, z, time?)",
      "rotateTo", "scaleTo", "blur(value, time?)", "rgbTo", "hex(hex, time?)"]],
    ["effect", ["Effect(source", "rain", "snow", "enable()", "disable()", "play()", "pause()",
      "density", "speedTo", "缩放", "尺寸", "密度", "速度", "240", "4000"]],
    ["light", ["Light(color", "enable()", "disable()", "强度", "rotateH", "rotateV", "方向",
      "水平面", "正立面", "散射", "传播距离", "泛光", "柔光", "宽度", "深度", "环境亮度", "排除", "8 盏"]],
  ];
  withFakeDom(() => {
    for (const [id, phrases] of specs) {
      const article = readerArticle("help", id);
      assert.ok(article, `帮助里缺 ${id} 一文`);
      assert.ok(article.body.trim().length > 3000, `${id} 不能是简略概述`);
      assert.equal(
        (article.body.match(/~~~/g) ?? []).length % 2,
        0,
        `${id} 的代码块围栏要成对`,
      );
      for (const phrase of phrases) {
        assert.ok(article.body.includes(phrase), `${id} 缺 ${phrase}`);
      }
      const root = renderMarkdown(article.body);
      assert.ok(root.findAll("reader__heading").length >= 8, `${id} 要有分节`);
      assert.ok(root.findAll("reader__subheading").length >= 6, `${id} 方法要逐个展开`);
      assert.ok(root.findAll("reader__pre").length >= 5, `${id} 要有足够示例`);
      assert.ok(root.findAll("reader__table").length >= 2, `${id} 要有参数表与速查表`);
      assert.ok(root.findAll("reader__list").length >= 3, `${id} 要有逐条说明`);
      assert.equal(
        root.findAll("reader__paragraph").filter((node) => node.text().trim().startsWith("|")).length,
        0,
        `${id} 的每张表格都要写分隔行，不能退化成正文`,
      );
    }
  });
});

test("Text 文字专项：构造参数、方法与示例都在，且能渲染", () => {
  const article = readerArticle("help", "text");
  assert.ok(article, "帮助里缺 Text 文字一文");
  for (const phrase of [
    "Text(text, x?, y?, size?, color?",
    "enable",
    "(0–1, time?)",
    "(x, y, z, time?)",
    "scaleTo",
    "rotateTo",
    "渐出",
    "渐入",
    "#ffffff",
    "\\n",
    "JetBrains Mono",
    "思源黑体",
    'font("字体名")',
    "本机字体",
  ]) {
    assert.ok(article.body.includes(phrase), `text 缺 ${phrase}`);
  }
  withFakeDom(() => {
    const root = renderMarkdown(article.body);
    assert.ok(root.findAll("reader__heading").length >= 5, "text 要有分节");
    assert.ok(root.findAll("reader__pre").length >= 3, "text 要有示例");
    assert.ok(root.findAll("reader__table").length >= 2, "text 要有参数表与方法表");
    assert.ok(root.findAll("reader__list").length >= 3, "text 要有逐条说明");
  });
});

test("代码总文章：有语言规则、可运行示例与常见错误排查", () => {
  const article = readerArticle("help", "code");
  for (const phrase of [
    "语句与注释", "值与运算", "变量与赋值", "参数名", "控制流", "函数", "场景与并行",
    "角色", "背景", "声音", "完整场景示例", "常见错误与排查",
  ]) {
    assert.ok(article.body.includes(phrase), `代码一文缺 ${phrase}`);
  }
});

test("导出 MP4 帮助写明入口、规格与限制", () => {
  const article = readerArticle("help", "export");
  assert.ok(article, "帮助里要有导出 MP4 一文");
  for (const phrase of [
    "演出 → 导出 MP4",
    "exports/",
    "静音",
    "固定第一项",
    "按上次运行",
    "入口脚本",
    "在文件夹中显示",
    "64 位",
    "12 / 24 / 25 / 30 / 50 / 60 / 90 / 120",
    "Canvas",
  ]) {
    assert.ok(article.body.includes(phrase), `帮助里缺 ${phrase}`);
  }
  assert.ok(readerArticle("help", "basics").body.includes("导出 MP4"), "基础使用要提到导出");
  assert.ok(readerArticle("about", "product").body.includes("视频导出"), "关于本软件要提到导出");
});

test("API 对照：内置名一个不落，中文与英文各占一列", () => {
  const article = readerArticle("help", "api");
  assert.ok(article.body.includes("| 中文 | 英文 |"), "对照表要标明中英文两列");
  for (const [chinese, english] of BUILTIN_ALIASES) {
    assert.ok(article.body.includes(chinese), `帮助里缺中文名 ${chinese}`);
    assert.ok(article.body.includes(english), `帮助里缺英文名 ${english}（${chinese}）`);
  }
});

test("导出 MP4 文章的小节、列表与规格代码块都能渲染", () => {
  withFakeDom(() => {
    const root = renderMarkdown(readerArticle("help", "export").body);
    assert.deepEqual(
      root.findAll("reader__heading").map((node) => node.text()),
      [
        "一、入口与产物",
        "二、导出参数",
        "三、视频规格",
        "四、与舞台一致的部分",
        "五、会渲染进画面的内容",
        "六、当前限制",
        "七、常见问题",
        "八、相关章节",
      ],
    );
    assert.ok(root.findAll("reader__pre")[0].text().includes("1920 × 1080"));
    assert.ok(root.findAll("reader__list").length >= 4, "每节都有列表");
  });
});

test("按名字查文章，查不到返回 null", () => {
  assert.equal(readerArticle("help", "code").title, "代码");
  assert.equal(readerArticle("about", "privacy").title, "隐私政策");
  assert.equal(readerArticle("help", "nope"), null);
  assert.equal(readerArticle("nope", "code"), null);
  assert.equal(readerSet("nope"), null);
});

test("目录：一节一个按钮，当前这一节被标记", () => {
  withFakeDom(() => {
    const set = readerSet("help");
    const picked = [];
    const nav = createReaderToc({ set, active: "code", onSelect: (id) => picked.push(id) });

    const items = nav.findAll("reader-toc__item");
    assert.equal(items.length, set.articles.length);
    assert.equal(items.filter((item) => item.classList.contains("is-active")).length, 1);
    assert.equal(items[1].getAttribute("aria-current"), "page");
    const flowIndex = set.articles.findIndex((article) => article.id === "flowmap");
    assert.ok(flowIndex > 0, "目录里要有 flowmap");
    assert.equal(nav.findAll("reader-toc__title")[flowIndex].textContent, "flowmap");
    assert.ok(nav.findAll("reader-toc__summary").length >= 1, "目录条目带一句内容摘要");

    // 点哪一节就上报哪一节的 id，面板据此重画，而不是自己换文章。
    items[flowIndex].dispatch("click");
    assert.deepEqual(picked, ["flowmap"]);
  });
});

test("Markdown：节标题、列表、代码块与行内标记各归各位", () => {
  withFakeDom(() => {
    const root = renderMarkdown(
      [
        "开头的一段。",
        "",
        "## 一节",
        "",
        "- 第一条",
        "- 第二条",
        "",
        "~~~pamela",
        "hero.say(`台词`)",
        "~~~",
        "",
        "行内 `code` 与 **强调**。",
      ].join("\n"),
    );

    assert.equal(root.findAll("reader__heading")[0].text(), "一节");
    const list = root.findAll("reader__list")[0];
    assert.equal(list.childNodes.length, 2, "两条列表项");
    assert.equal(list.childNodes[0].text(), "第一条");
    assert.equal(root.findAll("reader__code")[0].text(), "code");
    assert.equal(root.findAll("reader__pre")[0].text(), "hero.say(`台词`)");
    const paragraphs = root.findAll("reader__paragraph");
    assert.equal(paragraphs.length, 2, "代码块前后的两段正文");
    assert.ok(paragraphs[1].text().includes("强调"), "粗体保留文字");
  });
});

test("Markdown：竖线表格分成表头与表身，单元格保留行内标记", () => {
  withFakeDom(() => {
    const root = renderMarkdown(
      ["| 中文 | 英文 |", "| --- | --- |", "| 姓名 | name |", "| 说 | `say` |"].join("\n"),
    );

    const table = root.findAll("reader__table")[0];
    assert.ok(table, "竖线行渲染成表格");
    const thead = table.childNodes[0];
    assert.equal(thead.tagName, "THEAD");
    const headCells = thead.childNodes[0].childNodes;
    assert.equal(headCells.length, 2);
    assert.equal(headCells[0].tagName, "TH");
    assert.equal(headCells[1].text(), "英文");

    const bodyRows = table.childNodes[1].childNodes;
    assert.equal(bodyRows.length, 2, "分隔行不判定为数据");
    assert.equal(bodyRows[0].childNodes[0].text(), "姓名");
    assert.equal(bodyRows[0].childNodes[1].text(), "name");
    assert.equal(bodyRows[1].childNodes[1].text(), "say", "单元格里的 `code` 只剩文字");
    assert.equal(root.findAll("reader__code").length, 1);
    assert.equal(root.findAll("reader__paragraph").length, 0, "表格不进正文段落");
  });
});

test("Markdown：没有分隔行的竖线行仍是正文", () => {
  withFakeDom(() => {
    const root = renderMarkdown("| 只是文字 |");
    assert.equal(root.findAll("reader__table").length, 0);
    assert.equal(root.findAll("reader__paragraph")[0].text(), "| 只是文字 |");
  });
});

test("Markdown：正文里的尖括号只是文字，不会被当成标签", () => {
  withFakeDom(() => {
    const root = renderMarkdown("写作 `if hp < 3 { … }` 时不必转义。");
    assert.equal(root.findAll("reader__code")[0].text(), "if hp < 3 { … }");
    assert.equal(root.childNodes.length, 1);
    assert.equal(root.childNodes[0].tagName, "P");
  });
});
