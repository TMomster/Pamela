// 对白设计器测试。
// Tests for the Pamela dialogue designer.

import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_STYLE, STYLE_SLOTS } from "../dialog.js";
import {
  BACKDROP_ID,
  DEFAULT_POLYGON_SIDES,
  HANDLES,
  LAYER_TYPES,
  LAYER_TYPE_LABELS,
  MAX_POLYGON_SIDES,
  MIN_POLYGON_SIDES,
  SAMPLE_SPEAKER,
  SAMPLE_TEXT,
  SYSTEM_COMPONENTS,
  TEXT_REGIONS,
  addLayer,
  angleFrom,
  clampSides,
  copyStyleTo,
  createDefaultStyle,
  createDefaultTemplate,
  createDocument,
  createLayer,
  documentToJson,
  duplicateLayer,
  findLayer,
  hitTest,
  isBackdropId,
  isRegionId,
  moveLayer,
  moveVertex,
  normalBox,
  normaliseDocument,
  normalisePoints,
  pointInPolygon,
  polygonBounds,
  regionByKey,
  regionFor,
  regularPolygonPoints,
  removeLayer,
  resizeBox,
  resizeLayerBox,
  rotationFrom,
  selectionBox,
  selectionFor,
  setPolygonSides,
  snapBox,
  styleFor,
  syncPolygonBox,
  toLocalDelta,
  toLocalPoint,
  translateLayer,
  updateLayer,
} from "../dialog-editor.js";

/**
 * The layers of a document's dialogue slot.
 *
 * A document holds two styles and the layer arithmetic is the same in both,
 * so these tests work it out on the dialogue slot — the one a new document
 * opens on. The slot is reached through `doc.styles`: a document no longer has
 * layers of its own, which is what the rest of this file would otherwise be
 * written against.
 */
const layersOf = (doc) => doc.styles.dialog.layers;

// --- layer construction ---

test("every layer type has a label the picker can show", () => {
  for (const type of LAYER_TYPES) {
    assert.equal(typeof LAYER_TYPE_LABELS[type], "string");
    assert.ok(LAYER_TYPE_LABELS[type].length > 0, `${type} needs a label`);
  }
  assert.equal(Object.keys(LAYER_TYPE_LABELS).length, LAYER_TYPES.length);
});

