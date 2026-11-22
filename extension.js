import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {AboutDialog} from './aboutDialog.js';
import {LocalPlayerClient} from './localPlayerClient.js';
import {MediaController} from './mediaController.js';
import {ZControllerIndicator} from './panelIndicator.js';
import {ShortcutManager} from './shortcutManager.js';
import {ShortcutsDialog} from './shortcutsDialog.js';
import {WaveAudioHub} from './waveVisualizer.js';

const BOTTOM_DOCK_DEFAULT_HEIGHT = 36;
const BOTTOM_EDGE_MARGIN = 10;
const SHOW_APPS_GAP = 8;

export default class ZCtrlExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._localPlayer = new LocalPlayerClient(this.path, this._settings);
        this._controller = new MediaController(this._localPlayer);
        this._waveHub = new WaveAudioHub();
        this._shortcuts = new ShortcutManager(
            this._settings,
            this._controller,
            () => this._toggleActiveMenu()
        );
        this._shortcutsDialog = null;
        this._shortcutsDialogDestroyId = 0;
        this._shortcutsOpenIdleId = 0;
        this._aboutDialog = null;
        this._aboutDialogDestroyId = 0;
        this._aboutOpenIdleId = 0;

        this._topIndicator = null;
        this._bottomIndicator = null;
        this._bottomHost = null;

        this._bottomSignalIds = [];
        this._dockSettings = null;
        this._dockSettingsSignalId = 0;
        this._repositionIdleId = 0;
        this._placementIdleId = 0;

        this._posChangedId = this._settings.connect('changed::controller-position', () => {
            this._scheduleSyncPlacement();
        });

        this._syncPlacement();
    }

    _toggleActiveMenu() {
        const indicator = this._topIndicator ?? this._bottomIndicator;
        if (!indicator?.menu)
            return;
        indicator.menu.toggle();
    }

    _closeShortcutsDialog() {
        if (!this._shortcutsDialog)
            return;
        const dialog = this._shortcutsDialog;
        this._shortcutsDialog = null;
        if (this._shortcutsDialogDestroyId) {
            dialog.disconnect(this._shortcutsDialogDestroyId);
            this._shortcutsDialogDestroyId = 0;
        }
        try {
            dialog.close();
        } catch {
            // Already closed
        }
    }

    _closeAboutDialog() {
        if (!this._aboutDialog)
            return;
        const dialog = this._aboutDialog;
        this._aboutDialog = null;
        if (this._aboutDialogDestroyId) {
            dialog.disconnect(this._aboutDialogDestroyId);
            this._aboutDialogDestroyId = 0;
        }
        try {
            dialog.close();
        } catch {
            // Already closed
        }
    }

    openShortcutsPopup() {
        if (!this._shortcuts || !this._settings)
            return;

        if (this._topIndicator?.menu?.isOpen)
            this._topIndicator.menu.close(false);
        if (this._bottomIndicator?.menu?.isOpen)
            this._bottomIndicator.menu.close(false);

        if (this._shortcutsOpenIdleId) {
            GLib.source_remove(this._shortcutsOpenIdleId);
            this._shortcutsOpenIdleId = 0;
        }

        // Open on next idle tick so the PopupMenu releases its modal grab cleanly first
        this._shortcutsOpenIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._shortcutsOpenIdleId = 0;
            if (!this._shortcuts || !this._settings)
                return GLib.SOURCE_REMOVE;

            this._closeShortcutsDialog();

            const dialog = new ShortcutsDialog(this._shortcuts, this._settings);
            this._shortcutsDialog = dialog;
            this._shortcutsDialogDestroyId = dialog.connect('destroy', () => {
                if (this._shortcutsDialog === dialog) {
                    this._shortcutsDialog = null;
                    this._shortcutsDialogDestroyId = 0;
                }
            });
            dialog.open();
            return GLib.SOURCE_REMOVE;
        });
    }

    openAboutPopup() {
        if (!this._settings)
            return;

        if (this._topIndicator?.menu?.isOpen)
            this._topIndicator.menu.close(false);
        if (this._bottomIndicator?.menu?.isOpen)
            this._bottomIndicator.menu.close(false);

        if (this._aboutOpenIdleId) {
            GLib.source_remove(this._aboutOpenIdleId);
            this._aboutOpenIdleId = 0;
        }

        // Open on next idle tick so the PopupMenu releases its modal grab cleanly first
        this._aboutOpenIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._aboutOpenIdleId = 0;
            if (!this._settings)
                return GLib.SOURCE_REMOVE;

            this._closeAboutDialog();

            const dialog = new AboutDialog(this.metadata, this._settings);
            this._aboutDialog = dialog;
            this._aboutDialogDestroyId = dialog.connect('destroy', () => {
                if (this._aboutDialog === dialog) {
                    this._aboutDialog = null;
                    this._aboutDialogDestroyId = 0;
                }
            });
            dialog.open();
            return GLib.SOURCE_REMOVE;
        });
    }

    _scheduleSyncPlacement() {
        if (this._placementIdleId)
            return;
        this._placementIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._placementIdleId = 0;
            this._syncPlacement();
            return GLib.SOURCE_REMOVE;
        });
    }

    _syncPlacement() {
        if (!this._settings)
            return;

        const mode = this._settings.get_string('controller-position');
        const wantTop = mode === 'top' || mode === 'both';
        const wantBottom = mode === 'bottom' || mode === 'both';

        if (wantTop && !this._topIndicator)
            this._createTopIndicator();
        else if (!wantTop && this._topIndicator)
            this._destroyTopIndicator();

        if (wantBottom && !this._bottomIndicator)
            this._createBottomIndicator();
        else if (!wantBottom && this._bottomIndicator)
            this._destroyBottomIndicator();
    }

    _createTopIndicator() {
        this._topIndicator = new ZControllerIndicator(
            this._controller,
            this._settings,
            this._waveHub,
            'top',
            this._shortcuts,
            () => this.openShortcutsPopup(),
            this.metadata,
            () => this.openAboutPopup()
        );

        let position = 1;
        const dateMenu = Main.panel.statusArea.dateMenu;
        if (dateMenu?.container) {
            const centerChildren = Main.panel._centerBox.get_children();
            const dateIndex = centerChildren.indexOf(dateMenu.container);
            if (dateIndex >= 0)
                position = dateIndex + 1;
        }

        Main.panel.addToStatusArea(this.uuid, this._topIndicator, position, 'center');
    }

    _destroyTopIndicator() {
        if (!this._topIndicator)
            return;
        this._topIndicator.destroy();
        this._topIndicator = null;
    }

    _createBottomIndicator() {
        this._bottomIndicator = new ZControllerIndicator(
            this._controller,
            this._settings,
            this._waveHub,
            'bottom',
            this._shortcuts,
            () => this.openShortcutsPopup(),
            this.metadata,
            () => this.openAboutPopup()
        );

        this._bottomHost = new St.Bin({
            style_class: 'zcontroller-bottom-host',
            reactive: false,
            child: this._bottomIndicator.container,
        });

        Main.layoutManager.addChrome(this._bottomHost, {
            affectsStruts: false,
            trackFullscreen: true,
        });

        this._connectBottomSignals();
        this._scheduleBottomReposition();
    }

    _connectBottomSignals() {
        this._disconnectBottomSignals();

        this._bottomSignalIds.push(
            [Main.layoutManager, Main.layoutManager.connect('monitors-changed', () => {
                this._scheduleBottomReposition();
            })],
            [global.display, global.display.connect('workareas-changed', () => {
                this._scheduleBottomReposition();
            })],
            [this._bottomHost, this._bottomHost.connect('notify::allocation', () => {
                this._scheduleBottomReposition();
            })],
            [this._settings, this._settings.connect('changed::waves-visible', () => {
                this._scheduleBottomReposition();
            })],
            [this._settings, this._settings.connect('changed::wave-width', () => {
                this._scheduleBottomReposition();
            })],
            [this._settings, this._settings.connect('changed::bar-timeline-visible', () => {
                this._scheduleBottomReposition();
            })],
            [Main.overview, Main.overview.connect('showing', () => {
                if (this._bottomIndicator?.menu?.isOpen)
                    this._bottomIndicator.menu.close(false);
                if (this._bottomHost)
                    this._bottomHost.hide();
            })],
            [Main.overview, Main.overview.connect('hiding', () => {
                if (this._bottomHost) {
                    this._bottomHost.show();
                    this._scheduleBottomReposition();
                }
            })]
        );

        // Optionally react to Ubuntu Dock / Dash-to-Dock geometry changes when installed
        try {
            const schemaSource = Gio.SettingsSchemaSource.get_default();
            const dockSchema = schemaSource?.lookup('org.gnome.shell.extensions.dash-to-dock', true);
            if (dockSchema) {
                this._dockSettings = new Gio.Settings({settings_schema: dockSchema});
                this._dockSettingsSignalId = this._dockSettings.connect('changed', () => {
                    this._scheduleBottomReposition();
                });
            }
        } catch {
            this._dockSettings = null;
        }
    }

    _disconnectBottomSignals() {
        for (const [obj, id] of this._bottomSignalIds) {
            try {
                obj.disconnect(id);
            } catch {
                // Already disposed
            }
        }
        this._bottomSignalIds = [];

        if (this._dockSettings && this._dockSettingsSignalId) {
            this._dockSettings.disconnect(this._dockSettingsSignalId);
            this._dockSettingsSignalId = 0;
        }
        this._dockSettings = null;

        if (this._repositionIdleId) {
            GLib.source_remove(this._repositionIdleId);
            this._repositionIdleId = 0;
        }
    }

    _scheduleBottomReposition() {
        if (this._repositionIdleId)
            return;
        this._repositionIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._repositionIdleId = 0;
            this._updateBottomPosition();
            return GLib.SOURCE_REMOVE;
        });
    }

    _findPrimaryBottomDock(monitor) {
        for (const actor of Main.layoutManager.uiGroup.get_children()) {
            if (!actor || actor.name !== 'dashtodockContainer' || !actor.visible)
                continue;
            const [ax, ay] = actor.get_transformed_position();
            const [aw, ah] = actor.get_transformed_size();
            if (aw <= 0 || ah <= 0)
                continue;
            const onPrimaryX = ax >= monitor.x - 4 && ax < monitor.x + monitor.width;
            const atBottom = ay >= monitor.y + monitor.height * 0.5 && ah < monitor.height * 0.35;
            if (onPrimaryX && atBottom)
                return {actor, x: ax, y: ay, width: aw, height: ah};
        }
        return null;
    }

    _updateBottomPosition() {
        if (!this._bottomHost || !this._bottomIndicator)
            return;

        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        if (Main.overview.visible) {
            this._bottomHost.hide();
            return;
        }

        const [, natW] = this._bottomHost.get_preferred_width(-1);
        const [, natH] = this._bottomHost.get_preferred_height(-1);
        const hostW = natW > 0 ? natW : Math.max(this._bottomHost.width, 1);
        const hostH = natH > 0 ? natH : Math.max(this._bottomHost.height, 26);

        const dockInfo = this._findPrimaryBottomDock(monitor);
        const workArea = Main.layoutManager.getWorkAreaForMonitor(monitor.index);

        let barY;
        let barH;
        let rightClearance = BOTTOM_EDGE_MARGIN;

        if (dockInfo) {
            barY = dockInfo.y;
            barH = dockInfo.height;

            // Avoid overlapping Ubuntu Dock's Show Apps button when it sits on the right edge
            const showAppsIcon = dockInfo.actor.dash?._showAppsIcon;
            if (showAppsIcon && showAppsIcon.visible) {
                const [sx, ] = showAppsIcon.get_transformed_position();
                const [sw, ] = showAppsIcon.get_transformed_size();
                if (sw > 0 && sx > monitor.x + monitor.width * 0.65) {
                    const edgeToIcon = (monitor.x + monitor.width) - sx;
                    if (edgeToIcon > 0 && edgeToIcon < monitor.width * 0.25)
                        rightClearance = edgeToIcon + SHOW_APPS_GAP;
                }
            }
        } else {
            const bottomInset = (monitor.y + monitor.height) - (workArea.y + workArea.height);
            barH = bottomInset >= 24 ? bottomInset : BOTTOM_DOCK_DEFAULT_HEIGHT;
            barY = monitor.y + monitor.height - barH;
        }

        const rtl = Clutter.get_default_text_direction() === Clutter.TextDirection.RTL;
        let x;
        if (rtl) {
            x = monitor.x + rightClearance;
        } else {
            x = monitor.x + monitor.width - rightClearance - hostW;
        }
        x = Math.max(monitor.x + 8, Math.min(x, monitor.x + monitor.width - hostW - 4));

        let y = barY + Math.round((barH - hostH) / 2);
        y = Math.max(monitor.y + 4, Math.min(y, monitor.y + monitor.height - hostH - 1));

        const targetX = Math.round(x);
        const targetY = Math.round(y);
        if (Math.round(this._bottomHost.x) !== targetX || Math.round(this._bottomHost.y) !== targetY)
            this._bottomHost.set_position(targetX, targetY);

        // Keep bottom controller cleanly above the dock bar without eclipsing menus/tooltips
        const parent = this._bottomHost.get_parent();
        if (parent && dockInfo?.actor && dockInfo.actor.get_parent() === parent)
            parent.set_child_above_sibling(this._bottomHost, dockInfo.actor);
    }

    _destroyBottomIndicator() {
        this._disconnectBottomSignals();

        if (this._bottomHost) {
            Main.layoutManager.removeChrome(this._bottomHost);
            this._bottomHost.child = null;
        }

        if (this._bottomIndicator) {
            this._bottomIndicator.destroy();
            this._bottomIndicator = null;
        }

        if (this._bottomHost) {
            this._bottomHost.destroy();
            this._bottomHost = null;
        }
    }

    disable() {
        if (this._placementIdleId) {
            GLib.source_remove(this._placementIdleId);
            this._placementIdleId = 0;
        }

        if (this._shortcutsOpenIdleId) {
            GLib.source_remove(this._shortcutsOpenIdleId);
            this._shortcutsOpenIdleId = 0;
        }

        if (this._aboutOpenIdleId) {
            GLib.source_remove(this._aboutOpenIdleId);
            this._aboutOpenIdleId = 0;
        }

        this._closeShortcutsDialog();
        this._closeAboutDialog();

        if (this._settings && this._posChangedId) {
            this._settings.disconnect(this._posChangedId);
            this._posChangedId = 0;
        }

        this._destroyTopIndicator();
        this._destroyBottomIndicator();

        if (this._shortcuts) {
            this._shortcuts.destroy();
            this._shortcuts = null;
        }

        if (this._waveHub) {
            this._waveHub.destroy();
            this._waveHub = null;
        }

        if (this._controller) {
            this._controller.destroy();
            this._controller = null;
        }

        if (this._localPlayer) {
            this._localPlayer.destroy();
            this._localPlayer = null;
        }

        this._settings = null;
    }
}
