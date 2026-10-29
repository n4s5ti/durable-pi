#!/usr/bin/env bash
# The oracle device: a second dpi-backend from this worktree on 127.0.0.1:4790 with its own data in ~/.dpi-oracle.
# The live device (~/.dpi, :4780) is never touched. OPENROUTER_API_KEY is read from the live device's env file into
# this process's environment only; it is not copied to disk and never appears in argv.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
export DPI_HOME="$HOME/.dpi-oracle"
if [ -z "${OPENROUTER_API_KEY:-}" ]; then
  OPENROUTER_API_KEY="$(sed -n 's/^OPENROUTER_API_KEY=//p' "$HOME/.dpi/backend.env" | tail -1)"
  export OPENROUTER_API_KEY
fi
[ -n "$OPENROUTER_API_KEY" ] || { echo "OPENROUTER_API_KEY not found" >&2; exit 1; }
cd "$here/apps/dpi-backend"
exec "$HOME/.nvm/versions/node/v24.16.0/bin/node" node_modules/.bin/tsx src/main.ts
