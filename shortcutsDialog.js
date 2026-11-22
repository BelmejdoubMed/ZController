import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

import {
    SHORTCUT_DEFINITIONS,
    eventToAccelerator,
    formatAccelerator,
} from './shortcutManager.js';
import {
    CONTROLLER_THEMES,
    getAccentPreset,
    getThemeMeta,
} from './themeConfig.js';

function hexToRgba(hex, alpha) {
    const clean = (hex || '#e95420').replace('#', '');
    const num = parseInt(clean, 16);
    const r = (num >> 16) & 255;
    const g = (num >> 8) & 255;
    const b = num & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export const ShortcutsDialog = GObject.registerClass(
class ShortcutsDialog extends ModalDialog.ModalDialog {
    _init(shortcutManager, settings) {
        super._init({
            styleClass: 'zcontroller-shortcuts-modal',
            destroyOnClose: true,
        });

        this._shortcuts = shortcutManager;
        this._settings = settings;
        this._recordingId = null;
        this._rows = new Map(); // id -> { row, icon, keyBtn, keyLabel, resetBtn, toggleBtn, toggleLabel }
        this._capturedEventId = 0;
        this._shortcutsChangedId = 0;
        this._themeChangedId = 0;
        this._accentChangedId = 0;
        this._cleanedUp = false;

        // Hide default empty ModalDialog button bar; we render a custom compact footer
        if (this.buttonLayout)
            this.buttonLayout.hide();

        this._buildUI();
        this._applyThemeAndAccent();
        this._refreshAllRows();

        this._shortcutsChangedId = this._shortcuts.connect('changed', () => {
            this._refreshAllRows();
        });
        this._themeChangedId = this._settings.connect('changed::controller-theme', () => {
            this._applyThemeAndAccent();
        });
        this._accentChangedId = this._settings.connect('changed::accent-color', () => {
            this._applyThemeAndAccent();
            this._refreshAllRows();
        });

        this._capturedEventId = this.connect('captured-event', (_actor, event) => {
            return this._onCapturedEvent(event);
        });

        this.connect('destroy', () => this._cleanup());
    }

    _buildUI() {
        const root = new St.BoxLayout({
            vertical: true,
            style_class: 'zcontroller-shortcuts-root',
            x_expand: true,
        });
        this.contentLayout.add_child(root);

        // ---- Header ----
        const header = new St.BoxLayout({
            style_class: 'zcontroller-shortcuts-header',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        root.add_child(header);

        this._headerIcon = new St.Icon({
            icon_name: 'preferences-desktop-keyboard-shortcuts-symbolic',
            icon_size: 18,
            style_class: 'zcontroller-shortcuts-header-icon',
        });
        header.add_child(this._headerIcon);

        const titleBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'zcontroller-shortcuts-title-box',
        });
        titleBox.add_child(new St.Label({
            text: 'Keyboard Shortcuts',
            style_class: 'zcontroller-shortcuts-title',
        }));
        titleBox.add_child(new St.Label({
            text: 'All shortcuts start off — activate the ones you want or click a key to customize',
            style_class: 'zcontroller-shortcuts-subtitle',
        }));
        header.add_child(titleBox);

        this._countBadge = new St.Label({
            text: 'All off',
            style_class: 'zcontroller-shortcuts-count-badge',
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(this._countBadge);

        const closeBtn = new St.Button({
            style_class: 'zcontroller-shortcuts-close-btn',
            reactive: true,
            can_focus: true,
            accessible_name: 'Close Shortcuts',
            child: new St.Icon({
                icon_name: 'window-close-symbolic',
                icon_size: 14,
            }),
        });
        closeBtn.connect('clicked', () => this.close());
        header.add_child(closeBtn);

        // ---- Status / Live Recording Banner ----
        this._banner = new St.BoxLayout({
            style_class: 'zcontroller-shortcuts-banner',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        root.add_child(this._banner);

        this._bannerIcon = new St.Icon({
            icon_name: 'input-keyboard-symbolic',
            icon_size: 14,
            style_class: 'zcontroller-shortcuts-banner-icon',
        });
        this._banner.add_child(this._bannerIcon);

        this._bannerLabel = new St.Label({
            text: '',
            style_class: 'zcontroller-shortcuts-banner-label',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._bannerLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._banner.add_child(this._bannerLabel);

        this._bannerCancelBtn = new St.Button({
            label: 'Cancel',
            style_class: 'zcontroller-shortcuts-banner-cancel',
            reactive: true,
            can_focus: true,
        });
        this._bannerCancelBtn.connect('clicked', () => this._stopRecording());
        this._banner.add_child(this._bannerCancelBtn);

        // ---- Scrollable Shortcuts List ----
        const scroll = new St.ScrollView({
            style_class: 'zcontroller-shortcuts-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
        });
        root.add_child(scroll);

        const list = new St.BoxLayout({
            vertical: true,
            style_class: 'zcontroller-shortcuts-list',
            x_expand: true,
        });
        scroll.child = list;

        let currentGroup = '';
        for (const def of SHORTCUT_DEFINITIONS) {
            if (def.group !== currentGroup) {
                currentGroup = def.group;
                list.add_child(new St.Label({
                    text: currentGroup.toUpperCase(),
                    style_class: 'zcontroller-shortcuts-group-label',
                }));
            }
            list.add_child(this._buildShortcutRow(def));
        }

        // ---- Footer ----
        const footer = new St.BoxLayout({
            style_class: 'zcontroller-shortcuts-footer',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        root.add_child(footer);

        footer.add_child(new St.Label({
            text: 'Click any key badge to record a custom shortcut',
            style_class: 'zcontroller-shortcuts-hint',
            x_expand: true,
        }));

        this._disableAllBtn = new St.Button({
            label: 'Disable All',
            style_class: 'zcontroller-shortcuts-secondary-btn',
            reactive: true,
            can_focus: true,
        });
        this._disableAllBtn.connect('clicked', () => {
            this._stopRecording();
            this._shortcuts.disableAll();
        });
        footer.add_child(this._disableAllBtn);

        this._doneBtn = new St.Button({
            label: 'Done',
            style_class: 'zcontroller-shortcuts-primary-btn',
            reactive: true,
            can_focus: true,
        });
        this._doneBtn.connect('clicked', () => this.close());
        footer.add_child(this._doneBtn);
    }

    _buildShortcutRow(def) {
        const row = new St.BoxLayout({
            style_class: 'zcontroller-shortcut-row',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const icon = new St.Icon({
            icon_name: def.iconName,
            icon_size: 15,
            style_class: 'zcontroller-shortcut-icon',
        });
        row.add_child(icon);

        const textBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'zcontroller-shortcut-text',
        });
        textBox.add_child(new St.Label({
            text: def.label,
            style_class: 'zcontroller-shortcut-name',
        }));
        const descLabel = new St.Label({
            text: def.description,
            style_class: 'zcontroller-shortcut-desc',
        });
        descLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        textBox.add_child(descLabel);
        row.add_child(textBox);

        // Customizable keybinding pill button (click to record new key combo)
        const keyLabel = new St.Label({
            text: formatAccelerator(def.defaultAccel),
            style_class: 'zcontroller-shortcut-key-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const keyBtn = new St.Button({
            style_class: 'zcontroller-shortcut-key-btn',
            reactive: true,
            can_focus: true,
            accessible_name: `Customize shortcut for ${def.label}`,
            child: keyLabel,
        });
        keyBtn.connect('clicked', () => {
            if (this._recordingId === def.id)
                this._stopRecording();
            else
                this._startRecording(def.id);
        });
        row.add_child(keyBtn);

        // Reset-to-default icon button (visible/reactive when customized)
        const resetBtn = new St.Button({
            style_class: 'zcontroller-shortcut-reset-btn',
            reactive: true,
            can_focus: true,
            accessible_name: `Reset ${def.label} shortcut to default`,
            child: new St.Icon({
                icon_name: 'edit-undo-symbolic',
                icon_size: 13,
            }),
        });
        resetBtn.connect('clicked', () => {
            if (this._recordingId !== null)
                this._stopRecording();
            this._shortcuts.resetShortcut(def.id);
            this._showNotice(`Reset ${def.label} to ${formatAccelerator(def.defaultAccel)}`, false);
        });
        row.add_child(resetBtn);

        // Activate / Deactivate toggle pill
        const toggleLabel = new St.Label({
            text: 'OFF',
            style_class: 'zcontroller-shortcut-toggle-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const toggleBtn = new St.Button({
            style_class: 'zcontroller-shortcut-toggle-btn',
            reactive: true,
            can_focus: true,
            accessible_name: `Activate or deactivate ${def.label} shortcut`,
            child: toggleLabel,
        });
        toggleBtn.connect('clicked', () => {
            if (this._recordingId !== null)
                this._stopRecording();
            this._shortcuts.toggleEnabled(def.id);
        });
        row.add_child(toggleBtn);

        this._rows.set(def.id, {
            def,
            row,
            icon,
            keyBtn,
            keyLabel,
            resetBtn,
            toggleBtn,
            toggleLabel,
        });
        return row;
    }

    _getThemeAndAccent() {
        const themeMeta = getThemeMeta(this._settings?.get_string('controller-theme'));
        const accentPreset = getAccentPreset(this._settings?.get_string('accent-color'));
        return {
            theme: {
                id: themeMeta.id,
                isLight: themeMeta.id === 'light',
            },
            accent: {
                id: accentPreset.id,
                hex: accentPreset.swatchHex,
                onColor: accentPreset.id === 'frost' ? '#0f172a' : '#ffffff',
            },
        };
    }

    _applyThemeAndAccent() {
        const {theme, accent} = this._getThemeAndAccent();
        const frame = this.dialogLayout ?? this._dialogLayout;
        if (frame) {
            for (const t of CONTROLLER_THEMES)
                frame.remove_style_class_name(`zcontroller-shortcuts-theme-${t.id}`);
            frame.add_style_class_name(`zcontroller-shortcuts-theme-${theme.id}`);
        }

        this._headerIcon.set_style(`color: ${accent.hex};`);
        this._doneBtn.set_style(`background-color: ${accent.hex}; color: ${accent.onColor};`);
    }

    _refreshAllRows() {
        if (this._cleanedUp || !this._shortcuts)
            return;

        const {theme, accent} = this._getThemeAndAccent();
        const activeCount = this._shortcuts.getActiveCount();

        if (activeCount > 0) {
            this._countBadge.text = `${activeCount} active`;
            this._countBadge.set_style(
                `background-color: ${hexToRgba(accent.hex, 0.22)}; color: ${theme.isLight ? accent.hex : '#ffffff'}; border: 1px solid ${hexToRgba(accent.hex, 0.5)};`
            );
            this._disableAllBtn.reactive = true;
            this._disableAllBtn.opacity = 255;
        } else {
            this._countBadge.text = 'All off';
            this._countBadge.set_style(null);
            this._disableAllBtn.reactive = false;
            this._disableAllBtn.opacity = 110;
        }

        for (const [id, refs] of this._rows.entries()) {
            const state = this._shortcuts.getShortcutState(id);
            if (!state)
                continue;

            const isRecording = this._recordingId === id;

            // Row highlight when active or recording
            if (isRecording) {
                refs.row.add_style_class_name('zcontroller-shortcut-row-recording');
                refs.row.set_style(
                    `border-color: ${accent.hex}; background-color: ${hexToRgba(accent.hex, theme.isLight ? 0.14 : 0.16)};`
                );
            } else {
                refs.row.remove_style_class_name('zcontroller-shortcut-row-recording');
                refs.row.set_style(null);
            }

            // Icon tint
            refs.icon.set_style(state.enabled || isRecording ? `color: ${accent.hex};` : null);

            // Keycap pill
            if (isRecording) {
                refs.keyLabel.text = 'Press keys…';
                refs.keyBtn.set_style(
                    `background-color: ${hexToRgba(accent.hex, 0.25)}; border-color: ${accent.hex}; color: ${theme.isLight ? '#18181c' : '#ffffff'};`
                );
            } else {
                refs.keyLabel.text = state.formattedAccel;
                if (state.enabled) {
                    refs.keyBtn.set_style(
                        `border-color: ${hexToRgba(accent.hex, 0.55)};`
                    );
                } else {
                    refs.keyBtn.set_style(null);
                }
            }

            // Reset button visibility
            refs.resetBtn.visible = state.isCustom;

            // Activate ON / OFF pill
            refs.toggleLabel.text = state.enabled ? 'ON' : 'OFF';
            if (state.enabled) {
                refs.toggleBtn.add_style_class_name('zcontroller-shortcut-toggle-on');
                refs.toggleBtn.set_style(
                    `background-color: ${accent.hex}; color: ${accent.onColor}; border-color: ${accent.hex};`
                );
            } else {
                refs.toggleBtn.remove_style_class_name('zcontroller-shortcut-toggle-on');
                refs.toggleBtn.set_style(null);
            }
        }
    }

    _startRecording(id) {
        const state = this._shortcuts.getShortcutState(id);
        if (!state)
            return;

        this._recordingId = id;
        this._shortcuts.setSuspended(true);

        const {theme, accent} = this._getThemeAndAccent();
        this._banner.visible = true;
        this._bannerCancelBtn.visible = true;
        this._bannerIcon.icon_name = 'input-keyboard-symbolic';
        this._bannerIcon.set_style(`color: ${accent.hex};`);
        this._bannerLabel.text = `Press new shortcut for "${state.label}"… (Esc to cancel)`;
        this._banner.set_style(
            `background-color: ${hexToRgba(accent.hex, theme.isLight ? 0.14 : 0.18)}; border-color: ${hexToRgba(accent.hex, 0.55)};`
        );

        this._refreshAllRows();
    }

    _stopRecording(keepBanner = false) {
        if (this._cleanedUp)
            return;
        if (this._recordingId !== null) {
            this._recordingId = null;
            this._shortcuts?.setSuspended(false);
        }
        if (!keepBanner && this._banner)
            this._banner.visible = false;
        this._refreshAllRows();
    }

    _showNotice(message, isError = false) {
        const {theme, accent} = this._getThemeAndAccent();
        this._banner.visible = true;
        this._bannerCancelBtn.visible = this._recordingId !== null;
        this._bannerIcon.icon_name = isError ? 'dialog-warning-symbolic' : 'emblem-ok-symbolic';
        const color = isError ? '#e01b24' : accent.hex;
        this._bannerIcon.set_style(`color: ${color};`);
        this._bannerLabel.text = message;
        this._banner.set_style(
            `background-color: ${hexToRgba(color, theme.isLight ? 0.12 : 0.18)}; border-color: ${hexToRgba(color, 0.55)};`
        );
    }

    _onCapturedEvent(event) {
        const type = event.type();

        // While recording a shortcut, capture ALL key presses before ModalDialog handles Escape
        if (this._recordingId !== null && type === Clutter.EventType.KEY_PRESS) {
            const result = eventToAccelerator(event);
            if (result.ignore)
                return Clutter.EVENT_STOP;

            if (result.cancel) {
                this._stopRecording(false);
                return Clutter.EVENT_STOP;
            }

            if (result.error) {
                this._showNotice(result.error, true);
                return Clutter.EVENT_STOP;
            }

            const targetId = this._recordingId;
            const conflict = this._shortcuts.findConflict(result.accel, targetId);
            if (conflict) {
                this._showNotice(
                    `${formatAccelerator(result.accel)} is already used by "${conflict.label}"`,
                    true
                );
                return Clutter.EVENT_STOP;
            }

            const state = this._shortcuts.getShortcutState(targetId);
            this._shortcuts.setAccelerator(targetId, result.accel);
            this._stopRecording(true);

            const formatted = formatAccelerator(result.accel);
            const suffix = state?.enabled ? '' : ' — click OFF to activate';
            this._showNotice(`Set "${state?.label ?? targetId}" to ${formatted}${suffix}`, false);
            return Clutter.EVENT_STOP;
        }

        // Click on the dimmed backdrop outside the modal frame closes cleanly
        if (type === Clutter.EventType.BUTTON_PRESS) {
            const frame = this.dialogLayout ?? this._dialogLayout;
            if (frame) {
                const [px, py] = event.get_coords();
                const [dx, dy] = frame.get_transformed_position();
                const [dw, dh] = frame.get_transformed_size();
                if (dw > 0 && dh > 0 && (px < dx || px > dx + dw || py < dy || py > dy + dh)) {
                    this._stopRecording(false);
                    this.close();
                    return Clutter.EVENT_STOP;
                }
            }
        }

        return Clutter.EVENT_PROPAGATE;
    }

    close(timestamp) {
        this._stopRecording(false);
        super.close(timestamp);
    }

    _cleanup() {
        if (this._cleanedUp)
            return;
        this._cleanedUp = true;

        this._recordingId = null;
        this._shortcuts?.setSuspended(false);

        if (this._capturedEventId) {
            try {
                this.disconnect(this._capturedEventId);
            } catch {
                // Already disconnected
            }
            this._capturedEventId = 0;
        }

        if (this._shortcuts && this._shortcutsChangedId) {
            this._shortcuts.disconnect(this._shortcutsChangedId);
            this._shortcutsChangedId = 0;
        }
        if (this._settings && this._themeChangedId) {
            this._settings.disconnect(this._themeChangedId);
            this._themeChangedId = 0;
        }
        if (this._settings && this._accentChangedId) {
            this._settings.disconnect(this._accentChangedId);
            this._accentChangedId = 0;
        }

        this._rows.clear();
        this._shortcuts = null;
        this._settings = null;
    }
});
