// 帮助文章里的示意图。
// Pamela — the diagrams the built-in reader shows.
//
// 图不按路径取：整张图写在这个文件里，`renderMarkdown` 把它换成 data: URI 交给
// <img>，所以装好的软件里没有 help/ 文件夹也照常显示，移动安装目录同样不影响。
// `ui/coordinate-system.svg` 只是出图给文档用的源文件，运行时不读它 —— 两份内容
// 由 `ui/tests/help-figures.test.js` 比对，改了一边忘了另一边会让测试红。
//
// 再加一张图：把 SVG 源码整段贴进 FIGURES，Markdown 里照写 `![说明](文件名)`。

const COORDINATE_SYSTEM = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="800" viewBox="0 0 900 800">
  <!-- 业界传统三轴配色：x 红(#ef4444)、y 绿(#22c55e)、z 蓝(#3b82f6)；
       平面配色：H 水平面随 x 红、V 正立面随 z 蓝、W 侧立面随 y 绿 -->
  <defs>
    <marker id="arrow-x" viewBox="0 0 10 10" refX="8" refY="5"
            markerWidth="8" markerHeight="8" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="#ef4444"/>
    </marker>
    <marker id="arrow-y" viewBox="0 0 10 10" refX="8" refY="5"
            markerWidth="8" markerHeight="8" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="#22c55e"/>
    </marker>
    <marker id="arrow-z" viewBox="0 0 10 10" refX="8" refY="5"
            markerWidth="8" markerHeight="8" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="#3b82f6"/>
    </marker>
  </defs>

  <rect width="900" height="800" fill="#ffffff"/>

  <!-- 坐标平面（向正负两个方向延伸）：H 红、V 蓝、W 绿 -->
  <polygon points="320,239 20,429 340,561 640,371"
           fill="#ef4444" fill-opacity="0.13" stroke="#ef4444" stroke-opacity="0.5" stroke-width="1.5"/>
  <polygon points="490,246 490,686 170,554 170,114"
           fill="#3b82f6" fill-opacity="0.13" stroke="#3b82f6" stroke-opacity="0.5" stroke-width="1.5"/>
  <polygon points="480,85 480,525 180,715 180,275"
           fill="#22c55e" fill-opacity="0.13" stroke="#22c55e" stroke-opacity="0.5" stroke-width="1.5"/>

  <!-- 各平面的内接圆（按平面基向量投影成椭圆，只描边不填充） -->
  <ellipse cx="330" cy="400" rx="220.16" ry="114.06" fill="none"
           stroke="#ef4444" stroke-width="2"
           transform="rotate(-6.01 330 400)"/>
  <ellipse cx="330" cy="400" rx="237.44" ry="148.25" fill="none"
           stroke="#3b82f6" stroke-width="2"
           transform="rotate(71.06 330 400)"/>
  <ellipse cx="330" cy="400" rx="250" ry="132" fill="none"
           stroke="#22c55e" stroke-width="2"
           transform="rotate(-70.39 330 400)"/>

  <!-- 摄影机：位于 z 负方向一侧，观察方向 +z，视野落在 -W 面 -->
  <line x1="687" y1="545" x2="492" y2="468" stroke="#6b7280" stroke-width="1.5"
        stroke-dasharray="7 6"/>
  <g transform="translate(718,558) rotate(-157.7)">
    <rect x="-30" y="-17" width="44" height="34" rx="5" fill="#1f2933"/>
    <polygon points="14,-13 32,-20 32,20 14,13" fill="#1f2933"/>
    <circle cx="-8" cy="0" r="6" fill="#ffffff"/>
  </g>
  <text x="718" y="604" text-anchor="middle" font-family="Microsoft YaHei, sans-serif"
        font-size="17" fill="#374151">摄影机　观察方向 +z</text>
  <text x="718" y="630" text-anchor="middle" font-family="Microsoft YaHei, sans-serif"
        font-size="17" fill="#374151">视野在 −z 侧（−W 面）</text>

  <!-- 坐标轴：负半轴 → 原点 → 正半轴（箭头表示正方向），x 红 / z 蓝 / y 绿 -->
  <line x1="180" y1="495" x2="480" y2="305" stroke="#ef4444" stroke-width="2" marker-end="url(#arrow-x)"/>
  <line x1="490" y1="466" x2="170" y2="334" stroke="#3b82f6" stroke-width="2" marker-end="url(#arrow-z)"/>
  <line x1="330" y1="620" x2="330" y2="180" stroke="#22c55e" stroke-width="2" marker-end="url(#arrow-y)"/>

  <!-- 轴名：平轴 / 升轴 / 推轴 -->
  <text x="492" y="300" font-family="Times New Roman, Microsoft YaHei, serif" font-size="22" fill="#b91c1c"><tspan font-style="italic">x</tspan>（平轴）</text>
  <text x="330" y="150" text-anchor="middle" font-family="Times New Roman, Microsoft YaHei, serif" font-size="22" fill="#15803d"><tspan font-style="italic">y</tspan>（升轴）</text>
  <text x="158" y="330" text-anchor="end" font-family="Times New Roman, Microsoft YaHei, serif" font-size="22" fill="#1d4ed8"><tspan font-style="italic">z</tspan>（推轴）</text>

  <!-- 三个平面的正负面标记 -->
  <text x="150" y="250" text-anchor="middle" font-family="Times New Roman, Microsoft YaHei, serif"
        font-size="20" font-weight="600" fill="#15803d">+<tspan font-style="italic">W</tspan> 面</text>
  <text x="500" y="505" font-family="Times New Roman, Microsoft YaHei, serif"
        font-size="20" font-weight="600" fill="#15803d">−<tspan font-style="italic">W</tspan> 面</text>
  <text x="672" y="330" text-anchor="middle" font-family="Times New Roman, Microsoft YaHei, serif"
        font-size="20" font-weight="600" fill="#b91c1c">+<tspan font-style="italic">H</tspan> 面</text>
  <text x="672" y="432" text-anchor="middle" font-family="Times New Roman, Microsoft YaHei, serif"
        font-size="20" font-weight="600" fill="#b91c1c">−<tspan font-style="italic">H</tspan> 面</text>
  <text x="530" y="230" text-anchor="middle" font-family="Times New Roman, Microsoft YaHei, serif"
        font-size="20" font-weight="600" fill="#1d4ed8">+<tspan font-style="italic">V</tspan> 面</text>
  <text x="110" y="560" text-anchor="middle" font-family="Times New Roman, Microsoft YaHei, serif"
        font-size="20" font-weight="600" fill="#1d4ed8">−<tspan font-style="italic">V</tspan> 面</text>

  <!-- 图例 -->
    <text x="30" y="58" font-family="Microsoft YaHei, sans-serif" font-size="17" fill="#374151"><tspan font-style="italic" font-family="Times New Roman, serif" fill="#b91c1c">H</tspan> 面 = 水平面（xoz 面）　　<tspan font-style="italic" font-family="Times New Roman, serif" fill="#1d4ed8">V</tspan> 面 = 正立面（yoz 面）　　<tspan font-style="italic" font-family="Times New Roman, serif" fill="#15803d">W</tspan> 面 = 侧立面（xoy 面）</text>

  <!-- 原点 -->
  <text x="310" y="388" text-anchor="end" font-family="Times New Roman, serif" font-style="italic" font-size="20" fill="#1f2933">O</text>
</svg>`;

/** 文件名 → 图源。运行时不读磁盘，整张图就在这个文件里。 */
const FIGURES = Object.freeze({
  "coordinate-system.svg": COORDINATE_SYSTEM,
});

/** 地址只取文件名：`../help/coordinate-system.svg` 与 `coordinate-system.svg` 等价。 */
function figureName(src) {
  return String(src ?? "").split(/[\\/]/).pop() ?? "";
}

/**
 * 把 Markdown 里的图片地址换成程序自带的一份图。
 *
 * 文章里写不写路径都行 —— 这里只认文件名，永远不去磁盘上找文件，所以安装目录
 * 里没有 `help/` 也不会出现半张破图。
 *
 * @param {string} src Markdown 括号里的地址。
 * @returns {string} data: URI；没有这张图时返回空串，调用方保留原地址。
 */
export function figureSource(src) {
  const svg = FIGURES[figureName(src)];
  if (!svg) {
    return "";
  }
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * 一张图的原始 SVG 源码（不做 URL 编码）。
 *
 * @param {string} name 文件名，或带路径的地址。
 * @returns {string} 没有这张图时返回空串。测试用它核对与源文件是否同步。
 */
export function figureMarkup(name) {
  return FIGURES[figureName(name)] ?? "";
}
