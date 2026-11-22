import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';

import {
    ACCENT_COLOR_PRESETS,
    CONTROLLER_POSITIONS,
    CONTROLLER_THEMES,
    WAVE_COLOR_PRESETS,
    WAVE_STYLES,
    WAVE_WIDTH_PRESETS,
    getAccentPreset,
    getThemeMeta,
} from './themeConfig.js';
import {SoundWaveWidget} from './waveVisualizer.js';

const TOOLTIP_DELAY_MS = 350;
const SEEK_TICK_MS = 1000;
const BAR_TIMELINE_TICK_MS = 250;
const SCROLL_VOLUME_STEP = 0.05;
const MAX_ART_CACHE = 16;
const SENSITIVITY_MIN = 0.5;
const SENSITIVITY_MAX = 2.5;
const TRANSPARENT_CORNER_RADIUS = 18;

const ROUNDED_CLIP_DECL = `
uniform vec2 bounds;
uniform float radius;
`;

const ROUNDED_CLIP_CODE = `
vec2 p = (cogl_tex_coord_in[0].xy - 0.5) * bounds;
vec2 halfSize = max(bounds * 0.5 - vec2(radius), vec2(0.0));
vec2 q = abs(p) - halfSize;
float dist = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
float mask = 1.0 - smoothstep(-0.75, 0.75, dist);
cogl_color_out *= mask;
`;

const ZeroSizeContainer = GObject.registerClass(
class ZeroSizeContainer extends St.Widget {
    vfunc_get_preferred_width(_forHeight) {
        return [0, 0];
    }

    vfunc_get_preferred_height(_forWidth) {
        return [0, 0];
    }
});

const RoundedCornerClipEffect = GObject.registerClass(
class RoundedCornerClipEffect extends Shell.GLSLEffect {
    _init(params) {
        super._init(params);
        this._boundsLoc = this.get_uniform_location('bounds');
        this._radiusLoc = this.get_uniform_location('radius');
        this._w = 0;
        this._h = 0;
        this._r = 0;
        this.setBounds(356, 300, TRANSPARENT_CORNER_RADIUS);
    }

    vfunc_build_pipeline() {
        this.add_glsl_snippet(
            Shell.SnippetHook.FRAGMENT,
            ROUNDED_CLIP_DECL,
            ROUNDED_CLIP_CODE,
            false
        );
    }

    setBounds(width, height, radius) {
        const w = Math.max(1, width);
        const h = Math.max(1, height);
        const r = Math.min(radius, Math.min(w, h) * 0.5);
        if (this._w === w && this._h === h && this._r === r)
            return;
        this._w = w;
        this._h = h;
        this._r = r;
        if (this._boundsLoc >= 0)
            this.set_uniform_float(this._boundsLoc, 2, [w, h]);
        if (this._radiusLoc >= 0)
            this.set_uniform_float(this._radiusLoc, 1, [r]);
        this.queue_repaint();
    }
});

function formatTimeUs(us) {
    if (!Number.isFinite(us) || us <= 0)
        return '0:00';
    const totalSeconds = Math.floor(us / 1_000_000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const secStr = seconds < 10 ? `0${seconds}` : `${seconds}`;
    if (hours > 0) {
        const minStr = minutes < 10 ? `0${minutes}` : `${minutes}`;
        return `${hours}:${minStr}:${secStr}`;
    }
    return `${minutes}:${secStr}`;
}

function volumeIconName(volume, muted) {
    if (muted || volume <= 0.001)
        return 'audio-volume-muted-symbolic';
    if (volume < 0.34)
        return 'audio-volume-low-symbolic';
    if (volume < 0.67)
        return 'audio-volume-medium-symbolic';
    return 'audio-volume-high-symbolic';
}

function parseHexRgb(hex) {
    const clean = (hex || '#e95420').replace('#', '');
    const num = parseInt(clean, 16);
    if (Number.isNaN(num))
        return [0.91, 0.33, 0.13];
    return [
        ((num >> 16) & 255) / 255,
        ((num >> 8) & 255) / 255,
        (num & 255) / 255,
    ];
}

function drawCapsule(cr, x, y, w, h) {
    if (w <= 0 || h <= 0)
        return;
    const r = Math.min(h / 2, w / 2);
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, (3 * Math.PI) / 2);
    cr.closePath();
}

