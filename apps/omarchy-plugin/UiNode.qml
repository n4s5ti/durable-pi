import QtQuick
import QtQuick.Layouts
import qs.Commons
import qs.Commons as Commons

// One component of an agent-made view, from the closed catalog in dpi-sdk/src/ui-spec.ts (the hub
// re-checks every view before streaming it). Read-only, plain text only: markdown shows as its text.
// Children load this file again through a Loader, which is how QML allows the recursion.
ColumnLayout {
  id: root

  property var node: ({})
  readonly property string type: node && node.type ? String(node.type) : ""
  readonly property var kids: node && Array.isArray(node.children) ? node.children : []

  function toneColor(tone) {
    if (tone === "accent") return Commons.Color.accent
    if (tone === "urgent") return Commons.Color.urgent
    if (tone === "muted") return Commons.Color.muted
    return Commons.Color.foreground
  }

  spacing: Style.space(4)

  component Plain: Text {
    Layout.fillWidth: true
    textFormat: Text.PlainText
    wrapMode: Text.Wrap
    color: Commons.Color.foreground
    font.family: Style.font.family
    font.pixelSize: Style.font.caption
  }

  Plain {
    visible: root.type === "card" && !!root.node.title
    text: root.node.title || ""
    font.bold: true
    font.pixelSize: Style.font.body
  }

  // card, column: children stacked; row: side by side.
  GridLayout {
    Layout.fillWidth: true
    visible: root.kids.length > 0
    columns: root.type === "row" ? Math.max(1, root.kids.length) : 1
    columnSpacing: Style.space(8)
    rowSpacing: Style.space(4)

    Repeater {
      model: root.kids
      Loader {
        required property var modelData
        Layout.fillWidth: true
        source: "UiNode.qml"
        onLoaded: item.node = modelData
      }
    }
  }

  Plain {
    visible: root.type === "text" || root.type === "markdown"
    text: root.node.text || ""
    color: root.toneColor(root.node.tone)
    maximumLineCount: 8
    elide: Text.ElideRight
  }

  Plain {
    visible: root.type === "metric"
    text: (root.node.value || "") + (root.node.unit ? " " + root.node.unit : "")
    font.pixelSize: Style.font.subtitle
    font.bold: true
  }
  Plain {
    visible: root.type === "metric"
    text: root.node.label || ""
    color: Commons.Color.muted
  }

  Rectangle {
    visible: root.type === "badge"
    implicitWidth: badgeText.implicitWidth + Style.space(12)
    implicitHeight: badgeText.implicitHeight + Style.space(4)
    radius: height / 2
    color: "transparent"
    border.width: 1
    border.color: root.toneColor(root.node.tone)
    Text {
      id: badgeText
      anchors.centerIn: parent
      textFormat: Text.PlainText
      text: root.node.text || ""
      color: root.toneColor(root.node.tone)
      font.family: Style.font.family
      font.pixelSize: Style.font.caption
    }
  }

  Plain {
    visible: root.type === "progress"
    text: (root.node.label ? root.node.label + " · " : "") + Math.round((Number(root.node.value) || 0) * 100) + "%"
    color: Commons.Color.muted
  }
  Rectangle {
    visible: root.type === "progress"
    Layout.fillWidth: true
    implicitHeight: Style.space(5)
    radius: height / 2
    color: Qt.rgba(1, 1, 1, 0.12)
    Rectangle {
      width: parent.width * Math.max(0, Math.min(1, Number(root.node.value) || 0))
      height: parent.height
      radius: parent.radius
      color: Commons.Color.accent
    }
  }

  Plain {
    visible: root.type === "list"
    text: (root.node.items || []).map(function(i) { return "• " + i }).join("\n")
  }

  Plain {
    visible: root.type === "table"
    font.family: "monospace"
    text: [root.node.columns || []].concat(root.node.rows || []).map(function(r) { return r.join("  ·  ") }).join("\n")
  }
}
