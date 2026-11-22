# ZCtrl

**Universal Media Controller, Isolated Local Music Player & Live PipeWire Sound Waves for Ubuntu / GNOME**

*Created by **Assaciro*** · **v1.0.0** · **GNU GPL v3.0**

---

ZCtrl transforms your Ubuntu top bar or bottom dock into a sleek, responsive audio command center. Control any media player or browser tab, mix individual PipeWire audio streams, play your local music library with a dedicated out-of-process audio engine, watch real-time PipeWire Sound Waves react to your music, and trigger everything from anywhere with customizable global keyboard shortcuts.

---

## Features

- **Universal Media & Audio Control**
  - Seamless MPRIS2 integration for Chrome, YouTube Music, Firefox, Spotify, VLC, Rhythmbox, and more.
  - Per-application PipeWire / PulseAudio audio stream control and master output volume management.
  - Smart auto-targeting with one-click manual source selection and inline seek bar with cover artwork.
- **Built-In Isolated Local Music Player**
  - Browse folders or pick individual audio files (`.mp3`, `.flac`, `.wav`, `.ogg`, `.opus`, `.m4a`, `.aac`, `.wma`, `.aiff`) with embedded ID3/Vorbis/MP4 metadata and album art extraction.
  - Runs in a dedicated out-of-process GStreamer daemon (`zctrl-player-service`) so GNOME Shell stays lightweight and crash-isolated.
  - Includes shuffle, repeat (`Off` / `All` / `One`), scrollable playlist, and automatic library persistence.
- **Interactive Bar Music Timeline**
  - Slim, accent-colored progress bar directly underneath the bar buttons and sound waves on both the top bar and bottom dock.
  - Click or drag right on the bar to scrub/seek with live timestamp preview tooltips (`1:42 / 3:50`), and toggle it on or off anytime in **Position & Bar**.
- **Real-Time PipeWire Sound Waves**
  - Live FFT & oscilloscope visualizer powered by PipeWire default-sink monitoring (`pw-record`).
  - 3 visual styles (**Waves**, **Line**, **Bars**), 3 widths (**S / M / L**), adjustable sensitivity, and 8 curated color palettes.
- **Customizable Global Keyboard Shortcuts**
  - Dedicated floating **Shortcuts** popup — all shortcuts start **OFF** by default so nothing conflicts with your workflow.
  - Activate only the shortcuts you want (including `Alt + Shift + P` for Play/Pause, Next, Previous, Stop, Seek ±10s, Volume Up/Down, Mute, Toggle Sound Waves, Open ZCtrl, and Local Music Play/Pause).
  - Click any key badge to record any custom shortcut live with built-in conflict detection and 1-click reset.
- **Flexible Placement & 5 Handcrafted Themes**
  - Place ZCtrl on the **Top Bar** (next to Date), on the **Bottom Bar** (dock-aligned), or **Both** simultaneously.
  - Choose from **Dark**, **Glass**, **Transparent** (GPU frosted backdrop blur), **Light**, and **OLED**, paired with 7 accent colors.

---

## Requirements

- **Ubuntu 24.04 LTS** (or any Linux distribution running **GNOME Shell 46**)
- Optional recommended packages (pre-installed on standard Ubuntu Desktop):
  - `pipewire-bin` (for live Sound Waves)
  - `zenity` (for native folder/file music pickers)
  - `gstreamer1.0-plugins-good` & `gstreamer1.0-plugins-ugly` or `gstreamer1.0-libav` (for MP3/AAC/FLAC playback)

---

## Installation

### Option 1: Install Ubuntu `.deb` Package (Recommended)

Download `gnome-shell-extension-zctrl_1.0.0_all.deb` from the Releases page and run:

```bash
sudo apt install ./gnome-shell-extension-zctrl_1.0.0_all.deb
gnome-extensions enable zctrl@assaciro.github.io
```

Then reload GNOME Shell (`Alt + F2` → `r` → `Enter` on X11, or log out and back in on Wayland).

### Option 2: Install from Source

```bash
git clone https://github.com/BelmejdoubMed/ZController.git
cd ZController
./install.sh
```

### Uninstall

```bash
./uninstall.sh
```

---

## Building Release Packages

To build both the **extensions.gnome.org** `.zip` bundle and the Ubuntu `.deb` package along with `SHA256SUMS`:

```bash
./build-release.sh
```

Artifacts are generated in `dist/`:
- `zctrl@assaciro.github.io.shell-extension.zip`
- `gnome-shell-extension-zctrl_1.0.0_all.deb`
- `SHA256SUMS`

---

## Versioning & Changelog

### v1.0.0
- Initial production release of **ZCtrl** by **Assaciro**.
- Universal MPRIS2 & PipeWire stream controller with Top Bar, Bottom Bar, and dual placement modes.
- Interactive accent-colored mini music timeline directly beneath the bar buttons and sound waves with click/drag seek and live timestamp preview.
- Out-of-process GStreamer local music player with metadata/artwork extraction, shuffle, and repeat.
- Real-time PipeWire Sound Waves visualizer with 3 styles and 8 palettes.
- Dedicated floating Keyboard Shortcuts manager with per-action activation and live key recording.
- Dedicated About dialog with version info and 5 GPU-frosted themes with 7 accent colors.

---

## License

ZCtrl is free software licensed under the **GNU General Public License v3.0 (GPL-3.0-or-later)**. See [`LICENSE`](LICENSE) for details.

**Created by Assaciro**