const BarTimelineWidget = GObject.registerClass({
    Signals: {
        'seek-requested': {param_types: [GObject.TYPE_DOUBLE]},
        'hover-changed': {param_types: [GObject.TYPE_DOUBLE, GObject.TYPE_DOUBLE]},
    },
}, class BarTimelineWidget extends St.DrawingArea {
    _init() {
        super._init({
            style_class: 'zcontroller-bar-timeline',
            reactive: true,
            track_hover: true,
            x_expand: true,
            accessible_name: 'Music Timeline (click or drag to seek)',
        });

        this._padX = 8;
        this._progress = 0;
        this._accentRgb = [0.91, 0.33, 0.13];
        this._lightSurface = false;
        this._seekable = true;

        this._hovered = false;
        this._hoverFraction = -1;
        this._dragging = false;
        this._dragFraction = 0;
        this._stageCaptureId = 0;
        this._destroyed = false;

        this.connect('enter-event', (_actor, event) => {
            this._hovered = true;
            this._updateHoverFromEvent(event);
            this.queue_repaint();
            return Clutter.EVENT_PROPAGATE;
        });

        this.connect('motion-event', (_actor, event) => {
            if (!this._dragging) {
                this._hovered = true;
                this._updateHoverFromEvent(event);
                this.queue_repaint();
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this.connect('leave-event', () => {
            this._hovered = false;
            if (!this._dragging) {
                this._hoverFraction = -1;
                this.emit('hover-changed', -1, -1);
            }
            this.queue_repaint();
            return Clutter.EVENT_PROPAGATE;
        });

        this.connect('button-press-event', (_actor, event) => {
            if (event.get_button() !== 1 || !this._seekable)
                return Clutter.EVENT_PROPAGATE;
            const {fraction, stageX} = this._fractionFromEvent(event);
            this._dragging = true;
            this._dragFraction = fraction;
            this._hoverFraction = fraction;
            this.emit('hover-changed', fraction, stageX);
            this.queue_repaint();
            this._startStageDragCapture();
            return Clutter.EVENT_STOP;
        });

        this.connect('destroy', () => this._onDestroy());
    }

    // Never widen the pill beyond the controls + waves row above
    vfunc_get_preferred_width(_forHeight) {
        return [0, 0];
    }

    get isDragging() {
        return this._dragging;
    }

    setProgress(fraction) {
        const clamped = Math.max(0, Math.min(1, Number(fraction) || 0));
        if (Math.abs(clamped - this._progress) < 0.001)
            return;
        this._progress = clamped;
        if (!this._dragging)
            this.queue_repaint();
    }

    setAccentHex(hex) {
        this._accentRgb = parseHexRgb(hex);
        this.queue_repaint();
    }

    setLightSurface(isLight) {
        const next = Boolean(isLight);
        if (this._lightSurface !== next) {
            this._lightSurface = next;
            this.queue_repaint();
        }
    }

    setSeekable(seekable) {
        const next = Boolean(seekable);
        if (this._seekable !== next) {
            this._seekable = next;
            if (!next && this._dragging)
                this._endStageDragCapture(false);
            this.queue_repaint();
        }
    }

    _fractionFromEvent(event) {
        const [stageX] = event.get_coords();
        const [ax] = this.get_transformed_position();
        const [aw] = this.get_transformed_size();
        const usableW = Math.max(1, aw - this._padX * 2);
        const rel = (stageX - (ax + this._padX)) / usableW;
        return {
            fraction: Math.max(0, Math.min(1, rel)),
            stageX,
        };
    }

    _updateHoverFromEvent(event) {
        if (!this._seekable)
            return;
        const {fraction, stageX} = this._fractionFromEvent(event);
        this._hoverFraction = fraction;
        this.emit('hover-changed', fraction, stageX);
    }

    _startStageDragCapture() {
        this._disconnectStageCapture();
        this._stageCaptureId = global.stage.connect('captured-event', (_stage, event) => {
            if (this._destroyed || !this._dragging)
                return Clutter.EVENT_PROPAGATE;
            const type = event.type();
            if (type === Clutter.EventType.MOTION) {
                const {fraction, stageX} = this._fractionFromEvent(event);
                this._dragFraction = fraction;
                this._hoverFraction = fraction;
                this.emit('hover-changed', fraction, stageX);
                this.queue_repaint();
                return Clutter.EVENT_STOP;
            }
            if (type === Clutter.EventType.BUTTON_RELEASE) {
                const {fraction} = this._fractionFromEvent(event);
                this._dragFraction = fraction;
                this._endStageDragCapture(true);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _endStageDragCapture(commit) {
        this._disconnectStageCapture();
        const finalFraction = this._dragFraction;
        this._dragging = false;
        if (!this._hovered) {
            this._hoverFraction = -1;
            this.emit('hover-changed', -1, -1);
        }
        if (commit) {
            this._progress = finalFraction;
            this.emit('seek-requested', finalFraction);
        }
        this.queue_repaint();
    }

    cancelDrag() {
        if (this._dragging)
            this._endStageDragCapture(false);
    }

    _disconnectStageCapture() {
        if (this._stageCaptureId) {
            try {
                global.stage.disconnect(this._stageCaptureId);
            } catch {
                // Already disconnected
            }
            this._stageCaptureId = 0;
        }
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor || 1;
        const padX = this._padX * scale;

        if (width <= padX * 2 + 2 || height <= 0) {
            cr.$dispose();
            return;
        }

        const active = (this._hovered || this._dragging) && this._seekable;
        const trackH = active
            ? Math.min(3.6 * scale, height - 1.4 * scale)
            : Math.min(2.4 * scale, height - 2.0 * scale);
        const trackX = padX;
        const trackW = width - padX * 2;
        const trackY = (height - trackH) / 2;

        // Background rail
        if (this._lightSurface)
            cr.setSourceRGBA(0, 0, 0, active ? 0.24 : 0.16);
        else
            cr.setSourceRGBA(1, 1, 1, active ? 0.26 : 0.18);
        drawCapsule(cr, trackX, trackY, trackW, trackH);
        cr.fill();

        const [r, g, b] = this._accentRgb;
        const shownFrac = this._dragging ? this._dragFraction : this._progress;

        // Subtle hover preview segment ahead of current position
        if (this._hovered && !this._dragging && this._seekable && this._hoverFraction > shownFrac) {
            const hoverW = Math.max(trackH, trackW * this._hoverFraction);
            cr.setSourceRGBA(r, g, b, 0.34);
            drawCapsule(cr, trackX, trackY, hoverW, trackH);
            cr.fill();
        }

        // Filled playback progress
        if (shownFrac > 0.002) {
            const fillW = Math.max(trackH, trackW * shownFrac);
            cr.setSourceRGBA(r, g, b, 0.96);
            drawCapsule(cr, trackX, trackY, fillW, trackH);
            cr.fill();
        }

        // Compact scrub dot when hovered or dragging
        if (active) {
            const dotFrac = this._dragging ? this._dragFraction : (this._hoverFraction >= 0 ? this._hoverFraction : shownFrac);
            const dotX = trackX + trackW * dotFrac;
            const dotY = height / 2;
            const dotR = Math.min(2.8 * scale, height / 2 - 0.3 * scale);

            cr.setSourceRGBA(r, g, b, 0.45);
            cr.arc(dotX, dotY, dotR + 0.9 * scale, 0, Math.PI * 2);
            cr.fill();

            cr.setSourceRGBA(1, 1, 1, 0.96);
            cr.arc(dotX, dotY, dotR * 0.72, 0, Math.PI * 2);
            cr.fill();
        }

        cr.$dispose();
    }

    cleanup() {
        this._dragging = false;
        this._disconnectStageCapture();
    }

    _onDestroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        this.cleanup();
    }
});

export const ZControllerIndicator = GObject.registerClass(
class ZControllerIndicator extends PanelMenu.Button {
    _init(controller, settings, waveHub, placement = 'top', shortcuts = null, openShortcutsCb = null, metadata = null, openAboutCb = null) {
        const isBottom = placement === 'bottom';
        super._init(isBottom ? 0.9 : 0.5, 'ZCtrl', true);

        this._controller = controller;
        this._settings = settings;
        this._waveHub = waveHub;
        this._shortcuts = shortcuts;
        this._openShortcutsCb = openShortcutsCb;
        this._metadata = metadata || {};
        this._openAboutCb = openAboutCb;
        this._shortcutsChangedId = 0;
        this._shortcutsSummaryLabel = null;
        this._placement = placement;
        this._isBottom = isBottom;
        this._destroyed = false;
        this._updatingSliders = false;
        this._isSeeking = false;
        this._draggingActiveVol = false;
        this._draggingMasterVol = false;
        this._draggingSensitivity = false;
        this._draggingStreamId = null;
        this._seekTimerId = 0;
        this._barTimelineTimerId = 0;
        this._barTimelineTickCount = 0;
        this._barSeekLockUntilMs = 0;
        this._barTimelineEnabled = true;
        this._barTimelineVisible = false;

        this._sourcesSignature = null;
        this._sourceRowRefs = new Map();
        this._localTracksSignature = null;
        this._localTrackRowRefs = new Map();

        this._tooltipLabel = null;
        this._tooltipTimeoutId = 0;
        this._tooltipTexts = new Map();

        this._artCache = new Map();
        this._artCancellable = null;
        this._currentArtUrl = '';

        this._activeThemeClass = null;
        this._activeAccentClass = null;
        this._activeThemeId = 'dark';
        this._blurBackdrop = null;
        this._backdropClone = null;
        this._blurEffect = null;
        this._clipEffect = null;
        this._menuAnimSignalIds = [];

        this._sections = new Map();
        this._positionBtns = new Map();
        this._waveStyleBtns = new Map();
        this._waveWidthBtns = new Map();
        this._waveColorBtns = new Map();
        this._themeBtns = new Map();
        this._accentColorBtns = new Map();

        // Create popup opening downward on top bar, upward on bottom dock bar
        this.setMenu(new PopupMenu.PopupMenu(
            this,
            isBottom ? 0.9 : 0.5,
            isBottom ? St.Side.BOTTOM : St.Side.TOP,
            0
        ));

        if (isBottom) {
            Main.panel.menuManager.addMenu(this.menu);
            this.add_style_class_name('zcontroller-bottom-placement');
        }

        this.add_style_class_name('zcontroller-panel-root');

        this._buildTopBarButtons();
        this._buildPopupMenu();

        this._controllerChangedId = this._controller.connect('changed', () => {
            if (!this._destroyed)
                this._syncAll();
        });
        this._controllerPosChangedId = this._controller.connect('position-changed', () => {
            if (this._destroyed)
                return;
            if (this.menu.isOpen)
                this._syncSeekBar();
            this._syncBarTimeline();
        });

        this._settingsChangedId = this._settings.connect('changed', () => {
            if (!this._destroyed)
                this._applySettings();
        });

        if (this._shortcuts) {
            this._shortcutsChangedId = this._shortcuts.connect('changed', () => {
                if (!this._destroyed)
                    this._syncShortcutsSummary();
            });
        }

        this._menuOpenChangedId = this.menu.connect('open-state-changed', (_menu, isOpen) => {
            this._hideTooltip();
            this._syncBlurBackdrop();
            if (isOpen) {
                this._showBtn.add_style_class_name('zcontroller-btn-active');
                this._syncPopup();
                this._syncAppearanceControls();
                const target = this._controller.getActiveTarget();
                if (target.type === 'mpris')
                    target.player.refreshPosition();
                this._startSeekTimer();
            } else {
                this._showBtn.remove_style_class_name('zcontroller-btn-active');
                this._stopSeekTimer();
                this._collapseAllSections();
            }
        });

        this._applySettings();
        this._syncAll();
    }

    /**
     * Override PanelMenu.Button default click handler so ONLY the "Show" button
     * toggles the popup menu, while other buttons act immediately.
     */
    vfunc_event(event) {
        if (event.type() === Clutter.EventType.SCROLL) {
            const dir = event.get_scroll_direction();
            if (dir === Clutter.ScrollDirection.UP) {
                this._controller.adjustActiveVolume(SCROLL_VOLUME_STEP);
                return Clutter.EVENT_STOP;
            }
            if (dir === Clutter.ScrollDirection.DOWN) {
                this._controller.adjustActiveVolume(-SCROLL_VOLUME_STEP);
                return Clutter.EVENT_STOP;
            }
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _buildTopBarButtons() {
        this._panelBox = new St.BoxLayout({
            vertical: true,
            style_class: 'zcontroller-panel-box',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._panelBox);

        this._controlsRow = new St.BoxLayout({
            style_class: 'zcontroller-panel-controls-row',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._panelBox.add_child(this._controlsRow);

        // 1. SHOW button (left-click: toggle popup; middle-click or Shift+click: raise app window)
        this._showBtn = this._createPanelButton('view-reveal-symbolic', 'Show Media Controller', 'show');
        this._showBtn.connect('button-press-event', (_actor, event) => {
            this._hideTooltip();
            const button = event.get_button();
            const state = event.get_state();
            if (button === 2 || (button === 1 && (state & Clutter.ModifierType.SHIFT_MASK))) {
                if (!this._controller.raiseActive())
                    this.menu.toggle();
                return Clutter.EVENT_STOP;
            }
            if (button === 1) {
                this.menu.toggle();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this._showBtn.connect('clicked', () => {
            this._hideTooltip();
            this.menu.toggle();
        });

        // 2. PREVIOUS button
        this._prevBtn = this._createPanelButton('media-skip-backward-symbolic', 'Previous', 'previous');
        this._prevBtn.connect('clicked', () => {
            this._hideTooltip();
            this._controller.previous();
        });

        // 3. PAUSE / PLAY button
        this._playPauseBtn = this._createPanelButton('media-playback-start-symbolic', 'Play / Pause', 'playpause');
        this._playPauseBtn.add_style_class_name('zcontroller-play-btn');
        this._playPauseBtn.connect('clicked', () => {
            this._hideTooltip();
            this._controller.playPause();
        });

        // 4. NEXT button
        this._nextBtn = this._createPanelButton('media-skip-forward-symbolic', 'Next', 'next');
        this._nextBtn.connect('clicked', () => {
            this._hideTooltip();
            this._controller.next();
        });

        // 5. SOUND WAVES toggle button (to the right of the 4 buttons)
        //    Left-click: Show / Hide live sound waves; Right-click: Cycle wave style
        this._waveToggleBtn = this._createPanelButton('sound-wave-symbolic', 'Toggle Sound Waves', 'waves');
        this._waveToggleBtn.connect('button-press-event', (_actor, event) => {
            this._hideTooltip();
            const button = event.get_button();
            if (button === 1) {
                const current = this._settings.get_boolean('waves-visible');
                this._settings.set_boolean('waves-visible', !current);
                return Clutter.EVENT_STOP;
            }
            if (button === 3) {
                if (!this._settings.get_boolean('waves-visible')) {
                    this._settings.set_boolean('waves-visible', true);
                } else {
                    const currentStyle = this._settings.get_string('wave-style');
                    const idx = WAVE_STYLES.findIndex(s => s.id === currentStyle);
                    const nextStyle = WAVE_STYLES[(idx + 1) % WAVE_STYLES.length].id;
                    this._settings.set_string('wave-style', nextStyle);
                }
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this._waveToggleBtn.connect('clicked', () => {
            this._hideTooltip();
            const current = this._settings.get_boolean('waves-visible');
            this._settings.set_boolean('waves-visible', !current);
        });

        // Subtle separator + live sound wave canvas (activated by default via GSettings)
        this._waveDivider = new St.Widget({
            style_class: 'zcontroller-wave-divider',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });

        this._waveWidget = new SoundWaveWidget(this._waveHub);
        this._waveWidget._key = 'wave-canvas';
        this._waveWidget.connect('notify::hover', () => {
            if (this._waveWidget.hover && !this.menu.isOpen)
                this._scheduleTooltip(this._waveWidget);
            else
                this._hideTooltip();
        });
        this._waveWidget.connect('style-changed-custom', () => {
            if (this._settings && this._settings.get_string('wave-style') !== this._waveWidget.styleId)
                this._settings.set_string('wave-style', this._waveWidget.styleId);
        });

        if (this._isBottom) {
            // Opposite direction on the bottom bar: waves expand leftward toward center,
            // media controls stay in natural Prev / Play / Next order, Show sits on the outer edge.
            this._controlsRow.add_child(this._waveWidget);
            this._controlsRow.add_child(this._waveDivider);
            this._controlsRow.add_child(this._waveToggleBtn);
            this._controlsRow.add_child(this._prevBtn);
            this._controlsRow.add_child(this._playPauseBtn);
            this._controlsRow.add_child(this._nextBtn);
            this._controlsRow.add_child(this._showBtn);
        } else {
            // Top bar next to Date: Show -> Prev -> Play/Pause -> Next -> Waves Toggle | Live Waves
            this._controlsRow.add_child(this._showBtn);
            this._controlsRow.add_child(this._prevBtn);
            this._controlsRow.add_child(this._playPauseBtn);
            this._controlsRow.add_child(this._nextBtn);
            this._controlsRow.add_child(this._waveToggleBtn);
            this._controlsRow.add_child(this._waveDivider);
            this._controlsRow.add_child(this._waveWidget);
        }

        // Interactive mini music timeline sitting directly beneath buttons + waves
        this._barTimeline = new BarTimelineWidget();
        this._barTimeline.visible = false;
        this._barTimeline.connect('seek-requested', (_widget, fraction) => {
            const target = this._controller?.getActiveTarget();
            if (target?.type === 'mpris' && target.player.lengthUs > 0) {
                this._barSeekLockUntilMs = Date.now() + 450;
                const targetUs = fraction * target.player.lengthUs;
                target.player.setPosition(targetUs);
                if (this.menu.isOpen)
                    this._syncSeekBar();
            }
        });
        this._barTimeline.connect('hover-changed', (_widget, fraction, stageX) => {
            if (this._destroyed || this.menu.isOpen || fraction < 0) {
                this._hideTooltip();
                return;
            }
            const target = this._controller?.getActiveTarget();
            if (target?.type === 'mpris' && target.player.lengthUs > 0) {
                const previewUs = fraction * target.player.lengthUs;
                this._showTooltip(
                    this._barTimeline,
                    `${formatTimeUs(previewUs)} / ${formatTimeUs(target.player.lengthUs)}`,
                    stageX >= 0 ? stageX : null
                );
            }
        });
        this._panelBox.add_child(this._barTimeline);
    }

    _createPanelButton(iconName, accessibleName, key) {
        const icon = new St.Icon({
            icon_name: iconName,
            style_class: 'system-status-icon zcontroller-panel-icon',
        });

        const btn = new St.Button({
            child: icon,
            style_class: 'zcontroller-panel-btn',
            reactive: true,
            can_focus: true,
            track_hover: true,
            accessible_name: accessibleName,
        });
        btn._icon = icon;
        btn._key = key;

        btn.connect('notify::hover', () => {
            if (btn.hover && !this.menu.isOpen)
                this._scheduleTooltip(btn);
            else
                this._hideTooltip();
        });

        return btn;
    }

    _scheduleTooltip(btn) {
        this._hideTooltip();
        this._tooltipTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TOOLTIP_DELAY_MS, () => {
            this._tooltipTimeoutId = 0;
            if (!this._destroyed && btn.hover && !this.menu.isOpen)
                this._showTooltip(btn, this._tooltipTexts.get(btn._key) || btn.accessible_name);
            return GLib.SOURCE_REMOVE;
        });
    }

    _showTooltip(anchorActor, text, overrideStageX = null) {
        if (!text || this._destroyed)
            return;

        if (!this._tooltipLabel) {
            this._tooltipLabel = new St.Label({
                style_class: 'zcontroller-tooltip',
                text,
            });
            Main.layoutManager.uiGroup.add_child(this._tooltipLabel);
        } else {
            this._tooltipLabel.text = text;
        }

        this._tooltipLabel.show();
        const [ax, ay] = anchorActor.get_transformed_position();
        const [aw, ah] = anchorActor.get_transformed_size();
        const [, natWidth] = this._tooltipLabel.get_preferred_width(-1);
        const [, natHeight] = this._tooltipLabel.get_preferred_height(-1);

        const monitor = Main.layoutManager.primaryMonitor;
        let x = overrideStageX !== null
            ? Math.round(overrideStageX - natWidth / 2)
            : Math.round(ax + (aw - natWidth) / 2);
        if (monitor) {
            const minX = monitor.x + 8;
            const maxX = monitor.x + monitor.width - natWidth - 8;
            x = Math.max(minX, Math.min(x, maxX));
        }
        const y = this._isBottom
            ? Math.round(ay - natHeight - 8)
            : Math.round(ay + ah + 6);

        this._tooltipLabel.set_position(x, y);
    }

    _hideTooltip() {
        if (this._tooltipTimeoutId) {
            GLib.source_remove(this._tooltipTimeoutId);
            this._tooltipTimeoutId = 0;
        }
        if (this._tooltipLabel)
            this._tooltipLabel.hide();
    }

    _createCollapsibleSection(parent, {id, iconName, title, defaultSummary = ''}) {
        const card = new St.BoxLayout({
            vertical: true,
            style_class: 'zcontroller-section-card',
            x_expand: true,
        });
        parent.add_child(card);

        const headerBtn = new St.Button({
            style_class: 'zcontroller-accordion-header',
            reactive: true,
            can_focus: true,
            x_expand: true,
        });

        const headerRow = new St.BoxLayout({
            style_class: 'zcontroller-accordion-header-row',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const iconBox = new St.Bin({
            style_class: 'zcontroller-section-icon-box',
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({
                icon_name: iconName,
                icon_size: 14,
                style_class: 'zcontroller-section-icon',
            }),
        });
        headerRow.add_child(iconBox);

        const titleLabel = new St.Label({
            text: title,
            style_class: 'zcontroller-accordion-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        headerRow.add_child(titleLabel);

        const summaryLabel = new St.Label({
            text: defaultSummary,
            style_class: 'zcontroller-accordion-summary',
            y_align: Clutter.ActorAlign.CENTER,
        });
        summaryLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        headerRow.add_child(summaryLabel);

        const chevron = new St.Icon({
            icon_name: 'pan-end-symbolic',
            icon_size: 14,
            style_class: 'zcontroller-accordion-chevron',
            y_align: Clutter.ActorAlign.CENTER,
        });
        headerRow.add_child(chevron);

        headerBtn.set_child(headerRow);
        card.add_child(headerBtn);

        const body = new St.BoxLayout({
            vertical: true,
            style_class: 'zcontroller-accordion-body',
            x_expand: true,
            visible: false,
        });
        card.add_child(body);

        const entry = {id, card, headerBtn, summaryLabel, chevron, body, expanded: false};
        this._sections.set(id, entry);

        headerBtn.connect('clicked', () => {
            this._toggleSection(id);
        });

        return entry;
    }

    _setSectionExpanded(entry, expanded) {
        if (!entry || entry.expanded === expanded)
            return;
        entry.expanded = expanded;
        entry.body.visible = expanded;
        entry.chevron.icon_name = expanded ? 'pan-down-symbolic' : 'pan-end-symbolic';
        if (expanded)
            entry.card.add_style_class_name('zcontroller-section-expanded');
        else
            entry.card.remove_style_class_name('zcontroller-section-expanded');
    }

    _toggleSection(id) {
        const target = this._sections.get(id);
        if (!target)
            return;
        const willExpand = !target.expanded;
        for (const [secId, entry] of this._sections) {
            if (secId === id)
                this._setSectionExpanded(entry, willExpand);
            else if (willExpand && entry.expanded)
                this._setSectionExpanded(entry, false);
        }
    }

    _collapseAllSections() {
        for (const entry of this._sections.values())
            this._setSectionExpanded(entry, false);
    }

    _setSectionSummary(id, text) {
        const entry = this._sections.get(id);
        if (entry)
            entry.summaryLabel.text = text;
    }

    _buildPopupMenu() {
        this.menu.actor.add_style_class_name('zcontroller-popup-menu');

        const wrapperItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: 'zcontroller-popup-item',
        });
        this.menu.addMenuItem(wrapperItem);

        const cardStack = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        wrapperItem.add_child(cardStack);

        // Real-time GPU frosted backdrop blur for the Transparent (MacBook) theme:
        // Clones global.window_group (wallpaper + all open windows, excluding our popup)
        // inside a zero-preferred-size clipped container, applies ACTOR Gaussian blur,
        // then clips cleanly to anti-aliased 18px rounded corners via Shell.GLSLEffect.
        this._blurBackdrop = new ZeroSizeContainer({
            style_class: 'zcontroller-blur-backdrop',
            layout_manager: new Clutter.FixedLayout(),
            clip_to_allocation: true,
            x_expand: true,
            y_expand: true,
            visible: false,
        });
        try {
            this._backdropClone = new Clutter.Clone({
                source: global.window_group,
                reactive: false,
            });
            this._blurBackdrop.add_child(this._backdropClone);

            this._blurEffect = new Shell.BlurEffect({
                name: 'zcontroller-backdrop-blur',
                mode: Shell.BlurMode.ACTOR,
                radius: 44,
                brightness: 0.66,
            });
            this._clipEffect = new RoundedCornerClipEffect();
            this._blurBackdrop.add_effect(this._blurEffect);
            this._blurBackdrop.add_effect(this._clipEffect);

            this._blurBackdrop.connect('notify::allocation', () => {
                this._syncBackdropTransform();
            });
            this._menuAnimSignalIds.push(
                this.menu.actor.connect('notify::allocation', () => this._syncBackdropTransform()),
                this.menu.actor.connect('notify::translation-x', () => this._syncBackdropTransform()),
                this.menu.actor.connect('notify::translation-y', () => this._syncBackdropTransform())
            );
        } catch (e) {
            console.warn(`[ZCtrl] Backdrop blur unavailable: ${e.message}`);
            this._backdropClone = null;
            this._blurEffect = null;
            this._clipEffect = null;
        }
        cardStack.add_child(this._blurBackdrop);

        const root = new St.BoxLayout({
            vertical: true,
            style_class: 'zcontroller-card',
            x_expand: true,
        });
        cardStack.add_child(root);

        // ====================================================================
        // HERO CARD: NOW PLAYING + TRANSPORT + ACTIVE VOLUME
        // ====================================================================
        const heroCard = new St.BoxLayout({
            vertical: true,
            style_class: 'zcontroller-hero-card',
            x_expand: true,
        });
        root.add_child(heroCard);

        const headerRow = new St.BoxLayout({
            style_class: 'zcontroller-header',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        heroCard.add_child(headerRow);

        this._artBin = new St.Button({
            style_class: 'zcontroller-art-btn',
            reactive: true,
            can_focus: true,
            accessible_name: 'Focus playing application',
        });
        this._artIcon = new St.Icon({
            icon_name: 'audio-x-generic-symbolic',
            icon_size: 46,
            style_class: 'zcontroller-art-icon',
        });
        this._artBin.set_child(this._artIcon);
        this._artBin.connect('clicked', () => {
            if (this._controller.raiseActive())
                this.menu.close();
        });
        headerRow.add_child(this._artBin);

        const metaBox = new St.BoxLayout({
            vertical: true,
            style_class: 'zcontroller-meta-box',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        headerRow.add_child(metaBox);

        this._titleLabel = new St.Label({
            text: 'No Media Playing',
            style_class: 'zcontroller-title',
        });
        this._titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        metaBox.add_child(this._titleLabel);

        this._subtitleLabel = new St.Label({
            text: '',
            style_class: 'zcontroller-subtitle',
        });
        this._subtitleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        metaBox.add_child(this._subtitleLabel);

        const badgeRow = new St.BoxLayout({
            x_align: Clutter.ActorAlign.START,
        });
        this._sourceBadge = new St.Label({
            text: '',
            style_class: 'zcontroller-source-badge',
        });
        this._sourceBadge.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        badgeRow.add_child(this._sourceBadge);
        metaBox.add_child(badgeRow);

        this._raiseBtn = new St.Button({
            child: new St.Icon({
                icon_name: 'window-new-symbolic',
                icon_size: 14,
            }),
            style_class: 'zcontroller-icon-btn zcontroller-raise-btn',
            reactive: true,
            can_focus: true,
            y_align: Clutter.ActorAlign.START,
            accessible_name: 'Open player window',
        });
        this._raiseBtn.connect('clicked', () => {
            if (this._controller.raiseActive())
                this.menu.close();
        });
        headerRow.add_child(this._raiseBtn);

        // Seek / Progress bar (hidden automatically when non-seekable)
        this._seekBox = new St.BoxLayout({
            style_class: 'zcontroller-seek-row',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        heroCard.add_child(this._seekBox);

        this._elapsedLabel = new St.Label({
            text: '0:00',
            style_class: 'zcontroller-time-label',
        });
        this._seekSlider = new Slider.Slider(0);
        this._seekSlider.add_style_class_name('zcontroller-slider');
        this._durationLabel = new St.Label({
            text: '0:00',
            style_class: 'zcontroller-time-label',
        });

        this._seekSlider.connect('drag-begin', () => {
            this._isSeeking = true;
        });
        this._seekSlider.connect('drag-end', () => {
            this._isSeeking = false;
            this._commitSeek();
        });
        this._seekSlider.connect('notify::value', () => {
            if (this._updatingSliders)
                return;
            const target = this._controller.getActiveTarget();
            if (target.type === 'mpris' && target.player.lengthUs > 0) {
                const previewUs = this._seekSlider.value * target.player.lengthUs;
                this._elapsedLabel.text = formatTimeUs(previewUs);
                if (!this._isSeeking)
                    this._commitSeek();
            }
        });

        this._seekBox.add_child(this._elapsedLabel);
        this._seekBox.add_child(this._seekSlider);
        this._seekBox.add_child(this._durationLabel);

        // Transport controls
        const controlsRow = new St.BoxLayout({
            style_class: 'zcontroller-controls-row',
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        heroCard.add_child(controlsRow);

        this._popupPrevBtn = this._createControlButton('media-skip-backward-symbolic', 'Previous', 'zcontroller-ctrl-btn');
        this._popupPrevBtn.connect('clicked', () => this._controller.previous());

        this._popupPlayBtn = this._createControlButton('media-playback-start-symbolic', 'Play / Pause', 'zcontroller-ctrl-btn zcontroller-ctrl-primary');
        this._popupPlayBtn.connect('clicked', () => this._controller.playPause());

        this._popupNextBtn = this._createControlButton('media-skip-forward-symbolic', 'Next', 'zcontroller-ctrl-btn');
        this._popupNextBtn.connect('clicked', () => this._controller.next());

        this._popupStopBtn = this._createControlButton('media-playback-stop-symbolic', 'Stop / Mute', 'zcontroller-ctrl-btn zcontroller-ctrl-subtle');
        this._popupStopBtn.connect('clicked', () => this._controller.stopActive());

        controlsRow.add_child(this._popupPrevBtn);
        controlsRow.add_child(this._popupPlayBtn);
        controlsRow.add_child(this._popupNextBtn);
        controlsRow.add_child(this._popupStopBtn);

        // Active target volume slider (hidden when master is active)
        this._activeVolRow = new St.BoxLayout({
            style_class: 'zcontroller-volume-row',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        heroCard.add_child(this._activeVolRow);

        this._activeMuteBtn = this._createControlButton('audio-volume-high-symbolic', 'Toggle Source Mute', 'zcontroller-icon-btn');
        this._activeMuteBtn.connect('clicked', () => this._controller.toggleActiveMute());

        this._activeVolSlider = new Slider.Slider(1.0);
        this._activeVolSlider.add_style_class_name('zcontroller-slider');
        this._activeVolSlider.connect('drag-begin', () => {
            this._draggingActiveVol = true;
        });
        this._activeVolSlider.connect('drag-end', () => {
            this._draggingActiveVol = false;
        });
        this._activeVolSlider.connect('notify::value', () => {
            if (this._updatingSliders)
                return;
            const maxScale = this._controller.getActiveVolume().maxScale;
            const val = this._activeVolSlider.value * maxScale;
            this._activeVolPct.text = `${Math.round(val * 100)}%`;
            this._controller.setActiveVolume(val);
        });

        this._activeVolPct = new St.Label({
            text: '100%',
            style_class: 'zcontroller-pct-label',
        });

        this._activeVolRow.add_child(this._activeMuteBtn);
        this._activeVolRow.add_child(this._activeVolSlider);
        this._activeVolRow.add_child(this._activeVolPct);

        // ====================================================================
        // COLLAPSIBLE SECTIONS STACK (All collapsed by default)
        // ====================================================================
        const sectionsStack = new St.BoxLayout({
            vertical: true,
            style_class: 'zcontroller-sections-stack',
            x_expand: true,
        });
        root.add_child(sectionsStack);

        this._buildSourcesSection(sectionsStack);
        this._buildLocalMusicSection(sectionsStack);
        this._buildPositionSection(sectionsStack);
        this._buildWavesSection(sectionsStack);
        this._buildShortcutsLauncherRow(sectionsStack);
        this._buildAppearanceSection(sectionsStack);
        this._buildOutputSection(sectionsStack);
        this._buildAboutLauncherRow(sectionsStack);
    }

    _buildAboutLauncherRow(parent) {
        const version = this._metadata?.['version-name'] || '1.0.0';

        const card = new St.BoxLayout({
            vertical: true,
            style_class: 'zcontroller-section-card',
            x_expand: true,
        });
        parent.add_child(card);

        const headerBtn = new St.Button({
            style_class: 'zcontroller-accordion-header',
            reactive: true,
            can_focus: true,
            x_expand: true,
            accessible_name: 'About ZCtrl',
        });

        const headerRow = new St.BoxLayout({
            style_class: 'zcontroller-accordion-header-row',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const iconBox = new St.Bin({
            style_class: 'zcontroller-section-icon-box',
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({
                icon_name: 'help-about-symbolic',
                icon_size: 14,
                style_class: 'zcontroller-section-icon',
            }),
        });
        headerRow.add_child(iconBox);

        const titleLabel = new St.Label({
            text: 'About',
            style_class: 'zcontroller-accordion-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        headerRow.add_child(titleLabel);

        const versionLabel = new St.Label({
            text: `v${version}`,
            style_class: 'zcontroller-accordion-summary',
            y_align: Clutter.ActorAlign.CENTER,
        });
        headerRow.add_child(versionLabel);

        const launchIcon = new St.Icon({
            icon_name: 'go-next-symbolic',
            icon_size: 13,
            style_class: 'zcontroller-accordion-chevron',
            y_align: Clutter.ActorAlign.CENTER,
        });
        headerRow.add_child(launchIcon);

        headerBtn.set_child(headerRow);
        card.add_child(headerBtn);

        headerBtn.connect('clicked', () => {
            this._openAboutCb?.();
        });
    }

    _buildShortcutsLauncherRow(parent) {
        const card = new St.BoxLayout({
            vertical: true,
            style_class: 'zcontroller-section-card',
            x_expand: true,
        });
        parent.add_child(card);

        const headerBtn = new St.Button({
            style_class: 'zcontroller-accordion-header',
            reactive: true,
            can_focus: true,
            x_expand: true,
            accessible_name: 'Open Keyboard Shortcuts Popup',
        });

        const headerRow = new St.BoxLayout({
            style_class: 'zcontroller-accordion-header-row',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const iconBox = new St.Bin({
            style_class: 'zcontroller-section-icon-box',
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({
                icon_name: 'preferences-desktop-keyboard-shortcuts-symbolic',
                icon_size: 14,
                style_class: 'zcontroller-section-icon',
            }),
        });
        headerRow.add_child(iconBox);

        const titleLabel = new St.Label({
            text: 'Shortcuts',
            style_class: 'zcontroller-accordion-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        headerRow.add_child(titleLabel);

        this._shortcutsSummaryLabel = new St.Label({
            text: 'Off',
            style_class: 'zcontroller-accordion-summary',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._shortcutsSummaryLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        headerRow.add_child(this._shortcutsSummaryLabel);

        const launchIcon = new St.Icon({
            icon_name: 'go-next-symbolic',
            icon_size: 13,
            style_class: 'zcontroller-accordion-chevron',
            y_align: Clutter.ActorAlign.CENTER,
        });
        headerRow.add_child(launchIcon);

        headerBtn.set_child(headerRow);
        card.add_child(headerBtn);

        headerBtn.connect('clicked', () => {
            this._openShortcutsCb?.();
        });

        this._syncShortcutsSummary();
    }

    _syncShortcutsSummary() {
        if (!this._shortcutsSummaryLabel)
            return;
        const count = this._shortcuts?.getActiveCount?.() ?? 0;
        this._shortcutsSummaryLabel.text = count > 0 ? `${count} active` : 'Off';
    }

    _buildLocalMusicSection(parent) {
        const entry = this._createCollapsibleSection(parent, {
            id: 'local',
            iconName: 'folder-music-symbolic',
            title: 'Local Music',
            defaultSummary: 'Add music',
        });
        const {body} = entry;

        // Lazily load saved folder into isolated zctrl-player-service only when user opens this section
        entry.headerBtn.connect('clicked', () => {
            if (entry.expanded)
                this._controller.localPlayer?.ensureFolderLoaded();
        });

        const toolbar = new St.BoxLayout({
            style_class: 'zcontroller-section-toolbar',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        body.add_child(toolbar);

        const folderBtn = new St.Button({
            label: 'Folder',
            style_class: 'zcontroller-pill-btn',
            reactive: true,
            can_focus: true,
            accessible_name: 'Choose music folder',
        });
        folderBtn.connect('clicked', () => {
            this.menu.close(false);
            this._controller.localPlayer?.pickFolder();
        });
        toolbar.add_child(folderBtn);

        const filesBtn = new St.Button({
            label: 'Files',
            style_class: 'zcontroller-pill-btn',
            reactive: true,
            can_focus: true,
            accessible_name: 'Pick MP3 or audio files',
        });
        filesBtn.connect('clicked', () => {
            this.menu.close(false);
            this._controller.localPlayer?.pickFiles();
        });
        toolbar.add_child(filesBtn);

        toolbar.add_child(new St.Widget({x_expand: true}));

        this._localShuffleBtn = this._createControlButton(
            'media-playlist-shuffle-symbolic',
            'Toggle Shuffle',
            'zcontroller-chip-btn zcontroller-chip-compact'
        );
        this._localShuffleBtn._icon.icon_size = 13;
        this._localShuffleBtn.connect('clicked', () => {
            this._controller.localPlayer?.toggleShuffle();
        });
        toolbar.add_child(this._localShuffleBtn);

        this._localRepeatBtn = this._createControlButton(
            'media-playlist-repeat-symbolic',
            'Cycle Repeat Mode (Off / All / One)',
            'zcontroller-chip-btn zcontroller-chip-compact'
        );
        this._localRepeatBtn._icon.icon_size = 13;
        this._localRepeatBtn.connect('clicked', () => {
            this._controller.localPlayer?.cycleRepeat();
        });
        toolbar.add_child(this._localRepeatBtn);

        this._localFolderLabel = new St.Label({
            text: 'Isolated player · Pick an MP3 folder or files',
            style_class: 'zcontroller-helper-hint',
            x_expand: true,
        });
        this._localFolderLabel.clutter_text.ellipsize = Pango.EllipsizeMode.START;
        body.add_child(this._localFolderLabel);

        this._quickMusicBtn = new St.Button({
            label: 'Load ~/Music Folder',
            style_class: 'zcontroller-pill-btn',
            reactive: true,
            can_focus: true,
            x_align: Clutter.ActorAlign.START,
            visible: false,
        });
        this._quickMusicBtn.connect('clicked', () => {
            const lp = this._controller.localPlayer;
            const defaultDir = lp?.getDefaultMusicDir();
            if (defaultDir)
                lp.loadFolder(defaultDir, false);
        });
        body.add_child(this._quickMusicBtn);

        this._localTracksScroll = new St.ScrollView({
            style_class: 'zcontroller-tracks-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
        });
        this._localTracksList = new St.BoxLayout({
            vertical: true,
            style_class: 'zcontroller-tracks-list',
            x_expand: true,
        });
        this._localTracksScroll.child = this._localTracksList;
        body.add_child(this._localTracksScroll);
    }

    _buildSourcesSection(parent) {
        const {body} = this._createCollapsibleSection(parent, {
            id: 'sources',
            iconName: 'multimedia-player-symbolic',
            title: 'Audio Sources',
            defaultSummary: 'None',
        });

        const toolbar = new St.BoxLayout({
            style_class: 'zcontroller-section-toolbar',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        body.add_child(toolbar);

        this._autoModeBtn = new St.Button({
            label: 'Auto Select',
            style_class: 'zcontroller-pill-btn',
            reactive: true,
            can_focus: true,
        });
        this._autoModeBtn.connect('clicked', () => this._controller.setAutoMode());
        toolbar.add_child(this._autoModeBtn);

        this._sourcesScroll = new St.ScrollView({
            style_class: 'zcontroller-sources-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
        });
        this._sourcesList = new St.BoxLayout({
            vertical: true,
            style_class: 'zcontroller-sources-list',
            x_expand: true,
        });
        this._sourcesScroll.child = this._sourcesList;
        body.add_child(this._sourcesScroll);
    }

    _buildPositionSection(parent) {
        const {body} = this._createCollapsibleSection(parent, {
            id: 'position',
            iconName: 'preferences-desktop-display-symbolic',
            title: 'Position & Bar',
            defaultSummary: 'Top (Date)',
        });

        const segmented = new St.BoxLayout({
            style_class: 'zcontroller-segmented',
            x_expand: true,
        });
        for (const pos of CONTROLLER_POSITIONS) {
            const btn = new St.Button({
                label: pos.label,
                style_class: 'zcontroller-segment-btn',
                reactive: true,
                can_focus: true,
                x_expand: true,
            });
            btn.connect('clicked', () => {
                // Close popup gracefully if switching away from this bar's placement
                const willRemoveSelf =
                    (this._placement === 'top' && pos.id === 'bottom') ||
                    (this._placement === 'bottom' && pos.id === 'top');
                if (willRemoveSelf && this.menu.isOpen)
                    this.menu.close(false);
                this._settings.set_string('controller-position', pos.id);
            });
            segmented.add_child(btn);
            this._positionBtns.set(pos.id, btn);
        }
        body.add_child(segmented);

        this._positionHintLabel = new St.Label({
            text: 'Visible in the top panel next to the Date bar.',
            style_class: 'zcontroller-helper-hint',
        });
        this._positionHintLabel.clutter_text.line_wrap = true;
        body.add_child(this._positionHintLabel);

        const timelineRow = new St.BoxLayout({
            style_class: 'zcontroller-custom-row',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        body.add_child(timelineRow);

        timelineRow.add_child(new St.Label({
            text: 'Bar Timeline',
            style_class: 'zcontroller-custom-label',
            x_expand: true,
        }));

        this._barTimelineToggleBtn = new St.Button({
            label: 'Shown',
            style_class: 'zcontroller-pill-btn',
            reactive: true,
            can_focus: true,
        });
        this._barTimelineToggleBtn.connect('clicked', () => {
            const current = this._settings.get_boolean('bar-timeline-visible');
            this._settings.set_boolean('bar-timeline-visible', !current);
        });
        timelineRow.add_child(this._barTimelineToggleBtn);
    }

    _buildWavesSection(parent) {
        const {body} = this._createCollapsibleSection(parent, {
            id: 'waves',
            iconName: 'media-eq-symbolic',
            title: 'Sound Waves',
            defaultSummary: 'On',
        });

        // Row 1: Live Visualizer Toggle
        const toggleRow = new St.BoxLayout({
            style_class: 'zcontroller-custom-row',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        body.add_child(toggleRow);

        toggleRow.add_child(new St.Label({
            text: 'Visualizer',
            style_class: 'zcontroller-custom-label',
            x_expand: true,
        }));

        this._popupWavesToggleBtn = new St.Button({
            label: 'On',
            style_class: 'zcontroller-pill-btn',
            reactive: true,
            can_focus: true,
        });
        this._popupWavesToggleBtn.connect('clicked', () => {
            const current = this._settings.get_boolean('waves-visible');
            this._settings.set_boolean('waves-visible', !current);
        });
        toggleRow.add_child(this._popupWavesToggleBtn);

        // Row 2: Wave Style (Waves / Line / Bars) + Wave Width (S / M / L)
        const styleWidthRow = new St.BoxLayout({
            style_class: 'zcontroller-custom-row',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        body.add_child(styleWidthRow);

        const styleGroup = new St.BoxLayout({
            style_class: 'zcontroller-chip-group',
            x_expand: true,
        });
        for (const style of WAVE_STYLES) {
            const btn = new St.Button({
                label: style.label,
                style_class: 'zcontroller-chip-btn',
                reactive: true,
                can_focus: true,
            });
            btn.connect('clicked', () => {
                this._settings.set_string('wave-style', style.id);
                if (!this._settings.get_boolean('waves-visible'))
                    this._settings.set_boolean('waves-visible', true);
            });
            styleGroup.add_child(btn);
            this._waveStyleBtns.set(style.id, btn);
        }
        styleWidthRow.add_child(styleGroup);

        const widthGroup = new St.BoxLayout({
            style_class: 'zcontroller-chip-group',
        });
        for (const preset of WAVE_WIDTH_PRESETS) {
            const btn = new St.Button({
                label: preset.label,
                style_class: 'zcontroller-chip-btn zcontroller-chip-compact',
                reactive: true,
                can_focus: true,
                accessible_name: `Wave width ${preset.id}`,
            });
            btn.connect('clicked', () => {
                this._settings.set_int('wave-width', preset.width);
            });
            widthGroup.add_child(btn);
            this._waveWidthBtns.set(preset.width, btn);
        }
        styleWidthRow.add_child(widthGroup);

        // Row 3: Wave Sensitivity Slider
        const sensRow = new St.BoxLayout({
            style_class: 'zcontroller-custom-row',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        body.add_child(sensRow);

        sensRow.add_child(new St.Label({
            text: 'Sensitivity',
            style_class: 'zcontroller-custom-label',
        }));

        this._sensitivitySlider = new Slider.Slider(0.35);
        this._sensitivitySlider.add_style_class_name('zcontroller-slider');
        this._sensitivitySlider.connect('drag-begin', () => {
            this._draggingSensitivity = true;
        });
        this._sensitivitySlider.connect('drag-end', () => {
            this._draggingSensitivity = false;
            const sens = SENSITIVITY_MIN + this._sensitivitySlider.value * (SENSITIVITY_MAX - SENSITIVITY_MIN);
            this._settings.set_double('wave-sensitivity', Math.round(sens * 10) / 10);
        });
        this._sensitivitySlider.connect('notify::value', () => {
            if (this._updatingSliders)
                return;
            const sens = SENSITIVITY_MIN + this._sensitivitySlider.value * (SENSITIVITY_MAX - SENSITIVITY_MIN);
            const rounded = Math.round(sens * 10) / 10;
            this._sensitivityValLabel.text = `${rounded.toFixed(1)}×`;
            this._waveWidget.setSensitivity(rounded);
            if (!this._draggingSensitivity)
                this._settings.set_double('wave-sensitivity', rounded);
        });
        sensRow.add_child(this._sensitivitySlider);

        this._sensitivityValLabel = new St.Label({
            text: '1.2×',
            style_class: 'zcontroller-pct-label',
        });
        sensRow.add_child(this._sensitivityValLabel);

        // Row 4: Wave Colors (8 swatches including Rainbow)
        const waveColorRow = new St.BoxLayout({
            style_class: 'zcontroller-custom-row',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        body.add_child(waveColorRow);

        waveColorRow.add_child(new St.Label({
            text: 'Color',
            style_class: 'zcontroller-custom-label',
        }));

        const waveSwatches = new St.BoxLayout({
            style_class: 'zcontroller-swatch-row',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
        });
        for (const preset of WAVE_COLOR_PRESETS) {
            const swatch = new St.Button({
                style_class: 'zcontroller-swatch-btn',
                style: preset.swatchCss,
                reactive: true,
                can_focus: true,
                accessible_name: `Wave color: ${preset.label}`,
            });
            swatch.connect('clicked', () => {
                this._settings.set_string('wave-color', preset.id);
            });
            waveSwatches.add_child(swatch);
            this._waveColorBtns.set(preset.id, swatch);
        }
        waveColorRow.add_child(waveSwatches);
    }

    _buildAppearanceSection(parent) {
        const {body} = this._createCollapsibleSection(parent, {
            id: 'appearance',
            iconName: 'preferences-color-symbolic',
            title: 'Theme & Colors',
            defaultSummary: 'Dark',
        });

        // Row 1: ZController Theme (Dark / Glass / Light / OLED)
        const themeSegmented = new St.BoxLayout({
            style_class: 'zcontroller-segmented',
            x_expand: true,
        });
        for (const theme of CONTROLLER_THEMES) {
            const btn = new St.Button({
                label: theme.label,
                style_class: 'zcontroller-segment-btn',
                reactive: true,
                can_focus: true,
                x_expand: true,
            });
            btn.connect('clicked', () => {
                this._settings.set_string('controller-theme', theme.id);
            });
            themeSegmented.add_child(btn);
            this._themeBtns.set(theme.id, btn);
        }
        body.add_child(themeSegmented);

        // Row 2: ZController Accent Color (7 swatches)
        const accentRow = new St.BoxLayout({
            style_class: 'zcontroller-custom-row',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        body.add_child(accentRow);

        accentRow.add_child(new St.Label({
            text: 'Accent',
            style_class: 'zcontroller-custom-label',
        }));

        const accentSwatches = new St.BoxLayout({
            style_class: 'zcontroller-swatch-row',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
        });
        for (const preset of ACCENT_COLOR_PRESETS) {
            const swatch = new St.Button({
                style_class: 'zcontroller-swatch-btn',
                style: `background-color: ${preset.swatchHex};`,
                reactive: true,
                can_focus: true,
                accessible_name: `Accent color: ${preset.label}`,
            });
            swatch.connect('clicked', () => {
                this._settings.set_string('accent-color', preset.id);
            });
            accentSwatches.add_child(swatch);
            this._accentColorBtns.set(preset.id, swatch);
        }
        accentRow.add_child(accentSwatches);
    }

    _buildOutputSection(parent) {
        const {body} = this._createCollapsibleSection(parent, {
            id: 'output',
            iconName: 'audio-speakers-symbolic',
            title: 'Output Device',
            defaultSummary: '100%',
        });

        this._masterDeviceLabel = new St.Label({
            text: 'Default Output',
            style_class: 'zcontroller-output-name',
            x_expand: true,
        });
        this._masterDeviceLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        body.add_child(this._masterDeviceLabel);

        const masterRow = new St.BoxLayout({
            style_class: 'zcontroller-volume-row',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        body.add_child(masterRow);

        this._masterMuteBtn = this._createControlButton('audio-volume-high-symbolic', 'Toggle Master Output Mute', 'zcontroller-icon-btn');
        this._masterMuteBtn.connect('clicked', () => this._controller.toggleDefaultSinkMute());

        this._masterVolSlider = new Slider.Slider(1.0);
        this._masterVolSlider.add_style_class_name('zcontroller-slider');
        this._masterVolSlider.connect('drag-begin', () => {
            this._draggingMasterVol = true;
        });
        this._masterVolSlider.connect('drag-end', () => {
            this._draggingMasterVol = false;
        });
        this._masterVolSlider.connect('notify::value', () => {
            if (this._updatingSliders)
                return;
            const val = this._masterVolSlider.value * this._controller.maxVolumeScale;
            const pctText = `${Math.round(val * 100)}%`;
            this._masterVolPct.text = pctText;
            this._setSectionSummary('output', pctText);
            this._controller.setDefaultSinkVolume(val);
        });

        this._masterVolPct = new St.Label({
            text: '100%',
            style_class: 'zcontroller-pct-label',
        });

        masterRow.add_child(this._masterMuteBtn);
        masterRow.add_child(this._masterVolSlider);
        masterRow.add_child(this._masterVolPct);
    }

    _applySettings() {
        if (this._destroyed || !this._settings)
            return;

        const wavesVisible = this._settings.get_boolean('waves-visible');
        const barTimelineVisible = this._settings.get_boolean('bar-timeline-visible');
        const waveStyle = this._settings.get_string('wave-style');
        const waveWidth = this._settings.get_int('wave-width');
        const waveSensitivity = this._settings.get_double('wave-sensitivity');
        const waveColor = this._settings.get_string('wave-color');
        const accentColor = this._settings.get_string('accent-color');
        const themeId = this._settings.get_string('controller-theme');
        this._barTimelineEnabled = barTimelineVisible;

        // Apply Theme & Accent CSS classes to BOTH top bar and popup menu
        this._activeThemeId = themeId;
        const nextThemeClass = `zcontroller-theme-${themeId}`;
        if (this._activeThemeClass !== nextThemeClass) {
            if (this._activeThemeClass) {
                this.remove_style_class_name(this._activeThemeClass);
                this.menu.actor.remove_style_class_name(this._activeThemeClass);
            }
            this._activeThemeClass = nextThemeClass;
            this.add_style_class_name(nextThemeClass);
            this.menu.actor.add_style_class_name(nextThemeClass);
        }
        this._syncBlurBackdrop();

        const nextAccentClass = `zcontroller-accent-${accentColor}`;
        if (this._activeAccentClass !== nextAccentClass) {
            if (this._activeAccentClass) {
                this.remove_style_class_name(this._activeAccentClass);
                this.menu.actor.remove_style_class_name(this._activeAccentClass);
            }
            this._activeAccentClass = nextAccentClass;
            this.add_style_class_name(nextAccentClass);
            this.menu.actor.add_style_class_name(nextAccentClass);
        }

        // Apply live Sound Waves configuration
        this._waveWidget.setStyleId(waveStyle);
        this._waveWidget.setWaveWidth(waveWidth);
        this._waveWidget.setSensitivity(waveSensitivity);
        this._waveWidget.setColorPreset(waveColor);
        this._waveWidget.setLightSurface(themeId === 'light');
        this._waveWidget.setShown(wavesVisible);
        this._waveDivider.visible = wavesVisible;

        if (wavesVisible)
            this._waveToggleBtn.add_style_class_name('zcontroller-wave-btn-active');
        else
            this._waveToggleBtn.remove_style_class_name('zcontroller-wave-btn-active');

        if (this._barTimeline) {
            const accentPreset = getAccentPreset(accentColor);
            this._barTimeline.setAccentHex(accentPreset.swatchHex);
            this._barTimeline.setLightSurface(themeId === 'light');
        }
        this._syncBarTimeline();

        this._syncWaveTooltips();
        this._syncAppearanceControls();
    }

    _syncBlurBackdrop() {
        if (!this._blurBackdrop)
            return;
        const enableBlur = Boolean(
            this.menu?.isOpen &&
            this._blurEffect &&
            this._backdropClone
        );
        if (enableBlur) {
            const meta = getThemeMeta(this._activeThemeId);
            this._blurEffect.radius = meta.blurRadius ?? 42;
            this._blurEffect.brightness = meta.blurBrightness ?? 0.62;
        }
        if (this._blurEffect)
            this._blurEffect.set_enabled(enableBlur);
        if (this._clipEffect)
            this._clipEffect.set_enabled(enableBlur);
        this._blurBackdrop.visible = enableBlur;
        if (enableBlur) {
            const [stageW, stageH] = global.stage.get_size();
            if (this._backdropClone.width !== stageW || this._backdropClone.height !== stageH)
                this._backdropClone.set_size(stageW, stageH);
            this._syncBackdropTransform();
        }
    }

    _syncBackdropTransform() {
        if (!this._blurBackdrop || !this._backdropClone || !this._blurBackdrop.visible)
            return;
        const box = this._blurBackdrop.get_allocation_box();
        const w = box.get_width();
        const h = box.get_height();
        if (w <= 0 || h <= 0)
            return;

        const [stageX, stageY] = this._blurBackdrop.get_transformed_position();
        const tx = -Math.round(stageX);
        const ty = -Math.round(stageY);
        if (this._backdropClone.translation_x !== tx)
            this._backdropClone.translation_x = tx;
        if (this._backdropClone.translation_y !== ty)
            this._backdropClone.translation_y = ty;

        if (this._clipEffect) {
            const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            this._clipEffect.setBounds(w, h, TRANSPARENT_CORNER_RADIUS * scale);
        }
    }

    _syncAppearanceControls() {
        if (!this._settings)
            return;

        const positionId = this._settings.get_string('controller-position');
        const wavesVisible = this._settings.get_boolean('waves-visible');
        const waveStyle = this._settings.get_string('wave-style');
        const waveWidth = this._settings.get_int('wave-width');
        const waveSensitivity = this._settings.get_double('wave-sensitivity');
        const waveColor = this._settings.get_string('wave-color');
        const accentColor = this._settings.get_string('accent-color');
        const themeId = this._settings.get_string('controller-theme');

        for (const [id, btn] of this._positionBtns) {
            if (id === positionId)
                btn.add_style_class_name('zcontroller-chip-active');
            else
                btn.remove_style_class_name('zcontroller-chip-active');
        }

        const posEntry = CONTROLLER_POSITIONS.find(p => p.id === positionId) ?? CONTROLLER_POSITIONS[0];
        this._setSectionSummary('position', posEntry.label);
        if (this._positionHintLabel) {
            const hints = {
                top: 'Visible in the top panel next to the Date bar.',
                bottom: 'Visible on the right of the bottom bar, opposite app icons.',
                both: 'Visible on both top panel & bottom bar in real-time sync.',
            };
            this._positionHintLabel.text = hints[positionId] ?? hints.top;
        }

        if (this._barTimelineToggleBtn) {
            const tlVisible = this._settings.get_boolean('bar-timeline-visible');
            this._barTimelineToggleBtn.label = tlVisible ? 'Shown' : 'Hidden';
            if (tlVisible)
                this._barTimelineToggleBtn.add_style_class_name('zcontroller-pill-active');
            else
                this._barTimelineToggleBtn.remove_style_class_name('zcontroller-pill-active');
        }

        this._popupWavesToggleBtn.label = wavesVisible ? 'On' : 'Off';
        if (wavesVisible)
            this._popupWavesToggleBtn.add_style_class_name('zcontroller-pill-active');
        else
            this._popupWavesToggleBtn.remove_style_class_name('zcontroller-pill-active');

        for (const [id, btn] of this._waveStyleBtns) {
            if (id === waveStyle)
                btn.add_style_class_name('zcontroller-chip-active');
            else
                btn.remove_style_class_name('zcontroller-chip-active');
        }

        for (const [width, btn] of this._waveWidthBtns) {
            if (width === waveWidth)
                btn.add_style_class_name('zcontroller-chip-active');
            else
                btn.remove_style_class_name('zcontroller-chip-active');
        }

        const styleEntry = WAVE_STYLES.find(s => s.id === waveStyle) ?? WAVE_STYLES[0];
        const widthEntry = WAVE_WIDTH_PRESETS.find(w => w.width === waveWidth) ?? WAVE_WIDTH_PRESETS[1];
        this._setSectionSummary(
            'waves',
            wavesVisible ? `On · ${styleEntry.label} · ${widthEntry.label}` : 'Off'
        );

        if (!this._draggingSensitivity) {
            this._updatingSliders = true;
            const norm = (waveSensitivity - SENSITIVITY_MIN) / (SENSITIVITY_MAX - SENSITIVITY_MIN);
            this._sensitivitySlider.value = Math.max(0, Math.min(1, norm));
            this._sensitivityValLabel.text = `${waveSensitivity.toFixed(1)}×`;
            this._updatingSliders = false;
        }

        for (const [id, btn] of this._waveColorBtns) {
            if (id === waveColor)
                btn.add_style_class_name('zcontroller-swatch-active');
            else
                btn.remove_style_class_name('zcontroller-swatch-active');
        }

        for (const [id, btn] of this._themeBtns) {
            if (id === themeId)
                btn.add_style_class_name('zcontroller-chip-active');
            else
                btn.remove_style_class_name('zcontroller-chip-active');
        }

        for (const [id, btn] of this._accentColorBtns) {
            if (id === accentColor)
                btn.add_style_class_name('zcontroller-swatch-active');
            else
                btn.remove_style_class_name('zcontroller-swatch-active');
        }

        const themeEntry = CONTROLLER_THEMES.find(t => t.id === themeId) ?? CONTROLLER_THEMES[0];
        const accentEntry = ACCENT_COLOR_PRESETS.find(a => a.id === accentColor) ?? ACCENT_COLOR_PRESETS[0];
        this._setSectionSummary('appearance', `${themeEntry.label} · ${accentEntry.label.split(' ')[0]}`);
    }

    _syncWaveTooltips() {
        const shown = this._waveWidget?.isShown ?? false;
        const styleLabel = this._waveWidget?.currentStyleLabel ?? 'Waves';
        this._tooltipTexts.set(
            'waves',
            shown
                ? `Hide Sound Waves · Right-click: Style (${styleLabel})`
                : 'Show Sound Waves'
        );
        this._tooltipTexts.set(
            'wave-canvas',
            `${styleLabel} · Click to switch style`
        );
    }

    _createControlButton(iconName, accessibleName, styleClass) {
        const icon = new St.Icon({
            icon_name: iconName,
            icon_size: 16,
        });
        const btn = new St.Button({
            child: icon,
            style_class: styleClass,
            reactive: true,
            can_focus: true,
            accessible_name: accessibleName,
        });
        btn._icon = icon;
        return btn;
    }

    _commitSeek() {
        const target = this._controller.getActiveTarget();
        if (target.type === 'mpris' && target.player.lengthUs > 0) {
            const targetUs = this._seekSlider.value * target.player.lengthUs;
            target.player.setPosition(targetUs);
        }
    }

    _startSeekTimer() {
        this._stopSeekTimer();
        this._seekTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SEEK_TICK_MS, () => {
            if (this._destroyed || !this.menu.isOpen) {
                this._seekTimerId = 0;
                return GLib.SOURCE_REMOVE;
            }
            this._syncSeekBar();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopSeekTimer() {
        if (this._seekTimerId) {
            GLib.source_remove(this._seekTimerId);
            this._seekTimerId = 0;
        }
    }

    _startBarTimelineTimer() {
        if (this._barTimelineTimerId)
            return;
        this._barTimelineTickCount = 0;
        this._barTimelineTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, BAR_TIMELINE_TICK_MS, () => {
            if (this._destroyed || !this._barTimelineVisible) {
                this._barTimelineTimerId = 0;
                return GLib.SOURCE_REMOVE;
            }
            const target = this._controller?.getActiveTarget();
            if (!target || target.type !== 'mpris' || !target.player.isPlaying || target.player.lengthUs <= 0) {
                this._barTimelineTimerId = 0;
                return GLib.SOURCE_REMOVE;
            }
            this._barTimelineTickCount++;
            if (this._barTimelineTickCount % 16 === 0 && typeof target.player.refreshPosition === 'function')
                target.player.refreshPosition();
            if (this._barTimeline && !this._barTimeline.isDragging && Date.now() >= this._barSeekLockUntilMs)
                this._barTimeline.setProgress(target.player.positionUs / target.player.lengthUs);
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopBarTimelineTimer() {
        if (this._barTimelineTimerId) {
            GLib.source_remove(this._barTimelineTimerId);
            this._barTimelineTimerId = 0;
        }
    }

    _syncBarTimeline() {
        if (this._destroyed || !this._barTimeline || !this._controller)
            return;

        const target = this._controller.getActiveTarget();
        const hasDuration = Boolean(
            target.type === 'mpris' &&
            target.player.lengthUs > 0 &&
            (target.player.isPlaying || target.player.status === 'Paused')
        );
        const shouldShow = this._barTimelineEnabled && hasDuration;

        if (this._barTimelineVisible !== shouldShow) {
            this._barTimelineVisible = shouldShow;
            if (!shouldShow)
                this._barTimeline.cancelDrag();
            this._barTimeline.visible = shouldShow;
            if (shouldShow)
                this._panelBox.add_style_class_name('zcontroller-has-timeline');
            else
                this._panelBox.remove_style_class_name('zcontroller-has-timeline');
        }

        if (!shouldShow) {
            this._stopBarTimelineTimer();
            return;
        }

        const p = target.player;
        this._barTimeline.setSeekable(Boolean(p.canSeek));
        if (!this._barTimeline.isDragging && Date.now() >= this._barSeekLockUntilMs)
            this._barTimeline.setProgress(p.positionUs / p.lengthUs);

        if (p.isPlaying)
            this._startBarTimelineTimer();
        else
            this._stopBarTimelineTimer();
    }

    _syncAll() {
        this._syncTopBar();
        if (this.menu.isOpen)
            this._syncPopup();
    }

    _syncTopBar() {
        const summary = this._controller.getActiveSummary();
        const playing = summary.isPlaying;
        const anyAudio = this._controller.hasAnyActiveAudio();

        this._playPauseBtn._icon.icon_name = playing
            ? 'media-playback-pause-symbolic'
            : 'media-playback-start-symbolic';

        if (anyAudio)
            this._showBtn.add_style_class_name('zcontroller-has-audio');
        else
            this._showBtn.remove_style_class_name('zcontroller-has-audio');

        this._tooltipTexts.set('show', `Show · ${summary.showTooltip}`);
        this._tooltipTexts.set('previous', summary.prevTooltip);
        this._tooltipTexts.set('playpause', summary.playTooltip);
        this._tooltipTexts.set('next', summary.nextTooltip);

        this._syncBarTimeline();
    }

    _syncPopup() {
        const summary = this._controller.getActiveSummary();
        const {target} = summary;

        this._titleLabel.text = summary.title;
        this._subtitleLabel.text = summary.subtitle;
        this._subtitleLabel.visible = Boolean(summary.subtitle);
        this._sourceBadge.text = `${summary.sourceName} · ${summary.statusText}`;

        this._raiseBtn.visible = target.type !== 'master' && target.player !== this._controller.localPlayer;
        this._artBin.reactive = this._raiseBtn.visible;

        this._updateArtwork(summary);

        const playIconName = summary.isPlaying
            ? 'media-playback-pause-symbolic'
            : 'media-playback-start-symbolic';
        this._popupPlayBtn._icon.icon_name = playIconName;

        this._popupStopBtn._icon.icon_name = target.type === 'mpris'
            ? 'media-playback-stop-symbolic'
            : 'audio-volume-muted-symbolic';

        this._syncSeekBar();
        this._syncVolumeSliders(target);
        this._rebuildSourcesList(target);
        this._syncLocalMusic();
    }

    _syncLocalMusic() {
        const lp = this._controller.localPlayer;
        if (!lp || !this._localTracksList)
            return;

        // Shuffle & Repeat chip active states
        if (lp.shuffle)
            this._localShuffleBtn.add_style_class_name('zcontroller-chip-active');
        else
            this._localShuffleBtn.remove_style_class_name('zcontroller-chip-active');

        if (lp.repeat === 'one') {
            this._localRepeatBtn._icon.icon_name = 'media-playlist-repeat-song-symbolic';
            this._localRepeatBtn.add_style_class_name('zcontroller-chip-active');
        } else if (lp.repeat === 'all') {
            this._localRepeatBtn._icon.icon_name = 'media-playlist-repeat-symbolic';
            this._localRepeatBtn.add_style_class_name('zcontroller-chip-active');
        } else {
            this._localRepeatBtn._icon.icon_name = 'media-playlist-repeat-symbolic';
            this._localRepeatBtn.remove_style_class_name('zcontroller-chip-active');
        }

        const tracks = lp.tracks;
        const count = tracks.length;
        const savedFolder = lp.folderPath;

        // Collapsed header summary badge
        if (lp.isPlaying) {
            this._setSectionSummary('local', `Playing · ${count}`);
        } else if (lp.status === 'Paused') {
            this._setSectionSummary('local', `Paused · ${count}`);
        } else if (count > 0) {
            this._setSectionSummary('local', `${count} ${count === 1 ? 'track' : 'tracks'}`);
        } else if (savedFolder) {
            this._setSectionSummary('local', 'Saved folder');
        } else {
            this._setSectionSummary('local', 'Add music');
        }

        // Folder / error caption
        if (lp.lastError) {
            this._localFolderLabel.text = lp.lastError;
        } else if (savedFolder) {
            const home = GLib.get_home_dir();
            const shortPath = savedFolder.startsWith(home)
                ? `~${savedFolder.slice(home.length)}`
                : savedFolder;
            this._localFolderLabel.text = count > 0
                ? `${shortPath} · ${count} ${count === 1 ? 'track' : 'tracks'}`
                : `${shortPath} · No audio files found`;
        } else {
            this._localFolderLabel.text = 'Isolated player · MP3, FLAC, WAV, OGG, M4A, OPUS';
        }

        const defaultMusicDir = !savedFolder ? lp.getDefaultMusicDir() : '';
        this._quickMusicBtn.visible = count === 0 && Boolean(defaultMusicDir);
        this._localTracksScroll.visible = count > 0;

        // Rebuild track rows only when playlist content changes
        const sig = `${savedFolder}|${tracks.map(t => t.filename).join('|')}`;
        if (sig !== this._localTracksSignature) {
            this._localTracksSignature = sig;
            this._localTrackRowRefs.clear();
            this._localTracksList.destroy_all_children();

            for (const track of tracks) {
                const rowBtn = new St.Button({
                    style_class: 'zcontroller-track-row',
                    reactive: true,
                    can_focus: true,
                    x_expand: true,
                });

                const rowBox = new St.BoxLayout({
                    style_class: 'zcontroller-track-row-box',
                    x_expand: true,
                    y_align: Clutter.ActorAlign.CENTER,
                });

                const numOrIcon = new St.Label({
                    text: `${track.index + 1}`,
                    style_class: 'zcontroller-track-index',
                    y_align: Clutter.ActorAlign.CENTER,
                });
                const playIcon = new St.Icon({
                    icon_name: 'media-playback-start-symbolic',
                    icon_size: 12,
                    style_class: 'zcontroller-track-play-icon',
                    visible: false,
                    y_align: Clutter.ActorAlign.CENTER,
                });

                const titleLabel = new St.Label({
                    text: track.artist ? `${track.title} — ${track.artist}` : track.title,
                    style_class: 'zcontroller-track-title',
                    x_expand: true,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;

                rowBox.add_child(numOrIcon);
                rowBox.add_child(playIcon);
                rowBox.add_child(titleLabel);
                rowBtn.set_child(rowBox);

                rowBtn.connect('clicked', () => {
                    if (lp.currentIndex === track.index && lp.isActiveSession)
                        lp.playPause();
                    else
                        this._controller.playLocalTrack(track.index);
                });

                this._localTracksList.add_child(rowBtn);
                this._localTrackRowRefs.set(track.index, {
                    rowBtn,
                    numOrIcon,
                    playIcon,
                    titleLabel,
                });
            }
        }

        // Sync active track highlight & live tag title
        for (const [idx, ref] of this._localTrackRowRefs) {
            const isCurrent = idx === lp.currentIndex && lp.isActiveSession;
            if (isCurrent) {
                ref.rowBtn.add_style_class_name('zcontroller-source-selected');
                ref.numOrIcon.hide();
                ref.playIcon.icon_name = lp.isPlaying
                    ? 'media-playback-pause-symbolic'
                    : 'media-playback-start-symbolic';
                ref.playIcon.show();
                const display = lp.artist ? `${lp.title} — ${lp.artist}` : lp.title;
                if (display)
                    ref.titleLabel.text = display;
            } else {
                ref.rowBtn.remove_style_class_name('zcontroller-source-selected');
                ref.playIcon.hide();
                ref.numOrIcon.show();
            }
        }
    }

    _updateArtwork(summary) {
        const url = summary.artUrl || '';
        const fallbackGIcon = summary.app?.get_icon?.() ?? null;

        const applyFallback = () => {
            if (fallbackGIcon) {
                this._artIcon.gicon = fallbackGIcon;
            } else {
                this._artIcon.gicon = null;
                this._artIcon.icon_name = summary.iconName || 'audio-x-generic-symbolic';
            }
        };

        if (!url) {
            this._currentArtUrl = '';
            this._cancelArtFetch();
            applyFallback();
            return;
        }

        if (url === this._currentArtUrl && this._artIcon.gicon)
            return;

        this._currentArtUrl = url;
        this._cancelArtFetch();

        if (url.startsWith('file://')) {
            applyFallback();
            try {
                const cancellable = new Gio.Cancellable();
                this._artCancellable = cancellable;
                const file = Gio.File.new_for_uri(url);
                file.query_info_async(
                    Gio.FILE_ATTRIBUTE_STANDARD_TYPE,
                    Gio.FileQueryInfoFlags.NONE,
                    GLib.PRIORITY_DEFAULT,
                    cancellable,
                    (src, res) => {
                        if (this._destroyed || cancellable.is_cancelled())
                            return;
                        try {
                            src.query_info_finish(res);
                            if (this._currentArtUrl === url)
                                this._artIcon.gicon = new Gio.FileIcon({file: src});
                        } catch {
                            // Local cover missing or unreadable; keep fallback icon
                        }
                    }
                );
            } catch {
                // Invalid URI; keep fallback icon
            }
            return;
        }

        if (url.startsWith('http://') || url.startsWith('https://')) {
            const cached = this._artCache.get(url);
            if (cached) {
                this._artIcon.gicon = cached;
                return;
            }

            applyFallback();
            const cancellable = new Gio.Cancellable();
            this._artCancellable = cancellable;
            const file = Gio.File.new_for_uri(url);
            file.load_contents_async(cancellable, (src, res) => {
                if (this._destroyed || cancellable.is_cancelled())
                    return;
                try {
                    const [ok, contents] = src.load_contents_finish(res);
                    if (ok && contents && contents.length > 0) {
                        const icon = new Gio.BytesIcon({bytes: GLib.Bytes.new(contents)});
                        if (this._artCache.size >= MAX_ART_CACHE) {
                            const oldest = this._artCache.keys().next().value;
                            this._artCache.delete(oldest);
                        }
                        this._artCache.set(url, icon);
                        if (this._currentArtUrl === url)
                            this._artIcon.gicon = icon;
                    }
                } catch {
                    // Remote cover unavailable; keep fallback icon
                }
            });
            return;
        }

        applyFallback();
    }

    _cancelArtFetch() {
        if (this._artCancellable) {
            this._artCancellable.cancel();
            this._artCancellable = null;
        }
    }

    _syncSeekBar() {
        const target = this._controller.getActiveTarget();
        if (target.type !== 'mpris' || target.player.lengthUs <= 0) {
            this._seekBox.hide();
            return;
        }

        this._seekBox.show();
        const lengthUs = target.player.lengthUs;
        const posUs = Math.min(target.player.positionUs, lengthUs);

        this._durationLabel.text = formatTimeUs(lengthUs);
        this._seekSlider.reactive = target.player.canSeek;

        if (!this._isSeeking) {
            this._elapsedLabel.text = formatTimeUs(posUs);
            this._updatingSliders = true;
            this._seekSlider.value = lengthUs > 0 ? Math.max(0, Math.min(1, posUs / lengthUs)) : 0;
            this._updatingSliders = false;
        }
    }

    _syncVolumeSliders(target) {
        this._updatingSliders = true;

        if (target.type === 'master') {
            this._activeVolRow.hide();
        } else {
            this._activeVolRow.show();
            const {volume, muted, maxScale} = this._controller.getActiveVolume();
            this._activeMuteBtn._icon.icon_name = volumeIconName(volume, muted);
            if (!this._draggingActiveVol) {
                this._activeVolSlider.value = Math.max(0, Math.min(1, volume / (maxScale || 1)));
                this._activeVolPct.text = muted ? 'Muted' : `${Math.round(volume * 100)}%`;
            }
        }

        const sinkName = this._controller.getDefaultSinkName();
        const masterVol = this._controller.getDefaultSinkVolume();
        const masterMuted = this._controller.getDefaultSinkMuted();
        const masterMax = this._controller.maxVolumeScale;

        this._masterDeviceLabel.text = sinkName;
        this._masterMuteBtn._icon.icon_name = volumeIconName(masterVol, masterMuted);
        if (!this._draggingMasterVol) {
            const masterText = masterMuted ? 'Muted' : `${Math.round(masterVol * 100)}%`;
            this._masterVolSlider.value = Math.max(0, Math.min(1, masterVol / (masterMax || 1)));
            this._masterVolPct.text = masterText;
            this._setSectionSummary('output', masterText);
        }

        this._updatingSliders = false;
    }

    _rebuildSourcesList(activeTarget) {
        if (this._controller.isAutoMode)
            this._autoModeBtn.add_style_class_name('zcontroller-pill-active');
        else
            this._autoModeBtn.remove_style_class_name('zcontroller-pill-active');

        const players = this._controller.getMprisPlayers();
        const streams = this._controller.getAudioStreams();
        const totalSources = players.length + streams.length;
        const modeTag = this._controller.isAutoMode ? 'Auto' : 'Pinned';
        this._setSectionSummary(
            'sources',
            totalSources > 0 ? `${totalSources} active · ${modeTag}` : 'None'
        );
        const signature = `${players.map(p => p.id).join(',')}|${streams.map(s => s.id).join(',')}`;

        if (signature !== this._sourcesSignature && !this._draggingStreamId) {
            this._sourcesSignature = signature;
            this._sourceRowRefs.clear();
            this._sourcesList.destroy_all_children();

            if (players.length === 0 && streams.length === 0) {
                this._sourcesList.add_child(new St.Label({
                    text: 'No active media players or app audio streams detected.\nControlling master device output.',
                    style_class: 'zcontroller-empty-label',
                }));
                return;
            }

            for (const player of players) {
                const row = new St.BoxLayout({
                    style_class: 'zcontroller-source-row',
                    x_expand: true,
                    y_align: Clutter.ActorAlign.CENTER,
                });

                const selectBtn = new St.Button({
                    style_class: 'zcontroller-source-select-btn',
                    reactive: true,
                    can_focus: true,
                    x_expand: true,
                });
                const selectContent = new St.BoxLayout({
                    vertical: true,
                    x_expand: true,
                });
                const nameLabel = new St.Label({
                    text: '',
                    style_class: 'zcontroller-source-name',
                });
                nameLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;

                const stateLabel = new St.Label({
                    text: '',
                    style_class: 'zcontroller-source-state',
                });
                selectContent.add_child(nameLabel);
                selectContent.add_child(stateLabel);
                selectBtn.set_child(selectContent);
                selectBtn.connect('clicked', () => this._controller.selectTarget(player.id));

                const quickPlayBtn = this._createControlButton(
                    'media-playback-start-symbolic',
                    `Play or Pause ${player.identity}`,
                    'zcontroller-row-action-btn'
                );
                quickPlayBtn.connect('clicked', () => player.playPause());

                row.add_child(selectBtn);
                row.add_child(quickPlayBtn);
                this._sourcesList.add_child(row);

                this._sourceRowRefs.set(player.id, {
                    kind: 'mpris',
                    row,
                    nameLabel,
                    stateLabel,
                    quickPlayBtn,
                });
            }

            for (const stream of streams) {
                const container = new St.BoxLayout({
                    vertical: true,
                    style_class: 'zcontroller-source-row',
                    x_expand: true,
                });

                const topLine = new St.BoxLayout({
                    x_expand: true,
                    y_align: Clutter.ActorAlign.CENTER,
                });

                const selectBtn = new St.Button({
                    style_class: 'zcontroller-source-select-btn',
                    reactive: true,
                    can_focus: true,
                    x_expand: true,
                });
                const selectContent = new St.BoxLayout({
                    vertical: true,
                    x_expand: true,
                });
                const nameLabel = new St.Label({
                    text: '',
                    style_class: 'zcontroller-source-name',
                });
                nameLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;

                const stateLabel = new St.Label({
                    text: '',
                    style_class: 'zcontroller-source-state',
                });
                selectContent.add_child(nameLabel);
                selectContent.add_child(stateLabel);
                selectBtn.set_child(selectContent);
                selectBtn.connect('clicked', () => this._controller.selectTarget(stream.id));

                const muteBtn = this._createControlButton(
                    'audio-volume-high-symbolic',
                    `Mute or Unmute ${stream.name}`,
                    'zcontroller-row-action-btn'
                );
                muteBtn.connect('clicked', () => stream.toggleMute());

                topLine.add_child(selectBtn);
                topLine.add_child(muteBtn);
                container.add_child(topLine);

                const miniSlider = new Slider.Slider(1.0);
                miniSlider.add_style_class_name('zcontroller-mini-slider');
                miniSlider.connect('drag-begin', () => {
                    this._draggingStreamId = stream.id;
                });
                miniSlider.connect('drag-end', () => {
                    if (this._draggingStreamId === stream.id)
                        this._draggingStreamId = null;
                    this._syncPopup();
                });
                miniSlider.connect('notify::value', () => {
                    if (this._updatingSliders)
                        return;
                    const maxScale = this._controller.maxVolumeScale;
                    const val = miniSlider.value * maxScale;
                    stream.setVolumeNormalized(val, maxScale);
                    const pct = Math.round(val * 100);
                    stateLabel.text = `Sound Output · ${pct}%${this._controller.getActiveTarget().id === stream.id ? ' · Active' : ''}`;
                });
                container.add_child(miniSlider);

                this._sourcesList.add_child(container);
                this._sourceRowRefs.set(stream.id, {
                    kind: 'stream',
                    row: container,
                    nameLabel,
                    stateLabel,
                    muteBtn,
                    miniSlider,
                });
            }
        }

        this._updatingSliders = true;
        const maxScale = this._controller.maxVolumeScale;

        for (const player of players) {
            const ref = this._sourceRowRefs.get(player.id);
            if (!ref)
                continue;
            const isSelected = activeTarget.id === player.id;
            if (isSelected)
                ref.row.add_style_class_name('zcontroller-source-selected');
            else
                ref.row.remove_style_class_name('zcontroller-source-selected');

            ref.nameLabel.text = player.hasTrackTitle
                ? `${player.identity} — ${player.title}`
                : player.identity;
            ref.stateLabel.text = `Media · ${player.status}${isSelected ? ' · Active' : ''}`;
            ref.quickPlayBtn._icon.icon_name = player.isPlaying
                ? 'media-playback-pause-symbolic'
                : 'media-playback-start-symbolic';
        }

        for (const stream of streams) {
            const ref = this._sourceRowRefs.get(stream.id);
            if (!ref)
                continue;
            const isSelected = activeTarget.id === stream.id;
            if (isSelected)
                ref.row.add_style_class_name('zcontroller-source-selected');
            else
                ref.row.remove_style_class_name('zcontroller-source-selected');

            ref.nameLabel.text = stream.description
                ? `${stream.name} — ${stream.description}`
                : stream.name;
            ref.muteBtn._icon.icon_name = volumeIconName(stream.volumeNormalized, stream.isMuted);

            if (this._draggingStreamId !== stream.id) {
                const pct = Math.round(stream.volumeNormalized * 100);
                const stateDesc = stream.isMuted
                    ? 'Muted'
                    : (stream.isRunning ? `Sound Output · ${pct}%` : `Stream · ${pct}%`);
                ref.stateLabel.text = `${stateDesc}${isSelected ? ' · Active' : ''}`;
                ref.miniSlider.value = Math.max(0, Math.min(1, stream.volumeNormalized / (maxScale || 1)));
            }
        }

        this._updatingSliders = false;
    }

    _onDestroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;

        this._stopSeekTimer();
        this._stopBarTimelineTimer();
        this._hideTooltip();
        this._cancelArtFetch();
        this._artCache.clear();

        if (this._shortcuts && this._shortcutsChangedId) {
            this._shortcuts.disconnect(this._shortcutsChangedId);
            this._shortcutsChangedId = 0;
        }
        this._shortcuts = null;
        this._openShortcutsCb = null;
        this._openAboutCb = null;
        this._metadata = null;
        this._shortcutsSummaryLabel = null;

        if (this._settings && this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }
        this._settings = null;

        if (this._waveWidget) {
            this._waveWidget.setShown(false);
            this._waveWidget = null;
        }
        if (this._barTimeline) {
            this._barTimeline.cleanup();
            this._barTimeline = null;
        }

        if (this._tooltipLabel) {
            this._tooltipLabel.destroy();
            this._tooltipLabel = null;
        }

        if (this._controller) {
            if (this._controllerChangedId)
                this._controller.disconnect(this._controllerChangedId);
            if (this._controllerPosChangedId)
                this._controller.disconnect(this._controllerPosChangedId);
            this._controllerChangedId = 0;
            this._controllerPosChangedId = 0;
            this._controller = null;
        }

        if (this.menu) {
            if (this.menu.actor && this._menuAnimSignalIds.length > 0) {
                for (const id of this._menuAnimSignalIds)
                    this.menu.actor.disconnect(id);
                this._menuAnimSignalIds = [];
            }
            if (this.menu.isOpen)
                this.menu.close(false);
            if (this._isBottom)
                Main.panel.menuManager.removeMenu(this.menu);
            if (this._menuOpenChangedId) {
                this.menu.disconnect(this._menuOpenChangedId);
                this._menuOpenChangedId = 0;
            }
        }

        if (this._backdropClone) {
            this._backdropClone.source = null;
            this._backdropClone = null;
        }
        this._blurBackdrop = null;
        this._blurEffect = null;
        this._clipEffect = null;
        this._waveHub = null;
        super._onDestroy();
    }
});