test("a new layer is visible, opaque and placed off the corner", () => {
  const layer = createLayer("rect");

  assert.equal(layer.type, "rect");
  assert.equal(layer.visible, true);
  assert.equal(layer.opacity, 1);
  assert.ok(layer.width > 0 && layer.height > 0, "a layer starts with a size");
  assert.match(layer.fill, /^#/, "a rectangle starts with a fill");
  assert.equal(layer.stroke.width, 0);
});

test("each layer type carries only the fields it draws with", () => {
  const rect = createLayer("rect");
  assert.equal(typeof rect.radius, "number");

  const ellipse = createLayer("ellipse");
  assert.equal(ellipse.radius, undefined, "only a rectangle is rounded");

  const line = createLayer("line");
  assert.equal(typeof line.color, "string");
  assert.equal(typeof line.thickness, "number");

  const image = createLayer("image");
  assert.equal(image.source, "");
});

test("layer ids are unique, so the list and the document agree on them", () => {
  const ids = new Set();
  for (let index = 0; index < 50; index += 1) {
    ids.add(createLayer("rect").id);
  }
  assert.equal(ids.size, 50);
});

// --- the document ---

test("a layer added to a loaded document takes an id the file is not using", () => {
  // The counter starts over on every run, so a file the last run wrote is full
  // of the ids this run is about to hand out. Two layers under one id are one
  // layer to everything downstream: both rows in the list mark as selected, and
  // the selection, the property panel and the hit test all answer the first of
  // them — so neither can be picked on its own.
  const doc = normaliseDocument({
    layers: [{ id: "l1", type: "rect", x: 0, y: 0, width: 10, height: 10 }],
  });
  const layers = layersOf(doc);

  const added = addLayer(doc, "polygon");

  assert.notEqual(added.id, "l1", "the id the file carries is not handed out again");
  assert.equal(new Set(layers.map((layer) => layer.id)).size, layers.length);
});

test("two layers under one id in the file are given one each on load", () => {
  const doc = normaliseDocument({
    layers: [
      { id: "l1", type: "rect", x: 0, y: 0, width: 10, height: 10 },
      { id: "l1", type: "ellipse", x: 0, y: 0, width: 10, height: 10 },
    ],
  });
  const layers = layersOf(doc);

  assert.equal(new Set(layers.map((layer) => layer.id)).size, 2);
  assert.equal(layers[1].type, "ellipse", "the repeat keeps its shape");
  assert.equal(findLayer(doc, layers[1].id).type, "ellipse", "and is addressable on its own");
});

test("a new document holds both styles, each an empty plate", () => {
  const doc = createDocument();

  assert.equal(doc.version, 2);
  assert.deepEqual(doc.canvas, DEFAULT_STYLE.canvas);
  assert.equal(doc.active, "dialog", "the designer opens on the dialogue box");
  assert.deepEqual(Object.keys(doc.styles).sort(), [...STYLE_SLOTS].sort());

  for (const slot of STYLE_SLOTS) {
    const style = doc.styles[slot];
    assert.deepEqual(style.layers, []);
    assert.equal(style.stamp.path, "", "the caller decides where the plate goes");
    assert.deepEqual(style.speaker, DEFAULT_STYLE.speaker);
    assert.deepEqual(style.text, DEFAULT_STYLE.text);
  }
});

test("a new document copies the defaults rather than sharing them, the slots apart", () => {
  const doc = createDocument();

  doc.styles.dialog.speaker.font.size = 12;
  doc.styles.dialog.text.font.color = "#000000";
  doc.styles.dialog.layers.push(createLayer("rect"));

  assert.notEqual(DEFAULT_STYLE.speaker.font.size, 12, "the runtime's defaults are not touched");
  assert.notEqual(DEFAULT_STYLE.text.font.color, "#000000");
  assert.equal(doc.styles.narration.speaker.font.size, DEFAULT_STYLE.speaker.font.size);
  assert.deepEqual(doc.styles.narration.layers, [], "a layer added to one slot is not in the other");
});

test("a bare style set is answered back as itself, so a helper takes either shape", () => {
  const doc = createDocument();
  const slot = doc.styles.dialog;

  assert.equal(styleFor(slot), slot, "a style set on its own is already the answer");
  assert.equal(styleFor(doc), slot, "a document answers the slot it is on");

  doc.active = "narration";
  assert.equal(styleFor(doc), doc.styles.narration, "and follows the slot being edited");
});

test("normalise fills a file's gaps from the defaults", () => {
  const doc = normaliseDocument({ stamp: { path: "assets/templates/a.png" } });

  assert.deepEqual(doc.canvas, DEFAULT_STYLE.canvas);
  assert.deepEqual(layersOf(doc), []);
  assert.equal(doc.styles.dialog.stamp.path, "assets/templates/a.png");
  assert.deepEqual(doc.styles.dialog.speaker, DEFAULT_STYLE.speaker);
});

test("normalise keeps what the file does set, fonts included", () => {
  const doc = normaliseDocument({
    canvas: { width: 1280, height: 720 },
    speaker: { x: 10, font: { size: 64 } },
  });

  assert.deepEqual(doc.canvas, { width: 1280, height: 720 });
  assert.equal(doc.styles.dialog.speaker.x, 10);
  assert.equal(doc.styles.dialog.speaker.font.size, 64);
  // The rest of the font block is still the default's.
  assert.equal(doc.styles.dialog.speaker.font.family, DEFAULT_STYLE.speaker.font.family);
  assert.equal(doc.styles.dialog.text.font.size, DEFAULT_STYLE.text.font.size);
});

test("an older file's single style becomes the dialogue slot, and narration is built in", () => {
  // A file from before the split names one style, at the top level, and that
  // one was the dialogue box. The narration slot is filled from the built-in
  // default rather than left empty, so an existing template still opens as
  // something a narrator can speak through.
  const doc = normaliseDocument({
    layers: [{ type: "rect", name: "旧底板" }],
    speaker: { x: 10 },
  });

  assert.equal(doc.styles.dialog.layers[0].name, "旧底板", "the file's layers are the dialogue box's");
  assert.equal(doc.styles.dialog.speaker.x, 10);
  assert.deepEqual(
    doc.styles.narration.layers.map((layer) => layer.name),
    ["底板"],
    "a narration box is built without a name plate",
  );
  assert.deepEqual(
    doc.styles.narration.speaker,
    createDefaultStyle("narration").speaker,
    "and its text sits where that box puts it",
  );
});

test("a file that names its styles is read slot by slot", () => {
  const doc = normaliseDocument({
    active: "narration",
    styles: {
      dialog: { layers: [{ id: "d1", type: "rect" }], speaker: { x: 11 } },
      narration: { layers: [{ id: "n1", type: "line" }] },
    },
  });

  assert.equal(doc.active, "narration", "the slot the file was left on is kept");
  assert.deepEqual(doc.styles.dialog.layers.map((layer) => layer.id), ["d1"]);
  assert.equal(doc.styles.dialog.speaker.x, 11);
  assert.deepEqual(doc.styles.narration.layers.map((layer) => layer.id), ["n1"]);
  // A block the file leaves out is filled from that slot's built-in default —
  // the plate and the text laid out over it, not the bare runtime geometry —
  // so a half-written file opens as something a writer can speak through
  // rather than as an empty rectangle.
  assert.deepEqual(
    doc.styles.narration.speaker,
    createDefaultStyle("narration").speaker,
    "the narrator's box is placed where a built-in one is",
  );
  assert.equal(doc.styles.narration.layers[0].type, "line", "and what it does name is kept");
  assert.equal(normaliseDocument({ styles: {} }).active, "dialog", "an unknown slot is not kept");

  // The geometry of a slot the file never mentions still comes from that
  // slot's built-in default, but its layers are the file's own — and a file
  // that names no layers for it names none. The box is therefore placed but
  // bare, which is what the caller stamps a plate for.
  const bare = normaliseDocument({ styles: {} }).styles.narration;
  assert.deepEqual(bare.layers, []);
  assert.deepEqual(bare.speaker, createDefaultStyle("narration").speaker);


});

test("normalise gives an id to a layer written without one", () => {
  const doc = normaliseDocument({ layers: [{ type: "rect" }, { id: "kept", type: "line" }] });
  const layers = layersOf(doc);

  assert.equal(typeof layers[0].id, "string");
  assert.ok(layers[0].id.length > 0);
  assert.equal(layers[1].id, "kept");
  assert.notEqual(layers[0].id, layers[1].id);
});

test("normalise survives whatever a broken file holds", () => {
  for (const raw of [null, undefined, 0, "text", []]) {
    assert.deepEqual(normaliseDocument(raw), createDocument(), `for ${JSON.stringify(raw)}`);
  }

  // A file whose `layers` is not a list is still a file from before the split,
  // so it lands in the dialogue slot with no layers rather than being thrown
  // away — and the narration slot is still built in.
  const odd = normaliseDocument({ layers: "no" });
  assert.deepEqual(layersOf(odd), []);
  assert.deepEqual(
    odd.styles.narration.layers.map((layer) => layer.name),
    ["底板"],
  );
});

test("the default template gives each slot a plate worth stamping", () => {
  const doc = createDefaultTemplate();

  assert.equal(doc.styles.dialog.stamp.path, "", "the caller decides where the plate goes");
  assert.deepEqual(
    doc.styles.dialog.layers.map((layer) => layer.name),
    ["底板", "姓名框"],
    "a bar for the line and a smaller plate for the name",
  );
  assert.deepEqual(
    doc.styles.narration.layers.map((layer) => layer.name),
    ["底板"],
    "a narration box shows no name, so it carries no name plate",
  );

  for (const slot of STYLE_SLOTS) {
    for (const plate of doc.styles[slot].layers) {
      assert.equal(plate.type, "rect");
      assert.ok(plate.width > 0 && plate.height > 0, "the plate covers area");
      assert.ok(plate.opacity < 1, "the text stays readable through it");
      assert.ok(plate.radius > 0, "the corners are rounded");
      assert.ok(plate.stroke.width > 0, "the outline keeps it visible on a pale frame");
    }
  }
});

test("the default template puts the name on its plate and the line on the bar", () => {
  const doc = createDefaultTemplate();
  const [bar, plate] = doc.styles.dialog.layers;

  const inside = (box, layer) =>
    box.x >= layer.x &&
    box.y >= layer.y &&
    box.x + box.width <= layer.x + layer.width &&
    box.y + box.height <= layer.y + layer.height;

  assert.ok(inside(doc.styles.dialog.speaker, plate), "the name sits on the name plate");
  assert.ok(inside(doc.styles.dialog.text, bar), "the line sits on the bar");
  assert.ok(
    inside(doc.styles.narration.text, doc.styles.narration.layers[0]),
    "the narrator's line sits on its own bar, which has no plate above it",
  );
});

test("two default templates share nothing, layers included", () => {
  const first = createDefaultTemplate();
  const second = createDefaultTemplate();

  assert.notEqual(layersOf(first)[0].id, layersOf(second)[0].id, "ids identify the layer");
  first.styles.dialog.layers[0].fill = "#ff0000";
  assert.notEqual(second.styles.dialog.layers[0].fill, "#ff0000");
  assert.notEqual(
    first.styles.narration.layers[0].id,
    second.styles.narration.layers[0].id,
    "the other slot's plates are their own too",
  );
});

test("copying a style over the other slot is a deep copy", () => {
  const doc = createDefaultTemplate();
  const source = doc.styles.dialog;
  source.stamp.path = "assets/templates/a.png";
  source.speaker.font.size = 55;

  assert.equal(copyStyleTo(doc, "narration"), true);

  const copy = doc.styles.narration;
  assert.equal(copy.stamp.path, "assets/templates/a.png", "the plate path travels too");
  assert.equal(copy.speaker.font.size, 55);
  assert.deepEqual(copy.layers.map((layer) => layer.name), ["底板", "姓名框"]);
  assert.notEqual(copy.layers[0], source.layers[0], "the layers are the copy's own");
  assert.notEqual(copy.speaker, source.speaker);

  // Nudging the copy leaves the original where it was: a copy sharing its
  // vertices or its font would look like two styles and behave as one.
  copy.layers[0].fill = "#00ff00";
  copy.speaker.font.size = 11;
  assert.equal(source.layers[0].fill, "#000000");
  assert.equal(source.speaker.font.size, 55);

  // A slot copied onto itself is not a copy of anything, and neither is one
  // that does not exist — nor is a bare style set a document to copy between.
  doc.active = "narration";
  assert.equal(copyStyleTo(doc, "narration"), false);
  assert.equal(copyStyleTo(doc, "nope"), false);
  assert.equal(copyStyleTo(doc.styles.dialog, "narration"), false);
});

test("a document serialises to JSON that reads back the same", () => {
  const doc = createDocument();
  addLayer(doc, "rect");

  const text = documentToJson(doc);

  assert.ok(text.endsWith("\n"), "the file ends in a newline");
  assert.deepEqual(JSON.parse(text), doc);
});

// --- document operations ---

function documentWith(...types) {
  const doc = createDocument();
  for (const type of types) {
    addLayer(doc, type);
  }
  return doc;
}

test("addLayer puts the new layer on top and answers it", () => {
  const doc = documentWith("rect");

  const added = addLayer(doc, "line");

  assert.equal(layersOf(doc).length, 2);
  assert.equal(layersOf(doc)[1], added, "later in the list paints on top");
});

test("findLayer answers the layer or null", () => {
  const doc = documentWith("rect");
  const id = layersOf(doc)[0].id;

  assert.equal(findLayer(doc, id), layersOf(doc)[0]);
  assert.equal(findLayer(doc, "missing"), null);
});

test("removeLayer reports whether anything went", () => {
  const doc = documentWith("rect");
  const id = layersOf(doc)[0].id;

  assert.equal(removeLayer(doc, id), true);
  assert.deepEqual(layersOf(doc), []);
  assert.equal(removeLayer(doc, id), false, "removing it twice does nothing");
});

test("moveLayer shifts a layer up and down the stack", () => {
  const doc = documentWith("rect", "ellipse", "line");
  const [bottom, middle, top] = layersOf(doc).map((layer) => layer.id);

  // Up one place: the bottom layer ends up between the other two.
  assert.equal(moveLayer(doc, bottom, 1), true);
  assert.deepEqual(layersOf(doc).map((layer) => layer.id), [middle, bottom, top]);

  // And back down again.
  assert.equal(moveLayer(doc, bottom, -1), true);
  assert.deepEqual(layersOf(doc).map((layer) => layer.id), [bottom, middle, top]);
});

test("moveLayer refuses to move past either end", () => {
  const doc = documentWith("rect", "ellipse");
  const [bottom, top] = layersOf(doc).map((layer) => layer.id);
  const before = layersOf(doc).map((layer) => layer.id);

  assert.equal(moveLayer(doc, bottom, -1), false);
  assert.equal(moveLayer(doc, top, 1), false);
  assert.equal(moveLayer(doc, "missing", 1), false);
  assert.deepEqual(layersOf(doc).map((layer) => layer.id), before);
});

test("updateLayer applies numbers as numbers", () => {
  const doc = documentWith("rect");
  const id = layersOf(doc)[0].id;

  const layer = updateLayer(doc, id, { x: 42, width: 0, name: "底板" });

  assert.equal(layer.x, 42);
  assert.equal(layer.width, 0);
  assert.equal(layer.name, "底板");
});

test("updateLayer merges a stroke instead of replacing it", () => {
  const doc = documentWith("rect");
  const id = layersOf(doc)[0].id;

  updateLayer(doc, id, { stroke: { color: "#ff0000" } });
  assert.deepEqual(findLayer(doc, id).stroke, { color: "#ff0000", width: 0 });

  updateLayer(doc, id, { stroke: { width: 3 } });
  assert.deepEqual(findLayer(doc, id).stroke, { color: "#ff0000", width: 3 });
});

test("updateLayer answers null for a layer that is not there", () => {
  const doc = documentWith("rect");
  assert.equal(updateLayer(doc, "missing", { x: 1 }), null);
});

test("a copy lands just above the layer it came from, under a name of its own", () => {
  const doc = documentWith("rect", "ellipse");
  const [bottom, top] = layersOf(doc);

  const copy = duplicateLayer(doc, bottom.id);

  assert.deepEqual(
    layersOf(doc).map((layer) => layer.id),
    [bottom.id, copy.id, top.id],
    "the copy sits directly above its original",
  );
  assert.notEqual(copy.id, bottom.id, "the copy is addressable on its own");
  assert.equal(copy.name, "矩形 副本");
  assert.equal(copy.type, "rect");

  assert.equal(duplicateLayer(doc, "missing"), null);
  assert.equal(duplicateLayer(doc, "region:text"), null, "a text block is not a layer");
});

test("a copy shares nothing with its original, vertices included", () => {
  const doc = documentWith("polygon");
  const original = layersOf(doc)[0];
  original.points = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }];
  syncPolygonBox(original);

  const copy = duplicateLayer(doc, original.id);

  assert.notEqual(copy.points, original.points, "the vertices are the copy's own");
  assert.notEqual(copy.stroke, original.stroke, "so is the outline");

  // Nudged clear of the original, vertices and box together: the box is only a
  // cache, so a copy that moved one and not the other would draw at the wrong
  // corners.
  near(copy.x, original.x + 20);
  near(copy.y, original.y + 20);
  assert.deepEqual(polygonBounds(copy.points), {
    x: copy.x,
    y: copy.y,
    width: copy.width,
    height: copy.height,
  });

  copy.points[0].x = -999;
  copy.stroke.color = "#00ff00";
  assert.equal(original.points[0].x, 0, "dragging the copy does not move the original");
  assert.equal(original.stroke.color, "#ffffff");
});

