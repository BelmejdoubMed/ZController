import Gio from 'gi://Gio';
import Gvc from 'gi://Gvc';
import Shell from 'gi://Shell';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';

const ALLOW_AMPLIFIED_KEY = 'allow-volume-above-100-percent';
const IGNORED_APP_IDS = new Set([
    'org.gnome.VolumeControl',
    'org.PulseAudio.pavucontrol',
    'org.gnome.Shell',
    'zctrl.local.player',
    'zcontroller.local.player',
]);

export class AudioStreamEntry {
    constructor(stream, mixer) {
        this.stream = stream;
        this._mixer = mixer;
        this.streamId = stream.id;
        this.id = `stream:${stream.id}`;
        this.lastActiveTimestamp = Date.now();
    }

    get name() {
        const name = this.stream.get_name?.() || '';
        const desc = this.stream.get_description?.() || '';
        if (name && desc && name.toLowerCase() !== desc.toLowerCase())
            return name;
        return name || desc || 'Audio Stream';
    }

    get description() {
        const name = this.stream.get_name?.() || '';
        const desc = this.stream.get_description?.() || '';
        if (desc && desc.toLowerCase() !== name.toLowerCase())
            return desc;
        return '';
    }

    get applicationId() {
        return this.stream.get_application_id?.() || '';
    }

    get iconName() {
        return this.stream.get_icon_name?.() || 'audio-x-generic-symbolic';
    }

    get isMuted() {
        return Boolean(this.stream.is_muted);
    }

    get state() {
        return this.stream.state;
    }

    get isRunning() {
        // Gvc sets state=INVALID (0) on MixerSinkInput streams under PipeWire/PulseAudio;
        // a present non-suspended sink-input represents an open playback stream.
        return this.stream.state === Gvc.MixerStreamState.RUNNING ||
            this.stream.state === Gvc.MixerStreamState.INVALID;
    }

    get isActiveUnmuted() {
        return this.isRunning && !this.isMuted && this.stream.volume > 0;
    }

    get volumeNormalized() {
        const maxNorm = this._mixer.get_vol_max_norm() || 65536;
        return this.stream.volume / maxNorm;
    }

    setVolumeNormalized(value, maxScale = 1.0) {
        const maxNorm = this._mixer.get_vol_max_norm() || 65536;
        const clamped = Math.max(0, Math.min(value, maxScale));
        this.stream.volume = Math.round(clamped * maxNorm);
        this.stream.push_volume();
        if (this.stream.is_muted && this.stream.volume > 0)
            this.stream.change_is_muted(false);
    }

    adjustVolume(delta, maxScale = 1.0) {
        this.setVolumeNormalized(this.volumeNormalized + delta, maxScale);
    }

    setMuted(muted) {
        if (!muted && this.stream.volume === 0) {
            const maxNorm = this._mixer.get_vol_max_norm() || 65536;
            this.stream.volume = Math.round(0.35 * maxNorm);
            this.stream.push_volume();
        }
        this.stream.change_is_muted(Boolean(muted));
    }

    toggleMute() {
        this.setMuted(!this.isMuted);
    }

    raise() {
        const appSystem = Shell.AppSystem.get_default();
        const appId = this.applicationId;
        if (appSystem && appId) {
            const desktopId = appId.endsWith('.desktop') ? appId : `${appId}.desktop`;
            const app = appSystem.lookup_app(desktopId);
            if (app) {
                app.activate();
                return true;
            }
        }

        const needle = this.name.toLowerCase();
        if (needle) {
            for (const actor of global.get_window_actors()) {
                const win = actor.meta_window;
                if (!win)
                    continue;
                const wmClass = (win.get_wm_class() ?? '').toLowerCase();
                const wmInstance = (win.get_wm_class_instance() ?? '').toLowerCase();
                const title = (win.get_title() ?? '').toLowerCase();
                if (wmClass.includes(needle) || needle.includes(wmClass) ||
                    wmInstance.includes(needle) || title.includes(needle)) {
                    Main.activateWindow(win);
                    return true;
                }
            }
        }

        return false;
    }
}

