import QtQuick
import QtQml.Models
import "camera.js" as Camera
import "layout.js" as Layout
import "positions.js" as Positions

// Public canvas component (spec L38-39): a clipped viewport Item that owns the
// camera (panX, panY, zoom) and a single transformed world Item. All camera
// arithmetic is delegated to camera.js -- none of it is reimplemented here.
//
// Pan input (left-button background drag, middle-button drag) and zoom input
// (wheel about the cursor) live here. Node delegates, edges, auto-layout and
// culling belong to later subtasks and deliberately do not exist yet.
Item {
    id: root

    // The viewport clips: world content outside width/height is not drawn.
    clip: true

    // Camera. Screen = world * zoom + pan, with the world Item's transform
    // origin at its top-left corner.
    property real panX: 0
    property real panY: 0
    property real zoom: 1

    // Caller-supplied model, array of {id, x?, y?, w?, h?, ...}. Read-only to
    // the canvas (spec L22): nothing below ever writes to it or to an entry.
    property var nodes: []

    // Caller-supplied edges, array of {id, from, to}. Read-only (spec L22):
    // layout() ranks nodes into columns from it, and CanvasEdges below draws one
    // cubic per entry. Clicking and selecting an edge is 5.2, not this file.
    property var edges: []

    // 7.3: the caller's optional connection rule, a function (from, to) -> bool
    // consulted at the drop and while the connect gesture is running. Any
    // non-callable value (the default null, undefined, a string, an object)
    // means "no caller rule" and every connection the built-in checks accept is
    // allowed, exactly as in 7.2. The verdict is read as a truth value, so a
    // rule that forgets to return rejects. It must be cheap and side-effect
    // free: the canvas promises nothing about how often it is called.
    property var canConnect: null

    // The caller's node delegate: a Component receiving `modelData` (spec L56).
    // Null is legal; node items are still instantiated and positioned.
    property Component nodeDelegate: null

    // Parent spec "Public API of Canvas": "Culling switch, default on". While
    // true a node is instantiated only when its world bounding box intersects
    // the viewport expanded by _cullMargin; while false every sanitized entry
    // is instantiated. Culling changes instantiation ONLY: positions, layout,
    // selection, pins and nodeMoved behave identically either way.
    property bool culling: true

    // The cull band, in SCREEN pixels, divided by the clamped zoom to reach
    // world units. An internal tuning constant with the same status as
    // fitPadding: readonly, and not part of the documented public API.
    readonly property real _cullMargin: 200

    // The sanitized model that is actually instantiated: entries that are
    // objects with a usable id, first occurrence of each id. Never written
    // back to `nodes`.
    property var _renderNodes: []

    // Working positions (spec L80), keyed by Positions.key(id) -> {x, y}.
    property var _positions: ({})

    // Positions.key(id) -> the caller's model entry, for the visible model's
    // delegates. Rebuilt by _applyLayout; read-only to everything else.
    property var _nodeByKey: ({})

    // Positions the user dropped nodes at (parent spec Data flow: a drag pins
    // the node). Separate from _positions because _relayout() below throws the
    // working map away: this map is what it seeds the merge with, so an edge
    // change re-lays out only the nodes nobody has dragged. Caller coordinates
    // still win over a pin -- Positions.merge checks isPinned(node) first.
    property var _dropped: ({})

    // A new map object, not an in-place write: see _moveNode for why.
    function _pinDrop(id, worldPosition) {
        var next = {};
        for (var k in root._dropped) {
            next[k] = root._dropped[k];
        }
        next[Positions.key(id)] = {x: worldPosition.x, y: worldPosition.y};
        root._dropped = next;
    }

    // A pin for an id that has left `nodes` is dead weight, and leaving it
    // would make the id coming back reappear at an old drop instead of being
    // laid out as the new node it is.
    function _pruneDrops(usable) {
        var live = {};
        for (var i = 0; i < usable.length; i++) {
            live[Positions.key(usable[i].id)] = true;
        }

        var kept = {};
        for (var k in root._dropped) {
            if (live[k]) {
                kept[k] = root._dropped[k];
            }
        }
        root._dropped = kept;
    }

    // A selection for an id that has left `nodes` is dead weight for the same
    // reason a pin is: the id coming back would arrive pre-selected without
    // anyone having clicked it. Clearing it is silent -- no nodeClicked, and
    // nothing the caller has to react to (spec Error paths).
    function _pruneSelection(usable) {
        if (root._selectedId === null) {
            return;
        }

        for (var i = 0; i < usable.length; i++) {
            if (usable[i].id === root._selectedId) {
                return;
            }
        }
        root._clearSelection();
    }

    // The edge counterpart of _pruneSelection: an id that leaves `edges` clears
    // the selection silently -- no edgeClicked, nothing the caller has to react
    // to (spec Error paths). Ids compare with ===, exactly as nodes do, and the
    // list is walked rather than indexed by id, so a prototype-shaped id needs
    // no special case. Culling is NOT pruning: an edge that is merely off
    // screen is still in `edges` and keeps its selection.
    function _pruneEdgeSelection() {
        if (root._selectedEdgeId === null) {
            return;
        }

        var list = Positions.asArray(root.edges);
        for (var i = 0; i < list.length; i++) {
            var edge = list[i];
            if (edge && typeof edge === "object"
                    && edge.id === root._selectedEdgeId) {
                return;
            }
        }
        root._clearEdgeSelection();
    }

    // The dragged-node exemption must never outlive the drag. It is cleared
    // from the delegate when the gesture ends, and here when the id leaves
    // `nodes`: that destroys the delegate, so nothing else would ever clear it
    // and the id coming back would never be culled again.
    function _pruneDragged(usable) {
        if (root._draggedId === null) {
            return;
        }

        for (var i = 0; i < usable.length; i++) {
            if (usable[i].id === root._draggedId) {
                return;
            }
        }
        root._draggedId = null;
    }

    // Clears the exemption only if it still belongs to `id`, so a release
    // arriving after another node has taken over cannot cancel that one.
    function _releaseDrag(id) {
        if (root._draggedId !== null && root._draggedId === id) {
            root._draggedId = null;
        }
    }

    // --- Connect gesture (7.2) ---
    //
    // The source node's caller id while a drag from its output port is running,
    // and the live pointer position in WORLD coordinates. Both null when no
    // connect is running; both written here only.
    property var _connectFromId: null
    property var _connectPoint: null

    // Scene -> world through the world Item's own mapping, so the camera
    // arithmetic is the transform that is already on screen and nothing is
    // reimplemented. A non-finite result is refused rather than drawn.
    function _worldPoint(scenePoint) {
        if (!scenePoint || typeof scenePoint !== "object") {
            return null;
        }
        var p = world.mapFromItem(null, scenePoint.x, scenePoint.y);
        if (!p || !Positions.isFiniteNumber(p.x)
                || !Positions.isFiniteNumber(p.y)) {
            return null;
        }
        return {x: p.x, y: p.y};
    }

    function _beginConnect(id) {
        root._connectFromId = id;
        root._connectPoint = null;
    }

    // An unusable point KEEPS the previous one (spec Error paths): a NaN must
    // never reach the temporary edge, and one junk event must not tear the
    // curve off the cursor.
    function _updateConnect(scenePoint) {
        if (root._connectFromId === null) {
            return;
        }
        var point = root._worldPoint(scenePoint);
        if (point === null) {
            return;
        }
        root._connectPoint = point;
    }

    // Clears the exemption only if it still belongs to `id`, exactly like
    // _releaseDrag: a release arriving after another node has taken over must
    // not cancel that one.
    function _releaseConnect(id) {
        if (root._connectFromId !== null && root._connectFromId === id) {
            root._connectFromId = null;
        }
    }

    // The gesture's source leaving `nodes` destroys its delegate, so nothing
    // else would ever clear the exemption: cancel silently (spec Error paths).
    function _pruneConnect(usable) {
        if (root._connectFromId === null) {
            return;
        }

        for (var i = 0; i < usable.length; i++) {
            if (usable[i].id === root._connectFromId) {
                return;
            }
        }
        root._connectFromId = null;
        root._connectPoint = null;
    }

    // The caller id of the node whose INPUT port hit region contains the world
    // point, or null. Only instantiated delegates are candidates -- a culled
    // node has no delegate and no measurable port, which is the same "no
    // target" as empty background. Two overlapping regions are resolved by the
    // nearest centre, so the answer is deterministic and never two ids.
    function _dropTargetId(point) {
        if (!point) {
            return null;
        }

        var best = null;
        var bestDistance = 0;
        for (var i = 0; i < nodeRepeater.count; i++) {
            var item = nodeRepeater.itemAt(i);
            if (!item || !item.entry || !item.containsInputPort(point.x, point.y)) {
                continue;
            }

            var distance = item.inputPortDistanceSquared(point.x, point.y);
            if (best === null || distance < bestDistance) {
                best = item.entry.id;
                bestDistance = distance;
            }
        }
        return best;
    }

    // Direction-sensitive, === on both endpoints (spec Observable behaviour 7),
    // so b->a is allowed while a->b exists. Null and non-object entries are
    // skipped rather than dereferenced.
    function _hasEdge(from, to) {
        var list = Positions.asArray(root.edges);
        for (var i = 0; i < list.length; i++) {
            var edge = list[i];
            if (edge && typeof edge === "object"
                    && edge.from === from && edge.to === to) {
                return true;
            }
        }
        return false;
    }

    // The caller's rule, or "allow" when there is none. The verdict is read as
    // a truth value (spec Error paths), so `undefined` from a rule that forgot
    // to return rejects rather than silently allowing.
    function _allowConnect(from, to) {
        var hook = root.canConnect;
        if (typeof hook !== "function") {
            return true;
        }

        try {
            return !!hook(from, to);
        } catch (error) {
            // Fail closed (spec Error paths): a broken caller rule must not
            // create an edge, and the throw must never escape into the drop
            // handler chain -- that would skip the rest of _finishConnect and
            // leave a stuck temporary edge.
            console.warn("Canvas: canConnect threw, rejecting the connection: "
                         + error);
            return false;
        }
    }

    // The whole drop verdict for a candidate target, and the ONLY place it is
    // decided: _finishConnect and the live invalid-target styling both call
    // this, so the red edge and the drop can never disagree.
    //
    // The built-in rejections stay UNCONDITIONAL (the spec rejects self-loops
    // and duplicates "by default" and says canConnect "adds caller rules"), so
    // the hook can never re-enable one -- and is never even consulted for one.
    function _connectAllowed(from, to) {
        if (to === null || to === from) {
            return false;
        }
        if (root._hasEdge(from, to)) {
            return false;
        }
        return root._allowConnect(from, to);
    }

    // True while the pointer is over SOME node's input port and a drop there
    // would not emit edgeCreated. With no target -- background, a node body, an
    // output port -- there is nothing to reject, so the temporary edge keeps its
    // normal stroke (spec Observable behaviour 5).
    //
    // Every input is taken as an ARGUMENT so the binding below reads it and
    // therefore depends on it: the pointer, the gesture, the caller's edges and
    // the rule itself. `edges` and `canConnect` are read through
    // _connectAllowed rather than used here directly, and are listed only to
    // make the feedback live when they are reassigned mid-gesture.
    function _computeConnectInvalid(from, point, edges, canConnect) {
        if (from === null || point === null) {
            return false;
        }

        var to = root._dropTargetId(point);
        if (to === null) {
            return false;
        }
        return !root._connectAllowed(from, to);
    }

    readonly property bool _connectInvalid:
        root._computeConnectInvalid(root._connectFromId, root._connectPoint,
                                    root.edges, root.canConnect)

    // The drop: the temporary edge goes in THIS frame (the point is cleared
    // synchronously), while the culling exemption is released after the handler
    // chain has unwound -- clearing it synchronously could destroy the delegate
    // in the middle of its own handler, the same reason onDraggingChanged
    // defers _releaseDrag.
    function _finishConnect(scenePoint) {
        var from = root._connectFromId;
        if (from === null) {
            return;
        }

        var point = root._worldPoint(scenePoint);
        if (point === null) {
            point = root._connectPoint;
        }

        root._connectPoint = null;
        Qt.callLater(root._releaseConnect, from);

        var to = root._dropTargetId(point);
        if (!root._connectAllowed(from, to)) {
            return;
        }
        root.edgeCreated(from, to);
    }

    // Layout runs over the sanitized model, then the merge decides per node:
    // caller coordinates win, otherwise the position already in the working
    // map is kept so auto-placed nodes do not jump, otherwise a fresh layout
    // position. Delegate implicit sizes cannot feed layout (it runs before any
    // delegate exists); layout.js falls back to 160x60.
    function _applyLayout(previous) {
        var usable = Positions.usableNodes(root.nodes);
        var laidOut = Layout.layout(usable, Positions.asArray(root.edges));
        root._positions = Positions.merge(previous, usable, laidOut);
        root._renderNodes = usable;

        // The Repeater's model carries working-map keys only (see
        // _syncVisibleModel), so the delegate looks its entry up here. The
        // values are the caller's own objects, stored by reference and never
        // written -- a ListModel holding them directly would copy them into
        // its own value types and the delegate would stop seeing extra fields.
        var byKey = {};
        for (var i = 0; i < usable.length; i++) {
            byKey[Positions.key(usable[i].id)] = usable[i];
        }
        root._nodeByKey = byKey;

        // After the merge: `previous` may still be the pre-prune map, which is
        // harmless because merge only ever looks up ids that are in `usable`.
        root._pruneDrops(usable);
        root._pruneSelection(usable);
        root._pruneDragged(usable);
        root._pruneConnect(usable);
    }

    // A new `nodes` array keeps every auto position already in the working map
    // (spec Data flow step 4: nodes must not jump when the model is rebuilt).
    function _recomputePositions() {
        root._applyLayout(root._positions);
    }

    // A new `edges` list is a new ranking, and the no-jumping rule is about a
    // new `nodes` array only, so the auto positions are laid out again from
    // scratch here. Caller-pinned nodes are unaffected: merge takes their
    // coordinates before it ever looks at the previous map. Nodes the USER
    // dropped are seeded from _dropped, so a drag survives an edge change
    // (parent spec Data flow: a drag pins the node).
    function _relayout() {
        root._applyLayout(root._dropped);
    }

    onNodesChanged: root._recomputePositions()
    onEdgesChanged: {
        root._relayout();
        root._pruneEdgeSelection();
    }

    Component.onCompleted: {
        root._recomputePositions();
        // Belt and braces: the membership binding's FIRST evaluation may have
        // happened before `nodes` existed and delivers no change signal, so the
        // initial visible set is synced once explicitly here.
        root._syncVisibleModel(culler.visibleKeys);
    }

    // Margin fitAll() leaves around the fitted bounds, in screen pixels. Not
    // part of the documented public API.
    readonly property real fitPadding: 40

    // --- Node interaction (parent spec L71-73) ---
    //
    // The canvas emits; the caller updates its own model. Nothing below ever
    // writes to `nodes` or to an entry in it (parent spec L22).
    signal nodeMoved(var id, real x, real y)
    signal nodeClicked(var id)

    // 5.2: a left click that landed on an edge's curve. The id is the caller's
    // own value, forwarded unchanged from the edge layer.
    signal edgeClicked(var id)

    // 7.2: a drag from a node's output port was dropped on ANOTHER node's input
    // port. The ids are the caller's own values, forwarded unchanged. The
    // canvas does not add the edge -- it never writes to `edges` (parent spec
    // L22); the caller appends it to its own model.
    signal edgeCreated(var from, var to)

    // 7.4: Delete/Backspace was pressed while an edge was selected. The id is
    // the caller's own value, forwarded unchanged. The canvas does NOT remove
    // the edge -- it never writes to `edges` (parent spec L22); the caller drops
    // it from its own model, and _pruneEdgeSelection then clears the selection.
    signal edgeRemoved(var id)

    // Single selection (parent spec L73; multi-select is out of scope in v1).
    // Exposed read-only: 4.3 exempts the selected node from culling and a
    // caller's delegate may style it, but only the canvas writes it.
    property var _selectedId: null
    readonly property var selectedId: root._selectedId

    // The selected EDGE id (5.2), or null. Same pattern and same rules as the
    // node selection above: written only here, exposed read-only, compared with
    // === so a prototype-shaped id needs no special case.
    property var _selectedEdgeId: null
    readonly property var selectedEdge: root._selectedEdgeId

    // There is never more than one selected thing (parent spec L73): selecting
    // a node drops the edge, and selecting an edge drops the node.
    function _select(id) {
        root._selectedId = id;
        root._selectedEdgeId = null;
    }

    function _selectEdge(id) {
        root._selectedEdgeId = id;
        root._selectedId = null;
    }

    // Node-only, deliberately: _pruneSelection calls this when an id leaves
    // `nodes`, and that must not drop a selected edge as a side effect. The
    // background tap clears both, explicitly.
    function _clearSelection() {
        root._selectedId = null;
    }

    function _clearEdgeSelection() {
        root._selectedEdgeId = null;
    }

    // Write a live or dropped world position into the working map. A NEW map
    // object is assigned rather than mutating the existing one: a QML `var`
    // property emits no change signal when an object it holds is mutated in
    // place, so the delegate's `position` binding would not re-evaluate and the
    // node would not follow the pointer.
    //
    // A null or non-finite position is dropped rather than written, so an
    // interrupted or degenerate drag can never leave a NaN behind (spec Error
    // paths).
    function _moveNode(id, worldPosition) {
        if (!worldPosition
                || !Positions.isFiniteNumber(worldPosition.x)
                || !Positions.isFiniteNumber(worldPosition.y)) {
            return;
        }

        var next = {};
        for (var k in root._positions) {
            next[k] = root._positions[k];
        }
        next[Positions.key(id)] = {x: worldPosition.x, y: worldPosition.y};
        root._positions = next;
    }

    // --- Culling (parent spec Data flow) ---
    //
    // layout.js's default node size (layout.js L233-234): the box culling
    // measures when the model gives no w/h. The delegate's implicit size is not
    // available -- a culled node has no delegate to measure, the same reason
    // _applyLayout cannot use it (L101-102 above).
    readonly property real _defaultNodeWidth: 160
    readonly property real _defaultNodeHeight: 60

    // The id whose delegate is mid-drag, or null. Written by the delegate's
    // drag handlers below; read here so an item is never destroyed under the
    // pointer, which would cancel the gesture.
    property var _draggedId: null

    // Measured sizes of the INSTANTIATED nodes, {key: {w, h}}, keyed by
    // Positions.key. Culled nodes are absent. CanvasEdges anchors on these so
    // edge ends meet the ports, which CanvasNode draws on its real size.
    // Replaced wholesale on every change so the binding re-evaluates. Nothing
    // that sizes a node reads it, so it cannot form a binding loop.
    property var _measured: ({})

    function _setMeasured(key, w, h) {
        var current = root._measured[key];
        if (current && current.w === w && current.h === h) {
            return;
        }
        var next = {};
        for (var k in root._measured) {
            next[k] = root._measured[k];
        }
        next[key] = {w: w, h: h};
        root._measured = next;
    }

    function _dropMeasured(key) {
        if (!root._measured[key]) {
            return;
        }
        var next = {};
        for (var k in root._measured) {
            if (k !== key) {
                next[k] = root._measured[k];
            }
        }
        root._measured = next;
    }

    // The working-map keys that must be instantiated, in _renderNodes order.
    // Every dependency (camera, viewport size, sanitized model, positions,
    // selection, dragged id, culling) is READ here, so the binding below tracks
    // all of them and re-evaluates when any changes. All arithmetic is
    // camera.js's: nothing about the 0.1-4 clamp is reimplemented.
    function _computeVisibleKeys() {
        var keys = [];
        var list = root._renderNodes;
        if (!list || typeof list.length !== "number") {
            return keys;
        }

        // Null means "cull nothing": culling switched off, or a viewport that
        // has no usable size yet (spec Error paths).
        var rect = root.culling
                 ? Camera.viewportWorldRect({panX: root.panX, panY: root.panY,
                                             zoom: root.zoom},
                                            {w: root.width, h: root.height},
                                            root._cullMargin)
                 : null;

        for (var i = 0; i < list.length; i++) {
            var node = list[i];
            var k = Positions.key(node.id);

            if (rect === null) {
                keys.push(k);
                continue;
            }

            // Never culled, whatever the camera says: destroying the selected
            // node would lose the caller's styling of it, and destroying the
            // dragged node or the node a connect started from would cancel the
            // gesture.
            if (node.id === root._selectedId || node.id === root._draggedId
                    || node.id === root._connectFromId) {
                keys.push(k);
                continue;
            }

            // An unusable working position gives a box with non-finite fields,
            // and rectsIntersect fails open on those: a node the canvas cannot
            // measure is instantiated, never hidden.
            var position = root._positions[k];
            var box = {x: position ? position.x : undefined,
                       y: position ? position.y : undefined,
                       w: Positions.sizeValue(node.w, root._defaultNodeWidth),
                       h: Positions.sizeValue(node.h, root._defaultNodeHeight)};

            if (Camera.rectsIntersect(box, rect)) {
                keys.push(k);
            }
        }
        return keys;
    }

    // Bring visibleModel in line with `keys` by insert, move and remove only.
    // A Repeater over a plain JS array destroys and recreates EVERY delegate
    // whenever the array is reassigned, so re-filtering into a new array on
    // each camera tick would reset every visible node and tear down the node
    // under the pointer mid-drag. Here a key that stays in the model keeps its
    // item instance, and a membership list that has not actually changed
    // touches nothing at all (the loops below find no work to do).
    function _syncVisibleModel(keys) {
        var wanted = {};
        var i;
        for (i = 0; i < keys.length; i++) {
            wanted[keys[i]] = true;
        }

        // Backwards, so removing one entry cannot skip the next.
        for (i = visibleModel.count - 1; i >= 0; i--) {
            if (!wanted[visibleModel.get(i).key]) {
                visibleModel.remove(i);
            }
        }

        for (i = 0; i < keys.length; i++) {
            if (i < visibleModel.count && visibleModel.get(i).key === keys[i]) {
                continue;
            }

            var at = -1;
            for (var j = i + 1; j < visibleModel.count; j++) {
                if (visibleModel.get(j).key === keys[i]) {
                    at = j;
                    break;
                }
            }

            if (at >= 0) {
                visibleModel.move(at, i, 1);
            } else {
                visibleModel.insert(i, {key: keys[i]});
            }
        }
    }

    // Ids only: the caller's entries stay in _nodeByKey and reach the delegate
    // by reference. The single role is `key`, a string from Positions.key(id),
    // so an id called "__proto__" or "constructor" cannot collide with an
    // Object.prototype member in the membership maps above.
    ListModel {
        id: visibleModel
        objectName: "visibleModel"
    }

    // The membership binding. Its change handler is the only writer of
    // visibleModel, so instantiation follows the camera without anything else
    // having to remember to ask.
    QtObject {
        id: culler
        property var visibleKeys: root._computeVisibleKeys()
        onVisibleKeysChanged: root._syncVisibleModel(culler.visibleKeys)
    }

    Item {
        id: world
        objectName: "world"

        transformOrigin: Item.TopLeft

        // One-way bindings: the camera drives the world, never the reverse.
        x: root.panX
        y: root.panY
        scale: Camera.clampZoom(root.zoom)

        // Edges first, so they paint UNDER the nodes they join. Everything it
        // needs is handed over as plain properties: the canvas keeps ownership
        // of positions, the sanitized model and the visibility decision, and the
        // layer reimplements none of them.
        // No objectName here: the component sets its own ("canvasEdges"), and
        // setting one on the instance would override it and hide the layer from
        // findChild in the tests.
        CanvasEdges {
            id: edgeLayer

            edges: root.edges
            positions: root._positions
            nodeByKey: root._nodeByKey
            visibleKeys: culler.visibleKeys
            defaultNodeWidth: root._defaultNodeWidth
            defaultNodeHeight: root._defaultNodeHeight
            measuredSizes: root._measured

            selectedEdgeId: root._selectedEdgeId
            tempFromId: root._connectFromId
            tempPoint: root._connectPoint
            tempInvalid: root._connectInvalid

            onEdgeClicked: function (id) {
                root._selectEdge(id);
                root.edgeClicked(id);
            }
        }

        // One CanvasNode per sanitized model entry, in world coordinates. The
        // transform above is the only place zoom and pan are applied, so the
        // delegate's x/y stay raw world coordinates.
        Repeater {
            id: nodeRepeater
            objectName: "nodeRepeater"

            // Keys, not entries (see _syncVisibleModel): an incrementally
            // updated model, so a node that stays visible keeps its item.
            model: visibleModel

            delegate: CanvasNode {
                // The caller's own model entry, looked up by working-map key.
                // `model` goes null while the delegate is being destroyed.
                readonly property var entry: model ? root._nodeByKey[model.key]
                                                   : null

                node: entry
                position: model ? root._positions[model.key] : null

                // Publish the real size for edge anchoring; drop it on
                // destruction so a culled node falls back to the default box.
                readonly property string _mkey: model ? model.key : ""
                onWidthChanged: if (model) root._setMeasured(_mkey, width, height)
                onHeightChanged: if (model) root._setMeasured(_mkey, width, height)
                Component.onCompleted: if (model) root._setMeasured(_mkey, width, height)
                Component.onDestruction: root._dropMeasured(_mkey)
                content: root.nodeDelegate

                // The scale this node is actually drawn at, i.e.
                // Camera.clampZoom(root.zoom): the drag divides the screen
                // delta by exactly that (parent spec L71-72).
                worldScale: world.scale

                // Single selection: at most one id matches. An id that leaves
                // `nodes` takes the selection with it (_pruneSelection), so
                // this can never match a node that was never clicked.
                selected: root._selectedId !== null && !!entry
                          && entry.id === root._selectedId

                onTapped: {
                    root._select(entry.id);
                    root.nodeClicked(entry.id);
                }

                // A drag selects too, so it never leaves a stale selection on
                // some other node. It is not a click: no nodeClicked here.
                // The id is also exempted from culling for the whole gesture:
                // destroying this item now would cancel the drag.
                onDragStarted: {
                    root._select(entry.id);
                    root._draggedId = entry.id;
                }

                onDragMoved: function (worldPosition) {
                    root._moveNode(entry.id, worldPosition);
                }

                onDragDropped: function (worldPosition) {
                    root._moveNode(entry.id, worldPosition);
                    root._pinDrop(entry.id, worldPosition);
                    root.nodeMoved(entry.id, worldPosition.x, worldPosition.y);
                }

                // 7.2: a drag from this node's output port. It is NOT a node
                // move and NOT a selection change -- the canvas only tracks the
                // gesture and decides, on release, whether an edge was asked
                // for. The id is exempted from culling for the whole gesture.
                onConnectStarted: root._beginConnect(entry.id)

                onConnectMoved: function (scenePoint) {
                    root._updateConnect(scenePoint);
                }

                onConnectDropped: function (scenePoint) {
                    root._finishConnect(scenePoint);
                }

                // The end of the gesture, from the one signal that fires for
                // every ending -- a normal release, a stolen grab, a cancel.
                // DEFERRED on purpose: `dragging` and CanvasNode's dragDropped
                // both fall out of the same activeChanged in an order Qt does
                // not fix, and clearing the exemption synchronously could
                // destroy this very item in the middle of its own handlers.
                // Qt.callLater runs it after the whole chain has unwound, so
                // the drop still emits exactly one nodeMoved.
                onDraggingChanged: {
                    if (!dragging && entry) {
                        Qt.callLater(root._releaseDrag, entry.id);
                    }
                }
            }
        }
    }

    // --- Input (spec L67) ---
    //
    // Pan is a pure screen-space translation: screen = world * zoom + pan, so
    // the pointer delta is added to the camera as-is and is never divided by
    // zoom. The handlers write root.panX/panY only -- world.x/y stay bound to
    // the camera above, and `target: null` stops Qt from translating this Item.
    //
    // The pose captured when a pan begins. Only one pan handler can be active
    // at a time (they accept different buttons), so a single origin suffices.
    property real _panOriginX: 0
    property real _panOriginY: 0

    function _beginPan() {
        root._panOriginX = root.panX;
        root._panOriginY = root.panY;
    }

    // Offset from the press point, applied to the captured origin. Computed
    // from the press position every time rather than accumulated per event, so
    // no rounding can build up over a long drag.
    function _applyPan(centroid) {
        root.panX = root._panOriginX
                  + (centroid.scenePosition.x - centroid.scenePressPosition.x);
        root.panY = root._panOriginY
                  + (centroid.scenePosition.y - centroid.scenePressPosition.y);
    }

    // Left-button drag on the empty background. Node delegates take their own
    // presses from 4.2 (CanvasNode's DragHandler and TapHandler both grab
    // first, being deeper in the item tree), so this handler only ever sees
    // presses that landed on empty space.
    DragHandler {
        id: backgroundPanHandler
        objectName: "backgroundPanHandler"

        target: null
        acceptedButtons: Qt.LeftButton
        // One finger pans; two fingers belong to the pinch handler below.
        maximumPointCount: 1

        onActiveChanged: {
            if (active) {
                root._beginPan();
                root._applyPan(centroid);
            }
        }
        onCentroidChanged: {
            if (active) {
                root._applyPan(centroid);
            }
        }
    }

    // Middle-button drag pans from anywhere inside the viewport, whatever is
    // under the press point. Same camera arithmetic as the background handler.
    DragHandler {
        id: middleButtonPanHandler
        objectName: "middleButtonPanHandler"

        target: null
        acceptedButtons: Qt.MiddleButton

        onActiveChanged: {
            if (active) {
                root._beginPan();
                root._applyPan(centroid);
            }
        }
        onCentroidChanged: {
            if (active) {
                root._applyPan(centroid);
            }
        }
    }

    // --- Zoom input (spec L68-69) ---
    //
    // Per-notch multiplicative steps. A mouse notch is 120 angle units, so the
    // factor is step^(delta / 120): notches compose multiplicatively and a
    // high-resolution trackpad delta lands smoothly between them. Internal
    // tuning constants, not part of the documented public API.
    readonly property real _zoomStep: 1.2
    readonly property real _fineZoomStep: 1.05

    // Scale the camera by `factor` about `pivot` ({x, y} in root coordinates),
    // delegating every bit of arithmetic -- including the 0.1-4x clamp -- to
    // camera.js. At a clamp boundary zoomAbout returns the pose it was given,
    // so pan does not move either.
    function _zoomBy(factor, pivot) {
        var camera = Camera.zoomAbout({panX: root.panX,
                                       panY: root.panY,
                                       zoom: root.zoom},
                                      factor, pivot);
        root.panX = camera.panX;
        root.panY = camera.panY;
        root.zoom = camera.zoom;
    }

    // Public: scale the camera by `factor` about the viewport centre, through
    // the same _zoomBy (and so the same camera.js clamp) as the keys. A factor
    // that is not a finite number above zero is a no-op.
    function zoomBy(factor) {
        if (typeof factor !== "number" || !isFinite(factor) || factor <= 0) {
            return;
        }
        root._zoomBy(factor, {x: root.width / 2, y: root.height / 2});
    }

    // Wheel / touchpad input, one entry point so it is testable (QtTest cannot
    // synthesize a pixelDelta).
    //  - pixelDelta non-zero (touchpad two-finger scroll), no Ctrl: PAN by the
    //    pixel delta, natural direction (content follows the fingers:
    //    panX += dx, panY += dy).
    //  - Ctrl held: ZOOM about the cursor. Pixel deltas use camera.js's smooth
    //    exponential; angle-only (mouse) keeps the fine Ctrl notch step.
    //  - angleDelta only (mouse wheel): ZOOM about the cursor, one notch = 120.
    // Non-finite deltas are dropped. Every zoom goes through _zoomBy, so the
    // 0.1-4x clamp lives in camera.js alone.
    function _handleWheel(pixelDelta, angleDelta, modifiers, point) {
        var px = pixelDelta ? pixelDelta.x : 0;
        var py = pixelDelta ? pixelDelta.y : 0;
        var ay = angleDelta ? angleDelta.y : 0;
        var ctrl = (modifiers & Qt.ControlModifier) !== 0;
        var hasPixels = (typeof px === "number" && px !== 0)
                     || (typeof py === "number" && py !== 0);

        if (hasPixels) {
            if (!isFinite(px) || !isFinite(py)) {
                return;
            }
            if (ctrl) {
                root._zoomBy(Camera.pixelZoomFactor(py), point);
            } else {
                root.panX += px;
                root.panY += py;
            }
            return;
        }

        if (typeof ay !== "number" || !isFinite(ay) || ay === 0) {
            return;
        }
        var step = ctrl ? root._fineZoomStep : root._zoomStep;
        root._zoomBy(Math.pow(step, ay / 120), point);
    }

    // `target: null` because this handler drives the camera itself and must
    // never transform the viewport Item. event.x / event.y are in root's
    // coordinate space, which is the space pan lives in.
    WheelHandler {
        id: zoomHandler
        objectName: "zoomHandler"

        target: null

        onWheel: function (event) {
            root._handleWheel(event.pixelDelta, event.angleDelta,
                              event.modifiers, {x: event.x, y: event.y});
        }
    }

    // Pinch: PinchHandler reports a cumulative scale since the gesture began;
    // the camera is driven by the ratio of consecutive reports about the pinch
    // centre. `_pinchScale` is that previous report.
    property real _pinchScale: 1

    function _pinchBegin() {
        root._pinchScale = 1;
    }

    function _pinchUpdate(scale, centre) {
        var factor = Camera.pinchFactor(root._pinchScale, scale);
        if (typeof scale === "number" && isFinite(scale) && scale > 0) {
            root._pinchScale = scale;
        }
        root._zoomBy(factor, centre);
    }

    PinchHandler {
        id: pinchHandler
        objectName: "pinchHandler"

        target: null

        onActiveChanged: {
            if (active) {
                root._pinchBegin();
            }
        }
        onActiveScaleChanged: {
            if (active) {
                root._pinchUpdate(activeScale,
                                  {x: centroid.position.x, y: centroid.position.y});
            }
        }
    }

    // --- Keyboard input (spec L69) ---
    //
    // The canvas takes focus on any press inside the viewport so a
    // click-then-type sequence works without the caller wiring focus up.
    // TapHandler's default gesturePolicy (DragThreshold) never takes an
    // exclusive pointer grab, so the pan DragHandlers above still activate on
    // exactly the same press.
    TapHandler {
        id: focusHandler
        objectName: "focusHandler"

        acceptedButtons: Qt.LeftButton | Qt.MiddleButton | Qt.RightButton

        onPressedChanged: {
            if (pressed) {
                root.forceActiveFocus();
            }
        }
    }

    // Clicking empty background clears the selection (parent spec L73).
    // Deliberately the DEFAULT gesturePolicy (DragThreshold, no exclusive grab),
    // like focusHandler: giving this handler ReleaseWithinBounds takes an
    // exclusive grab on every press and breaks focusHandler and the key/focus
    // tests in tst_viewport.qml (verified). It does not fire for a click on a
    // node because the node's own TapHandler (ReleaseWithinBounds, an exclusive
    // grab -- see CanvasNode.qml) owns that press; verified by
    // test_clicking_a_node_selects_it_and_emits_node_clicked. The pan
    // DragHandlers are a different type and still take over for a drag.
    TapHandler {
        id: backgroundTapHandler
        objectName: "backgroundTapHandler"

        acceptedButtons: Qt.LeftButton

        onTapped: {
            root._clearSelection();
            root._clearEdgeSelection();
        }
    }

    // A key event carries no cursor position, so the keyboard zoom pivots on
    // the viewport centre. Only +, -, and Delete/Backspace (with an edge
    // selected) are consumed; anything else is left unaccepted so it propagates to the parent.
    Keys.onPressed: function (event) {
        var pivot = {x: root.width / 2, y: root.height / 2};

        if (event.key === Qt.Key_Plus) {
            root._zoomBy(root._zoomStep, pivot);
        } else if (event.key === Qt.Key_Minus) {
            root._zoomBy(1 / root._zoomStep, pivot);
        } else if (event.key === Qt.Key_Delete
                   || event.key === Qt.Key_Backspace) {
            // The key is only OURS while an edge is selected. With nothing (or
            // a node) selected the canvas has nothing to say, so the event is
            // left unaccepted and propagates, exactly like an unknown key.
            // `=== null` and not `!`: 0 and "" are valid ids.
            if (root._selectedEdgeId === null) {
                return;
            }
            // Emit and nothing else: no write to `edges`, no clearing of the
            // selection (parent spec L22). _pruneEdgeSelection drops the
            // selection when the caller drops the edge.
            root.edgeRemoved(root._selectedEdgeId);
        } else {
            return;
        }

        event.accepted = true;
    }

    // --- Public view methods (spec L49-63) ---

    // Back to the identity pose: no pan, 1:1 zoom.
    function resetView() {
        root.panX = 0;
        root.panY = 0;
        root.zoom = 1;
    }

    // Only finite numbers count as coordinates. A string "12" or a NaN is
    // treated as absent, never coerced.
    function _isFiniteNumber(value) {
        return typeof value === "number" && isFinite(value);
    }

    // Union bounding rect {x, y, w, h} over EVERY usable node, or null when
    // none has a working position. Positions are the canvas's own
    // (_positions, so auto-laid-out and dragged nodes count at where they are
    // now); sizes resolve measured first, then model w/h, then the 160x60
    // default -- the same order CanvasEdges uses. Culled nodes count too.
    // Nothing here writes to `nodes`.
    function _nodeBounds() {
        var usable = Positions.usableNodes(root.nodes);

        var minX = 0, minY = 0, maxX = 0, maxY = 0;
        var found = false;

        for (var i = 0; i < usable.length; ++i) {
            var k = Positions.key(usable[i].id);
            var position = root._positions[k];
            if (!position || !_isFiniteNumber(position.x)
                    || !_isFiniteNumber(position.y)) {
                continue;
            }

            var measured = root._measured[k];
            var w = Positions.sizeValue(measured ? measured.w : usable[i].w,
                                        root._defaultNodeWidth);
            var h = Positions.sizeValue(measured ? measured.h : usable[i].h,
                                        root._defaultNodeHeight);

            minX = found ? Math.min(minX, position.x) : position.x;
            minY = found ? Math.min(minY, position.y) : position.y;
            maxX = found ? Math.max(maxX, position.x + w) : position.x + w;
            maxY = found ? Math.max(maxY, position.y + h) : position.y + h;
            found = true;
        }

        if (!found) {
            return null;
        }
        return {x: minX, y: minY, w: maxX - minX, h: maxY - minY};
    }

    // Frame every usable node. No-op when nothing is usable or when the
    // viewport has not been laid out yet -- better to keep the current pose
    // than to snap to a garbage one.
    function fitAll() {
        if (root.width <= 0 || root.height <= 0) {
            return;
        }

        var bounds = _nodeBounds();
        if (bounds === null) {
            return;
        }
        root._fitRect(bounds);
    }

    // Frame a world rect (viewport already known to be laid out).
    function _fitRect(bounds) {
        var camera = Camera.fitToRect(bounds,
                                      {w: root.width, h: root.height},
                                      root.fitPadding);
        root.panX = camera.panX;
        root.panY = camera.panY;
        root.zoom = camera.zoom;
    }

    // Re-run the auto-layout over EVERY node, ignoring caller-pinned and
    // dragged positions (the nodes are handed to layout.js stripped of x/y),
    // and adopt the result as the working positions. nodeMoved(id, x, y) is
    // emitted once per node whose position changed so the caller can persist
    // it, and each such position is pinned like a drag drop. Sizes are the
    // measured ones where a delegate exists, else the model's w/h (layout
    // falls back to 160x60). The caller's `nodes` is never written.
    //
    // The view is then framed with the same bounds helper as fitAll(), which
    // reads the NEW working positions, not the caller's stale coordinates.
    function organize() {
        var usable = Positions.usableNodes(root.nodes);
        if (usable.length === 0) {
            return;
        }

        var stripped = [];
        for (var i = 0; i < usable.length; i++) {
            var measured = root._measured[Positions.key(usable[i].id)];
            stripped.push({id: usable[i].id,
                           w: measured ? measured.w : usable[i].w,
                           h: measured ? measured.h : usable[i].h});
        }
        var laidOut = Layout.layout(stripped, Positions.asArray(root.edges));

        var next = {};
        var moved = [];
        for (var j = 0; j < usable.length; j++) {
            var id = usable[j].id;
            var k = Positions.key(id);
            var placed = laidOut[id];
            if (!placed || !Positions.isFiniteNumber(placed.x)
                    || !Positions.isFiniteNumber(placed.y)) {
                next[k] = root._positions[k];
                continue;
            }
            next[k] = {x: placed.x, y: placed.y};
            var before = root._positions[k];
            if (!before || before.x !== placed.x || before.y !== placed.y) {
                moved.push({id: id, x: placed.x, y: placed.y});
            }
        }

        root._positions = next;
        for (var m = 0; m < moved.length; m++) {
            root._pinDrop(moved[m].id, moved[m]);
            root.nodeMoved(moved[m].id, moved[m].x, moved[m].y);
        }

        // Same frame as fitAll(); measured sizes still win over model w/h here,
        // which is what the layout above used.
        root.fitAll();
    }

    // First node with a matching id and usable coordinates, else null.
    // A matching node whose x/y are unusable is not centre-able, so it is
    // treated as not found.
    function _findNode(id) {
        if (id === undefined || id === null) {
            return null;
        }

        var list = root.nodes;
        if (!list || typeof list.length !== "number") {
            return null;
        }

        for (var i = 0; i < list.length; ++i) {
            var node = list[i];
            if (!node || node.id !== id) {
                continue;
            }
            if (!_isFiniteNumber(node.x) || !_isFiniteNumber(node.y)) {
                return null;
            }
            return node;
        }
        return null;
    }

    // Pan so the node's centre sits at the viewport centre, at the current
    // (clamped) zoom. Unknown or unusable ids are a no-op.
    function centerOn(id) {
        var node = _findNode(id);
        if (node === null) {
            return;
        }

        var zoom = Camera.clampZoom(root.zoom);
        var nodeW = _isFiniteNumber(node.w) ? node.w : 0;
        var nodeH = _isFiniteNumber(node.h) ? node.h : 0;
        var centerX = node.x + nodeW / 2;
        var centerY = node.y + nodeH / 2;

        root.panX = root.width / 2 - centerX * zoom;
        root.panY = root.height / 2 - centerY * zoom;
        root.zoom = zoom;
    }
}
