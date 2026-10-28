.pragma library

// Layered auto-layout for Canvas.qml. QML JS library: only top-level
// `function` declarations, because the test loader evaluates this source in a
// node:vm context and reads the declarations back off it, where `const`/`let`
// would be invisible. No imports, and nothing the caller passed in is written.
//
// Public surface: layout(nodes, edges, options?) -> {id: {x, y}}, built on
// assignRanks (ranks) plus a fixed 4-pass barycenter sweep for in-layer order
// and a coordinate pass that honours node sizes, caller-pinned nodes (omitted
// from the result) and disconnected components.

// Internal maps are keyed by mapKey(id), never by the raw id, so a node called
// "constructor" or "toString" cannot collide with an Object.prototype member.
function mapKey(id) {
    return "n" + id;
}

// `target["__proto__"] = rank` on an object literal silently does nothing: the
// assignment hits Object.prototype's __proto__ setter instead of creating an
// own property, and the node would disappear from the result. Every node must
// appear exactly once, so define that one property explicitly.
function setRank(target, id, rank) {
    if (id === "__proto__") {
        Object.defineProperty(target, id, {
            value: rank,
            enumerable: true,
            writable: true,
            configurable: true
        });
    } else {
        target[id] = rank;
    }
}

// Longest-path layering: a node with no incoming edge gets rank 0, every other
// node gets 1 + the deepest rank among its sources. Only `node.id`,
// `edge.from` and `edge.to` are read, and nothing is written.
function assignRanks(nodes, edges) {
    var result = {};
    if (!nodes || nodes.length === 0) {
        return result;
    }

    // A QML binding can deliver the edge list as undefined before its source
    // exists; that is a graph with no edges, not an error.
    var edgeInput = edges ? edges : [];
    var i;

    // Node ids in input order, deduplicated. `order` keeps the caller's ids for
    // the result; `keys` is the internal-map form of the same list.
    var order = [];
    var keys = [];
    var known = {};
    for (i = 0; i < nodes.length; i++) {
        var id = nodes[i].id;
        var key = mapKey(id);
        if (!known[key]) {
            known[key] = true;
            order.push(id);
            keys.push(key);
        }
    }

    // Root spec L94: an edge referencing a missing node is skipped with a
    // console warning. It never invents a node and never affects a rank.
    var edgeList = [];
    for (i = 0; i < edgeInput.length; i++) {
        var edge = edgeInput[i];
        var from = mapKey(edge.from);
        var to = mapKey(edge.to);
        if (!known[from] || !known[to]) {
            console.warn("layout.js: edge " + edge.id + " references a missing node (" +
                         edge.from + " -> " + edge.to + "), skipping it");
            continue;
        }
        edgeList.push({ from: from, to: to });
    }

    var retained = dropBackEdges(keys, edgeList);
    var ranks = longestPathRanks(keys, retained, buildOutgoing(retained));
    for (i = 0; i < order.length; i++) {
        setRank(result, order[i], ranks[keys[i]]);
    }
    return result;
}

// key -> indices into edgeList, in edge input order, so every traversal below
// follows the caller's order and never object key enumeration order.
function buildOutgoing(edgeList) {
    var outgoing = {};
    for (var i = 0; i < edgeList.length; i++) {
        var from = edgeList[i].from;
        if (!outgoing[from]) {
            outgoing[from] = [];
        }
        outgoing[from].push(i);
    }
    return outgoing;
}

// Depth-first traversal visiting nodes in input order and each node's outgoing
// edges in edge input order. An edge whose target is on the current stack is a
// back-edge (a self-loop is the one-node case of that); it is dropped, so the
// retained graph is acyclic and layering terminates. The stack is explicit
// rather than recursive so a long chain cannot overflow it. Returns a new
// array; the input edge list is not modified.
function dropBackEdges(keys, edgeList) {
    var outgoing = buildOutgoing(edgeList);
    var dropped = {};
    var state = {};
    var i;

    for (i = 0; i < keys.length; i++) {
        if (state[keys[i]]) {
            continue;
        }
        state[keys[i]] = "open";
        var stack = [{ key: keys[i], next: 0 }];

        while (stack.length > 0) {
            var frame = stack[stack.length - 1];
            var out = outgoing[frame.key] ? outgoing[frame.key] : [];
            if (frame.next >= out.length) {
                state[frame.key] = "done";
                stack.pop();
                continue;
            }

            var index = out[frame.next];
            frame.next += 1;
            var to = edgeList[index].to;
            if (state[to] === "open") {
                dropped[index] = true;
            } else if (!state[to]) {
                state[to] = "open";
                stack.push({ key: to, next: 0 });
            }
        }
    }

    var retained = [];
    for (i = 0; i < edgeList.length; i++) {
        if (!dropped[i]) {
            retained.push(edgeList[i]);
        }
    }
    return retained;
}