export class AudioManager extends Signals.EventEmitter {
    constructor() {
        super();

        this._destroyed = false;
        this._mixer = Volume.getMixerControl();
        this._mixerSignalIds = [];
        this._streamSignalMap = new Map(); // streamId -> { entry, signalIds }
        this._defaultSink = null;
        this._defaultSinkSignalIds = [];

        this._soundSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.sound'});
        this._allowAmplified = this._soundSettings.get_boolean(ALLOW_AMPLIFIED_KEY);
        this._soundSettingsSignalId = this._soundSettings.connect(
            `changed::${ALLOW_AMPLIFIED_KEY}`,
            () => {
                this._allowAmplified = this._soundSettings.get_boolean(ALLOW_AMPLIFIED_KEY);
                this.emit('changed');
            }
        );

        this._connectMixer();
        this._syncAll();
    }

    _connectMixer() {
        this._mixerSignalIds.push(
            this._mixer.connect('state-changed', () => this._syncAll()),
            this._mixer.connect('default-sink-changed', () => {
                this._bindDefaultSink();
                this.emit('changed');
            }),
            this._mixer.connect('stream-added', (_mixer, id) => {
                this._onStreamAdded(id);
            }),
            this._mixer.connect('stream-removed', (_mixer, id) => {
                this._onStreamRemoved(id);
            }),
            this._mixer.connect('stream-changed', (_mixer, id) => {
                this._onStreamChanged(id);
            })
        );
    }

    _syncAll() {
        if (this._destroyed)
            return;

        this._bindDefaultSink();

        const currentIds = new Set();
        const sinkInputs = this._mixer.get_sink_inputs?.() ?? [];
        for (const stream of sinkInputs) {
            if (!this._isManageableSinkInput(stream))
                continue;
            currentIds.add(stream.id);
            if (!this._streamSignalMap.has(stream.id))
                this._trackStream(stream);
        }

        for (const id of Array.from(this._streamSignalMap.keys())) {
            if (!currentIds.has(id))
                this._untrackStream(id);
        }

        this.emit('changed');
    }

    _isManageableSinkInput(stream) {
        if (!stream || !(stream instanceof Gvc.MixerSinkInput))
            return false;
        if (stream.is_event_stream || stream.is_virtual)
            return false;
        const appId = stream.get_application_id?.() || '';
        if (appId && IGNORED_APP_IDS.has(appId))
            return false;
        const name = (stream.get_name?.() || '').toLowerCase();
        if (name === 'libcanberra' || name === 'gnome shell' ||
            name === 'zctrl music' || name === 'zctrl-local-player' ||
            name === 'zctrl-player' ||
            name === 'zcontroller music' || name === 'zcontroller-local-player' ||
            name === 'zcontroller-player')
            return false;
        return true;
    }

    _trackStream(stream) {
        if (this._streamSignalMap.has(stream.id))
            return;

        const entry = new AudioStreamEntry(stream, this._mixer);
        const signalIds = [
            stream.connect('notify::volume', () => {
                if (!this._destroyed)
                    this.emit('changed');
            }),
            stream.connect('notify::is-muted', () => {
                if (!this._destroyed)
                    this.emit('changed');
            }),
            stream.connect('notify::state', () => {
                if (stream.state === Gvc.MixerStreamState.RUNNING)
                    entry.lastActiveTimestamp = Date.now();
                if (!this._destroyed)
                    this.emit('changed');
            }),
            stream.connect('notify::description', () => {
                if (!this._destroyed)
                    this.emit('changed');
            }),
        ];

        this._streamSignalMap.set(stream.id, {entry, signalIds});
    }

    _untrackStream(id) {
        const tracked = this._streamSignalMap.get(id);
        if (!tracked)
            return;
        for (const sigId of tracked.signalIds) {
            try {
                tracked.entry.stream.disconnect(sigId);
            } catch {
                // Stream already disposed
            }
        }
        this._streamSignalMap.delete(id);
    }

    _onStreamAdded(id) {
        if (this._destroyed)
            return;
        const stream = this._mixer.lookup_stream_id(id);
        if (this._isManageableSinkInput(stream)) {
            this._trackStream(stream);
            this.emit('changed');
        }
    }

    _onStreamRemoved(id) {
        if (this._destroyed)
            return;
        if (this._streamSignalMap.has(id)) {
            this._untrackStream(id);
            this.emit('changed');
        }
    }

