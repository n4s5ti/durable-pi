# Vendored: omarchy-canvas

These files are copied unchanged from [paulomtts/omarchy-canvas](https://github.com/paulomtts/omarchy-canvas)
at commit `6302468` (2026-09-24): `Canvas.qml`, `CanvasNode.qml`, `CanvasEdges.qml`,
`CanvasControls.qml`, `camera.js`, `layout.js`, `positions.js`.

Omarchy plugins cannot import from another plugin and reject symlinks, so the upstream README asks
consumers to vendor these files. Upstream declares the MIT license in its `manifest.json`
(`"license": "MIT"`, author paulomtts); the repository ships no separate license file.

To update: copy the same files from a newer upstream commit and change the commit above. Do not
edit them here; `ReadOnlyCanvas.qml` in the plugin root is where this plugin adapts them.
