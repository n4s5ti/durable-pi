import QtQuick
import QtQuick.Window
import Quickshell
import Quickshell.Hyprland
import qs.Commons
import qs.Commons as Commons
import qs.Ui

// Bar icon for the Durable Pi hub. It polls the hub's GET /api/network (no token: the hub keeps them) and colors
// itself by what it finds. Left click opens the hub web UI as a web app, right click the status panel.
BarWidget {
  id: root
  moduleName: "n4s5ti.durable-pi"

  readonly property int maxDevices: 20
  readonly property int maxSessions: 12
  readonly property int maxText: 80
  readonly property int maxResponse: 2 * 1024 * 1024

  readonly property string hubUrl: {
    var match = String(setting("hubUrl", "http://127.0.0.1:4781/")).match(/^(https?:\/\/[^\/?#]+)/i)
    return (match ? match[1] : "http://127.0.0.1:4781") + "/"
  }

  // { ok, devices: [{ id, name, status, error, sessions: [{ name, busy, agents }], moreSessions }] }
  property var network: ({ ok: false, loaded: false, devices: [] })
  readonly property var devices: network.devices
  readonly property int onlineCount: devices.filter(function(d) { return d.status === "online" }).length
  readonly property int sessionCount: devices.reduce(function(n, d) { return n + d.sessions.length + d.moreSessions }, 0)
  readonly property int busyCount: devices.reduce(function(n, d) {
    return n + d.sessions.filter(function(s) { return s.busy }).length
  }, 0)
  readonly property bool deviceTrouble: network.ok && onlineCount < devices.length

  readonly property color indicatorColor: !network.ok
    ? (bar ? bar.barForeground : Commons.Color.foreground)
    : busyCount > 0 ? Commons.Color.accent
    : deviceTrouble ? (bar ? bar.urgent : Commons.Color.urgent)
    : (bar ? bar.barForeground : Commons.Color.foreground)
  readonly property string tooltipText: network.ok
    ? strings.t("tooltip.up").arg(onlineCount).arg(devices.length).arg(sessionCount).arg(busyCount)
    : strings.t("tooltip.down")

  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false
  readonly property bool popoutSwitchClosing: panelLoader.item ? panelLoader.item.popoutSwitchClosing === true : false

  Commons.Translations { id: strings; directory: Qt.resolvedUrl("i18n") }

  function clip(value) {
    var text = String(value === undefined || value === null ? "" : value)
    return text.length > maxText ? text.slice(0, maxText - 1) + "…" : text
  }

  // Bound and shape the hub's answer; everything in it is untrusted display text.
  function parseNetwork(text) {
    var body = JSON.parse(text)
    var list = Array.isArray(body && body.devices) ? body.devices.slice(0, maxDevices) : []
    return {
      ok: true,
      loaded: true,
      devices: list.map(function(d) {
        var sessions = d && d.tree && Array.isArray(d.tree.sessions) ? d.tree.sessions : []
        return {
          id: clip(d.id),
          name: clip(d.name || d.id),
          status: clip(d.status),
          error: clip(d.error),
          moreSessions: Math.max(0, sessions.length - maxSessions),
          sessions: sessions.slice(0, maxSessions).map(function(s) {
            var agents = Array.isArray(s.agents) ? s.agents : []
            return {
              name: clip(s.name || s.id),
              busy: s.busy === true || agents.some(function(a) { return a.busy === true || Number(a.background) > 0 }),
              agents: agents.length,
            }
          }),
        }
      }),
    }
  }

  function refresh() {
    var request = new XMLHttpRequest()
    request.timeout = 2000
    request.onreadystatechange = function() {
      if (request.readyState !== XMLHttpRequest.DONE) return
      var next = { ok: false, loaded: true, devices: [] }
      if (request.status >= 200 && request.status < 300 && request.responseText.length <= maxResponse) {
        try {
          next = parseNetwork(request.responseText)
        } catch (error) {
          console.warn("[n4s5ti.durable-pi] bad /api/network answer:", error)
        }
      }
      root.network = next
      if (button.tooltipHovered && bar) bar.showTooltip(button, tooltipText)
    }
    request.open("GET", hubUrl + "api/network")
    request.send()
  }

  // The panel window follows the bar window it is anchored to, so its screen is this instance's.
  readonly property string screenName: panelLoader.item ? panelLoader.item.screenName : ""

  // An IPC target routes to one bar instance; run `method` on the one on the focused monitor instead.
  function onFocusedScreen(method) {
    var monitor = Hyprland.focusedMonitor
    var name = monitor ? String(monitor.name || "") : ""
    var items = bar && typeof bar.moduleWidgets === "function" ? bar.moduleWidgets(moduleName) : [root]
    var target = items.find(function(item) { return item && item.screenName === name }) || root
    target[method]()
  }

  // For `omarchy-shell n4s5ti.durable-pi diagnostics`: what every bar instance sees.
  function diagnostics() {
    var items = bar && typeof bar.moduleWidgets === "function" ? bar.moduleWidgets(moduleName) : [root]
    return JSON.stringify({
      hubOk: network.ok,
      devices: devices.length,
      sessions: sessionCount,
      busy: busyCount,
      focused: Hyprland.focusedMonitor ? String(Hyprland.focusedMonitor.name) : "",
      instances: items.map(function(item) {
        return { screen: item.screenName, panelLoaded: !!item.panelItem, opened: item.opened }
      }),
    })
  }
  readonly property var panelItem: panelLoader.item

  function openHub() { Quickshell.execDetached(["omarchy-launch-webapp", hubUrl]) }
  function open() { if (panelLoader.item) panelLoader.item.open() }
  function close() { if (panelLoader.item) panelLoader.item.close() }
  function toggle() { if (panelLoader.item) panelLoader.item.toggle() }
  function closeForPopoutSwitch() {
    if (panelLoader.item && panelLoader.item.closeForPopoutSwitch) panelLoader.item.closeForPopoutSwitch()
    else root.close()
  }

  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    target.bar = root.bar
    target.anchorItem = button
    target.hostWidget = root
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onBarChanged: injectPanel()

  Timer {
    interval: Math.max(2, Number(root.setting("pollSeconds", "5")) || 5) * 1000
    repeat: true
    triggeredOnStart: true
    running: root.Window.window ? root.Window.window.visible : false
    onTriggered: root.refresh()
  }

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  ShellIpc {
    target: "n4s5ti.durable-pi"

    function refresh(): void { root.broadcast("refresh") }
    function openHub(): void { root.openHub() }
    function open(): void { root.onFocusedScreen("open") }
    function close(): void { root.broadcast("close") }
    function toggle(): void { root.onFocusedScreen("toggle") }
    function diagnostics(): string { return root.diagnostics() }
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: ""
    labelVisible: false
    hasVisualContent: true
    fixedWidth: 28
    fixedHeight: root.barSize
    tooltipText: root.tooltipText

    onPressed: function(mouseButton) {
      if (mouseButton === Qt.LeftButton) root.openHub()
      else if (mouseButton === Qt.RightButton) root.toggle()
      else if (mouseButton === Qt.MiddleButton) root.refresh()
    }

    Text {
      anchors.centerIn: parent
      textFormat: Text.PlainText
      text: "󰚩"
      color: root.indicatorColor
      opacity: root.network.ok ? 1 : 0.4
      font.family: button.fontFamily
      font.pixelSize: 14
    }
  }
}
