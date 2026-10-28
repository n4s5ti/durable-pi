# The Omarchy bar plugin: hub status in the bar, the web UI one click away.

set shell := ["zsh", "-cu"]
set positional-arguments
set working-directory := "../../apps/omarchy-plugin"

id := "n4s5ti.durable-pi"
dest := env("HOME") / ".config/omarchy/plugins" / id

# List Omarchy plugin commands
[default]
default:
    @just --list omarchy

# Copy the plugin into ~/.config/omarchy/plugins and put it on the bar (again after edits: the shell reloads it)
install SECTION="right":
    omarchy plugin validate .
    mkdir -p {{ dest }}
    rsync -a --delete --exclude README.md ./ {{ dest }}/
    omarchy-shell shell rescanPlugins
    omarchy plugin enable {{ id }} --section "$1"

# Take the plugin off the bar and delete the installed copy
uninstall:
    -omarchy plugin disable {{ id }}
    rm -rf {{ dest }}
