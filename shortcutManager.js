import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

const SEEK_STEP_US = 10_000_000; // 10 seconds
const VOLUME_STEP = 0.05;

const SHORTCUT_MOD_MASK =
    Clutter.ModifierType.CONTROL_MASK |
    Clutter.ModifierType.SHIFT_MASK |
    Clutter.ModifierType.MOD1_MASK |
    Clutter.ModifierType.SUPER_MASK;

// Bare modifier keys ignored while waiting for the actual trigger key
const MODIFIER_KEYVALS = new Set([
    Clutter.KEY_Shift_L, Clutter.KEY_Shift_R,
    Clutter.KEY_Control_L, Clutter.KEY_Control_R,
    Clutter.KEY_Alt_L, Clutter.KEY_Alt_R,
    Clutter.KEY_Super_L, Clutter.KEY_Super_R,
    Clutter.KEY_Meta_L, Clutter.KEY_Meta_R,
    Clutter.KEY_Hyper_L, Clutter.KEY_Hyper_R,
    Clutter.KEY_ISO_Level3_Shift, Clutter.KEY_ISO_Level5_Shift,
    Clutter.KEY_Caps_Lock, Clutter.KEY_Num_Lock, Clutter.KEY_Scroll_Lock,
    Clutter.KEY_Mode_switch,
]);

// All default bindings use <Shift><Alt>+<Letter> combos that are unused by
// Ubuntu GNOME Shell, Terminal, Chrome, and editors — and ALL start disabled
// until the user explicitly activates them in the Shortcuts popup.
export const SHORTCUT_DEFINITIONS = [
    {
        id: 'play-pause',
        settingKey: 'shortcut-play-pause',
        group: 'Playback',
        label: 'Play / Pause',
        description: 'Play or pause the active media source',
        iconName: 'media-playback-start-symbolic',
        defaultAccel: '<Shift><Alt>p',
        allowAutorepeat: false,
    },
    {
        id: 'stop',
        settingKey: 'shortcut-stop',
        group: 'Playback',
        label: 'Stop Playback',
        description: 'Stop the active player or mute active stream',
        iconName: 'media-playback-stop-symbolic',
        defaultAccel: '<Shift><Alt>x',
        allowAutorepeat: false,
    },
    {
        id: 'next',
        settingKey: 'shortcut-next',
        group: 'Playback',
        label: 'Next Track',
        description: 'Skip to the next track',
        iconName: 'media-skip-forward-symbolic',
        defaultAccel: '<Shift><Alt>n',
        allowAutorepeat: false,
    },
    {
        id: 'previous',
        settingKey: 'shortcut-previous',
        group: 'Playback',
        label: 'Previous Track',
        description: 'Go back to the previous track',
        iconName: 'media-skip-backward-symbolic',
        defaultAccel: '<Shift><Alt>b',
        allowAutorepeat: false,
    },
    {
        id: 'seek-forward',
        settingKey: 'shortcut-seek-forward',
        group: 'Playback',
        label: 'Seek Forward (+10s)',
        description: 'Jump forward 10 seconds in the active track',
        iconName: 'media-seek-forward-symbolic',
        defaultAccel: '<Shift><Alt>k',
        allowAutorepeat: true,
    },
    {
        id: 'seek-backward',
        settingKey: 'shortcut-seek-backward',
        group: 'Playback',
        label: 'Seek Backward (-10s)',
        description: 'Jump backward 10 seconds in the active track',
        iconName: 'media-seek-backward-symbolic',
        defaultAccel: '<Shift><Alt>j',
        allowAutorepeat: true,
    },
    {
        id: 'volume-up',
        settingKey: 'shortcut-volume-up',
        group: 'Audio & Volume',
        label: 'Volume Up',
        description: 'Increase active audio source volume by 5%',
        iconName: 'audio-volume-high-symbolic',
        defaultAccel: '<Shift><Alt>u',
        allowAutorepeat: true,
    },
    {
        id: 'volume-down',
        settingKey: 'shortcut-volume-down',
        group: 'Audio & Volume',
        label: 'Volume Down',
        description: 'Decrease active audio source volume by 5%',
        iconName: 'audio-volume-low-symbolic',
        defaultAccel: '<Shift><Alt>d',
        allowAutorepeat: true,
    },
    {
        id: 'mute',
        settingKey: 'shortcut-mute',
        group: 'Audio & Volume',
        label: 'Mute / Unmute',
        description: 'Toggle mute on the active audio source',
        iconName: 'audio-volume-muted-symbolic',
        defaultAccel: '<Shift><Alt>m',
        allowAutorepeat: false,
    },
    {
        id: 'toggle-waves',
        settingKey: 'shortcut-toggle-waves',
        group: 'Controller & Local Music',
        label: 'Toggle Sound Waves',
        description: 'Show or hide live sound waves on the bar',
        iconName: 'audio-x-generic-symbolic',
        defaultAccel: '<Shift><Alt>w',
        allowAutorepeat: false,
    },
    {
        id: 'toggle-menu',
        settingKey: 'shortcut-toggle-menu',
        group: 'Controller & Local Music',
        label: 'Open ZCtrl',
        description: 'Toggle the ZCtrl popup card',
        iconName: 'multimedia-player-symbolic',
        defaultAccel: '<Shift><Alt>z',
        allowAutorepeat: false,
    },
    {
        id: 'local-play-pause',
        settingKey: 'shortcut-local-play-pause',
        group: 'Controller & Local Music',
        label: 'Local Music Play / Pause',
        description: 'Play or pause ZCtrl local music directly',
        iconName: 'folder-music-symbolic',
        defaultAccel: '<Shift><Alt>l',
        allowAutorepeat: false,
    },
];