// --- geometry ---

test("the eight grips are the sides of a box, each named once", () => {
  assert.equal(HANDLES.length, 8);
  assert.equal(new Set(HANDLES).size, 8, "no grip is named twice");
  for (const name of HANDLES) {
    assert.match(name, /^[nsew]{1,2}$/, `${name} is a side or a corner`);
  }
});

test("normalBox turns a box stored inside out back the right way", () => {
  const box = { x: 100, y: 50, width: 200, height: 100 };

  assert.deepEqual(normalBox(box), box);
  assert.deepEqual(normalBox({ x: 300, y: 150, width: -200, height: -100 }), box);
});

test("a point on an unrotated layer is already in its own space", () => {
  const layer = { x: 10, y: 20, width: 100, height: 40, rotation: 0 };
  assert.deepEqual(toLocalPoint(layer, 30, 40), { x: 30, y: 40 });
});

test("a point is turned back through the layer's own angle", () => {
  // A 100×100 box at 90°: the plate point to the right of its centre is the
  // top edge's midpoint once the angle is undone.
  const layer = { x: 0, y: 0, width: 100, height: 100, rotation: 90 };
  const local = toLocalPoint(layer, 100, 50);

  assert.ok(Math.abs(local.x - 50) < 1e-9, `x was ${local.x}`);
  assert.ok(Math.abs(local.y) < 1e-9, `y was ${local.y}`);
});

