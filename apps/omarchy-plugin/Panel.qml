import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import qs.Commons
import qs.Commons as Commons
import qs.Ui

// Status panel: every device the hub knows, its sessions and which of them are busy, as a list or as
// the live read-only canvas. The bar widget owns the data.
Panel {
  id: root
  moduleName: "n4s5ti.durable-pi"
  manageIpc: false

  property var anchorItem: null
  property var hostWidget: null
  readonly property var barIdentity: hostWidget || root
  readonly property string screenName: panel.screen ? String(panel.screen.name || "") : ""
  readonly property var network: hostWidget ? hostWidget.network : ({ ok: false, loaded: false, devices: [] })
  property bool canvasMode: false
  readonly property bool canvasStale: !!hostWidget && hostWidget.canvasState !== null && !hostWidget.canvasLive

  Commons.Translations { id: strings; directory: Qt.resolvedUrl("i18n") }

  function open() {
    if (hostWidget) hostWidget.refresh()
    root.controller.show()
    Qt.callLater(function() { if (root.opened) keyCatcher.forceActiveFocus() })
  }

  function switchPanel(direction) {
    if (root.bar && typeof root.bar.switchPanelFrom === "function") return root.bar.switchPanelFrom(root.barIdentity, direction)
    return false
  }

  function statusColor(status) {
    if (status === "online") return Commons.Color.accent
    if (status === "checking") return Commons.Color.muted
    return Commons.Color.urgent
  }

  component Label: Text {
    textFormat: Text.PlainText
    color: Commons.Color.foreground
    font.family: Style.font.family
    font.pixelSize: Style.font.body
    elide: Text.ElideRight
  }

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    centerOnBar: true
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(root.canvasMode ? 760 : 380))
    contentHeight: root.canvasMode
      ? panel.fittedContentHeight(Style.space(560), Style.space(560))
      : panel.fittedContentHeight(body.implicitHeight, Style.space(520))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onMoveRequested: function(dx, dy) {
        if (dy === 0) return
        var maximum = Math.max(0, scroll.contentHeight - scroll.height)
        scroll.contentY = Math.max(0, Math.min(maximum, scroll.contentY + dy * Style.space(64)))
      }
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }

      ColumnLayout {
        id: body
        anchors.fill: parent
        spacing: Style.space(10)

        RowLayout {
          Layout.fillWidth: true

          ColumnLayout {
            Layout.fillWidth: true
            spacing: Style.space(2)

            Label {
              Layout.fillWidth: true
              text: strings.t("title")
              font.pixelSize: Style.font.subtitle
              font.bold: true
            }

            Label {
              Layout.fillWidth: true
              text: !root.network.loaded ? strings.t("loading")
                : !root.network.ok ? strings.t("hubDown").arg(root.hostWidget ? root.hostWidget.hubUrl : "")
                : strings.t("summary").arg(root.hostWidget.onlineCount).arg(root.network.devices.length).arg(root.hostWidget.busyCount)
              color: root.network.ok ? Commons.Color.foreground : Commons.Color.muted
              font.pixelSize: Style.font.caption
            }

            Label {
              Layout.fillWidth: true
              visible: root.canvasMode && root.canvasStale
              text: strings.t("stale")
              color: Commons.Color.accent
              font.pixelSize: Style.font.caption
            }
          }

          Button {
            text: root.canvasMode ? strings.t("list") : strings.t("canvas")
            bordered: true
            enabled: root.canvasMode || (!!root.hostWidget && root.hostWidget.canvasState !== null)
            onClicked: root.canvasMode = !root.canvasMode
          }

          Button {
            text: strings.t("close")
            bordered: true
            onClicked: root.close()
          }
        }

        RowLayout {
          Layout.fillWidth: true
          spacing: Style.space(6)

          Button {
            Layout.fillWidth: true
            text: strings.t("openHub")
            bordered: true
            onClicked: {
              if (root.hostWidget) root.hostWidget.openHub()
              root.close()
            }
          }

          Button {
            text: strings.t("refresh")
            bordered: true
            onClicked: if (root.hostWidget) root.hostWidget.refresh()
          }
        }

        PanelSeparator { Layout.fillWidth: true }

        Loader {
          Layout.fillWidth: true
          Layout.fillHeight: true
          visible: root.canvasMode
          active: root.canvasMode && root.opened
          sourceComponent: ReadOnlyCanvas {
            canvasState: root.hostWidget ? root.hostWidget.canvasState : null
            stale: root.canvasStale
          }
        }

        Flickable {
          id: scroll
          visible: !root.canvasMode
          Layout.fillWidth: true
          Layout.fillHeight: true
          Layout.preferredHeight: list.implicitHeight
          clip: true
          contentWidth: width
          contentHeight: list.implicitHeight
          boundsBehavior: Flickable.StopAtBounds
          ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

          Column {
            id: list
            width: scroll.width
            spacing: Style.space(12)

            Label {
              visible: root.network.loaded && !root.network.ok
              width: parent.width
              text: strings.t("hubDownHint")
              color: Commons.Color.muted
            }

            Label {
              visible: root.network.ok && root.network.devices.length === 0
              width: parent.width
              text: strings.t("noDevices")
              color: Commons.Color.muted
            }

            Repeater {
              model: root.network.devices

              Column {
                required property var modelData
                width: list.width
                spacing: Style.space(4)

                RowLayout {
                  width: parent.width
                  spacing: Style.space(6)

                  Rectangle {
                    implicitWidth: Style.space(8)
                    implicitHeight: Style.space(8)
                    radius: width / 2
                    color: root.statusColor(modelData.status)
                  }

                  Label {
                    Layout.fillWidth: true
                    text: modelData.name
                    font.bold: true
                  }

                  Label {
                    text: strings.t("status." + modelData.status, modelData.status)
                    color: root.statusColor(modelData.status)
                    font.pixelSize: Style.font.caption
                  }
                }

                Label {
                  visible: modelData.status !== "online" && modelData.error !== ""
                  width: parent.width
                  leftPadding: Style.space(14)
                  text: modelData.error
                  color: Commons.Color.muted
                  font.pixelSize: Style.font.caption
                  wrapMode: Text.Wrap
                  maximumLineCount: 2
                }

                Label {
                  visible: modelData.status === "online" && modelData.sessions.length === 0
                  leftPadding: Style.space(14)
                  text: strings.t("noSessions")
                  color: Commons.Color.muted
                  font.pixelSize: Style.font.caption
                }

                Repeater {
                  model: modelData.sessions

                  RowLayout {
                    required property var modelData
                    width: list.width
                    spacing: Style.space(6)

                    Label {
                      Layout.fillWidth: true
                      leftPadding: Style.space(14)
                      text: modelData.name
                    }

                    Label {
                      text: strings.tn("agents", modelData.agents).arg(Commons.I18n.formatNumber(modelData.agents))
                      color: Commons.Color.muted
                      font.pixelSize: Style.font.caption
                    }

                    Label {
                      text: modelData.busy ? strings.t("busy") : strings.t("idle")
                      color: modelData.busy ? Commons.Color.accent : Commons.Color.muted
                      font.pixelSize: Style.font.caption
                      font.bold: modelData.busy
                    }
                  }
                }

                Label {
                  visible: modelData.moreSessions > 0
                  leftPadding: Style.space(14)
                  text: strings.t("moreSessions").arg(modelData.moreSessions)
                  color: Commons.Color.muted
                  font.pixelSize: Style.font.caption
                }
              }
            }
          }
        }
      }
    }
  }
}