const SPECIAL_KEY_LABELS = {
    Up: '↑',
    Down: '↓',
    Left: '←',
    Right: '→',
    Page_Up: 'PgUp',
    Page_Down: 'PgDn',
    space: 'Space',
    Return: 'Enter',
    KP_Enter: 'Enter',
    Tab: 'Tab',
    ISO_Left_Tab: 'Tab',
    BackSpace: 'Backspace',
    Delete: 'Del',
    Home: 'Home',
    End: 'End',
    Insert: 'Ins',
    plus: '+',
    minus: '-',
    equal: '=',
    bracketleft: '[',
    bracketright: ']',
    braceleft: '{',
    braceright: '}',
    semicolon: ';',
    comma: ',',
    period: '.',
    slash: '/',
    backslash: '\\',
    grave: '`',
    AudioPlay: 'Media Play',
    XF86AudioPlay: 'Media Play',
    AudioPause: 'Media Pause',
    XF86AudioPause: 'Media Pause',
    AudioStop: 'Media Stop',
    XF86AudioStop: 'Media Stop',
    AudioNext: 'Media Next',
    XF86AudioNext: 'Media Next',
    AudioPrev: 'Media Prev',
    XF86AudioPrev: 'Media Prev',
    AudioMute: 'Media Mute',
    XF86AudioMute: 'Media Mute',
    AudioRaiseVolume: 'Vol +',
    XF86AudioRaiseVolume: 'Vol +',
    AudioLowerVolume: 'Vol -',
    XF86AudioLowerVolume: 'Vol -',
};

function isFunctionOrMediaKey(keyval, keyName) {
    if (keyval >= Clutter.KEY_F1 && keyval <= Clutter.KEY_F24)
        return true;
    if (keyName && (keyName.startsWith('Audio') || keyName.startsWith('XF86Audio')))
        return true;
    return false;
}

/**
 * Formats a Mutter/GTK accelerator string (e.g. "<Shift><Alt>p") into a
 * clean human-readable label (e.g. "Alt + Shift + P").
 */
export function formatAccelerator(accel) {
    if (!accel || typeof accel !== 'string')
        return 'Not set';

    const modTokens = [];
    const lower = accel.toLowerCase();
    if (lower.includes('<control>') || lower.includes('<ctrl>') || lower.includes('<primary>'))
        modTokens.push('Ctrl');
    if (lower.includes('<super>'))
        modTokens.push('Super');
    if (lower.includes('<alt>') || lower.includes('<meta>'))
        modTokens.push('Alt');
    if (lower.includes('<shift>'))
        modTokens.push('Shift');

    const rawKey = accel.replace(/<[^>]+>/g, '').trim();
    if (!rawKey)
        return 'Not set';

    let keyLabel = SPECIAL_KEY_LABELS[rawKey] ?? rawKey;
    if (keyLabel.length === 1)
        keyLabel = keyLabel.toUpperCase();
    else if (keyLabel.startsWith('XF86'))
        keyLabel = keyLabel.slice(4);

    return [...modTokens, keyLabel].join(' + ');
}

/**
 * Converts a Clutter key-press event into a canonical Mutter accelerator string.
 */