// Kahn's algorithm over an acyclic edge list, relaxing each target to
// 1 + the deepest source seen so far. Every node starts at 0, so nodes with no
// incoming edge simply stay there. The queue is seeded in node input order, so
// the result never depends on key enumeration order.
function longestPathRanks(keys, edgeList, outgoing) {
    var ranks = {};
    var indegree = {};
    var i;

    for (i = 0; i < keys.length; i++) {
        ranks[keys[i]] = 0;
        indegree[keys[i]] = 0;
    }
    for (i = 0; i < edgeList.length; i++) {
        indegree[edgeList[i].to] += 1;
    }

    var queue = [];
    for (i = 0; i < keys.length; i++) {
        if (indegree[keys[i]] === 0) {
            queue.push(keys[i]);
        }
    }

    var head = 0;
    while (head < queue.length) {
        var key = queue[head];
        head += 1;
        var out = outgoing[key] ? outgoing[key] : [];
        for (var j = 0; j < out.length; j++) {
            var to = edgeList[out[j]].to;
            if (ranks[key] + 1 > ranks[to]) {
                ranks[to] = ranks[key] + 1;
            }
            indegree[to] -= 1;
            if (indegree[to] === 0) {
                queue.push(to);
            }
        }
    }

    return ranks;
}

// Non-negative finite number option, else the default.
function optionValue(options, name, fallback) {
    var value = options ? options[name] : undefined;
    if (typeof value === "number" && isFinite(value) && value >= 0) {
        return value;
    }
    return fallback;
}

// Node dimension: a finite number > 0, else the default.
function sizeValue(value, fallback) {
    if (typeof value === "number" && isFinite(value) && value > 0) {
        return value;
    }
    return fallback;
}

// Union-find root with path halving; iterative, so no recursion.
function findRoot(parent, i) {
    while (parent[i] !== i) {
        parent[i] = parent[parent[i]];
        i = parent[i];
    }
    return i;
}

// Public entry point: layout(nodes, edges, options?) -> {id: {x, y}}.
// Columns by rank (left to right), rows within a column, weakly connected
// components stacked along y. Nothing the caller passed is written.
function layout(nodes, edges, options) {
    var result = {};
    if (!nodes || nodes.length === 0) {
        return result;
    }
    var edgeInput = edges ? edges : [];
    var rankGap = optionValue(options, "rankGap", 80);
    var nodeGap = optionValue(options, "nodeGap", 40);
    var componentGap = optionValue(options, "componentGap", 80);
    var defaultWidth = sizeValue(options ? options.defaultWidth : undefined, 160);
    var defaultHeight = sizeValue(options ? options.defaultHeight : undefined, 60);
    var i;

    // The one place a missing-node edge warns.
    var ranks = assignRanks(nodes, edgeInput);

    var records = [];
    var byKey = {};
    for (i = 0; i < nodes.length; i++) {
        var key = mapKey(nodes[i].id);
        if (byKey[key] !== undefined) {
            continue;
        }
        byKey[key] = records.length;
        records.push({
            id: nodes[i].id,
            key: key,
            rank: ranks[nodes[i].id],
            w: sizeValue(nodes[i].w, defaultWidth),
            h: sizeValue(nodes[i].h, defaultHeight),
            pinned: isFinite(nodes[i].x) && isFinite(nodes[i].y) &&
                    typeof nodes[i].x === "number" && typeof nodes[i].y === "number",
            component: 0,
            x: 0,
            y: 0
        });
    }

    // Own edge list, silently: unknown endpoints are skipped, and requiring
    // rank[from] < rank[to] drops exactly the back-edges and self-loops.
    var links = [];
    var preds = [];
    var succs = [];
    for (i = 0; i < records.length; i++) {
        preds.push([]);
        succs.push([]);
    }
    for (i = 0; i < edgeInput.length; i++) {
        var from = byKey[mapKey(edgeInput[i].from)];
        var to = byKey[mapKey(edgeInput[i].to)];
        if (from === undefined || to === undefined) {
            continue;
        }
        if (records[from].rank < records[to].rank) {
            links.push({ from: from, to: to });
            // Only adjacent-rank edges steer the in-layer order.
            if (records[to].rank - records[from].rank === 1) {
                preds[to].push(from);
                succs[from].push(to);
            }
        }
    }

    // Weakly connected components, numbered by first appearance in `nodes`.
    var parent = [];
    for (i = 0; i < records.length; i++) {
        parent.push(i);
    }
    for (i = 0; i < links.length; i++) {
        var a = findRoot(parent, links[i].from);
        var b = findRoot(parent, links[i].to);
        if (a !== b) {
            parent[Math.max(a, b)] = Math.min(a, b);
        }
    }
    var components = [];
    var componentOfRoot = {};
    for (i = 0; i < records.length; i++) {
        var root = findRoot(parent, i);
        if (componentOfRoot[root] === undefined) {
            componentOfRoot[root] = components.length;
            components.push([]);
        }
        records[i].component = componentOfRoot[root];
        components[records[i].component].push(i);
    }

    var top = 0;
    for (i = 0; i < components.length; i++) {
        top = placeComponent(records, components[i], preds, succs, top, rankGap, nodeGap) + componentGap;
    }

    for (i = 0; i < records.length; i++) {
        if (records[i].pinned) {
            continue;
        }
        setRank(result, records[i].id, { x: records[i].x, y: records[i].y });
    }
    return result;
}