test("a drag offset is read along the layer's own axes", () => {
  assert.deepEqual(toLocalDelta(0, 10, 5), { x: 10, y: 5 });

  const delta = toLocalDelta(90, 10, 0);
  assert.ok(Math.abs(delta.x) < 1e-9, `x was ${delta.x}`);
  assert.ok(Math.abs(delta.y + 10) < 1e-9, `y was ${delta.y}`);
});

test("the angle to a point is measured the way the plate is drawn", () => {
  const centre = { x: 0, y: 0 };

  near(angleFrom(centre, 1, 0), 0);
  // y runs down, so the point below the centre is a quarter turn clockwise —
  // the same direction an increasing `rotation` turns a layer.
  near(angleFrom(centre, 0, 1), 90);
  near(angleFrom(centre, -1, 0), 180);
  near(angleFrom(centre, 0, -1), -90);
});

test("a rotation drag adds the pointer's swing to the turn already there", () => {
  // Grabbed to the right of the centre and dragged under it: a quarter turn
  // clockwise, on top of the 30° the shape came with.
  assert.equal(rotationFrom(30, 0, 90), 120);
  // Only the swing matters, not where the grip happened to be grabbed: this
  // is a quarter turn anticlockwise, from wherever the pointer started.
  assert.equal(rotationFrom(0, 45, -45), -90);
  assert.equal(rotationFrom(0, -90, -180), -90);
  assert.equal(rotationFrom(0, 137, 137), 0, "a press with no drag changes nothing");
});

