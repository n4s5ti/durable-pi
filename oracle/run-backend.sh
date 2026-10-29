#!/usr/bin/env bash
# The oracle device: a second dpi-backend from this worktree on 127.0.0.1:4790 with its own data in ~/.dpi-oracle.
# The live device's data (~/.dpi/backend, :4780) is never touched. Models come from the live device's Claude
# subscription login, shared in place through DPI_AUTH_FILE (a copy would rotate its own refresh token and sign the
# live device out). OPENROUTER_API_KEY, when present, is read from the live env file into this process only.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
export DPI_HOME="$HOME/.dpi-oracle"
export DPI_AUTH_FILE="$HOME/.dpi/auth.json"
if [ -z "${OPENROUTER_API_KEY:-}" ]; then
  OPENROUTER_API_KEY="$(sed -n 's/^OPENROUTER_API_KEY=//p' "$HOME/.dpi/backend.env" | tail -1)"
  export OPENROUTER_API_KEY
fi
cd "$here/apps/dpi-backend"
exec "$HOME/.nvm/versions/node/v24.16.0/bin/node" node_modules/.bin/tsx src/main.ts