// Lays one component out with its top edge at `top`; returns its bottom edge.
function placeComponent(records, members, preds, succs, top, rankGap, nodeGap) {
    var columns = [];
    var i;
    for (i = 0; i < members.length; i++) {
        var r = records[members[i]].rank;
        while (columns.length <= r) {
            columns.push([]);
        }
        columns[r].push(members[i]);
    }

    sweepColumns(columns, preds, succs);

    var x = 0;
    var bottom = top;
    for (var c = 0; c < columns.length; c++) {
        var y = top;
        var width = 0;
        for (i = 0; i < columns[c].length; i++) {
            var rec = records[columns[c][i]];
            rec.x = x;
            rec.y = y;
            y += rec.h + nodeGap;
            width = Math.max(width, rec.w);
        }
        bottom = Math.max(bottom, y - nodeGap);
        x += width + rankGap;
    }
    return bottom;
}

// Four alternating barycenter passes (forward, backward, forward, backward).
// A forward pass reorders each column by the mean index of its predecessors in
// the column before it, a backward pass by its successors in the column after.
// A node with no such neighbour keeps its current index; the sort is stable.
// `columns` is reordered in place; it holds record indices, nothing else.
function sweepColumns(columns, preds, succs) {
    for (var pass = 0; pass < 4; pass++) {
        var forward = pass % 2 === 0;
        var c = forward ? 1 : columns.length - 2;
        while (c >= 0 && c < columns.length) {
            var reference = forward ? columns[c - 1] : columns[c + 1];
            var neighbours = forward ? preds : succs;
            reorderColumn(columns, c, reference, neighbours);
            c += forward ? 1 : -1;
        }
    }
}

function reorderColumn(columns, c, reference, neighbours) {
    var indexIn = {};
    var i;
    for (i = 0; i < reference.length; i++) {
        indexIn[reference[i]] = i;
    }
    var column = columns[c];
    var entries = [];
    for (i = 0; i < column.length; i++) {
        var sum = 0;
        var count = 0;
        var list = neighbours[column[i]];
        for (var j = 0; j < list.length; j++) {
            if (indexIn[list[j]] !== undefined) {
                sum += indexIn[list[j]];
                count += 1;
            }
        }
        entries.push({ index: column[i], at: i, value: count > 0 ? sum / count : i });
    }
    entries.sort(function (p, q) {
        return p.value !== q.value ? p.value - q.value : p.at - q.at;
    });
    for (i = 0; i < entries.length; i++) {
        column[i] = entries[i].index;
    }
}