test("a turn is normalised into (-180, 180], so a past-half turn reads short", () => {
  assert.equal(rotationFrom(0, 0, 180), 180, "half a turn is kept whole");
  assert.equal(rotationFrom(0, 0, 200), -160);
  assert.equal(rotationFrom(170, 0, -200), -30);
  assert.equal(rotationFrom(0, 0, -190), 170);
});

test("the side opposite the grip remains fixed while the grabbed side follows", () => {
  const box = { x: 100, y: 100, width: 200, height: 100 };

  // A drag across the other axis is ignored: an east grip only touches width.
  assert.deepEqual(resizeBox(box, "e", 10, 999), {
    x: 100,
    y: 100,
    width: 210,
    height: 100,
  });
  assert.deepEqual(resizeBox(box, "n", 999, -10), {
    x: 100,
    y: 90,
    width: 200,
    height: 110,
  });
  assert.deepEqual(resizeBox(box, "nw", -10, -20), {
    x: 90,
    y: 80,
    width: 210,
    height: 120,
  });
  assert.deepEqual(box, { x: 100, y: 100, width: 200, height: 100 }, "the box is untouched");
});

test("hitTest picks the topmost layer under the point", () => {
  const doc = documentWith("rect");
  const bottom = layersOf(doc)[0];
  Object.assign(bottom, { x: 0, y: 0, width: 100, height: 100 });

  const top = addLayer(doc, "rect");
  Object.assign(top, { x: 50, y: 50, width: 100, height: 100 });

  assert.equal(hitTest(doc, 10, 10), bottom.id, "only the bottom layer reaches there");
  assert.equal(hitTest(doc, 75, 75), top.id, "the later layer wins where they overlap");
  assert.equal(hitTest(doc, 400, 400), null, "nothing there");
});

