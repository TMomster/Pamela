// 图片编辑器。
// Pamela — image editor.
// 画布外围留白用于容纳框外手柄；位图不参与序列化，需按 `source` 重载。
/** 把数值夹到 [lo, hi]。 */

export function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

/** 调色参数默认值与范围。亮度 / 对比度 / 饱和度均为 0–2 的乘子，1 为原样。 */
export const ADJUST_DEFAULTS = Object.freeze({
  // 亮度为 0–2 的乘子，1.0 为基准值。
  // Brightness is a 0-2 multiplier with 1.0 as the neutral value.
  brightness: 1,
  contrast: 1, // 0–2，1.0 居中
  saturation: 1, // 0–2，1.0 居中
  hue: 0, // -180–180 度
});

/** 夹取并补全调色参数。 */
export function clampAdjust(input = {}) {
  const a = { ...ADJUST_DEFAULTS, ...input };
  return {
    brightness: clamp(Number(a.brightness) || 1, 0, 2),
    contrast: clamp(Number(a.contrast) || 1, 0, 2),
    saturation: clamp(Number(a.saturation) || 1, 0, 2),
    hue: clamp(Number(a.hue) || 0, -180, 180),
  };
}

/** 把调色参数转成 canvas filter 字符串。 */
export function adjustToFilter(adjust) {
  const a = clampAdjust(adjust);
  return `brightness(${a.brightness}) contrast(${a.contrast}) saturate(${a.saturation}) hue-rotate(${a.hue}deg)`;
}

let layerSeq = 0;

/** 生成一个不与现有图层冲突的图层 id。 */
export function uniqueLayerId(layers) {
  const taken = new Set(layers.map((l) => l.id));
  let id;
  do {
    layerSeq += 1;
    id = `l${layerSeq}`;
  } while (taken.has(id));
  return id;
}

/** 新建图片图层（位图就绪后调用，`bitmap` 是 Image 或 canvas）。 */
export function imageLayer(path, bitmap, width, height) {
  return {
    id: uniqueLayerId([]),
    type: "image",
    source: path,
    bitmap,
    x: 0,
    y: 0,
    width,
    height,
    rotation: 0,
    opacity: 1,
    adjust: { ...ADJUST_DEFAULTS },
    blur: 0,
    sharpen: 0,
  };
}

/** 新建文字图层。 */
export function textLayer(text = "文字") {
  return {
    id: uniqueLayerId([]),
    type: "text",
    text,
    x: 40,
    y: 40,
    fontSize: 48,
    fontFamily: "sans-serif",
    color: "#ffffff",
    rotation: 0,
    opacity: 1,
  };
}

/** 新建形状图层（rect 或 ellipse）。 */
export function shapeLayer(shape = "rect") {
  return {
    id: uniqueLayerId([]),
    type: "shape",
    shape,
    x: 40,
    y: 40,
    width: 200,
    height: 120,
    fill: "#3399ff",
    stroke: "",
    strokeWidth: 0,
    rotation: 0,
    opacity: 1,
  };
}

/** 一个图层的轴对齐包围盒（未旋转）。 */
export function layerBounds(layer) {
  if (layer.type === "image") {
    return { x: layer.x, y: layer.y, width: layer.width, height: layer.height };
  }
  if (layer.type === "shape") {
    return { x: layer.x, y: layer.y, width: layer.width, height: layer.height };
  }
  // 文字图层按字号估算宽高。
  const w = Math.max(1, (layer.text || "").length * layer.fontSize * 0.6);
  return { x: layer.x, y: layer.y, width: w, height: layer.fontSize * 1.2 };
}

/** 命中测试：点 (px, py) 是否落在图层包围盒内。 */
export function hitLayer(layer, px, py) {
  const b = layerBounds(layer);
  return px >= b.x && px <= b.x + b.width && py >= b.y && py <= b.y + b.height;
}

/** 文档尺寸：取所有图层坐标的极值包围盒。 */
export function documentSize(layers) {
  if (!layers.length) {
    return { width: 1, height: 1 };
  }
  let maxX = 0;
  let maxY = 0;
  for (const layer of layers) {
    const b = layerBounds(layer);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }
  return { width: Math.max(1, Math.ceil(maxX)), height: Math.max(1, Math.ceil(maxY)) };
}

