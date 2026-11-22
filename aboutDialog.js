import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

import {
    CONTROLLER_THEMES,
    getAccentPreset,
    getThemeMeta,
} from './themeConfig.js';

const AUTHOR_NAME = 'Assaciro';
const LICENSE_NAME = 'GNU GPL v3.0';
const PROJECT_DESCRIPTION =
    'A sleek universal media controller, isolated local music player, and real-time PipeWire sound wave visualizer for Ubuntu & GNOME — crafted for effortless top-bar and bottom-dock audio control.';

const FEATURE_HIGHLIGHTS = [
    'Universal MPRIS & PipeWire',
    'Isolated Local Music Player',
    'Live Sound Waves',
    'Global Shortcuts',
    '5 Frosted-Glass Themes',
    'Top & Bottom Bar',
];

function hexToRgba(hex, alpha) {
    const clean = (hex || '#e95420').replace('#', '');
    const num = parseInt(clean, 16);
    const r = (num >> 16) & 255;
    const g = (num >> 8) & 255;
    const b = num & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export const AboutDialog = GObject.registerClass(
class AboutDialog extends ModalDialog.ModalDialog {
    _init(metadata, settings) {
        super._init({
            styleClass: 'zcontroller-about-modal',
            destroyOnClose: true,
        });

        this._metadata = metadata || {};
        this._settings = settings;
        this._cleanedUp = false;
        this._capturedEventId = 0;
        this._themeChangedId = 0;
        this._accentChangedId = 0;

        if (this.buttonLayout)
            this.buttonLayout.hide();

        this._buildUI();
        this._applyThemeAndAccent();

        if (this._settings) {
            this._themeChangedId = this._settings.connect('changed::controller-theme', () => {
                this._applyThemeAndAccent();
            });
            this._accentChangedId = this._settings.connect('changed::accent-color', () => {
                this._applyThemeAndAccent();
            });
        }

        this._capturedEventId = this.connect('captured-event', (_actor, event) => {
            return this._onCapturedEvent(event);
        });

        this.connect('destroy', () => this._cleanup());
    }

    _buildUI() {
        const appName = this._metadata.name || 'ZCtrl';
        const version = this._metadata['version-name'] || '1.0.0';
        const projectUrl = this._metadata.url || 'https://github.com/BelmejdoubMed/ZController';

        const root = new St.BoxLayout({
            vertical: true,
            style_class: 'zcontroller-about-root',
            x_expand: true,
        });
        this.contentLayout.add_child(root);

        // ---- Top bar with close button ----
        const topRow = new St.BoxLayout({
            style_class: 'zcontroller-about-top-row',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        root.add_child(topRow);

        topRow.add_child(new St.Label({
            text: 'About',
            style_class: 'zcontroller-about-eyebrow',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));

        const closeBtn = new St.Button({
            style_class: 'zcontroller-shortcuts-close-btn',
            reactive: true,
            can_focus: true,
            accessible_name: 'Close About',
            child: new St.Icon({
                icon_name: 'window-close-symbolic',
                icon_size: 14,
            }),
        });
        closeBtn.connect('clicked', () => this.close());
        topRow.add_child(closeBtn);

        // ---- Brand Hero ----
        const hero = new St.BoxLayout({
            vertical: true,
            style_class: 'zcontroller-about-hero',
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
        });
        root.add_child(hero);

        this._emblemBox = new St.Bin({
            style_class: 'zcontroller-about-emblem',
            x_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({
                icon_name: 'audio-x-generic-symbolic',
                icon_size: 28,
            }),
        });
        hero.add_child(this._emblemBox);

        const titleRow = new St.BoxLayout({
            style_class: 'zcontroller-about-title-row',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        titleRow.add_child(new St.Label({
            text: appName,
            style_class: 'zcontroller-about-name',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._versionBadge = new St.Label({
            text: `v${version}`,
            style_class: 'zcontroller-about-version-pill',
            y_align: Clutter.ActorAlign.CENTER,
        });
        titleRow.add_child(this._versionBadge);
        hero.add_child(titleRow);

        hero.add_child(new St.Label({
            text: `Created by ${AUTHOR_NAME}`,
            style_class: 'zcontroller-about-author',
            x_align: Clutter.ActorAlign.CENTER,
        }));

        const descLabel = new St.Label({
            text: PROJECT_DESCRIPTION,
            style_class: 'zcontroller-about-desc',
            x_expand: true,
        });
        descLabel.clutter_text.line_wrap = true;
        root.add_child(descLabel);

        // ---- Feature Chips (2 balanced rows of 3) ----
        const chipsBox = new St.BoxLayout({
            vertical: true,
            style_class: 'zcontroller-about-chips-box',
            x_expand: true,
        });
        root.add_child(chipsBox);

        for (let i = 0; i < FEATURE_HIGHLIGHTS.length; i += 3) {
            const row = new St.BoxLayout({
                style_class: 'zcontroller-about-chips-row',
                x_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
            });
            for (const feat of FEATURE_HIGHLIGHTS.slice(i, i + 3)) {
                row.add_child(new St.Label({
                    text: feat,
                    style_class: 'zcontroller-about-chip',
                }));
            }
            chipsBox.add_child(row);
        }

        // ---- Metadata Card ----
        const metaCard = new St.BoxLayout({
            vertical: true,
            style_class: 'zcontroller-about-meta-card',
            x_expand: true,
        });
        root.add_child(metaCard);

        const metaRows = [
            ['Version', `v${version}`],
            ['Created By', AUTHOR_NAME],
            ['Compatibility', 'Ubuntu / GNOME Shell 46'],
            ['License', LICENSE_NAME],
        ];
        for (const [k, v] of metaRows) {
            const line = new St.BoxLayout({
                style_class: 'zcontroller-about-meta-row',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            line.add_child(new St.Label({
                text: k,
                style_class: 'zcontroller-about-meta-key',
                x_expand: true,
            }));
            line.add_child(new St.Label({
                text: v,
                style_class: 'zcontroller-about-meta-val',
            }));
            metaCard.add_child(line);
        }

        // ---- Footer ----
        const footer = new St.BoxLayout({
            style_class: 'zcontroller-shortcuts-footer',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        root.add_child(footer);

        const repoBtnBox = new St.BoxLayout({
            style_class: 'zcontroller-about-link-content',
            y_align: Clutter.ActorAlign.CENTER,
        });
        repoBtnBox.add_child(new St.Icon({
            icon_name: 'web-browser-symbolic',
            icon_size: 13,
        }));
        repoBtnBox.add_child(new St.Label({
            text: 'Project Page',
            y_align: Clutter.ActorAlign.CENTER,
        }));

        const repoBtn = new St.Button({
            style_class: 'zcontroller-shortcuts-secondary-btn',
            reactive: true,
            can_focus: true,
            accessible_name: 'Open ZCtrl Project Page',
            child: repoBtnBox,
        });
        repoBtn.connect('clicked', () => {
            try {
                Gio.AppInfo.launch_default_for_uri(projectUrl, null);
            } catch (err) {
                console.warn(`[ZCtrl] Failed opening project URL: ${err.message}`);
            }
            this.close();
        });
        footer.add_child(repoBtn);

        footer.add_child(new St.Widget({x_expand: true}));

        this._doneBtn = new St.Button({
            label: 'Close',
            style_class: 'zcontroller-shortcuts-primary-btn',
            reactive: true,
            can_focus: true,
        });
        this._doneBtn.connect('clicked', () => this.close());
        footer.add_child(this._doneBtn);
    }

    _applyThemeAndAccent() {
        const themeMeta = getThemeMeta(this._settings?.get_string('controller-theme'));
        const accentPreset = getAccentPreset(this._settings?.get_string('accent-color'));
        const isLight = themeMeta.id === 'light';
        const hex = accentPreset.swatchHex;
        const onColor = accentPreset.id === 'frost' ? '#0f172a' : '#ffffff';

        const frame = this.dialogLayout ?? this._dialogLayout;
        if (frame) {
            for (const t of CONTROLLER_THEMES)
                frame.remove_style_class_name(`zcontroller-shortcuts-theme-${t.id}`);
            frame.add_style_class_name(`zcontroller-shortcuts-theme-${themeMeta.id}`);
        }

        this._emblemBox.set_style(
            `background-color: ${hexToRgba(hex, isLight ? 0.16 : 0.22)}; color: ${hex}; border: 1px solid ${hexToRgba(hex, 0.45)};`
        );
        this._versionBadge.set_style(
            `background-color: ${hexToRgba(hex, 0.22)}; color: ${isLight ? hex : '#ffffff'}; border: 1px solid ${hexToRgba(hex, 0.48)};`
        );
        this._doneBtn.set_style(`background-color: ${hex}; color: ${onColor};`);
    }

    _onCapturedEvent(event) {
        if (event.type() === Clutter.EventType.BUTTON_PRESS) {
            const frame = this.dialogLayout ?? this._dialogLayout;
            if (frame) {
                const [px, py] = event.get_coords();
                const [dx, dy] = frame.get_transformed_position();
                const [dw, dh] = frame.get_transformed_size();
                if (dw > 0 && dh > 0 && (px < dx || px > dx + dw || py < dy || py > dy + dh)) {
                    this.close();
                    return Clutter.EVENT_STOP;
                }
            }
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _cleanup() {
        if (this._cleanedUp)
            return;
        this._cleanedUp = true;

        if (this._capturedEventId) {
            try {
                this.disconnect(this._capturedEventId);
            } catch {
                // Already disconnected
            }
            this._capturedEventId = 0;
        }
        if (this._settings && this._themeChangedId) {
            this._settings.disconnect(this._themeChangedId);
            this._themeChangedId = 0;
        }
        if (this._settings && this._accentChangedId) {
            this._settings.disconnect(this._accentChangedId);
            this._accentChangedId = 0;
        }

        this._settings = null;
        this._metadata = null;
    }
});
