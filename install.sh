#!/usr/bin/env bash
set -euo pipefail

UUID="zctrl@assaciro.github.io"
LEGACY_UUIDS=("zcontroller@belmejdoubmed.github.io" "zcontroller@zcontroller.local")
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_DIR="${HOME}/.local/share/gnome-shell/extensions/${UUID}"
BUILD_DIR="$(mktemp -d)"

cleanup() {
    rm -rf "${BUILD_DIR}"
}
trap cleanup EXIT

# Migrate saved settings once from previous schema path if new path has no settings yet
if command -v dconf >/dev/null 2>&1; then
    NEW_DUMP="$(dconf dump /org/gnome/shell/extensions/zctrl/ 2>/dev/null || true)"
    OLD_DUMP="$(dconf dump /org/gnome/shell/extensions/zcontroller/ 2>/dev/null || true)"
    if [[ -z "${NEW_DUMP}" && -n "${OLD_DUMP}" ]]; then
        echo "Migrating existing ZCtrl preferences..."
        printf '%s\n' "${OLD_DUMP}" | dconf load /org/gnome/shell/extensions/zctrl/ || true
    fi
fi

# Clean up any legacy UUID installations so there are no duplicate controllers
for LEGACY_UUID in "${LEGACY_UUIDS[@]}"; do
    if [[ -d "${HOME}/.local/share/gnome-shell/extensions/${LEGACY_UUID}" ]] || gnome-extensions info "${LEGACY_UUID}" >/dev/null 2>&1; then
        echo "Removing previous installation (${LEGACY_UUID})..."
        gnome-extensions disable "${LEGACY_UUID}" 2>/dev/null || true
        gnome-extensions uninstall "${LEGACY_UUID}" 2>/dev/null || true
        rm -rf "${HOME}/.local/share/gnome-shell/extensions/${LEGACY_UUID}"
    fi
done

EXTRA_ARGS=(
    --extra-source=themeConfig.js
    --extra-source=mprisManager.js
    --extra-source=audioManager.js
    --extra-source=localPlayerClient.js
    --extra-source=zctrl-player-service
    --extra-source=mediaController.js
    --extra-source=shortcutManager.js
    --extra-source=shortcutsDialog.js
    --extra-source=aboutDialog.js
    --extra-source=waveVisualizer.js
    --extra-source=panelIndicator.js
)
if [[ -f "${SCRIPT_DIR}/LICENSE" ]]; then
    EXTRA_ARGS+=(--extra-source=LICENSE)
fi

echo "Packing ZCtrl GNOME Shell extension (${UUID})..."
gnome-extensions pack "${SCRIPT_DIR}" \
    --force \
    --out-dir="${BUILD_DIR}" \
    --schema="schemas/org.gnome.shell.extensions.zctrl.gschema.xml" \
    "${EXTRA_ARGS[@]}"

BUNDLE="${BUILD_DIR}/${UUID}.shell-extension.zip"
if [[ ! -f "${BUNDLE}" ]]; then
    echo "Error: Failed to create extension bundle." >&2
    exit 1
fi

echo "Installing to ${EXT_DIR}..."
gnome-extensions install --force "${BUNDLE}"

# Ensure user extensions are enabled in GNOME Shell
gsettings set org.gnome.shell disable-user-extensions false || true

# Clean legacy UUIDs from enabled-extensions if still listed
CURRENT="$(gsettings get org.gnome.shell enabled-extensions)"
for LEGACY_UUID in "${LEGACY_UUIDS[@]}"; do
    if [[ "${CURRENT}" == *"${LEGACY_UUID}"* ]]; then
        CURRENT="$(python3 -c "import ast, sys; raw = sys.argv[1].replace('@as ', ''); items = [x for x in ast.literal_eval(raw) if x != sys.argv[2]]; print(repr(items))" "${CURRENT}" "${LEGACY_UUID}")"
        gsettings set org.gnome.shell enabled-extensions "${CURRENT}" || true
    fi
done

if gnome-extensions enable "${UUID}" 2>/dev/null; then
    echo "ZCtrl installed and enabled!"
else
    CURRENT="$(gsettings get org.gnome.shell enabled-extensions)"
    if [[ "${CURRENT}" != *"${UUID}"* ]]; then
        UPDATED="$(python3 -c "import ast, sys; raw = sys.argv[1].replace('@as ', ''); items = ast.literal_eval(raw); items.append(sys.argv[2]); print(repr(items))" "${CURRENT}" "${UUID}")"
        gsettings set org.gnome.shell enabled-extensions "${UPDATED}"
    fi
    echo "ZCtrl installed and registered in GNOME Shell enabled-extensions."
fi

if [[ "${XDG_SESSION_TYPE:-}" == "x11" ]]; then
    echo "Tip: Press Alt+F2, type 'r', and press Enter to reload GNOME Shell with the updated extension."
else
    echo "Tip: Log out and log back in to load the updated extension on Wayland."
fi