    _onStreamChanged(id) {
        if (this._destroyed)
            return;
        const stream = this._mixer.lookup_stream_id(id);
        if (this._isManageableSinkInput(stream)) {
            if (!this._streamSignalMap.has(id))
                this._trackStream(stream);
            this.emit('changed');
        } else if (this._streamSignalMap.has(id)) {
            this._untrackStream(id);
            this.emit('changed');
        }
    }

    _bindDefaultSink() {
        const newSink = this._mixer.get_default_sink?.() ?? null;
        if (newSink === this._defaultSink)
            return;

        this._disconnectDefaultSink();
        this._defaultSink = newSink;

        if (this._defaultSink) {
            this._defaultSinkSignalIds = [
                this._defaultSink.connect('notify::volume', () => {
                    if (!this._destroyed)
                        this.emit('changed');
                }),
                this._defaultSink.connect('notify::is-muted', () => {
                    if (!this._destroyed)
                        this.emit('changed');
                }),
                this._defaultSink.connect('notify::description', () => {
                    if (!this._destroyed)
                        this.emit('changed');
                }),
            ];
        }
    }

    _disconnectDefaultSink() {
        if (!this._defaultSink)
            return;
        for (const sigId of this._defaultSinkSignalIds) {
            try {
                this._defaultSink.disconnect(sigId);
            } catch {
                // Already disposed
            }
        }
        this._defaultSinkSignalIds = [];
        this._defaultSink = null;
    }

    get maxVolumeScale() {
        if (!this._allowAmplified)
            return 1.0;
        const maxNorm = this._mixer.get_vol_max_norm() || 65536;
        const maxAmp = this._mixer.get_vol_max_amplified() || maxNorm;
        return Math.max(1.0, maxAmp / maxNorm);
    }

    getStreams() {
        return Array.from(this._streamSignalMap.values()).map(item => item.entry);
    }

    getStreamById(id) {
        for (const {entry} of this._streamSignalMap.values()) {
            if (entry.id === id)
                return entry;
        }
        return null;
    }

    getDefaultSinkName() {
        if (!this._defaultSink)
            return 'System Output';
        return this._defaultSink.get_description?.() ||
            this._defaultSink.get_name?.() ||
            'System Output';
    }

    getDefaultSinkMuted() {
        return Boolean(this._defaultSink?.is_muted);
    }

    getDefaultSinkVolume() {
        if (!this._defaultSink)
            return 0;
        const maxNorm = this._mixer.get_vol_max_norm() || 65536;
        return this._defaultSink.volume / maxNorm;
    }

    setDefaultSinkVolume(value) {
        if (!this._defaultSink)
            return;
        const maxNorm = this._mixer.get_vol_max_norm() || 65536;
        const clamped = Math.max(0, Math.min(value, this.maxVolumeScale));
        this._defaultSink.volume = Math.round(clamped * maxNorm);
        this._defaultSink.push_volume();
        if (this._defaultSink.is_muted && this._defaultSink.volume > 0)
            this._defaultSink.change_is_muted(false);
    }

    adjustDefaultSinkVolume(delta) {
        this.setDefaultSinkVolume(this.getDefaultSinkVolume() + delta);
    }

    setDefaultSinkMuted(muted) {
        if (!this._defaultSink)
            return;
        if (!muted && this._defaultSink.volume === 0) {
            const maxNorm = this._mixer.get_vol_max_norm() || 65536;
            this._defaultSink.volume = Math.round(0.25 * maxNorm);
            this._defaultSink.push_volume();
        }
        this._defaultSink.change_is_muted(Boolean(muted));
    }

    toggleDefaultSinkMute() {
        this.setDefaultSinkMuted(!this.getDefaultSinkMuted());
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;

        if (this._soundSettings && this._soundSettingsSignalId) {
            this._soundSettings.disconnect(this._soundSettingsSignalId);
            this._soundSettingsSignalId = 0;
        }
        this._soundSettings = null;

        for (const sigId of this._mixerSignalIds) {
            try {
                this._mixer.disconnect(sigId);
            } catch {
                // Ignored
            }
        }
        this._mixerSignalIds = [];

        this._disconnectDefaultSink();

        for (const id of Array.from(this._streamSignalMap.keys()))
            this._untrackStream(id);

        // NOTE: Do NOT call this._mixer.close() because Volume.getMixerControl() is GNOME Shell's shared singleton!
        this._mixer = null;
    }
}
