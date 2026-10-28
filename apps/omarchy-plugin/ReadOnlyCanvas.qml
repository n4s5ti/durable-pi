import QtQuick
import QtQuick.Layouts
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import "canvas" as Local
import "Agui.js" as Agui

// The network graph on the vendored omarchy-canvas (canvas/NOTICE.md), held read-only: no
// connection is ever allowed, removals and clicks change nothing, and a dragged node moves only in
// this view. Node positions come from the canvas's own auto-layout.
Item {
  id: root

  property var canvasState: null
  property bool stale: false

  readonly property var graph: Agui.toGraph(root.canvasState)
  // Positions the user dragged to, by node id; local to this view and forgotten on reload.
  property var moved: ({})

  readonly property var nodes: graph.nodes.map(function(n) {
    var at = root.moved[n.id]
    return at ? Object.assign({}, n, { x: at.x, y: at.y }) : n
  })

  Local.Canvas {
    id: canvas
    anchors.fill: parent
    nodes: root.nodes
    edges: root.graph.edges
    nodeDelegate: card
    canConnect: function() { return false }
    opacity: root.stale ? 0.55 : 1

    onNodeMoved: function(id, x, y) {
      var next = Object.assign({}, root.moved)
      next[id] = { x: x, y: y }
      root.moved = next
    }
  }

  Local.CanvasControls {
    canvas: canvas
    showCulling: false
  }

  Component {
    id: card

    Rectangle {
      readonly property bool isView: modelData.type === "view"
      implicitWidth: Style.space(isView ? 280 : 180)
      implicitHeight: isView ? viewBody.implicitHeight + Style.space(16) : Style.space(48)
      radius: Style.cornerRadius
      color: canvas.selectedId === modelData.id ? Qt.rgba(1, 1, 1, 0.08) : Qt.rgba(0, 0, 0, 0.25)
      border.width: modelData.busy ? 2 : 1
      border.color: modelData.busy ? Commons.Color.accent
        : modelData.type === "device" && modelData.online ? Commons.Color.foreground
        : Commons.Color.muted

      ColumnLayout {
        id: viewBody
        visible: parent.isView
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        anchors.margins: Style.space(8)
        spacing: Style.space(6)

        Text {
          Layout.fillWidth: true
          textFormat: Text.PlainText
          text: modelData.label
          color: Commons.Color.foreground
          font.family: Style.font.family
          font.pixelSize: Style.font.body
          font.bold: true
          elide: Text.ElideRight
        }

        Loader {
          Layout.fillWidth: true
          active: parent.visible
          source: "UiNode.qml"
          onLoaded: item.node = modelData.spec
        }
      }

      ColumnLayout {
        visible: !parent.isView
        anchors.fill: parent
        anchors.margins: Style.space(8)
        spacing: Style.space(2)

        Text {
          Layout.fillWidth: true
          textFormat: Text.PlainText
          text: modelData.label
          color: Commons.Color.foreground
          font.family: Style.font.family
          font.pixelSize: Style.font.body
          font.bold: true
          elide: Text.ElideRight
        }

        Text {
          Layout.fillWidth: true
          textFormat: Text.PlainText
          text: modelData.detail
          color: Commons.Color.muted
          font.family: Style.font.family
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
        }
      }
    }
  }
}