/**
 * 3x3 卷积，返回新的 RGBA 像素数组（Uint8ClampedArray 视图）。
 *
 * `kernel` 为长度 9 的数组，按行主序；`divisor` 与 `offset` 用于归一化。
 * 边界像素用最近边复制（clamp），避免黑边。
 */
export function convolve(pixels, width, height, kernel, divisor = 1, offset = 0) {
  const input = pixels;
  const output = new Uint8ClampedArray(input.length);
  const at = (x, y, c) => {
    const cx = clamp(x, 0, width - 1);
    const cy = clamp(y, 0, height - 1);
    return input[(cy * width + cx) * 4 + c];
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      for (let c = 0; c < 3; c += 1) {
        let sum = 0;
        let i = 0;
        for (let ky = -1; ky <= 1; ky += 1) {
          for (let kx = -1; kx <= 1; kx += 1) {
            sum += at(x + kx, y + ky, c) * kernel[i];
            i += 1;
          }
        }
        output[(y * width + x) * 4 + c] = clamp(sum / divisor + offset, 0, 255);
      }
      output[(y * width + x) * 4 + 3] = input[(y * width + x) * 4 + 3];
    }
  }
  return output;
}

/** 锐化核（轻度）。 */
export const SHARPEN_KERNEL = [0, -1, 0, -1, 5, -1, 0, -1, 0];

/** 图层序列化（位图不进磁盘，只记来源与几何）。 */
export function serializeLayers(layers) {
  return JSON.stringify(
    layers.map((l) => {
      const { bitmap, ...rest } = l;
      return rest;
    }),
  );
}

/** 反序列化图层（位图留空，加载时再补齐）。 */
export function parseLayers(json) {
  const list = JSON.parse(json);
  return Array.isArray(list) ? list : [];
}

// --- 裁剪框几何 ---

/** 八向手柄名：四角 + 四边中点。 */
export const CROP_HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** 各手柄在裁剪框上的中心坐标（文档坐标）。 */
export function cropHandlePositions(box) {
  const { x, y, w, h } = box;
  return {
    nw: { x, y },
    n: { x: x + w / 2, y },
    ne: { x: x + w, y },
    e: { x: x + w, y: y + h / 2 },
    se: { x: x + w, y: y + h },
    s: { x: x + w / 2, y: y + h },
    sw: { x, y: y + h },
    w: { x, y: y + h / 2 },
  };
}

/**
 * 拖动手柄时按指针位置更新裁剪框。东 / 西手柄改宽，南 / 北手柄改高，
 * 角手柄同时改两者；手柄往对侧越界时夹到 `minSize`，框不会翻转。
 */
export function resizeCrop(box, handle, px, py, minSize = 1) {
  let { x, y, w, h } = box;
  const right = x + w;
  const bottom = y + h;
  if (handle.includes("w")) {
    x = Math.min(px, right - minSize);
    w = right - x;
  }
  if (handle.includes("e")) {
    w = Math.max(minSize, px - x);
  }
  if (handle.includes("n")) {
    y = Math.min(py, bottom - minSize);
    h = bottom - y;
  }
  if (handle.includes("s")) {
    h = Math.max(minSize, py - y);
  }
  return { x, y, w, h };
}

/** 整体平移裁剪框（不夹边界）。 */
export function moveCrop(box, dx, dy) {
  return { ...box, x: box.x + dx, y: box.y + dy };
}

/** 命中测试：指针是否落在某手柄内（文档坐标，radius 为命中半径）。 */
export function hitCropHandle(box, px, py, radius = 8) {
  const positions = cropHandlePositions(box);
  for (const handle of CROP_HANDLES) {
    const p = positions[handle];
    if (Math.abs(px - p.x) <= radius && Math.abs(py - p.y) <= radius) {
      return handle;
    }
  }
  return null;
}

/**
 * 画布在文档四周留出的空白（像素）。手柄有一半画在裁剪框外，贴着文档边缘的
 * 画布外围留白用于容纳框外手柄；画布若仅取文档尺寸，手柄会被裁切。
 * 手柄半径为 8px，12px 留白可完整容纳框外手柄。
 */
export const CROP_PAD = 12;

/**
 * 把指针事件坐标换算成文档坐标。
 *
 * 画布像素尺寸是「文档 + 四周各一圈 CROP_PAD」，文档内容整体平移 CROP_PAD
 * 绘制，所以换算要按整张画布缩放后再扣掉这圈空白。pointerdown / pointermove
 * 共用同一套换算，避免两处各自维护出现偏差。
 */