test("hitTest skips a hidden layer and reads a rotated one in its own space", () => {
  const doc = documentWith("rect");
  const layer = layersOf(doc)[0];
  Object.assign(layer, { x: 0, y: 0, width: 100, height: 100, visible: false });

  assert.equal(hitTest(doc, 50, 50), null, "a hidden layer is not picked");

  layer.visible = true;
  layer.rotation = 45;
  assert.equal(hitTest(doc, 50, 50), layer.id, "the centre is still inside it");
  assert.equal(hitTest(doc, 5, 5), null, "and the corner it turned away from is not");
});

test("a line is picked by how near the point is, so a hairline is clickable", () => {
  const doc = documentWith("line");
  const line = layersOf(doc)[0];
  Object.assign(line, { x: 0, y: 0, width: 100, height: 0, thickness: 2 });

  assert.equal(hitTest(doc, 50, 5), line.id);
  assert.equal(hitTest(doc, 50, 40), null);
  // Past its end, the nearest point is the line's own end.
  assert.equal(hitTest(doc, 104, 0), line.id);
  assert.equal(hitTest(doc, 200, 0), null);
});

test("hitTest reads the slot being edited, so each style picks its own layers", () => {
  const doc = documentWith("rect");
  const dialogue = layersOf(doc)[0];
  Object.assign(dialogue, { x: 0, y: 0, width: 100, height: 100 });

  // A layer joins the slot that was being edited when it was added, and the
  // hit test reads the same slot, so neither style can pick the other's work.
  doc.active = "narration";
  const narrator = addLayer(doc, "rect");
  Object.assign(narrator, { x: 300, y: 300, width: 100, height: 100 });
  doc.active = "dialog";

  assert.equal(hitTest(doc, 350, 350), null, "the dialogue plate has nothing there");
  assert.equal(hitTest(doc, 50, 50), dialogue.id, "and its own layer is where it was");

  doc.active = "narration";
  assert.equal(hitTest(doc, 350, 350), narrator.id);
  assert.equal(hitTest(doc, 50, 50), null, "the narrator's plate has nothing there");
});


// --- polygons ---

/** Whether two numbers agree to within a rounding error. */
function near(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-9, message ?? `${actual} is not ${expected}`);
}

test("a side count is rounded and kept inside the range a polygon can hold", () => {
  assert.equal(clampSides(7), 7);
  assert.equal(clampSides(6.4), 6);
  assert.equal(clampSides(2), MIN_POLYGON_SIDES);
  assert.equal(clampSides(100), MAX_POLYGON_SIDES);
  assert.equal(clampSides("8"), 8, "a field hands a string over");
  assert.equal(clampSides("nope"), DEFAULT_POLYGON_SIDES);
  assert.equal(clampSides(undefined), DEFAULT_POLYGON_SIDES);
});

test("the vertices of a regular polygon sit on the box, the first one on top", () => {
  const square = regularPolygonPoints({ x: 0, y: 0, width: 100, height: 100 }, 4);

  assert.equal(square.length, 4);
  near(square[0].x, 50, "a square stands on a side, so it has a corner on top");
  near(square[0].y, 0);
  near(square[1].x, 100);
  near(square[1].y, 50);

  // Every vertex is on the ellipse the box describes, which is what lets a wide
  // box give a wide polygon instead of a circle that ignores the height.
  const wide = regularPolygonPoints({ x: 0, y: 0, width: 200, height: 100 }, 12);
  assert.equal(wide.length, 12);
  for (const point of wide) {
    const dx = (point.x - 100) / 100;
    const dy = (point.y - 50) / 50;
    near(dx * dx + dy * dy, 1, "the vertex is on the box's own ellipse");
  }
});

test("a polygon's box is read back from its vertices", () => {
  assert.deepEqual(polygonBounds([]), { x: 0, y: 0, width: 0, height: 0 }, "no vertices, no extent");

  const layer = { points: [{ x: 10, y: 5 }, { x: 40, y: 5 }, { x: 40, y: 45 }] };
  syncPolygonBox(layer);

  assert.deepEqual(layer, { points: layer.points, x: 10, y: 5, width: 30, height: 40 });
});

test("a fresh polygon's box is the one its vertices cover, not the one they were built over", () => {
  const layer = createLayer("polygon");

  assert.equal(layer.points.length, DEFAULT_POLYGON_SIDES);
  // A hexagon inscribed in a 400-wide box never reaches its sides, so the box
  // it was built over is not the box it is.
  assert.deepEqual(
    { x: layer.x, y: layer.y, width: layer.width, height: layer.height },
    polygonBounds(layer.points),
  );
  assert.match(layer.fill, /^#/);
  assert.equal(layer.stroke.width, 0);
});

test("a point is inside a polygon by the polygon's own outline", () => {
  const square = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];

  assert.equal(pointInPolygon(square, 50, 50), true);
  assert.equal(pointInPolygon(square, 150, 50), false);
  assert.equal(pointInPolygon(square, 50, -10), false);
  assert.equal(pointInPolygon([], 50, 50), false, "a shape with no area holds nothing");
  assert.equal(pointInPolygon([{ x: 0, y: 0 }, { x: 10, y: 10 }], 5, 5), false);
});

