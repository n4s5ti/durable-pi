import QtQuick
import "positions.js" as Positions

// One instantiated node (spec Files: "CanvasNode.qml -- wraps each delegate:
// drag, selection, (stage 2) ports"). 4.1 positions and sizes the wrapper and
// loads the caller's delegate; 4.2 adds its pointer input: a left-button drag
// that reports a new WORLD position (screen delta / zoom, parent spec L71-72)
// and a tap that asks to be selected. Ports are stage 2.
//
// This item reports and owns nothing: it never writes to `node` (parent spec
// L22) and never sets its own x/y. The canvas owns the working position map
// (parent spec L80) and hands a new `position` back down.
Item {
    id: nodeItem
    objectName: "canvasNode"

    // The caller's model entry and the working position the canvas computed for
    // it ({x, y}). Both are read-only here: nothing below writes to either.
    property var node: null
    property var position: null

    // The caller's nodeDelegate. Null is legal (spec Error paths): the wrapper
    // still exists and is positioned, it just draws nothing.
    property Component content: null

    // The scale the world Item is drawn at -- Camera.clampZoom(canvas.zoom).
    // The canvas binds this to world.scale so the 0.1-4x clamp keeps living in
    // camera.js alone and the drag divides by exactly what is on screen.
    property real worldScale: 1

    // Single selection (parent spec L73), written by the canvas. Readable here
    // together with `dragging` so 4.3 can exempt these nodes from culling and a
    // caller's delegate can style them. 4.2 renders neither.
    property bool selected: false
    readonly property bool dragging: dragHandler.active

    // Pointer input needs a usable id (the canvas keys its working map by it)
    // and a usable position to drag from. Anything else is inert rather than a
    // half-drag that would write a NaN (spec Error paths).
    readonly property bool interactive:
        !!node && node.id !== undefined && node.id !== null
        && !!position && Positions.isFiniteNumber(position.x)
        && Positions.isFiniteNumber(position.y)

    // Reported upward; the canvas decides what to do with them. These are
    // internal wiring -- the public signals are Canvas.qml's nodeMoved and
    // nodeClicked.
    signal tapped()
    signal dragStarted()
    signal dragMoved(var worldPosition)
    signal dragDropped(var worldPosition)

    // 7.2: the connect gesture that starts on the OUTPUT port. Internal wiring
    // like the drag signals above -- the public signal is Canvas.qml's
    // edgeCreated. Points are SCENE coordinates: this item knows nothing about
    // the camera, so the canvas maps them through its own world item.
    signal connectStarted()
    signal connectMoved(var scenePoint)
    signal connectDropped(var scenePoint)

    // World coordinates, verbatim. The world Item already applies pan and zoom,
    // so these must never be scaled or offset here. Anything unusable is the
    // origin rather than a NaN geometry.
    x: (position && Positions.isFiniteNumber(position.x)) ? position.x : 0
    y: (position && Positions.isFiniteNumber(position.y)) ? position.y : 0

    // Spec "Sizing": the delegate's implicit size, overridden by model w/h.
    // A delegate whose own implicitWidth is derived from its width would make
    // this a binding loop; node delegates declare a content-derived implicit
    // size, as Omarchy's Ui/ controls do.
    implicitWidth: contentLoader.item ? contentLoader.item.implicitWidth : 0
    implicitHeight: contentLoader.item ? contentLoader.item.implicitHeight : 0

    width: Positions.sizeValue(node ? node.w : undefined, implicitWidth)
    height: Positions.sizeValue(node ? node.h : undefined, implicitHeight)

    Loader {
        id: contentLoader
        objectName: "nodeContent"

        // The caller's delegate expects `modelData` (parent spec, Public API).
        // A Component is instantiated in the context where it was *declared* --
        // the caller's file -- not in the Repeater's delegate context, so the
        // model entry is republished here, where the Loader's own properties
        // are visible to the item it creates.
        property var modelData: nodeItem.node

        anchors.fill: parent
        sourceComponent: nodeItem.content
    }

    // --- Ports (parent spec L102: "each node has an output port (right) and
    // input port (left)") ---
    //
    // The INPUT port is decoration plus a hit region: it declares no handler, so
    // every event that lands on one still reaches nodeDragHandler /
    // nodeTapHandler below, and Canvas.qml resolves a drop against it
    // geometrically through containsInputPort(). The OUTPUT port carries the
    // 7.2 connect gesture: a left-button drag from it connects instead of
    // moving the node.

    // Each port is CENTRED on the point CanvasEdges.qml already anchors an edge
    // at (_computeSegments: fromX = x + w, fromY = y + h/2 for the source end;
    // toX = x, toY = y + h/2 for the target end), so a port straddles the node
    // edge rather than sitting inside it.
    //
    // A port is 12 SCREEN px (parent spec L98): the world Item is drawn at
    // `worldScale`, so the world-unit size below is 12 divided by it -- at zoom
    // 4 a port is 3 world units, at zoom 0.1 it is 120. The guard is the one
    // draggedPosition already
    // applies (positions.js sizeValue: finite and > 0, else the fallback) --
    // the 0.1-4x clamp itself stays in camera.js and is never repeated here,
    // and a junk scale is a scale of 1 rather than a division by zero.
    readonly property real _portSize:
        12 / Positions.sizeValue(nodeItem.worldScale, 1)

    // The world point Canvas.qml tests a drop against: this Item lives directly
    // inside the world Item, so its x/y ARE world coordinates and no camera
    // arithmetic is needed here. The region is the visible port itself --
    // 12 / worldScale world units, i.e. ~12 screen px at every zoom.
    function containsInputPort(worldX, worldY) {
        if (!nodeItem.interactive) {
            return false;
        }
        if (!Positions.isFiniteNumber(worldX)
                || !Positions.isFiniteNumber(worldY)) {
            return false;
        }

        var half = nodeItem._portSize / 2;
        return Math.abs(worldX - nodeItem.x) <= half
            && Math.abs(worldY - (nodeItem.y + nodeItem.height / 2)) <= half;
    }

    // Squared distance to the input anchor, so a canvas with two overlapping
    // hit regions can pick the nearest centre deterministically (spec Error
    // paths). Squared: the comparison needs no sqrt.
    function inputPortDistanceSquared(worldX, worldY) {
        var dx = worldX - nodeItem.x;
        var dy = worldY - (nodeItem.y + nodeItem.height / 2);
        return dx * dx + dy * dy;
    }

    // A left press that LANDED on the output port belongs to the connect
    // gesture, so the node's own DragHandler is disabled for the whole press.
    // The latch reopens only through Qt.callLater: a TapHandler's `pressed`
    // goes false the moment the tap is cancelled by the drag threshold, and
    // clearing synchronously there would re-enable nodeDragHandler inside the
    // very event that is starting the connect.
    property bool _portPressed: false

    function _clearPortPressed() {
        if (!outputPortDragHandler.active) {
            nodeItem._portPressed = false;
        }
    }

    // The last usable SCENE point of the current connect, and whether one is
    // running: the drop is reported exactly once, from that point, for a normal
    // release, a cancel or a stolen grab -- the same contract as dragDropped.
    property var _connectLast: null
    property bool _connecting: false

    function _scenePoint(centroid) {
        var p = centroid.scenePosition;
        if (!p || !Positions.isFiniteNumber(p.x)
                || !Positions.isFiniteNumber(p.y)) {
            return null;
        }
        return {x: p.x, y: p.y};
    }

    Item {
        objectName: "nodeInputPort"

        width: nodeItem._portSize
        height: nodeItem._portSize
        x: -width / 2
        y: nodeItem.height / 2 - height / 2

        Rectangle {
            anchors.fill: parent
            radius: width / 2
            color: "#888888"
        }
    }

    Item {
        objectName: "nodeOutputPort"

        width: nodeItem._portSize
        height: nodeItem._portSize
        x: nodeItem.width - width / 2
        y: nodeItem.height / 2 - height / 2

        Rectangle {
            anchors.fill: parent
            radius: width / 2
            color: "#888888"
        }

        // Latches the press before anything can move, so the node's DragHandler
        // is already disabled by the time the drag threshold is crossed. The
        // default gesturePolicy (DragThreshold) takes no exclusive grab, so it
        // does not stop the node's own TapHandler from selecting on a click.
        TapHandler {
            id: outputPortPressHandler
            objectName: "nodeOutputPortPressHandler"

            acceptedButtons: Qt.LeftButton
            enabled: nodeItem.interactive

            onPressedChanged: {
                if (pressed) {
                    nodeItem._portPressed = true;
                } else {
                    Qt.callLater(nodeItem._clearPortPressed);
                }
            }
        }

        // target: null -- this gesture draws a temporary edge in the canvas; it
        // must never translate the port or the node.
        DragHandler {
            id: outputPortDragHandler
            objectName: "nodeOutputPortDragHandler"

            target: null
            acceptedButtons: Qt.LeftButton
            enabled: nodeItem.interactive

            onActiveChanged: {
                if (active) {
                    if (!nodeItem.interactive) {
                        return;
                    }
                    nodeItem._connecting = true;
                    nodeItem._connectLast = nodeItem._scenePoint(centroid);
                    nodeItem.connectStarted();
                    if (nodeItem._connectLast) {
                        nodeItem.connectMoved(nodeItem._connectLast);
                    }
                    return;
                }

                // Inactive: a release, or a grab stolen / cancelled mid-drag.
                if (!nodeItem._connecting) {
                    Qt.callLater(nodeItem._clearPortPressed);
                    return;
                }
                var dropped = nodeItem._connectLast;
                nodeItem._connecting = false;
                nodeItem._connectLast = null;
                Qt.callLater(nodeItem._clearPortPressed);
                nodeItem.connectDropped(dropped);
            }

            onCentroidChanged: {
                if (!active) {
                    return;
                }
                var p = nodeItem._scenePoint(centroid);
                if (!p) {
                    return;
                }
                nodeItem._connectLast = p;
                nodeItem.connectMoved(p);
            }
        }
    }

    // --- Pointer input (parent spec L71-73) ---

    // The world position the drag began at, and the last position computed for
    // it. The delta is measured from the press point on every event rather than
    // accumulated, so no per-event rounding can build up over a long drag.
    property var _dragOrigin: null
    property var _dragLast: null

    function _positionFor(centroid) {
        return Positions.draggedPosition(
            nodeItem._dragOrigin,
            {x: centroid.scenePosition.x - centroid.scenePressPosition.x,
             y: centroid.scenePosition.y - centroid.scenePressPosition.y},
            nodeItem.worldScale);
    }

    DragHandler {
        id: dragHandler
        objectName: "nodeDragHandler"

        // target: null -- the canvas owns the position. Translating this Item
        // here would fight the x/y bindings above and hide the move from the
        // working map.
        target: null

        // Left button only, so a middle-button drag falls through to the
        // canvas's middleButtonPanHandler and still pans from over a node.
        acceptedButtons: Qt.LeftButton
        enabled: nodeItem.interactive && !nodeItem._portPressed

        onActiveChanged: {
            if (active) {
                // Belt and braces: `enabled` already requires this, but the
                // binding could have gone stale between press and activation.
                if (!nodeItem.interactive) {
                    return;
                }
                nodeItem._dragOrigin = {x: nodeItem.position.x,
                                        y: nodeItem.position.y};
                nodeItem._dragLast = nodeItem._dragOrigin;
                nodeItem.dragStarted();
                return;
            }

            // Inactive: a normal release, or a grab stolen / cancelled mid-drag
            // (spec Error paths). Either way the drop is reported exactly once,
            // from the last position that was computed, and the state is
            // cleared so a second deactivation reports nothing.
            var dropped = nodeItem._dragLast;
            nodeItem._dragOrigin = null;
            nodeItem._dragLast = null;
            if (dropped) {
                nodeItem.dragDropped(dropped);
            }
        }

        onCentroidChanged: {
            if (!active) {
                return;
            }
            var next = nodeItem._positionFor(centroid);
            if (!next) {
                return;
            }
            nodeItem._dragLast = next;
            nodeItem.dragMoved(next);
        }
    }

    // Tap selects (parent spec L73). ReleaseWithinBounds takes an exclusive
    // grab on press, which is what makes a click on a node stop at this node:
    // the canvas's backgroundTapHandler (default policy, no grab of its own)
    // then never fires for this tap, so it cannot clear the selection this
    // click just made (verified against Qt 6.11). A DragHandler *is* a different type and
    // may take over, which cancels the tap -- exactly what a drag should do.
    TapHandler {
        id: tapHandler
        objectName: "nodeTapHandler"

        acceptedButtons: Qt.LeftButton
        gesturePolicy: TapHandler.ReleaseWithinBounds
        enabled: nodeItem.interactive

        onTapped: nodeItem.tapped()
    }
}