export function eventToAccelerator(event) {
    const keyval = event.get_key_symbol();
    const mods = event.get_state() & SHORTCUT_MOD_MASK;

    if (MODIFIER_KEYVALS.has(keyval))
        return {ignore: true};

    if (keyval === Clutter.KEY_Escape && mods === 0)
        return {cancel: true};

    const keyName = Clutter.keyval_name(keyval) || '';
    const hasPrimaryMod = Boolean(
        mods & (
            Clutter.ModifierType.CONTROL_MASK |
            Clutter.ModifierType.MOD1_MASK |
            Clutter.ModifierType.SUPER_MASK
        )
    );

    if (!hasPrimaryMod && !isFunctionOrMediaKey(keyval, keyName)) {
        return {
            error: 'Include Ctrl, Alt, or Super (or press an F / Media key)',
        };
    }

    // Normalize ISO_Left_Tab back to Tab when Shift is held
    const normalizedKeyval = keyval === Clutter.KEY_ISO_Left_Tab ? Clutter.KEY_Tab : keyval;
    const accel = Meta.accelerator_name(mods, normalizedKeyval);
    if (!accel)
        return {error: 'Unsupported key combination'};

    return {accel};
}

export class ShortcutManager extends Signals.EventEmitter {
    constructor(settings, controller, toggleMenuCb) {
        super();

        this._settings = settings;
        this._controller = controller;
        this._toggleMenuCb = toggleMenuCb;
        this._destroyed = false;
        this._suspended = false;
        this._savingConfig = false;

        this._boundKeys = new Set();
        this._config = new Map(); // id -> { accel, enabled }

        this._loadConfig();

        this._configChangedId = this._settings.connect('changed::shortcuts-config', () => {
            if (this._savingConfig || this._destroyed)
                return;
            this._loadConfig();
            this._syncBindings();
            this.emit('changed');
        });

        this._syncBindings();
    }

    _loadConfig() {
        let parsed = {};
        try {
            const raw = this._settings.get_string('shortcuts-config') || '{}';
            const obj = JSON.parse(raw);
            if (obj && typeof obj === 'object')
                parsed = obj;
        } catch {
            parsed = {};
        }

        this._config.clear();
        for (const def of SHORTCUT_DEFINITIONS) {
            const saved = parsed[def.id];
            const accel = (saved && typeof saved.accel === 'string' && saved.accel.trim())
                ? saved.accel.trim()
                : def.defaultAccel;
            const enabled = Boolean(saved?.enabled);
            this._config.set(def.id, {accel, enabled});
        }
    }

    _saveConfig() {
        const obj = {};
        for (const def of SHORTCUT_DEFINITIONS) {
            const entry = this._config.get(def.id);
            if (!entry)
                continue;
            obj[def.id] = {
                accel: entry.accel,
                enabled: entry.enabled,
            };
        }
        this._savingConfig = true;
        try {
            this._settings.set_string('shortcuts-config', JSON.stringify(obj));
        } finally {
            this._savingConfig = false;
        }
    }

    _unbindKey(settingKey) {
        if (!this._boundKeys.has(settingKey))
            return;
        try {
            Main.wm.removeKeybinding(settingKey);
        } catch {
            // Already removed
        }
        this._boundKeys.delete(settingKey);
    }

    _unbindAll() {
        for (const settingKey of Array.from(this._boundKeys))
            this._unbindKey(settingKey);
    }

    _syncBindings() {
        if (this._destroyed)
            return;

        if (this._suspended) {
            this._unbindAll();
            return;
        }

        for (const def of SHORTCUT_DEFINITIONS) {
            const entry = this._config.get(def.id);
            const active = Boolean(entry?.enabled && entry?.accel);
            const desired = active ? [entry.accel] : [];
            const current = this._settings.get_strv(def.settingKey);

            if (current.length !== desired.length || current[0] !== desired[0])
                this._settings.set_strv(def.settingKey, desired);

            if (active) {
                if (!this._boundKeys.has(def.settingKey)) {
                    const flags = def.allowAutorepeat
                        ? Meta.KeyBindingFlags.NONE
                        : Meta.KeyBindingFlags.IGNORE_AUTOREPEAT;
                    const actionMode = def.id === 'toggle-menu'
                        ? (Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP)
                        : (Shell.ActionMode.NORMAL |
                           Shell.ActionMode.OVERVIEW |
                           Shell.ActionMode.POPUP |
                           Shell.ActionMode.LOCK_SCREEN |
                           Shell.ActionMode.UNLOCK_SCREEN);
                    try {
                        const action = Main.wm.addKeybinding(
                            def.settingKey,
                            this._settings,
                            flags,
                            actionMode,
                            () => this._triggerAction(def.id)
                        );
                        if (action !== Meta.KeyBindingAction.NONE)
                            this._boundKeys.add(def.settingKey);
                        else
                            console.warn(`[ZCtrl] Keybinding ${def.id} (${entry.accel}) could not be registered by Mutter`);
                    } catch (err) {
                        console.error(`[ZCtrl] Failed binding shortcut ${def.id}: ${err.message}`);
                    }
                }
            } else {
                this._unbindKey(def.settingKey);
            }
        }
    }

