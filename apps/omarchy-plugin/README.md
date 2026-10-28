# Durable Pi for the Omarchy bar

An [Omarchy](https://omarchy.org) shell plugin (`n4s5ti.durable-pi`): a bar icon for the Durable Pi hub, with the web UI one click away.

| Action | Does |
|---|---|
| Left click | Opens the hub web UI (`http://127.0.0.1:4781/`) as a web app |
| Right click | Opens the status panel: every device, its status, its sessions and which are busy |
| Middle click | Refreshes now |

The icon is dim while the hub is down, takes the theme accent while any session is busy, and turns urgent when the hub is up but a device is not online. It polls the hub's `GET /api/network` every 5 seconds while the bar is visible. That route needs no token (the hub holds the device tokens and only answers its own host), so the plugin never reads a token.

## Install

Needs a running hub (`just hub start`).

```bash
just omarchy install          # copy to ~/.config/omarchy/plugins/n4s5ti.durable-pi and add it to the bar's right section
just omarchy install centerEnd
just omarchy uninstall
```

Settings live on the widget's entry in `~/.config/omarchy/shell.json`: `hubUrl` (default `http://127.0.0.1:4781/`) and `pollSeconds` (default `5`).

## IPC

```bash
omarchy-shell n4s5ti.durable-pi toggle        # the panel on the focused monitor
omarchy-shell n4s5ti.durable-pi openHub
omarchy-shell n4s5ti.durable-pi refresh
omarchy-shell n4s5ti.durable-pi diagnostics   # JSON: hub state and each bar instance's screen and panel
```

Editing the QML and running `just omarchy install` again reloads the widget, but the shell keeps the first IPC handler it registered. After changing the IPC functions, run `omarchy restart shell`.
