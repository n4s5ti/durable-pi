import QtQuick
import Quickshell.Io
import "Agui.js" as Agui

// Follows the hub's read-only AG-UI stream (GET /api/agui) with curl, one SSE line at a time:
// STATE_SNAPSHOT replaces `canvas`, STATE_DELTA patches it. When the stream drops or a delta does not
// fit, `live` goes false, the last state stays (the owner marks it stale) and curl restarts with
// backoff; every new connection begins with a fresh snapshot. Nothing is ever sent to the hub.
Item {
  id: root

  property string hubUrl: "http://127.0.0.1:4781/"
  property bool enabled: true
  // The AG-UI canvas state (not `state`: every Item already has a `state` string property).
  property var canvas: null
  readonly property bool loaded: canvas !== null
  property bool live: false

  property var _pending: []
  property int _backoff: 1000

  function _reset() {
    root.live = false
    root._pending = []
    if (proc.running) proc.running = false
  }

  function _read(line) {
    try {
      var next = Agui.readLine(root._pending, line)
      root._pending = next.pending
      var event = next.event
      if (!event) return
      if (event.type === "STATE_SNAPSHOT") {
        root.canvas = event.snapshot
        root.live = true
        root._backoff = 1000
      } else if (event.type === "STATE_DELTA" && root.live) {
        root.canvas = Agui.applyPatch(root.canvas, event.delta)
      }
    } catch (error) {
      console.warn("[n4s5ti.durable-pi] AG-UI stream out of sync, reconnecting:", error)
      root._reset()
    }
  }

  Process {
    id: proc
    command: ["curl", "-sSN", "--fail", "--connect-timeout", "3", root.hubUrl + "api/agui"]
    running: false
    stdout: SplitParser {
      splitMarker: "\n"
      onRead: function(line) { root._read(line) }
    }
    onExited: {
      root.live = false
      root._pending = []
    }
  }

  Timer {
    interval: root._backoff
    running: root.enabled && !proc.running
    onTriggered: {
      root._backoff = Math.min(root._backoff * 2, 30000)
      proc.running = true
    }
  }

  onHubUrlChanged: _reset()
  onEnabledChanged: if (!enabled) _reset()
  Component.onDestruction: _reset()
}
