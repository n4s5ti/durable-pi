import QtQuick
import qs.Commons
import qs.Ui

// Floating controls for a Canvas, reusable by any plugin that imports it.
// Drop it as a SIBLING declared after the canvas (or in the same parent): it
// fills its parent and floats above the canvas. It never intercepts pointer
// input outside its own two small groups -- there is no full-size MouseArea and
// the root Item takes no events -- so pan, wheel and pinch reach the canvas.
//
//   Local.Canvas { id: canvas; anchors.fill: parent }
//   Local.CanvasControls { canvas: canvas }
//
// It drives the canvas's documented camera API and `culling`, and never writes
// to the caller's nodes or edges. A null `canvas` disables it: every control
// is a no-op.
Item {
  id: root
  objectName: "canvasControls"

  // The Local.Canvas to drive.
  property var canvas: null
  // Show the lower-left culling switch. Off for consumers that manage culling.
  property bool showCulling: true
  // Factor of one zoom button press: in zooms by zoomStep, out by 1/zoomStep.
  property real zoomStep: 1.25

  anchors.fill: parent
  z: 1

  // Lower left: culling switch, plain label, and a "?" help icon.
  Row {
    id: cullingGroup
    objectName: "cullingGroup"
    visible: root.showCulling
    anchors.left: parent.left
    anchors.bottom: parent.bottom
    anchors.margins: Style.space(8)
    spacing: Style.space(8)

    ToggleSwitch {
      objectName: "cullingToggle"
      anchors.verticalCenter: parent.verticalCenter
      enabled: root.canvas !== null
      checked: root.canvas ? root.canvas.culling : false
      onToggled: if (root.canvas) root.canvas.culling = !root.canvas.culling
    }

    Text {
      objectName: "cullingLabel"
      anchors.verticalCenter: parent.verticalCenter
      textFormat: Text.PlainText
      text: "Culling"
      color: Color.foreground
      font.pixelSize: Style.font.body
    }

    Item {
      id: cullingHelp
      objectName: "cullingHelp"
      anchors.verticalCenter: parent.verticalCenter
      width: Style.space(16)
      height: Style.space(16)

      Text {
        anchors.centerIn: parent
        textFormat: Text.PlainText
        text: "?"
        color: Color.foreground
        font.pixelSize: Style.font.caption
      }

      MouseArea {
        id: helpHover
        anchors.fill: parent
        hoverEnabled: true
      }

      PanelToolTip {
        objectName: "cullingHelpTip"
        visible: helpHover.containsMouse
        text: "Only creates nodes near the viewport. Matters for large graphs."
      }
    }
  }

  // Lower right: [ - ] [ organize ] [ fit ] [ + ], all icon-only (Font Awesome
  // glyphs, like the Omarchy bar widgets) and one shared square size, so the
  // four cannot drift apart.
  Row {
    id: zoomGroup
    objectName: "zoomGroup"
    anchors.right: parent.right
    anchors.bottom: parent.bottom
    anchors.margins: Style.space(8)
    spacing: Style.space(4)

    readonly property real controlSize: Style.space(32)

    Button {
      objectName: "zoomOutButton"
      width: zoomGroup.controlSize
      height: zoomGroup.controlSize
      iconText: ""
      tooltipText: "Zoom out"
      bordered: true
      enabled: root.canvas !== null
      onClicked: if (root.canvas) root.canvas.zoomBy(1 / root.zoomStep)
    }

    Button {
      objectName: "organizeButton"
      width: zoomGroup.controlSize
      height: zoomGroup.controlSize
      iconText: ""
      tooltipText: "Organize nodes"
      bordered: true
      enabled: root.canvas !== null
      onClicked: if (root.canvas) root.canvas.organize()
    }

    Button {
      objectName: "fitAllButton"
      width: zoomGroup.controlSize
      height: zoomGroup.controlSize
      iconText: ""
      tooltipText: "Fit all"
      bordered: true
      enabled: root.canvas !== null
      onClicked: if (root.canvas) root.canvas.fitAll()
    }

    Button {
      objectName: "zoomInButton"
      width: zoomGroup.controlSize
      height: zoomGroup.controlSize
      iconText: ""
      tooltipText: "Zoom in"
      bordered: true
      enabled: root.canvas !== null
      onClicked: if (root.canvas) root.canvas.zoomBy(root.zoomStep)
    }
  }
}
