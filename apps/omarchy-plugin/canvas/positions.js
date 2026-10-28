.pragma library

// Working-position bookkeeping for Canvas.qml (parent spec Data flow steps
// 2-4). QML JS library: no imports, and only top-level `function` declarations,
// because the test loader evaluates this source in a node:vm context and reads
// the declarations back off it, where `const`/`let` would be invisible.
// Nothing the caller passed in is ever written.
//
// Public surface:
//   asArray(value)                  -> the array-like itself, or []
//   isFiniteNumber(value)           -> bool
//   isPinned(node)                  -> bool
//   sizeValue(value, fallback)      -> number
//   draggedPosition(origin, screenDelta, worldScale) -> {x, y} or null
//   key(id)                         -> working-map key for an id
//   usableNodes(nodes)              -> sanitized array of model entries
//   placedPosition(laidOut, id)     -> {x, y} or null
//   merge(previous, nodes, laidOut) -> {key(id): {x, y}}

// A QML binding can deliver a model as undefined before its source exists, and
// a caller can hand us anything at all; both are an empty model, not an error.
// Strings are array-like and are deliberately excluded.
function asArray(value) {
    if (!value || typeof value === "string" || typeof value.length !== "number") {
        return [];
    }
    return value;
}

// Only finite numbers count as coordinates. A string "12" or a NaN is treated
// as absent, never coerced -- same rule as Canvas.qml's _isFiniteNumber.
function isFiniteNumber(value) {
    return typeof value === "number" && isFinite(value);
}

// Parent spec Data flow step 2: a node the caller positioned is pinned, and its
// coordinates always win over layout's.
function isPinned(node) {
    return !!node && isFiniteNumber(node.x) && isFiniteNumber(node.y);
}

// Node dimension: a finite number > 0, else the fallback. Mirrors layout.js's
// own sizeValue so the drawn size and the laid-out size agree.
function sizeValue(value, fallback) {
    if (isFiniteNumber(value) && value > 0) {
        return value;
    }
    return fallback;
}

// Parent spec L71-72: a node drag moves in WORLD coordinates, so the pointer's
// screen delta is divided by the scale the world is drawn at. `worldScale` is
// the already-clamped zoom (Camera.clampZoom) -- the clamp lives in camera.js
// and is never reimplemented here; the guard below only stops a junk value from
// dividing by zero or producing a NaN (spec Error paths).
//
// An unusable origin is a documented no-move: null, which callers skip. An
// unusable delta component contributes 0 rather than poisoning the pair.
function draggedPosition(origin, screenDelta, worldScale) {
    if (!origin || !isFiniteNumber(origin.x) || !isFiniteNumber(origin.y)) {
        return null;
    }

    var scale = (isFiniteNumber(worldScale) && worldScale > 0) ? worldScale : 1;
    var deltaX = (screenDelta && isFiniteNumber(screenDelta.x)) ? screenDelta.x : 0;
    var deltaY = (screenDelta && isFiniteNumber(screenDelta.y)) ? screenDelta.y : 0;

    return {x: origin.x + deltaX / scale, y: origin.y + deltaY / scale};
}

// The working map is keyed by key(id), never by the raw id, so a node called
// "constructor" or "__proto__" cannot collide with an Object.prototype member.
function key(id) {
    return "n" + id;
}

// layout() dereferences nodes[i].id unguarded, so it only ever sees this array:
// entries that are objects carrying a usable id, first occurrence of each id
// (matching layout.js, which keys by mapKey and skips repeats). A new array is
// returned; the caller's array and entries are untouched.
function usableNodes(nodes) {
    var list = asArray(nodes);
    var result = [];
    var seen = {};
    for (var i = 0; i < list.length; i++) {
        var node = list[i];
        if (!node || typeof node !== "object") {
            continue;
        }
        if (node.id === undefined || node.id === null) {
            continue;
        }
        var k = key(node.id);
        if (seen[k]) {
            continue;
        }
        seen[k] = true;
        result.push(node);
    }
    return result;
}

// layout()'s result is keyed by the raw id, so a plain lookup for "toString"
// would find Object.prototype's method. Read own properties only, and accept
// only a pair of finite coordinates.
function placedPosition(laidOut, id) {
    if (!laidOut || !Object.prototype.hasOwnProperty.call(laidOut, id)) {
        return null;
    }
    var value = laidOut[id];
    if (!value || !isFiniteNumber(value.x) || !isFiniteNumber(value.y)) {
        return null;
    }
    return {x: value.x, y: value.y};
}

// Parent spec Data flow steps 2-4. For every usable entry of the new model:
// caller coordinates win; otherwise the position it already had in `previous`
// is kept, so an auto-placed node does not jump when a new array arrives; only
// a genuinely new unpositioned node takes a fresh layout position. Ids absent
// from the new model are simply not carried over.
function merge(previous, nodes, laidOut) {
    var prior = previous ? previous : {};
    var list = usableNodes(nodes);
    var result = {};
    for (var i = 0; i < list.length; i++) {
        var node = list[i];
        var k = key(node.id);

        if (isPinned(node)) {
            result[k] = {x: node.x, y: node.y};
            continue;
        }

        var kept = prior[k];
        if (kept && isFiniteNumber(kept.x) && isFiniteNumber(kept.y)) {
            result[k] = {x: kept.x, y: kept.y};
            continue;
        }

        var placed = placedPosition(laidOut, node.id);
        result[k] = placed ? placed : {x: 0, y: 0};
    }
    return result;
}
