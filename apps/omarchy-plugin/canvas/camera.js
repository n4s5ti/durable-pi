.pragma library

// Pure camera math for Canvas.qml. QML JS library: only top-level `function`
// declarations, because the test loader reads declarations off a node:vm
// context where `const`/`let` would be invisible.
//
// Camera: {panX, panY, zoom}. The world is a transformed Item with
// x = panX, y = panY, scale = zoom, so screen = world * zoom + pan.

function finiteOr(value, fallback) {
    if (typeof value === "number" && isFinite(value)) {
        return value;
    }
    return fallback;
}

// Zoom is clamped to 0.1-4x everywhere (spec L68). Anything unusable
// (NaN, a non-number) falls back to 1 rather than propagating NaN.
function clampZoom(value) {
    if (typeof value !== "number" || isNaN(value)) {
        return 1;
    }
    if (value > 4) {
        return 4;
    }
    if (value < 0.1) {
        return 0.1;
    }
    return value;
}

function worldToScreen(camera, point) {
    var zoom = clampZoom(camera.zoom);
    return {
        x: finiteOr(point.x, 0) * zoom + finiteOr(camera.panX, 0),
        y: finiteOr(point.y, 0) * zoom + finiteOr(camera.panY, 0)
    };
}

function screenToWorld(camera, point) {
    var zoom = clampZoom(camera.zoom);
    return {
        x: (finiteOr(point.x, 0) - finiteOr(camera.panX, 0)) / zoom,
        y: (finiteOr(point.y, 0) - finiteOr(camera.panY, 0)) / zoom
    };
}

// Wheel zoom about the cursor (spec L68-69): scale by `factor`, clamp to
// 0.1-4x, then move pan so the world point under `pivot` stays under `pivot`.
// Returns a new camera; `camera` and `pivot` are never mutated (spec L22).
function zoomAbout(camera, factor, pivot) {
    var oldZoom = clampZoom(camera.zoom);
    var panX = finiteOr(camera.panX, 0);
    var panY = finiteOr(camera.panY, 0);
    var pivotX = finiteOr(pivot.x, 0);
    var pivotY = finiteOr(pivot.y, 0);

    var newZoom = clampZoom(oldZoom * factor);

    // The world point currently under the pivot.
    var worldX = (pivotX - panX) / oldZoom;
    var worldY = (pivotY - panY) / oldZoom;

    return {
        panX: pivotX - worldX * newZoom,
        panY: pivotY - worldY * newZoom,
        zoom: newZoom
    };
}

// Pinch reports a CUMULATIVE scale since the gesture began. The canvas zooms
// by the ratio of consecutive reports so zoomAbout's clamp applies each step.
// Anything unusable (non-number, non-finite, not above zero) is a no-op 1.
function pinchFactor(previousScale, scale) {
    if (typeof previousScale !== "number" || !isFinite(previousScale) || previousScale <= 0
            || typeof scale !== "number" || !isFinite(scale) || scale <= 0) {
        return 1;
    }
    return scale / previousScale;
}

// Ctrl+scroll on a touchpad arrives as a pixel delta: positive zooms in, and
// equal deltas compose multiplicatively (an exponential, so it is smooth and
// exactly invertible). Non-finite input is a no-op 1.
function pixelZoomFactor(deltaY) {
    if (typeof deltaY !== "number" || !isFinite(deltaY)) {
        return 1;
    }
    return Math.exp(deltaY * 0.01);
}

// Fit `rect` (world {x, y, w, h}) inside `viewport` (screen {w, h}) with
// `padding` screen pixels of margin on every side, centered. Zoom is clamped
// to 0.1-4x, so the rect may overflow when clamping bites; it stays centered.
// Degenerate input (empty rect, zero viewport, padding wider than the
// viewport) falls back to zoom 1 rather than dividing by zero.
function fitToRect(rect, viewport, padding) {
    var pad = finiteOr(padding, 0);
    var rectX = finiteOr(rect.x, 0);
    var rectY = finiteOr(rect.y, 0);
    var rectW = finiteOr(rect.w, 0);
    var rectH = finiteOr(rect.h, 0);
    var viewW = finiteOr(viewport.w, 0);
    var viewH = finiteOr(viewport.h, 0);

    var availableW = viewW - 2 * pad;
    var availableH = viewH - 2 * pad;

    var zoom = 1;
    if (rectW > 0 && rectH > 0 && availableW > 0 && availableH > 0) {
        zoom = Math.min(availableW / rectW, availableH / rectH);
    }
    zoom = clampZoom(zoom);

    var centerX = rectX + rectW / 2;
    var centerY = rectY + rectH / 2;

    return {
        panX: viewW / 2 - centerX * zoom,
        panY: viewH / 2 - centerY * zoom,
        zoom: zoom
    };
}

// --- Culling (spec Data flow: "a node is instantiated only if its world
// bounding box intersects the viewport plus a margin") ---

// The world rectangle the viewport currently covers, expanded by `margin`
// SCREEN pixels on all four sides (world units = margin / the clamped zoom, so
// the band is a constant width on screen at any zoom). The clamp is clampZoom's
// alone, so this rect always describes what the world Item is actually drawn
// at. Returns null when the viewport has no usable size: that is the documented
// "cull nothing" answer, because blanking a canvas that has not been laid out
// yet is worse than instantiating too much. Never mutates its arguments.
function viewportWorldRect(camera, viewport, margin) {
    var zoom = clampZoom(camera ? camera.zoom : undefined);
    var width = finiteOr(viewport ? viewport.w : undefined, 0);
    var height = finiteOr(viewport ? viewport.h : undefined, 0);

    if (!(width > 0) || !(height > 0)) {
        return null;
    }

    var pad = finiteOr(margin, 0) / zoom;
    var left = (0 - finiteOr(camera ? camera.panX : undefined, 0)) / zoom;
    var top = (0 - finiteOr(camera ? camera.panY : undefined, 0)) / zoom;

    return {
        x: left - pad,
        y: top - pad,
        w: width / zoom + 2 * pad,
        h: height / zoom + 2 * pad
    };
}

// A rect is measurable only when all four fields are finite numbers. A string
// "12" is not a coordinate -- same rule as positions.js's isFiniteNumber.
function rectIsMeasurable(rect) {
    return !!rect
        && typeof rect.x === "number" && isFinite(rect.x)
        && typeof rect.y === "number" && isFinite(rect.y)
        && typeof rect.w === "number" && isFinite(rect.w)
        && typeof rect.h === "number" && isFinite(rect.h);
}

// Do two world rects share at least a boundary point? Touching edges count, so
// a node flush against the margin is kept. Fails OPEN: anything unmeasurable
// intersects, because culling must never hide a node it cannot measure (spec
// Error paths). Never mutates its arguments.
function rectsIntersect(a, b) {
    if (!rectIsMeasurable(a) || !rectIsMeasurable(b)) {
        return true;
    }
    return a.x <= b.x + b.w && b.x <= a.x + a.w
        && a.y <= b.y + b.h && b.y <= a.y + a.h;
}