    _triggerAction(id) {
        if (this._destroyed || this._suspended)
            return;

        switch (id) {
        case 'play-pause':
            this._controller.playPause();
            break;
        case 'stop':
            this._controller.stopActive();
            break;
        case 'next':
            this._controller.next();
            break;
        case 'previous':
            this._controller.previous();
            break;
        case 'seek-forward':
            this._controller.seekActiveBy(SEEK_STEP_US);
            break;
        case 'seek-backward':
            this._controller.seekActiveBy(-SEEK_STEP_US);
            break;
        case 'volume-up':
            this._controller.adjustActiveVolume(VOLUME_STEP);
            break;
        case 'volume-down':
            this._controller.adjustActiveVolume(-VOLUME_STEP);
            break;
        case 'mute':
            this._controller.toggleActiveMute();
            break;
        case 'toggle-waves':
            this._settings.set_boolean('waves-visible', !this._settings.get_boolean('waves-visible'));
            break;
        case 'toggle-menu':
            this._toggleMenuCb?.();
            break;
        case 'local-play-pause':
            this._controller.playPauseLocal();
            break;
        default:
            break;
        }
    }

    getShortcutState(id) {
        const def = SHORTCUT_DEFINITIONS.find(d => d.id === id);
        if (!def)
            return null;
        const entry = this._config.get(id) ?? {accel: def.defaultAccel, enabled: false};
        return {
            ...def,
            accel: entry.accel,
            enabled: entry.enabled,
            isCustom: entry.accel !== def.defaultAccel,
            formattedAccel: formatAccelerator(entry.accel),
        };
    }

    getAllStates() {
        return SHORTCUT_DEFINITIONS.map(def => this.getShortcutState(def.id));
    }

    getActiveCount() {
        let count = 0;
        for (const entry of this._config.values()) {
            if (entry.enabled && entry.accel)
                count++;
        }
        return count;
    }

    findConflict(accel, excludeId = null) {
        if (!accel)
            return null;
        const normalized = accel.toLowerCase();
        for (const def of SHORTCUT_DEFINITIONS) {
            if (def.id === excludeId)
                continue;
            const entry = this._config.get(def.id);
            if (entry?.accel && entry.accel.toLowerCase() === normalized)
                return def;
        }
        return null;
    }

    setEnabled(id, enabled) {
        const entry = this._config.get(id);
        if (!entry)
            return;
        const next = Boolean(enabled);
        if (entry.enabled === next)
            return;
        entry.enabled = next;
        this._saveConfig();
        this._syncBindings();
        this.emit('changed');
    }

    toggleEnabled(id) {
        const entry = this._config.get(id);
        if (!entry)
            return;
        this.setEnabled(id, !entry.enabled);
    }

    setAccelerator(id, accel) {
        const def = SHORTCUT_DEFINITIONS.find(d => d.id === id);
        const entry = this._config.get(id);
        if (!def || !entry || !accel)
            return;

        entry.accel = accel;
        this._saveConfig();

        // Force clean re-bind so Mutter picks up the new accelerator immediately
        this._unbindKey(def.settingKey);
        this._syncBindings();
        this.emit('changed');
    }

    resetShortcut(id) {
        const def = SHORTCUT_DEFINITIONS.find(d => d.id === id);
        if (!def)
            return;
        this.setAccelerator(id, def.defaultAccel);
    }

    disableAll() {
        let changed = false;
        for (const entry of this._config.values()) {
            if (entry.enabled) {
                entry.enabled = false;
                changed = true;
            }
        }
        if (!changed)
            return;
        this._saveConfig();
        this._syncBindings();
        this.emit('changed');
    }

    /**
     * Temporarily suspends active global keybindings while the Shortcuts popup
     * is capturing a new key combination from the keyboard.
     */
    setSuspended(suspended) {
        const next = Boolean(suspended);
        if (this._suspended === next)
            return;
        this._suspended = next;
        this._syncBindings();
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;

        if (this._settings && this._configChangedId) {
            this._settings.disconnect(this._configChangedId);
            this._configChangedId = 0;
        }

        this._unbindAll();
        this._config.clear();
        this._settings = null;
        this._controller = null;
        this._toggleMenuCb = null;
    }
}
