import QtQuick
import QtQuick.Shapes
import "positions.js" as Positions

// The edge layer (spec 5.1): one cubic Bezier per entry of the caller's `edges`
// array, in WORLD coordinates. It lives inside Canvas.qml's `world` Item, so
// pan and zoom come from that Item's transform alone -- there is no camera
// arithmetic anywhere in this file.
//
// The root is an Item rather than a Shape because ShapePath is not an Item and
// QtQuick's Repeater instantiates Item delegates only: a dynamically sized list
// of paths has to be a Repeater of one-path Shapes. Each edge therefore gets its
// own Shape, which is also what 5.2's hit area will attach to.
//
// Nothing here writes to the caller's `nodes` or `edges` (spec L22).
Item {
    id: root
    objectName: "canvasEdges"

    // Caller edges, array of {id, from, to}. Read-only.
    property var edges: []

    // Canvas._positions: Positions.key(id) -> {x, y}.
    property var positions: ({})

    // Canvas._nodeByKey: Positions.key(id) -> the caller's model entry.
    property var nodeByKey: ({})

    // Canvas's culler.visibleKeys: an array of Positions.key strings. Read by
    // _computeSegments from 5.1's culling rule (added below).
    property var visibleKeys: []

    // The sizes an entry without w/h is measured at. Canvas passes its own
    // _defaultNodeWidth / _defaultNodeHeight (160 / 60).
    property real defaultNodeWidth: 160
    property real defaultNodeHeight: 60

    // {key: {w, h}} of the nodes that are currently instantiated (their real
    // size). Preferred over model w/h and the default box.
    property var measuredSizes: ({})

    // Stroke styling. Internal to the edge layer: this card adds no public
    // Canvas API (5.2 owns selection styling).
    property color strokeColor: "#888888"
    property real strokeWidth: 2

    // The width of the clickable band around the curve, in WORLD units, so it
    // scales with zoom exactly like the ink. Ports' 1/zoom counter-scaling is
    // stage 2 and deliberately not done here. Internal, like the stroke above.
    property real hitWidth: 16

    // Selection styling (5.2), internal like the stroke above: an accent colour
    // and a thicker line, so the selected edge reads as selected without any
    // new public Canvas API.
    property color selectedStrokeColor: "#4aa3ff"
    property real selectedStrokeWidth: 4

    // Invalid-target styling (7.3), internal like the strokes above: the colour
    // the TEMPORARY edge is drawn in while Canvas reports that a drop under the
    // pointer would be rejected. Real edges never use it.
    property color invalidStrokeColor: "#e0524a"

    // The selected edge's id, or null. Written by Canvas.qml only; this layer
    // never decides what is selected, it only draws the decision.
    property var selectedEdgeId: null

    // The in-progress connect (7.2), written by Canvas.qml only: the source
    // node's caller id and the live pointer position in WORLD coordinates.
    // Both null when no connect is running. This layer decides nothing about
    // the gesture -- it only draws the state it is handed.
    property var tempFromId: null
    property var tempPoint: null

    // True while a drop at tempPoint would be rejected AND there is a target to
    // reject (7.3). Written by Canvas.qml only: this layer decides nothing
    // about validity, it only paints the verdict it is handed -- exactly like
    // selectedEdgeId above.
    property bool tempInvalid: false

    // Emitted on a left click that lands within hitWidth / 2 of an edge's
    // curve. Canvas.qml forwards it unchanged as its own edgeClicked; the id is
    // the caller's own value, never a Positions.key string.
    signal edgeClicked(var id)

    // The layer itself has no extent and never clips: each per-edge Shape below
    // places itself at its own world-space bounding box.
    width: 0
    height: 0

    // Control-point offset: half the horizontal span, with a floor so a
    // near-vertical edge still leaves and enters horizontally. Deterministic and
    // symmetric for a given pair of anchors.
    readonly property real _minControlOffset: 40
    readonly property real _controlFraction: 0.5

    // The world box of a node endpoint, or null when the id is not in the
    // sanitized model or has no usable working position -- both are "missing"
    // as far as drawing goes (spec Error paths). Sizes come from
    // Positions.sizeValue so the drawn anchor and the culled box agree; the
    // working map is indexed by Positions.key, never by a raw id.
    function _endpointBox(id) {
        if (id === undefined || id === null) {
            return null;
        }

        var k = Positions.key(id);
        var node = root.nodeByKey ? root.nodeByKey[k] : undefined;
        if (!node) {
            return null;
        }

        var position = root.positions ? root.positions[k] : undefined;
        if (!position || !Positions.isFiniteNumber(position.x)
                || !Positions.isFiniteNumber(position.y)) {
            return null;
        }

        var measured = root.measuredSizes ? root.measuredSizes[k] : undefined;
        var w = Positions.sizeValue(node.w, root.defaultNodeWidth);
        var h = Positions.sizeValue(node.h, root.defaultNodeHeight);
        if (measured) {
            w = Positions.sizeValue(measured.w, w);
            h = Positions.sizeValue(measured.h, h);
        }

        return {key: k, x: position.x, y: position.y, w: w, h: h};
    }

    // The skip warnings already printed, as a set of message strings (spec
    // Error paths: EXACTLY ONE warning per skipped edge). The segments binding
    // below re-runs on every camera tick, so warning from inside it directly
    // would reprint a permanently broken edge on every pan frame.
    //
    // The object is created once and only ever mutated IN PLACE: a `var`
    // property that is read by the binding and then reassigned by it would be a
    // binding loop, while an in-place write emits no change signal at all.
    readonly property var _warnedMessages: ({})

    function _warnOnce(seen, message) {
        seen[message] = true;
        if (root._warnedMessages[message] !== true) {
            root._warnedMessages[message] = true;
            console.warn(message);
        }
    }

    // Forget the faults that are gone, so a repaired edge that breaks again is
    // reported again -- "once" is per occurrence, not per process lifetime.
    function _forgetRepaired(seen) {
        for (var message in root._warnedMessages) {
            if (seen[message] !== true) {
                delete root._warnedMessages[message];
            }
        }
    }

    // One geometry record per drawn edge, in caller order. Every input property
    // is READ here, so the binding below re-evaluates whenever positions, the
    // model or the edge list change -- that is the live-follow rule.
    //
    // A skipped edge warns (once, see above) and never stops its siblings.
    function _computeSegments() {
        var list = Positions.asArray(root.edges);

        // Spec L90: an edge is drawn only if at least one endpoint is visible.
        // The visibility DECISION is Canvas's (culler.visibleKeys, which already
        // covers the selected node, the dragged node and culling being off); all
        // this layer does is look keys up in it, so camera.js's intersection
        // arithmetic is not reimplemented here.
        var keys = Positions.asArray(root.visibleKeys);
        var visible = {};
        for (var v = 0; v < keys.length; v++) {
            visible[keys[v]] = true;
        }

        var out = [];

        // The skips THIS evaluation saw, so _forgetRepaired below can drop the
        // ones that are gone.
        var seen = {};

        for (var i = 0; i < list.length; i++) {
            var edge = list[i];

            if (!edge || typeof edge !== "object"
                    || edge.id === undefined || edge.id === null
                    || edge.from === undefined || edge.from === null
                    || edge.to === undefined || edge.to === null) {
                root._warnOnce(seen,
                               "CanvasEdges: skipping malformed edge at index "
                               + i);
                continue;
            }

            var fromBox = root._endpointBox(edge.from);
            if (fromBox === null) {
                root._warnOnce(seen, "CanvasEdges: edge \"" + edge.id
                               + "\" skipped: no drawable node for from \""
                               + edge.from + "\"");
                continue;
            }

            var toBox = root._endpointBox(edge.to);
            if (toBox === null) {
                root._warnOnce(seen, "CanvasEdges: edge \"" + edge.id
                               + "\" skipped: no drawable node for to \""
                               + edge.to + "\"");
                continue;
            }

            // Both endpoints culled: silently omitted, not an error (spec).
            if (!visible[fromBox.key] && !visible[toBox.key]) {
                continue;
            }

            var fromX = fromBox.x + fromBox.w;
            var fromY = fromBox.y + fromBox.h / 2;
            var toX = toBox.x;
            var toY = toBox.y + toBox.h / 2;

            var offset = Math.max(root._minControlOffset,
                                  Math.abs(toX - fromX) * root._controlFraction);

            out.push({id: edge.id,
                      fromX: fromX, fromY: fromY,
                      toX: toX, toY: toY,
                      c1X: fromX + offset, c1Y: fromY,
                      c2X: toX - offset, c2Y: toY});
        }

        root._forgetRepaired(seen);
        return out;
    }

    property var segments: root._computeSegments()

    // The temporary edge's geometry, or null when there is nothing to draw.
    // Deliberately NOT part of segments: it has no id, must never be hit-tested
    // or selected, and must never warn -- an unresolvable source mid-gesture is
    // not a broken model (spec Error paths), unlike an edge in `edges`.
    function _computeTempSegment() {
        if (root.tempFromId === undefined || root.tempFromId === null) {
            return null;
        }

        var point = root.tempPoint;
        if (!point || typeof point !== "object"
                || !Positions.isFiniteNumber(point.x)
                || !Positions.isFiniteNumber(point.y)) {
            return null;
        }

        var fromBox = root._endpointBox(root.tempFromId);
        if (fromBox === null) {
            return null;
        }

        // The same anchors and the same control rule as a real edge.
        var fromX = fromBox.x + fromBox.w;
        var fromY = fromBox.y + fromBox.h / 2;
        var toX = point.x;
        var toY = point.y;
        var offset = Math.max(root._minControlOffset,
                              Math.abs(toX - fromX) * root._controlFraction);

        return {fromX: fromX, fromY: fromY,
                toX: toX, toY: toY,
                c1X: fromX + offset, c1Y: fromY,
                c2X: toX - offset, c2Y: toY};
    }

    property var tempSegment: root._computeTempSegment()

    // --- Hit testing (5.2) ---
    //
    // A Qt Shape hit-tests its FILL only, so a wide transparent stroke would
    // never accept a click. Acceptance is decided here instead, by distance to
    // the curve -- which is also what makes a click inside the Shape's bounding
    // box but away from the ink a MISS, and therefore a background click.
    //
    // The cubic is flattened into _hitSamples chords and the click is measured
    // against the nearest one. Sampling is uniform in t, not in arc length;
    // 32 chords keep the flattening error orders of magnitude below the
    // hitWidth / 2 radius for the curves this layer draws.
    readonly property int _hitSamples: 32

    function _cubicPointX(s, t) {
        var u = 1 - t;
        return u * u * u * s.fromX + 3 * u * u * t * s.c1X
             + 3 * u * t * t * s.c2X + t * t * t * s.toX;
    }

    function _cubicPointY(s, t) {
        var u = 1 - t;
        return u * u * u * s.fromY + 3 * u * u * t * s.c1Y
             + 3 * u * t * t * s.c2Y + t * t * t * s.toY;
    }

    // Squared distance from (px, py) to the chord (ax, ay)-(bx, by). Squared so
    // the caller can compare against a squared radius: no sqrt per chord, per
    // click. A zero-length chord (a self-edge produces several) degenerates to
    // the distance to its single point rather than dividing by zero.
    function _chordDistanceSquared(px, py, ax, ay, bx, by) {
        var vx = bx - ax;
        var vy = by - ay;
        var lengthSquared = vx * vx + vy * vy;

        var t = lengthSquared > 0
              ? ((px - ax) * vx + (py - ay) * vy) / lengthSquared
              : 0;
        t = Math.max(0, Math.min(1, t));

        var dx = px - (ax + t * vx);
        var dy = py - (ay + t * vy);
        return dx * dx + dy * dy;
    }

    // True when the WORLD point (wx, wy) lies within hitWidth / 2 of this
    // segment's curve. A missing record or a non-finite point never hits, so a
    // degenerate edge can never swallow a click meant for the background.
    function _hitsCurve(segment, wx, wy) {
        if (!segment || !Positions.isFiniteNumber(wx)
                || !Positions.isFiniteNumber(wy)) {
            return false;
        }

        var radius = Math.max(0, root.hitWidth) / 2;
        var limit = radius * radius;

        var previousX = root._cubicPointX(segment, 0);
        var previousY = root._cubicPointY(segment, 0);

        for (var i = 1; i <= root._hitSamples; i++) {
            var t = i / root._hitSamples;
            var x = root._cubicPointX(segment, t);
            var y = root._cubicPointY(segment, t);

            if (root._chordDistanceSquared(wx, wy, previousX, previousY, x, y)
                    <= limit) {
                return true;
            }

            previousX = x;
            previousY = y;
        }
        return false;
    }

    Repeater {
        id: edgeRepeater
        objectName: "edgeRepeater"

        model: root.segments

        delegate: Shape {
            id: edgeShape
            objectName: "edge"

            readonly property var segment: modelData
            readonly property var edgeId: segment ? segment.id : null

            // Selection is BY ID and by strict ===, exactly as nodes compare
            // (Canvas.qml:430). Duplicate ids therefore both highlight -- the
            // caller's business -- and nothing keys an object by the id, so a
            // prototype-shaped id works like any other. Exposed so tests read
            // the decision rather than pixels.
            readonly property bool selected: root.selectedEdgeId !== null
                                             && edgeId !== null
                                             && edgeId === root.selectedEdgeId

            // A cubic lies inside the convex hull of its four control points, so
            // that box (plus half a stroke) is this Shape's extent, and the Shape
            // is placed at its top-left corner. A Shape has to have a real size
            // to be rendered, which a curve drawn at raw world coordinates inside
            // a zero-sized item would not give it -- hence the offset below.
            // Half-widths of everything this Shape carries: the visible stroke
            // and, from 5.2, the hit band. A smaller pad would clip the hit
            // region at the Shape's own extent, and a click near the end of a
            // near-horizontal edge would fall outside the item entirely.
            readonly property real _pad: Math.max(1, root.strokeWidth,
                                                  root.selectedStrokeWidth,
                                                  root.hitWidth / 2)
            readonly property real _minX: segment
                ? Math.min(segment.fromX, segment.toX, segment.c1X, segment.c2X)
                : 0
            readonly property real _minY: segment
                ? Math.min(segment.fromY, segment.toY, segment.c1Y, segment.c2Y)
                : 0
            readonly property real _maxX: segment
                ? Math.max(segment.fromX, segment.toX, segment.c1X, segment.c2X)
                : 0
            readonly property real _maxY: segment
                ? Math.max(segment.fromY, segment.toY, segment.c1Y, segment.c2Y)
                : 0

            x: _minX - _pad
            y: _minY - _pad
            width: (_maxX - _minX) + 2 * _pad
            height: (_maxY - _minY) + 2 * _pad

            // The drawn geometry, mapped back into world coordinates, so tests
            // and 5.2 read the path itself rather than a copy of the record it
            // came from.
            readonly property real startX: edgeShape.x + edgePath.startX
            readonly property real startY: edgeShape.y + edgePath.startY
            readonly property real endX: edgeShape.x + edgeCurve.x
            readonly property real endY: edgeShape.y + edgeCurve.y
            readonly property real control1X: edgeShape.x + edgeCurve.control1X
            readonly property real control1Y: edgeShape.y + edgeCurve.control1Y
            readonly property real control2X: edgeShape.x + edgeCurve.control2X
            readonly property real control2Y: edgeShape.y + edgeCurve.control2Y

            ShapePath {
                id: edgePath

                strokeColor: edgeShape.selected ? root.selectedStrokeColor
                                                : root.strokeColor
                strokeWidth: edgeShape.selected ? root.selectedStrokeWidth
                                                : root.strokeWidth
                fillColor: "transparent"
                capStyle: ShapePath.RoundCap

                // Item-local: the world anchor minus this Shape's own origin.
                startX: edgeShape.segment
                        ? edgeShape.segment.fromX - edgeShape.x : 0
                startY: edgeShape.segment
                        ? edgeShape.segment.fromY - edgeShape.y : 0

                PathCubic {
                    id: edgeCurve

                    x: edgeShape.segment
                       ? edgeShape.segment.toX - edgeShape.x : 0
                    y: edgeShape.segment
                       ? edgeShape.segment.toY - edgeShape.y : 0
                    control1X: edgeShape.segment
                               ? edgeShape.segment.c1X - edgeShape.x : 0
                    control1Y: edgeShape.segment
                               ? edgeShape.segment.c1Y - edgeShape.y : 0
                    control2X: edgeShape.segment
                               ? edgeShape.segment.c2X - edgeShape.x : 0
                    control2Y: edgeShape.segment
                               ? edgeShape.segment.c2Y - edgeShape.y : 0
                }
            }

            // Only clicks near the curve reach this Shape at all: the mask
            // rejects the rest of the bounding box, which then falls through to
            // the canvas's background handlers -- exactly the behaviour the
            // spec asks for ("behaves like a background click").
            //
            // The signature MUST be typed (`point: point`, `: bool`): Qt looks
            // the mask's method up as contains(QPointF) returning bool, and an
            // untyped QML function registers as contains(QVariant), which Qt
            // rejects with "does not have an invokable contains method".
            // `point` is in this Shape's own coordinates, so the Shape's origin
            // is added back to reach the world coordinates the segment is in.
            containmentMask: QtObject {
                function contains(point: point): bool {
                    return root._hitsCurve(edgeShape.segment,
                                           edgeShape.x + point.x,
                                           edgeShape.y + point.y);
                }
            }

            // ReleaseWithinBounds takes an exclusive grab on press, which is
            // what stops the canvas's backgroundTapHandler (default policy, no
            // grab of its own) from also seeing this click and clearing the
            // selection the click just made -- the same mechanism
            // CanvasNode.qml:159-168 relies on. A DragHandler is a different
            // type and may still take the grab, so a drag that begins on an
            // edge pans the canvas instead of clicking the edge.
            TapHandler {
                id: edgeTapHandler
                objectName: "edgeTapHandler"

                acceptedButtons: Qt.LeftButton
                gesturePolicy: TapHandler.ReleaseWithinBounds
                enabled: edgeShape.edgeId !== null

                onTapped: root.edgeClicked(edgeShape.edgeId)
            }
        }
    }

    // One temporary edge, outside the Repeater: exactly one can exist, it is
    // absent from `segments`, and it carries no TapHandler and no
    // containmentMask, so it can never take a click that belongs to the
    // background or to a real edge. Same stroke as a real edge, except while
    // `tempInvalid` reports that the drop under the pointer would be rejected:
    // then the ink is invalidStrokeColor (7.3). Only the colour changes -- the
    // width stays put, so the curve does not jump as the pointer crosses a
    // port.
    Shape {
        id: tempEdgeShape
        objectName: "tempEdge"

        readonly property var segment: root.tempSegment

        visible: segment !== null

        readonly property real _pad: Math.max(1, root.strokeWidth)
        readonly property real _minX: segment
            ? Math.min(segment.fromX, segment.toX, segment.c1X, segment.c2X) : 0
        readonly property real _minY: segment
            ? Math.min(segment.fromY, segment.toY, segment.c1Y, segment.c2Y) : 0
        readonly property real _maxX: segment
            ? Math.max(segment.fromX, segment.toX, segment.c1X, segment.c2X) : 0
        readonly property real _maxY: segment
            ? Math.max(segment.fromY, segment.toY, segment.c1Y, segment.c2Y) : 0

        x: _minX - _pad
        y: _minY - _pad
        width: (_maxX - _minX) + 2 * _pad
        height: (_maxY - _minY) + 2 * _pad

        // The drawn geometry in world coordinates, named exactly as the per-edge
        // delegate's readouts are, so tests read the path itself.
        readonly property real startX: tempEdgeShape.x + tempPath.startX
        readonly property real startY: tempEdgeShape.y + tempPath.startY
        readonly property real endX: tempEdgeShape.x + tempCurve.x
        readonly property real endY: tempEdgeShape.y + tempCurve.y
        readonly property real control1X: tempEdgeShape.x + tempCurve.control1X
        readonly property real control1Y: tempEdgeShape.y + tempCurve.control1Y
        readonly property real control2X: tempEdgeShape.x + tempCurve.control2X
        readonly property real control2Y: tempEdgeShape.y + tempCurve.control2Y

        ShapePath {
            id: tempPath

            strokeColor: root.tempInvalid ? root.invalidStrokeColor
                                          : root.strokeColor
            strokeWidth: root.strokeWidth
            fillColor: "transparent"
            capStyle: ShapePath.RoundCap

            startX: tempEdgeShape.segment
                    ? tempEdgeShape.segment.fromX - tempEdgeShape.x : 0
            startY: tempEdgeShape.segment
                    ? tempEdgeShape.segment.fromY - tempEdgeShape.y : 0

            PathCubic {
                id: tempCurve

                x: tempEdgeShape.segment
                   ? tempEdgeShape.segment.toX - tempEdgeShape.x : 0
                y: tempEdgeShape.segment
                   ? tempEdgeShape.segment.toY - tempEdgeShape.y : 0
                control1X: tempEdgeShape.segment
                           ? tempEdgeShape.segment.c1X - tempEdgeShape.x : 0
                control1Y: tempEdgeShape.segment
                           ? tempEdgeShape.segment.c1Y - tempEdgeShape.y : 0
                control2X: tempEdgeShape.segment
                           ? tempEdgeShape.segment.c2X - tempEdgeShape.x : 0
                control2Y: tempEdgeShape.segment
                           ? tempEdgeShape.segment.c2Y - tempEdgeShape.y : 0
            }
        }
    }
}
