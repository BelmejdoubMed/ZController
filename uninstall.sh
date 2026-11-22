#!/usr/bin/env bash
set -euo pipefail

for UUID in "zctrl@assaciro.github.io" "zcontroller@belmejdoubmed.github.io" "zcontroller@zcontroller.local"; do
    EXT_DIR="${HOME}/.local/share/gnome-shell/extensions/${UUID}"
    if [[ -d "${EXT_DIR}" ]] || gnome-extensions info "${UUID}" >/dev/null 2>&1; then
        echo "Disabling and removing ${UUID}..."
        gnome-extensions disable "${UUID}" 2>/dev/null || true
        gnome-extensions uninstall "${UUID}" 2>/dev/null || true
        rm -rf "${EXT_DIR}"
    fi
done

echo "ZCtrl has been uninstalled."