test("dragging one vertex leaves the others alone and moves the box with it", () => {
  const layer = createLayer("polygon");
  layer.points = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
  syncPolygonBox(layer);

  moveVertex(layer, 2, 200, 150);

  assert.deepEqual(layer.points[0], { x: 0, y: 0 });
  assert.deepEqual(layer.points[2], { x: 200, y: 150 });
  assert.deepEqual(
    { x: layer.x, y: layer.y, width: layer.width, height: layer.height },
    { x: 0, y: 0, width: 200, height: 150 },
  );
  assert.equal(moveVertex(layer, 99, 0, 0), null, "there is no vertex there");
});

test("a file's vertices are believed, and a file without them gets a shape", () => {
  const points = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }];
  const kept = normalisePoints(points, { x: 0, y: 0, width: 10, height: 10 });

  assert.deepEqual(kept, points);
  assert.notEqual(kept, points, "the vertices are copied, not shared with the file");

  // A list with holes in it is not a shape: too few usable vertices, and the
  // layer is rebuilt as a regular polygon over the box it declares.
  const rebuilt = normalisePoints([{ x: 5, y: 5 }, { x: "nope", y: 0 }], {
    x: 0,
    y: 0,
    width: 100,
    height: 100,
  });
  assert.equal(rebuilt.length, DEFAULT_POLYGON_SIDES);
  const bounds = polygonBounds(rebuilt);
  near(bounds.x + bounds.width / 2, 50, "the rebuilt shape is centred on the box");
  near(bounds.y + bounds.height / 2, 50);
});

test("changing the side count keeps the room the polygon had", () => {
  const layer = createLayer("polygon");
  const before = polygonBounds(layer.points);

  setPolygonSides(layer, 12);

  assert.equal(layer.points.length, 12);
  const after = polygonBounds(layer.points);
  near(after.x + after.width / 2, before.x + before.width / 2);
  near(after.y + after.height / 2, before.y + before.height / 2);
  assert.deepEqual(
    { x: layer.x, y: layer.y, width: layer.width, height: layer.height },
    after,
  );
  assert.equal(setPolygonSides(createLayer("rect"), 5), null, "only a polygon has sides");
});

test("a polygon's vertices travel with its box", () => {
  const doc = documentWith("polygon", "rect");
  const [polygon, rect] = layersOf(doc);
  const from = { x: polygon.x, y: polygon.y };

  translateLayer(polygon, 10, -20);

  near(polygon.x, from.x + 10);
  near(polygon.y, from.y - 20);
  assert.deepEqual(polygonBounds(polygon.points), {
    x: polygon.x,
    y: polygon.y,
    width: polygon.width,
    height: polygon.height,
  });

  // A rectangle has no vertices to bring along: its box is all there is.
  translateLayer(rect, 5, 5);
  assert.equal(rect.x, 105);
  assert.equal(rect.y, 105);
  assert.equal(rect.points, undefined);
});

test("resizing a polygon scales its vertices, and a flat box only slides them", () => {
  const layer = createLayer("polygon");
  layer.points = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
  syncPolygonBox(layer);

  resizeLayerBox(layer, { x: 0, y: 0, width: 200, height: 50 });

  assert.deepEqual(layer.points, [
    { x: 0, y: 0 },
    { x: 200, y: 0 },
    { x: 200, y: 50 },
    { x: 0, y: 50 },
  ]);

  // A box with no width cannot be scaled across, so that axis is only moved.
  const flat = createLayer("polygon");
  flat.points = [{ x: 10, y: 0 }, { x: 10, y: 100 }, { x: 10, y: 50 }];
  syncPolygonBox(flat);
  resizeLayerBox(flat, { x: 60, y: 0, width: 0, height: 100 });

  assert.deepEqual(flat.points, [{ x: 60, y: 0 }, { x: 60, y: 100 }, { x: 60, y: 50 }]);
});

test("a polygon read back from a file keeps its vertices and rebuilds its box", () => {
  const doc = normaliseDocument({
    layers: [
      {
        type: "polygon",
        x: 999,
        y: 999,
        width: 1,
        height: 1,
        points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }],
      },
      { type: "polygon", x: 0, y: 0, width: 100, height: 100 },
    ],
  });

  const [kept, rebuilt] = layersOf(doc);
  assert.deepEqual(kept.points, [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }]);
  assert.deepEqual(
    { x: kept.x, y: kept.y, width: kept.width, height: kept.height },
    { x: 0, y: 0, width: 100, height: 100 },
    "the vertices decide the box, not the numbers the file claims",
  );
  assert.equal(rebuilt.points.length, DEFAULT_POLYGON_SIDES);
});

// --- text regions ---