export function pointerToDoc(clientX, clientY, rect, docWidth, docHeight) {
  const scaleX = (docWidth + CROP_PAD * 2) / rect.width;
  const scaleY = (docHeight + CROP_PAD * 2) / rect.height;
  return {
    x: (clientX - rect.left) * scaleX - CROP_PAD,
    y: (clientY - rect.top) * scaleY - CROP_PAD,
  };
}

/**
 * 构建图片编辑器。
 *
 * @param {object} options
 * @param {HTMLElement} options.element 容器
 * @param {(path: string) => Promise<string>} options.readImage 项目内图片 → data URL
 * @param {(path: string, dataUrl: string) => Promise<void>} options.writeAsset 写回 assets
 * @param {() => string[]} [options.listImages] 项目内图片路径列表（添加图层用）
 * @param {(message: string) => void} [options.onError]
 * @param {(message: string) => void} [options.onStatus] 普通状态提示（成功信息）
 * @param {() => void} [options.onChange]
 */
export function createImageEditor({
  element,
  readImage,
  writeAsset,
  listImages = () => [],
  onError = () => {},
  onStatus = () => {},
  onChange = () => {},
}) {
  let path = null;
  let layers = [];
  let selectedId = null;
  let docWidth = 1;
  let docHeight = 1;
  let dirty = false;
  // 裁剪选框为 `{ x, y, w, h }`；`null` 表示非裁剪态。
  let cropMode = null;

  const history = [];
  const future = [];

  // --- DOM 骨架 ---
  const node = document.createElement("div");
  node.className = "image-editor";

  const toolbar = document.createElement("div");
  toolbar.className = "image-editor__toolbar";

  const canvasWrap = document.createElement("div");
  canvasWrap.className = "image-editor__canvas-wrap";
  const canvas = document.createElement("canvas");
  canvas.className = "image-editor__canvas";
  canvasWrap.append(canvas);
  const ctx = canvas.getContext("2d");

  const side = document.createElement("div");
  side.className = "image-editor__side";
  const layerList = document.createElement("div");
  layerList.className = "image-editor__layers";
  const props = document.createElement("div");
  props.className = "image-editor__props";

  const body = document.createElement("div");
  body.className = "image-editor__body";
  body.append(canvasWrap, side);
  node.append(toolbar, body);
  side.append(layerList, props);
  element.append(node);

  // --- 工具按钮 ---
  const buttons = [
    { label: "添加图片", run: addImageLayer },
    { label: "添加文字", run: () => addTextLayer() },
    { label: "矩形", run: () => addShapeLayer("rect") },
    { label: "椭圆", run: () => addShapeLayer("ellipse") },
    { label: "裁剪", run: toggleCrop, keepCrop: true },
    { label: "应用裁剪", run: applyCrop, keepCrop: true },
    { label: "上移", run: () => reorder(1) },
    { label: "下移", run: () => reorder(-1) },
    { label: "删除", run: deleteSelected },
    { label: "撤销", run: undo },
    { label: "重做", run: redo },
    { label: "保存", run: saveOverwrite },
    { label: "导出为…", run: exportAs },
  ];
  for (const { label, run, keepCrop } of buttons) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "image-editor__btn";
    btn.textContent = label;
    btn.addEventListener("click", () => {
      if (!keepCrop) exitCrop();
      run();
    });
    toolbar.append(btn);
  }

  // --- 快照与撤销重做 ---
  function snapshot() {
    history.push(JSON.stringify(layers));
    if (history.length > 100) history.shift();
    future.length = 0;
  }
  function undo() {
    if (!history.length) return;
    future.push(JSON.stringify(layers));
    layers = JSON.parse(history.pop());
    reattachBitmaps();
    if (!layers.find((l) => l.id === selectedId)) selectedId = null;
    markDirty();
    render();
  }
  function redo() {
    if (!future.length) return;
    history.push(JSON.stringify(layers));
    layers = JSON.parse(future.pop());
    reattachBitmaps();
    markDirty();
    render();
  }

  // 反序列化后位图不保留，需按 `source` 重新载入。
  async function reattachBitmaps() {
    for (const layer of layers) {
      if (layer.type === "image" && !layer.bitmap && layer.source) {
        try {
          layer.bitmap = await decode(layer.source);
        } catch {
          /* 加载失败保留占位 */
        }
      }
    }
  }

  function markDirty() {
    dirty = true;
    onChange();
  }

  function decode(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`无法加载图片：${src}`));
      readImage(src).then((url) => {
        img.src = url;
      }, reject);
    });
  }

  /** 加载一张图片作为初始底图（覆盖当前编辑）。 */
  async function load(projectPath) {
    path = projectPath;
    try {
      const img = await decode(projectPath);
      layers = [imageLayer(projectPath, img, img.naturalWidth, img.naturalHeight)];
      selectedId = layers[0].id;
      docWidth = img.naturalWidth;
      docHeight = img.naturalHeight;
      history.length = 0;
      future.length = 0;
      dirty = false;
      render();
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }

  function addImageLayer() {
    const candidates = listImages();
    const choice = window.prompt(
      "请输入要添加的图片路径（项目相对，如 assets/bg.png）：",
      candidates[0] ?? "assets/",
    );
    if (!choice) return;
    snapshot();
    decode(choice.trim())
      .then((img) => {
        const layer = imageLayer(choice.trim(), img, img.naturalWidth, img.naturalHeight);
        layers.push(layer);
        selectedId = layer.id;
        markDirty();
        render();
      })
      .catch((error) => onError(error instanceof Error ? error.message : String(error)));
  }

  function addTextLayer() {
    const text = window.prompt("文字内容：", "文字");
    if (text === null) return;
    snapshot();
    const layer = textLayer(text);
    layers.push(layer);
    selectedId = layer.id;
    markDirty();
    render();
  }

  function addShapeLayer(shape) {
    snapshot();
    const layer = shapeLayer(shape);
    layers.push(layer);
    selectedId = layer.id;
    markDirty();
    render();
  }

  function deleteSelected() {
    if (!selectedId) return;
    snapshot();
    layers = layers.filter((l) => l.id !== selectedId);
    selectedId = null;
    markDirty();
    render();
  }

  function reorder(delta) {
    if (!selectedId) return;
    const index = layers.findIndex((l) => l.id === selectedId);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= layers.length) return;
    snapshot();
    const [item] = layers.splice(index, 1);
    layers.splice(target, 0, item);
    markDirty();
    render();
  }

  function selected() {
    return layers.find((l) => l.id === selectedId) ?? null;
  }

  // --- 裁剪 ---
  function toggleCrop() {
    if (cropMode) {
      exitCrop();
    } else {
      enterCrop();
    }
  }

  function enterCrop() {
    cropMode = { x: 0, y: 0, w: docWidth, h: docHeight };
    render();
  }
  function exitCrop() {
    if (!cropMode) return;
    cropMode = null;
    render();
  }
  function applyCrop() {
    if (!cropMode) return;
    const r = cropMode;
    if (r.w < 2 || r.h < 2) {
      exitCrop();
      return;
    }
    snapshot();
    const composed = composeToCanvas(docWidth, docHeight);
    const c = document.createElement("canvas");
    c.width = Math.round(r.w);
    c.height = Math.round(r.h);
    c.getContext("2d").drawImage(
      composed,
      Math.round(r.x),
      Math.round(r.y),
      Math.round(r.w),
      Math.round(r.h),
      0,
      0,
      Math.round(r.w),
      Math.round(r.h),
    );
    layers = [imageLayer(path, c, c.width, c.height)];
    docWidth = c.width;
    docHeight = c.height;
    selectedId = layers[0].id;
    cropMode = null;
    markDirty();
    render();
  }

  // --- 渲染 ---
  function composeToCanvas(width, height) {
    const c = document.createElement("canvas");
    c.width = width;
    c.height = height;
    const cc = c.getContext("2d");
    drawAll(cc, width, height);
    return c;
  }

  function drawAll(cc, width, height) {
    cc.clearRect(0, 0, width, height);
    for (const layer of layers) {
      drawLayer(cc, layer);
    }
  }

  function drawLayer(cc, layer) {
    cc.save();
    cc.globalAlpha = layer.opacity ?? 1;
    if (layer.type === "image") {
      drawImageLayer(cc, layer);
    } else if (layer.type === "text") {
      drawTextLayer(cc, layer);
    } else if (layer.type === "shape") {
      drawShapeLayer(cc, layer);
    }
    cc.restore();
  }

  function drawImageLayer(cc, layer) {
    if (!layer.bitmap) return;
    const temp = document.createElement("canvas");
    temp.width = layer.width;
    temp.height = layer.height;
    const tc = temp.getContext("2d");
    const filter = adjustToFilter(layer.adjust);
    tc.filter = layer.blur > 0 ? `${filter} blur(${layer.blur}px)` : filter;
    tc.drawImage(layer.bitmap, 0, 0, layer.width, layer.height);
    let source = temp;
    if (layer.sharpen > 0) {
      source = sharpenCanvas(temp, layer.sharpen);
    }
    cc.translate(layer.x + layer.width / 2, layer.y + layer.height / 2);
    cc.rotate((layer.rotation * Math.PI) / 180);
    cc.drawImage(source, -layer.width / 2, -layer.height / 2, layer.width, layer.height);
  }

  function sharpenCanvas(src, amount) {
    const w = src.width;
    const h = src.height;
    const sctx = src.getContext("2d");
    const data = sctx.getImageData(0, 0, w, h);
    const kernel = SHARPEN_KERNEL.map((k) => k * (amount / 100));
    kernel[4] = 1 + (kernel[1] + kernel[3] + kernel[5] + kernel[7]) * -1 + 4 * (amount / 100);
    const out = convolve(data.data, w, h, kernel, 1, 0);
    const result = document.createElement("canvas");
    result.width = w;
    result.height = h;
    result.getContext("2d").putImageData(new ImageData(out, w, h), 0, 0);
    return result;
  }

  function drawTextLayer(cc, layer) {
    cc.translate(layer.x, layer.y);
    cc.rotate((layer.rotation * Math.PI) / 180);
    cc.fillStyle = layer.color;
    cc.font = `${layer.fontSize}px ${layer.fontFamily}`;
    cc.textBaseline = "top";
    cc.fillText(layer.text, 0, 0);
  }

  function drawShapeLayer(cc, layer) {
    cc.translate(layer.x + layer.width / 2, layer.y + layer.height / 2);
    cc.rotate((layer.rotation * Math.PI) / 180);
    cc.fillStyle = layer.fill;
    cc.beginPath();
    if (layer.shape === "ellipse") {
      cc.ellipse(0, 0, layer.width / 2, layer.height / 2, 0, 0, Math.PI * 2);
    } else {
      cc.rect(-layer.width / 2, -layer.height / 2, layer.width, layer.height);
    }
    cc.fill();
    if (layer.strokeWidth > 0 && layer.stroke) {
      cc.lineWidth = layer.strokeWidth;
      cc.strokeStyle = layer.stroke;
      cc.stroke();
    }
  }

  // 拖动滑块或手柄时仅重绘画布，不重建属性面板，以免中断交互。
  function redrawCanvas() {
    // 画布比文档四周各大 CROP_PAD：贴边裁剪手柄有一半画在框外，只有文档大小
    // 的画布会把它们裁掉。文档内容整体平移 CROP_PAD 绘制，指针坐标换算时再扣回。
    canvas.width = docWidth + CROP_PAD * 2;
    canvas.height = docHeight + CROP_PAD * 2;
    ctx.setTransform(1, 0, 0, 1, CROP_PAD, CROP_PAD);
    drawAll(ctx, docWidth, docHeight);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (cropMode) {
      drawCropOverlay();
    }
  }

  // 裁剪遮罩 + 八向操作手柄（四角 + 四边中点）。
  function drawCropOverlay() {
    const r = cropMode;
    ctx.save();
    // 框外暗化，突出裁剪区域。
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.fillRect(0, 0, docWidth, r.y);
    ctx.fillRect(0, r.y + r.h, docWidth, docHeight - (r.y + r.h));
    ctx.fillRect(0, r.y, r.x, r.h);
    ctx.fillRect(r.x + r.w, r.y, docWidth - (r.x + r.w), r.h);
    ctx.strokeStyle = "#3399ff";
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.setLineDash([]);
    const positions = cropHandlePositions(r);
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "#3399ff";
    ctx.lineWidth = 2;
    for (const handle of CROP_HANDLES) {
      const p = positions[handle];
      ctx.fillRect(p.x - 8, p.y - 8, 16, 16);
      ctx.strokeRect(p.x - 8, p.y - 8, 16, 16);
    }
    ctx.restore();
  }

  function render() {
    redrawCanvas();
    renderLayerList();
    renderProps();
  }

  function renderLayerList() {
    layerList.replaceChildren();
    [...layers].reverse().forEach((layer) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "image-editor__layer";
      if (layer.id === selectedId) row.classList.add("is-selected");
      const label =
        layer.type === "image"
          ? `图片 ${layer.source.split("/").pop()}`
          : layer.type === "text"
            ? `文字 ${layer.text}`
            : `形状 ${layer.shape}`;
      row.textContent = label;
      row.addEventListener("click", () => {
        selectedId = layer.id;
        render();
      });
      layerList.append(row);
    });
  }

  function renderProps() {
    props.replaceChildren();
    const layer = selected();
    if (!layer) {
      props.textContent = "未选中图层";
      return;
    }
    const title = document.createElement("div");
    title.className = "image-editor__prop-title";
    title.textContent = `属性（${layer.type}）`;
    props.append(title);

    const fmtInt = (v) => String(Math.round(Number(v)));
    const fmt2 = (v) => Number(v).toFixed(2);
    const addNumber = (key, labelText, min, max, step, format, target) => {
      // 调色参数存储于 `layer.adjust` 子对象，需显式指定目标对象。
      const obj = target ?? layer;
      const fmt = format ?? ((v) => v);
      const wrap = document.createElement("label");
      wrap.className = "image-editor__field";
      const head = document.createElement("div");
      head.className = "image-editor__field-head";
      const name = document.createElement("span");
      name.textContent = labelText;
      const valueSpan = document.createElement("span");
      valueSpan.className = "image-editor__field-value";
      valueSpan.textContent = fmt(obj[key] ?? 0);
      head.append(name, valueSpan);
      const input = document.createElement("input");
      input.type = "range";
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(obj[key] ?? 0);
      input.addEventListener("input", () => {
        snapshotOnFirstEdit();
        const v = Number(input.value);
        obj[key] = v;
        valueSpan.textContent = fmt(v);
        redrawCanvas();
      });
      input.addEventListener("change", endEdit);
      wrap.append(head, input);
      props.append(wrap);
    };

    addNumber("x", "X", -docWidth, docWidth * 2, 1, fmtInt);
    addNumber("y", "Y", -docHeight, docHeight * 2, 1, fmtInt);
    if (layer.type === "image" || layer.type === "shape") {
      addNumber("width", "宽", 1, docWidth * 2, 1, fmtInt);
      addNumber("height", "高", 1, docHeight * 2, 1, fmtInt);
    }
    addNumber("rotation", "旋转", -180, 180, 1, fmtInt);
    addNumber("opacity", "透明度", 0, 1, 0.05, fmt2);

    if (layer.type === "image") {
      addNumber("blur", "模糊", 0, 20, 0.5, fmt2);
      addNumber("sharpen", "锐化", 0, 100, 1, fmtInt);
      addNumber("brightness", "亮度", 0, 2, 0.05, fmt2, layer.adjust);
      addNumber("contrast", "对比度", 0, 2, 0.05, fmt2, layer.adjust);
      addNumber("saturation", "饱和度", 0, 2, 0.05, fmt2, layer.adjust);
      addNumber("hue", "色相", -180, 180, 1, fmtInt, layer.adjust);
    }
    if (layer.type === "text") {
      const t = document.createElement("label");
      t.className = "image-editor__field";
      t.textContent = "文字";
      const i = document.createElement("input");
      i.type = "text";
      i.value = layer.text;
      i.addEventListener("input", () => {
        snapshotOnFirstEdit();
        layer.text = i.value;
        // Rebuilding the panel here would remove the input and drop the caret.
        redrawCanvas();
      });
      i.addEventListener("change", () => {
        renderLayerList();
        endEdit();
      });
      t.append(i);
      props.append(t);
      const color = document.createElement("label");
      color.className = "image-editor__field";
      color.textContent = "颜色";
      const ci = document.createElement("input");
      ci.type = "color";
      ci.value = layer.color;
      ci.addEventListener("input", () => {
        snapshotOnFirstEdit();
        layer.color = ci.value;
        redrawCanvas();
      });
      ci.addEventListener("change", endEdit);
      color.append(ci);
      props.append(color);
    }
  }

  // 滑块拖动期间只在第一次落点记一次快照，避免每像素一条历史。
  let editing = false;
  function snapshotOnFirstEdit() {
    if (!editing) {
      snapshot();
      editing = true;
    }
  }
  function endEdit() {
    editing = false;
  }

  // --- 画布交互：移动图层 / 拖裁剪框 ---
  // 裁剪手柄命中半径，单位为文档坐标；取值放宽以提高指针命中率。
  const HANDLE_RADIUS = 14;
  let dragging = null;

  canvas.addEventListener("pointerdown", (event) => {
    const rect = canvas.getBoundingClientRect();
    // 画布含四周 CROP_PAD 空白，需换算到文档坐标。
    const p = pointerToDoc(event.clientX, event.clientY, rect, docWidth, docHeight);
    const px = p.x;
    const py = p.y;
    if (cropMode) {
      // 命中优先级：八向手柄、框体（移动整个选框）、从落点新建选框。
      const handle = hitCropHandle(cropMode, px, py, HANDLE_RADIUS);
      if (handle) {
        dragging = { kind: "cropHandle", handle };
        return;
      }
      if (
        px >= cropMode.x &&
        px <= cropMode.x + cropMode.w &&
        py >= cropMode.y &&
        py <= cropMode.y + cropMode.h
      ) {
        dragging = { kind: "cropMove", startX: px, startY: py, orig: { ...cropMode } };
        return;
      }
      cropMode = { x: px, y: py, w: 0, h: 0 };
      dragging = { kind: "crop" };
      return;
    }
    // 从顶层往下命中（列表逆序绘制即顶层在上）。
    const hit = [...layers].reverse().find((l) => hitLayer(l, px, py));
    if (hit) {
      selectedId = hit.id;
      dragging = { kind: "layer", id: hit.id, dx: px - hit.x, dy: py - hit.y };
      snapshotOnFirstEdit();
      render();
    }
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    const rect = canvas.getBoundingClientRect();
    const p = pointerToDoc(event.clientX, event.clientY, rect, docWidth, docHeight);
    const px = p.x;
    const py = p.y;
    if (dragging.kind === "cropHandle") {
      cropMode = resizeCrop(cropMode, dragging.handle, px, py);
      redrawCanvas();
      return;
    }
    if (dragging.kind === "cropMove") {
      cropMode = moveCrop(cropMode, px - dragging.startX, py - dragging.startY);
      redrawCanvas();
      return;
    }
    if (dragging.kind === "crop") {
      cropMode.w = px - cropMode.x;
      cropMode.h = py - cropMode.y;
      redrawCanvas();
      return;
    }
    const layer = layers.find((l) => l.id === dragging.id);
    if (layer) {
      layer.x = px - dragging.dx;
      layer.y = py - dragging.dy;
      redrawCanvas();
    }
  });

  function stopDrag() {
    if (dragging?.kind === "crop" && cropMode) {
      // 归一化负向拖拽。
      if (cropMode.w < 0) {
        cropMode.x += cropMode.w;
        cropMode.w = -cropMode.w;
      }
      if (cropMode.h < 0) {
        cropMode.y += cropMode.h;
        cropMode.h = -cropMode.h;
      }
    }
    dragging = null;
    endEdit();
  }
  canvas.addEventListener("pointerup", stopDrag);
  canvas.addEventListener("pointerleave", stopDrag);

  // 裁剪模式下回车确认，Esc 取消。
  node.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && cropMode) {
      event.preventDefault();
      applyCrop();
    } else if (event.key === "Escape") {
      if (cropMode) exitCrop();
    }
  });

  // --- 导出 / 保存 ---
  function exportDataUrl() {
    return composeToCanvas(docWidth, docHeight).toDataURL("image/png");
  }

  async function saveOverwrite() {
    if (!path) return;
    try {
      await writeAsset(path, exportDataUrl());
      dirty = false;
      onChange();
      onStatus(`已保存 ${path}`);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }

  async function exportAs() {
    const target = window.prompt("导出路径（项目相对，如 assets/out.png）：", "assets/out.png");
    if (!target) return;
    try {
      await writeAsset(target.trim(), exportDataUrl());
      onStatus(`已导出 ${target.trim()}`);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }

  function close() {
    node.remove();
  }

  return {
    node,
    load,
    render,
    addImageLayer,
    addTextLayer,
    addShapeLayer,
    deleteSelected,
    selectLayer: (id) => {
      selectedId = id;
      render();
    },
    undo,
    redo,
    crop: applyCrop,
    enterCrop,
    exitCrop,
    exportDataUrl,
    save: saveOverwrite,
    serialize: () => serializeLayers(layers),
    get dirty() {
      return dirty;
    },
    close,
  };
}
