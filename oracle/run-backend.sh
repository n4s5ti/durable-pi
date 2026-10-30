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
# The oracle has bash and uses the real CLIs, not wrappers. ~/.dpi-oracle/bin holds symlinks: pip3r -> a clean build of
# pip3r `dev` (with the NULL-content index fix; the user's own pip3r stays on his checkout) and gitnexus -> a pinned
# GitNexus 1.6.12 install. Both shebangs are `env node`, so node 24 goes first.
export PATH="$HOME/.dpi-oracle/bin:$HOME/.nvm/versions/node/v24.16.0/bin:$PATH"
cd "$here/apps/dpi-backend"
# The runner starts Claude cloud sessions through the real claude binary (mise's command wrapper fails in a pty).
export DPI_CLAUDE_BIN="${DPI_CLAUDE_BIN:-$HOME/.local/share/mise/installs/claude/latest/claude}"
# Model provider keys (GROQ_API_KEY, DEEPSEEK_API_KEY, ...) come from Bitwarden Secrets Manager, injected by `bws run`
# into this process only (bws strips its own token from the child). AGENTMAIL_API_KEY lives in the same project but is
# not a provider key, so it is removed before the backend (and the oracle's bash) can see it.
exec env BWS_ACCESS_TOKEN="$(cat "$HOME/.config/bws/access-token")" \
  bws run --project-id b7e80205-45d5-4c9b-bfff-b4ef00e284e9 -- \
  "exec env -u AGENTMAIL_API_KEY \"$HOME/.nvm/versions/node/v24.16.0/bin/node\" node_modules/.bin/tsx src/main.ts"