test("the two text blocks are the only regions, and they are named apart", () => {
  assert.deepEqual(TEXT_REGIONS.map((region) => region.key), ["speaker", "text"]);
  assert.equal(new Set(TEXT_REGIONS.map((region) => region.id)).size, 2, "no id is used twice");

  assert.equal(regionFor("region:speaker").key, "speaker");
  assert.equal(regionByKey("text").id, "region:text");
  assert.equal(regionFor("l1"), null, "a layer id is not a region");
  assert.equal(regionByKey("nope"), null);
  assert.equal(isRegionId("region:text"), true);
  assert.equal(isRegionId("l1"), false);
});

test("the designer's sample words fill both blocks, one face each", () => {
  // The two are what an author reads a font by, so neither may be blank.
  assert.ok(SAMPLE_SPEAKER.length > 0);
  assert.ok(SAMPLE_TEXT.length > 0);
  assert.notEqual(SAMPLE_SPEAKER, SAMPLE_TEXT, "the name plate and the line differ");
});

test("a selection id names a layer or a region, and the box follows the kind", () => {
  const doc = documentWith("rect");
  const layer = layersOf(doc)[0];

  assert.deepEqual(selectionFor(doc, layer.id), { kind: "layer", layer });
  assert.deepEqual(selectionFor(doc, "region:speaker"), {
    kind: "region",
    key: "speaker",
    block: doc.styles.dialog.speaker,
  });
  assert.equal(selectionFor(doc, "region:nope"), null);
  assert.equal(selectionFor(doc, null), null);

  assert.deepEqual(selectionBox(selectionFor(doc, "region:text")), normalBox(doc.styles.dialog.text));
  assert.deepEqual(selectionBox(selectionFor(doc, layer.id)), normalBox(layer));
});

test("a region selection follows the slot being edited, as a layer does", () => {
  const doc = createDocument();
  doc.styles.dialog.speaker.x = 10;
  doc.styles.narration.speaker.x = 20;

  assert.equal(selectionFor(doc, "region:speaker").block.x, 10);
  doc.active = "narration";
  assert.equal(selectionFor(doc, "region:speaker").block.x, 20);
});

// --- the test backdrop and the system components list ---

test("the test backdrop has an id of its own, apart from layers and regions", () => {
  assert.equal(isBackdropId(BACKDROP_ID), true);
  assert.equal(isBackdropId("region:text"), false);
  assert.equal(isBackdropId("l1"), false);
  assert.equal(isBackdropId(null), false);
  assert.equal(isBackdropId(undefined), false);
});

test("系统组件 offers the two text blocks and the test backdrop, each once", () => {
  assert.deepEqual(
    SYSTEM_COMPONENTS.map((component) => component.id),
    ["region:text", "region:speaker", BACKDROP_ID],
  );
  assert.equal(
    new Set(SYSTEM_COMPONENTS.map((component) => component.id)).size,
    SYSTEM_COMPONENTS.length,
    "no id is used twice",
  );
  for (const component of SYSTEM_COMPONENTS) {
    assert.ok(component.name.length > 0, `${component.id} needs a name`);
    assert.ok(["region", "backdrop"].includes(component.kind), `${component.id} has a kind`);
  }

  // A row edits the block the style file declares, so the two must not drift:
  // same id, same name, and the kind that keeps it out of the layer stack.
  for (const region of TEXT_REGIONS) {
    const row = SYSTEM_COMPONENTS.find((component) => component.id === region.id);
    assert.equal(row?.name, region.name);
    assert.equal(row?.kind, "region");
  }
  assert.equal(SYSTEM_COMPONENTS.find((component) => component.id === BACKDROP_ID).kind, "backdrop");
});

test("selecting the test backdrop carries no document half", () => {
  const doc = documentWith("rect");

  // It is the editor's own picture, so the selection is the whole answer — not
  // a missing layer, which reads as `null`.
  assert.deepEqual(selectionFor(doc, BACKDROP_ID), { kind: "backdrop" });
});

// --- alignment ---

test("a box snaps its nearest edge to an alignment line within the threshold", () => {
  const box = { x: 103, y: 200, width: 100, height: 50 };
  const lines = { vertical: [100, 500], horizontal: [200] };

  const snapped = snapBox(box, lines, 8);
  assert.equal(snapped.x, -3, "the left edge is 3 units past the line at 100");
  assert.equal(snapped.y, 0, "the top edge is already on its line");
  assert.deepEqual(snapped.guides, { vertical: [100], horizontal: [200] });
});

test("the nearest of the box's three lines wins", () => {
  // Centre (150) is closer to 152 than either edge is to any line.
  const snapped = snapBox(
    { x: 100, y: 0, width: 100, height: 50 },
    { vertical: [152], horizontal: [] },
    8,
  );
  assert.equal(snapped.x, 2);
  assert.deepEqual(snapped.guides, { vertical: [152], horizontal: [] });
});

test("a line beyond the threshold is ignored, and no guide is drawn", () => {
  const snapped = snapBox(
    { x: 100, y: 100, width: 100, height: 50 },
    { vertical: [130], horizontal: [180] },
    8,
  );
  assert.equal(snapped.x, 0);
  assert.equal(snapped.y, 0);
  assert.deepEqual(snapped.guides, { vertical: [], horizontal: [] });
});









