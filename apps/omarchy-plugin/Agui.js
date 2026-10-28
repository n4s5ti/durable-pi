.pragma library

// The hub's read-only AG-UI stream (GET /api/agui) on the QML side: SSE parsing, RFC 6902 patches
// over the canvas state, and the two views the plugin draws from it. Same rules as the web client
// (apps/dpi-sdk/src/agui.ts): a patch that does not fit throws, and the caller reconnects for a
// fresh snapshot instead of guessing.

var MAX_EVENT = 2 * 1024 * 1024;

function isRecord(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function unescapeToken(token) {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

/** Apply a patch to a copy of `state`; throws on a path that does not resolve. */
function applyPatch(state, ops) {
  var root = clone(state);
  for (var i = 0; i < ops.length; i++) {
    var op = ops[i];
    if (!op || typeof op.path !== "string") throw new Error("Bad patch operation");
    if (op.path === "") {
      if (op.op === "remove") throw new Error("Cannot remove the document root");
      root = clone(op.value);
      continue;
    }
    if (op.path.charAt(0) !== "/") throw new Error("Bad JSON Pointer: " + op.path);
    var tokens = op.path.slice(1).split("/").map(unescapeToken);
    var last = tokens.pop();
    var parent = root;
    for (var t = 0; t < tokens.length; t++) {
      if (!isRecord(parent) || !(tokens[t] in parent)) throw new Error("No such path: " + op.path);
      parent = parent[tokens[t]];
    }
    if (!isRecord(parent)) throw new Error("No such path: " + op.path);
    if (op.op === "add") parent[last] = clone(op.value);
    else if (!(last in parent)) throw new Error("No such path: " + op.path);
    else if (op.op === "remove") delete parent[last];
    else if (op.op === "replace") parent[last] = clone(op.value);
    else throw new Error("Unsupported op: " + op.op);
  }
  return root;
}

/**
 * Feed one stdout line of the SSE body. `pending` holds the data lines of the event being read;
 * returns { pending, event } where event is the parsed AG-UI event once a blank line ends it.
 */
function readLine(pending, line) {
  line = String(line).replace(/\r$/, "");
  if (line === "") {
    if (!pending.length) return { pending: [], event: null };
    var data = pending.join("\n");
    if (data.length > MAX_EVENT) throw new Error("AG-UI event too large");
    return { pending: [], event: JSON.parse(data) };
  }
  if (line.charAt(0) === ":") return { pending: pending, event: null };
  if (line.indexOf("data:") === 0) {
    var next = pending.slice();
    next.push(line.slice(5).replace(/^ /, ""));
    return { pending: next, event: null };
  }
  return { pending: pending, event: null };
}

function values(record) {
  return isRecord(record) ? Object.keys(record).map(function(k) { return record[k]; }) : [];
}

/** The shape BarWidget.qml and Panel.qml already draw: devices with their sessions. */
function toNetwork(state) {
  return {
    ok: true,
    loaded: true,
    devices: values(state && state.devices).map(function(d) {
      return {
        id: String(d.id),
        name: String(d.name || d.id),
        status: String(d.status),
        error: d.error ? String(d.error) : "",
        moreSessions: Number(d.moreSessions) || 0,
        sessions: values(d.sessions).map(function(s) {
          var agents = values(s.agents);
          return {
            name: String(s.name || s.id),
            busy: s.busy === true || agents.some(function(a) { return a.busy === true || Number(a.background) > 0; }),
            agents: agents.length + (Number(s.moreAgents) || 0),
          };
        }),
      };
    }),
  };
}

/** Nodes and edges for the canvas: device → session → root agents → forks and subagents. */
function toGraph(state) {
  var nodes = [];
  var edges = [];
  values(state && state.devices).forEach(function(d) {
    var deviceKey = "d:" + d.id;
    var sessions = values(d.sessions);
    nodes.push({
      id: deviceKey,
      type: "device",
      label: String(d.name || d.id),
      detail: d.status === "online" ? sessions.length + " sessions" : String(d.error || d.status),
      online: d.status === "online",
      busy: false,
    });
    sessions.forEach(function(s) {
      var sessionKey = "s:" + d.id + "/" + s.id;
      nodes.push({
        id: sessionKey,
        type: "session",
        label: String(s.name || s.id),
        detail: String(s.error || s.model || ""),
        online: true,
        busy: s.busy === true,
      });
      edges.push({ id: deviceKey + ">" + sessionKey, from: deviceKey, to: sessionKey });
      var agents = values(s.agents);
      var ids = {};
      agents.forEach(function(a) { ids[a.id] = true; });
      agents.forEach(function(a) {
        var key = "a:" + d.id + "/" + s.id + "/" + a.id;
        var p = a.parentId !== null && a.parentId !== undefined ? a.parentId : a.ownerAgentId;
        var hasParent = p !== null && p !== undefined && p !== a.id && ids[p] === true;
        var parentKey = hasParent ? "a:" + d.id + "/" + s.id + "/" + p : sessionKey;
        nodes.push({
          id: key,
          type: "agent",
          label: String(a.name),
          detail: (a.kind === "root" ? "agent" : String(a.kind)) + (a.background ? " · " + a.background + " in background" : ""),
          online: true,
          busy: a.busy === true || Number(a.background) > 0,
        });
        edges.push({ id: parentKey + ">" + key, from: parentKey, to: key });
      });
    });
  });
  return { nodes: nodes, edges: edges };
}
