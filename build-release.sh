#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_VERSION="$(python3 -c "import json, sys; print(json.load(open(sys.argv[1]))['version-name'])" "${SCRIPT_DIR}/metadata.json")"

UUID="zctrl@assaciro.github.io"
PKG_NAME="gnome-shell-extension-zctrl"
VERSION="${1:-${DEFAULT_VERSION}}"
MAINTAINER="Assaciro <BelmejdoubMed@gmail.com>"
HOMEPAGE="https://github.com/BelmejdoubMed/ZController"

DIST_DIR="${SCRIPT_DIR}/dist"
STAGE_DIR="$(mktemp -d)"

cleanup() {
    rm -rf "${STAGE_DIR}"
}
trap cleanup EXIT

mkdir -p "${DIST_DIR}"
rm -f "${DIST_DIR}"/*.zip "${DIST_DIR}"/*.deb "${DIST_DIR}/SHA256SUMS"

# ---------------------------------------------------------------------------
# 1. Build clean extensions.gnome.org submission bundle (.zip)
# ---------------------------------------------------------------------------
echo "Building extensions.gnome.org zip bundle (ZCtrl v${VERSION})..."
EGO_ZIP="${DIST_DIR}/${UUID}.shell-extension.zip"

gnome-extensions pack "${SCRIPT_DIR}" \
    --force \
    --out-dir="${DIST_DIR}" \
    --schema="schemas/org.gnome.shell.extensions.zctrl.gschema.xml" \
    --extra-source=themeConfig.js \
    --extra-source=mprisManager.js \
    --extra-source=audioManager.js \
    --extra-source=localPlayerClient.js \
    --extra-source=zctrl-player-service \
    --extra-source=mediaController.js \
    --extra-source=shortcutManager.js \
    --extra-source=shortcutsDialog.js \
    --extra-source=aboutDialog.js \
    --extra-source=waveVisualizer.js \
    --extra-source=panelIndicator.js \
    --extra-source=LICENSE

echo "Created EGO bundle: ${EGO_ZIP}"

# ---------------------------------------------------------------------------
# 2. Build Ubuntu / Debian installer package (.deb)
# ---------------------------------------------------------------------------
echo "Building Ubuntu .deb package (${PKG_NAME}_${VERSION}_all.deb)..."

DEB_ROOT="${STAGE_DIR}/${PKG_NAME}_${VERSION}_all"
EXT_TARGET="${DEB_ROOT}/usr/share/gnome-shell/extensions/${UUID}"
SCHEMA_TARGET="${DEB_ROOT}/usr/share/glib-2.0/schemas"
DOC_TARGET="${DEB_ROOT}/usr/share/doc/${PKG_NAME}"

mkdir -p "${DEB_ROOT}/DEBIAN" "${EXT_TARGET}" "${SCHEMA_TARGET}" "${DOC_TARGET}"

# Extract the exact clean EGO bundle into the system extension path
unzip -q "${EGO_ZIP}" -d "${EXT_TARGET}"
glib-compile-schemas "${EXT_TARGET}/schemas"

# Also install GSettings XML in system glib schemas directory for system triggers
cp "${SCRIPT_DIR}/schemas/org.gnome.shell.extensions.zctrl.gschema.xml" "${SCHEMA_TARGET}/"

# Debian copyright file
cat <<EOF > "${DOC_TARGET}/copyright"
Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/
Upstream-Name: ZCtrl
Source: ${HOMEPAGE}

Files: *
Copyright: 2026 ${MAINTAINER}
License: GPL-3.0-or-later
 This program is free software: you can redistribute it and/or modify
 it under the terms of the GNU General Public License as published by
 the Free Software Foundation, either version 3 of the License, or
 (at your option) any later version.
 .
 On Debian and Ubuntu systems, the complete text of the GNU General
 Public License version 3 can be found in "/usr/share/common-licenses/GPL-3".
EOF

# Normalize permissions to standard Debian policy (0755 dirs, 0644 files)
chmod 0755 "${DEB_ROOT}"
find "${DEB_ROOT}/usr" -type d -exec chmod 0755 {} +
find "${DEB_ROOT}/usr" -type f -exec chmod 0644 {} +

# Calculate installed size in KiB
INSTALLED_SIZE="$(du -sk "${DEB_ROOT}/usr" | cut -f1)"

cat <<EOF > "${DEB_ROOT}/DEBIAN/control"
Package: ${PKG_NAME}
Version: ${VERSION}
Section: gnome
Priority: optional
Architecture: all
Installed-Size: ${INSTALLED_SIZE}
Depends: gnome-shell (>= 46), gnome-shell (<< 48)
Recommends: pipewire-bin, zenity, gstreamer1.0-plugins-good, gstreamer1.0-plugins-ugly | gstreamer1.0-libav
Provides: gnome-shell-extension-zcontroller
Conflicts: gnome-shell-extension-zcontroller
Replaces: gnome-shell-extension-zcontroller
Maintainer: ${MAINTAINER}
Homepage: ${HOMEPAGE}
Description: Universal media controller, local player & live sound waves for GNOME
 ZCtrl by Assaciro brings a sleek, frosted-glass universal media and audio
 controller directly to your Ubuntu top bar or bottom dock.
 .
 Control any MPRIS2 player (Chrome, YouTube Music, Spotify, VLC, Firefox),
 manage individual PipeWire/PulseAudio application streams, scrub tracks right
 from the interactive bar music timeline, play local MP3/FLAC/OGG/WAV folders
 with an isolated GStreamer engine, visualize real-time PipeWire Sound Waves,
 and bind customizable global keyboard shortcuts across 5 handcrafted themes.
EOF

cat <<'EOF' > "${DEB_ROOT}/DEBIAN/postinst"
#!/bin/sh
set -e
if [ "$1" = "configure" ] && command -v glib-compile-schemas >/dev/null 2>&1; then
    glib-compile-schemas /usr/share/glib-2.0/schemas || true
fi
exit 0
EOF

cat <<'EOF' > "${DEB_ROOT}/DEBIAN/postrm"
#!/bin/sh
set -e
if [ "$1" = "remove" ] || [ "$1" = "purge" ]; then
    if command -v glib-compile-schemas >/dev/null 2>&1; then
        glib-compile-schemas /usr/share/glib-2.0/schemas || true
    fi
fi
exit 0
EOF

chmod 0755 "${DEB_ROOT}/DEBIAN/postinst" "${DEB_ROOT}/DEBIAN/postrm"

DEB_OUT="${DIST_DIR}/${PKG_NAME}_${VERSION}_all.deb"
dpkg-deb --root-owner-group --build "${DEB_ROOT}" "${DEB_OUT}"

(cd "${DIST_DIR}" && sha256sum "$(basename "${EGO_ZIP}")" "$(basename "${DEB_OUT}")" > SHA256SUMS)

echo ""
echo "Release artifacts ready in ${DIST_DIR}:"
ls -lh "${EGO_ZIP}" "${DEB_OUT}" "${DIST_DIR}/SHA256SUMS"
