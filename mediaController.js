import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';
import {MprisManager} from './mprisManager.js';
import {AudioManager} from './audioManager.js';

const VOLUME_STEP = 0.05;

function normalizeToken(value) {
    return (value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function streamMatchesPlayer(stream, player) {
    const tokens = new Set();
    const busBase = player.busName.replace('org.mpris.MediaPlayer2.', '').split('.')[0];
    if (busBase)
        tokens.add(normalizeToken(busBase));
    if (player.desktopEntry)
        tokens.add(normalizeToken(player.desktopEntry));
    if (player.identity)
        tokens.add(normalizeToken(player.identity));

    // Handle Chrome / Chromium aliases
    if (tokens.has('chromium') || tokens.has('chrome') || tokens.has('googlechrome')) {
        tokens.add('chromium');
        tokens.add('chrome');
        tokens.add('googlechrome');
    }

    // Handle ZCtrl local player aliases
    if (tokens.has('zctrl') || tokens.has('zctrlplayer') || tokens.has('zctrlmusic') ||
        tokens.has('zcontroller') || tokens.has('zcontrollerplayer') || tokens.has('zcontrollermusic')) {
        tokens.add('zctrl');
        tokens.add('zctrlplayer');
        tokens.add('zctrllocalplayer');
        tokens.add('zctrlmusic');
        tokens.add('zcontroller');
        tokens.add('zcontrollerplayer');
        tokens.add('zcontrollerlocalplayer');
        tokens.add('zcontrollermusic');
    }

    const streamFields = [
        normalizeToken(stream.name),
        normalizeToken(stream.description),
        normalizeToken(stream.applicationId),
    ].filter(Boolean);

    for (const field of streamFields) {
        for (const token of tokens) {
            if (token.length >= 3 && (field.includes(token) || token.includes(field)))
                return true;
        }
    }
    return false;
}

export class MediaController extends Signals.EventEmitter {
    constructor(localPlayer = null) {
        super();

        this._destroyed = false;
        this._manualTargetId = null; // null => Auto mode; 'master' | 'mpris:...' | 'local:...' | 'stream:...'

        this._mpris = new MprisManager();
        this._audio = new AudioManager();
        this._localPlayer = localPlayer;

        this._mpris.connect('players-changed', () => {
            if (!this._destroyed)
                this.emit('changed');
        });
        this._mpris.connect('position-changed', (_mgr, player) => {
            if (!this._destroyed)
                this.emit('position-changed', player);
        });
        this._audio.connect('changed', () => {
            if (!this._destroyed)
                this.emit('changed');
        });

        if (this._localPlayer) {
            this._localChangedId = this._localPlayer.connect('changed', () => {
                if (!this._destroyed)
                    this.emit('changed');
            });
            this._localPosChangedId = this._localPlayer.connect('position-changed', () => {
                if (!this._destroyed)
                    this.emit('position-changed', this._localPlayer);
            });
        } else {
            this._localChangedId = 0;
            this._localPosChangedId = 0;
        }
    }

    get localPlayer() {
        return this._localPlayer;
    }

    playLocalTrack(index) {
        if (!this._localPlayer)
            return;
        if (this._manualTargetId !== null && this._manualTargetId !== this._localPlayer.id)
            this._manualTargetId = this._localPlayer.id;
        this._localPlayer.playIndex(index);
    }

    playPauseLocal() {
        if (!this._localPlayer)
            return;
        this._localPlayer.ensureFolderLoaded();
        if (this._manualTargetId !== null && this._manualTargetId !== this._localPlayer.id)
            this._manualTargetId = this._localPlayer.id;
        this._localPlayer.playPause();
    }

    seekActiveBy(offsetUs) {
        const target = this.getActiveTarget();
        if (target.type !== 'mpris')
            return;
        if (target.player === this._localPlayer) {
            if (this._localPlayer.canSeek)
                this._localPlayer.setPosition(this._localPlayer.positionUs + offsetUs);
            return;
        }
        if (target.player.canSeek)
            target.player.seekBy(offsetUs);
    }

    get isAutoMode() {
        return this._manualTargetId === null;
    }

    get manualTargetId() {
        return this._manualTargetId;
    }

    get maxVolumeScale() {
        return this._audio.maxVolumeScale;
    }

    setAutoMode() {
        if (this._manualTargetId !== null) {
            this._manualTargetId = null;
            this.emit('changed');
        }
    }

    selectTarget(targetId) {
        this._manualTargetId = targetId;
        this.emit('changed');
    }

    _isUsableMprisPlayer(player) {
        if (!player)
            return false;
        if (player === this._localPlayer)
            return player.isActiveSession || player.hasTracks || player.hasSavedFolder;
        // Ignore ghost browser MPRIS instances (e.g. Chrome after closing/stopping media)
        // that remain on D-Bus with Stopped + CanPlay=false + CanPause=false.
        if (player.status === 'Stopped' && !player.canPlay && !player.canPause)
            return false;
        return true;
    }

    getMprisPlayers() {
        const players = this._mpris.getPlayers().filter(
            p => this._isUsableMprisPlayer(p) || this._manualTargetId === p.id
        );
        if (this._localPlayer && (
            this._localPlayer.isActiveSession ||
            this._localPlayer.hasTracks ||
            this._manualTargetId === this._localPlayer.id
        ))
            players.push(this._localPlayer);
        return players;
    }

    getAudioStreams() {
        const streams = this._audio.getStreams();
        if (!this._localPlayer)
            return streams;
        return streams.filter(s => !streamMatchesPlayer(s, this._localPlayer));
    }

    findMatchingStreamForPlayer(player) {
        if (player === this._localPlayer)
            return null;
        const streams = this._audio.getStreams();
        // Prefer running streams first
        const runningMatch = streams.find(s => s.isRunning && streamMatchesPlayer(s, player));
        if (runningMatch)
            return runningMatch;
        return streams.find(s => streamMatchesPlayer(s, player)) ?? null;
    }

    getNonMprisStreams() {
        const players = this.getMprisPlayers();
        return this._audio.getStreams().filter(stream =>
            !players.some(player => streamMatchesPlayer(stream, player)) &&
            !(this._localPlayer && streamMatchesPlayer(stream, this._localPlayer))
        );
    }

    /**
     * Resolves the current active target controlled by the 4 top-bar buttons:
     *   { type: 'mpris', id, player, linkedStream }
     * | { type: 'stream', id, stream }
     * | { type: 'master', id: 'master' }
     */
    getActiveTarget() {
        const players = this.getMprisPlayers();

        // 1. Respect manual selection while that target still exists
        if (this._manualTargetId === 'master')
            return {type: 'master', id: 'master'};

        if (this._localPlayer && this._manualTargetId === this._localPlayer.id) {
            if (this._localPlayer.isActiveSession || this._localPlayer.canPlay) {
                return {
                    type: 'mpris',
                    id: this._localPlayer.id,
                    player: this._localPlayer,
                    linkedStream: null,
                };
            }
            this._manualTargetId = null;
        } else if (this._manualTargetId?.startsWith('mpris:')) {
            const player = this._mpris.getPlayerById(this._manualTargetId);
            if (player) {
                return {
                    type: 'mpris',
                    id: player.id,
                    player,
                    linkedStream: this.findMatchingStreamForPlayer(player),
                };
            }
            // Selected player vanished -> return to Auto mode
            this._manualTargetId = null;
        } else if (this._manualTargetId?.startsWith('stream:')) {
            const stream = this._audio.getStreamById(this._manualTargetId);
            if (stream)
                return {type: 'stream', id: stream.id, stream};
            this._manualTargetId = null;
        }

        // 2. Auto mode priority:
        //    (a) Currently Playing MPRIS player (most recently active)
        const playingMpris = players
            .filter(p => p.isPlaying)
            .sort((a, b) => b.lastActiveTimestamp - a.lastActiveTimestamp);
        if (playingMpris.length > 0) {
            const player = playingMpris[0];
            return {
                type: 'mpris',
                id: player.id,
                player,
                linkedStream: this.findMatchingStreamForPlayer(player),
            };
        }

        //    (b) Any active unmuted non-MPRIS audio stream currently outputting sound
        const nonMprisStreams = this.getNonMprisStreams();
        const activeNonMpris = nonMprisStreams
            .filter(s => s.isActiveUnmuted)
            .sort((a, b) => b.lastActiveTimestamp - a.lastActiveTimestamp);
        if (activeNonMpris.length > 0)
            return {type: 'stream', id: activeNonMpris[0].id, stream: activeNonMpris[0]};

        //    (c) Most recently active Paused MPRIS player (so Play resumes it immediately!)
        const pausedMpris = players
            .filter(p => p.status === 'Paused')
            .sort((a, b) => b.lastActiveTimestamp - a.lastActiveTimestamp);
        if (pausedMpris.length > 0) {
            const player = pausedMpris[0];
            return {
                type: 'mpris',
                id: player.id,
                player,
                linkedStream: this.findMatchingStreamForPlayer(player),
            };
        }

        //    (d) Any muted/idle non-MPRIS audio stream (so user can unmute/resume it!)
        if (nonMprisStreams.length > 0)
            return {type: 'stream', id: nonMprisStreams[0].id, stream: nonMprisStreams[0]};

        //    (e) Any remaining usable MPRIS player (e.g. Stopped with CanPlay=true, like Local Music or VLC)
        const usableStopped = players
            .filter(p => this._isUsableMprisPlayer(p))
            .sort((a, b) => b.lastActiveTimestamp - a.lastActiveTimestamp);
        if (usableStopped.length > 0) {
            const player = usableStopped[0];
            return {
                type: 'mpris',
                id: player.id,
                player,
                linkedStream: this.findMatchingStreamForPlayer(player),
            };
        }

        //    (e2) Saved Local Music folder ready to play on demand
        if (this._localPlayer?.canPlay) {
            return {
                type: 'mpris',
                id: this._localPlayer.id,
                player: this._localPlayer,
                linkedStream: null,
            };
        }

        //    (f) Master device output sink (always available!)
        return {type: 'master', id: 'master'};
    }

    /**
     * Returns true when audio is actively playing/outputting on the active target
     * (determines Pause vs Play icon on the top bar).
     */
    isActivePlaying() {
        const target = this.getActiveTarget();
        if (target.type === 'mpris')
            return target.player.isPlaying;
        if (target.type === 'stream')
            return !target.stream.isMuted;
        return false;
    }

    /**
     * Returns true if ANY sound source across the entire device is currently active.
     */
    hasAnyActiveAudio() {
        if (this.getMprisPlayers().some(p => p.isPlaying))
            return true;
        if (!this._audio.getDefaultSinkMuted() && this.getNonMprisStreams().some(s => s.isActiveUnmuted))
            return true;
        return false;
    }

    getActiveSummary() {
        const target = this.getActiveTarget();
        if (target.type === 'mpris') {
            const p = target.player;
            const subtitle = [p.artist, p.album].filter(Boolean).join(' · ');
            return {
                target,
                title: p.title,
                subtitle: subtitle || p.identity,
                sourceName: p.identity,
                statusText: p.status,
                isPlaying: p.isPlaying,
                artUrl: p.artUrl,
                app: p.app,
                iconName: 'audio-x-generic-symbolic',
                prevTooltip: p.canGoPrevious ? 'Previous track' : (p.canSeek ? 'Rewind 10s' : 'Previous'),
                playTooltip: p.isPlaying ? `Pause (${p.identity})` : `Play (${p.identity})`,
                nextTooltip: p.canGoNext ? 'Next track' : (p.canSeek ? 'Forward 10s' : 'Next'),
                showTooltip: `${p.title} — ${p.identity}`,
            };
        }

        if (target.type === 'stream') {
            const s = target.stream;
            const stateText = s.isMuted ? 'Muted' : (s.isRunning ? 'Playing Audio' : 'Audio Ready');
            return {
                target,
                title: s.name,
                subtitle: s.description || 'Device Audio Stream',
                sourceName: s.name,
                statusText: stateText,
                isPlaying: !s.isMuted,
                artUrl: '',
                app: null,
                iconName: s.iconName,
                prevTooltip: `Volume Down (${s.name})`,
                playTooltip: s.isMuted ? `Unmute (${s.name})` : `Mute (${s.name})`,
                nextTooltip: `Volume Up (${s.name})`,
                showTooltip: `${s.name} · ${stateText}`,
            };
        }

        const sinkName = this._audio.getDefaultSinkName();
        const muted = this._audio.getDefaultSinkMuted();
        const pct = Math.round(this._audio.getDefaultSinkVolume() * 100);
        return {
            target,
            title: 'No Media Playing',
            subtitle: sinkName,
            sourceName: sinkName,
            statusText: muted ? 'Muted' : `Volume ${pct}%`,
            isPlaying: false,
            artUrl: '',
            app: null,
            iconName: muted ? 'audio-volume-muted-symbolic' : 'audio-speakers-symbolic',
            prevTooltip: 'Master Volume Down',
            playTooltip: muted ? 'Unmute Device Output' : 'Mute Device Output',
            nextTooltip: 'Master Volume Up',
            showTooltip: `Device Output · ${sinkName} (${muted ? 'Muted' : `${pct}%`})`,
        };
    }

    // ---- Top-bar 4-button actions ----

    playPause() {
        const target = this.getActiveTarget();
        if (target.type === 'mpris') {
            target.player.playPause();
            return;
        }
        if (target.type === 'stream') {
            target.stream.toggleMute();
            return;
        }
        this._audio.toggleDefaultSinkMute();
    }

    previous() {
        const target = this.getActiveTarget();
        if (target.type === 'mpris') {
            target.player.previous();
            return;
        }
        if (target.type === 'stream') {
            target.stream.adjustVolume(-VOLUME_STEP, this.maxVolumeScale);
            return;
        }
        this._audio.adjustDefaultSinkVolume(-VOLUME_STEP);
    }

    next() {
        const target = this.getActiveTarget();
        if (target.type === 'mpris') {
            target.player.next();
            return;
        }
        if (target.type === 'stream') {
            target.stream.adjustVolume(VOLUME_STEP, this.maxVolumeScale);
            return;
        }
        this._audio.adjustDefaultSinkVolume(VOLUME_STEP);
    }

    stopActive() {
        const target = this.getActiveTarget();
        if (target.type === 'mpris')
            target.player.stop();
        else if (target.type === 'stream')
            target.stream.setMuted(true);
        else
            this._audio.setDefaultSinkMuted(true);
    }

    raiseActive() {
        const target = this.getActiveTarget();
        if (target.type === 'mpris')
            return target.player.raise();
        if (target.type === 'stream')
            return target.stream.raise();
        return false;
    }

    adjustActiveVolume(delta) {
        const target = this.getActiveTarget();
        if (target.type === 'mpris') {
            if (target.linkedStream) {
                target.linkedStream.adjustVolume(delta, this.maxVolumeScale);
            } else {
                target.player.setVolume(target.player.volume + delta);
            }
            return;
        }
        if (target.type === 'stream') {
            target.stream.adjustVolume(delta, this.maxVolumeScale);
            return;
        }
        this._audio.adjustDefaultSinkVolume(delta);
    }

    getActiveVolume() {
        const target = this.getActiveTarget();
        if (target.type === 'mpris') {
            if (target.player === this._localPlayer) {
                return {
                    volume: this._localPlayer.rawVolume,
                    muted: this._localPlayer.isMuted,
                    maxScale: 1.0,
                };
            }
            if (target.linkedStream) {
                return {
                    volume: target.linkedStream.volumeNormalized,
                    muted: target.linkedStream.isMuted,
                    maxScale: this.maxVolumeScale,
                };
            }
            return {
                volume: target.player.volume,
                muted: target.player.volume <= 0.001,
                maxScale: 1.0,
            };
        }
        if (target.type === 'stream') {
            return {
                volume: target.stream.volumeNormalized,
                muted: target.stream.isMuted,
                maxScale: this.maxVolumeScale,
            };
        }
        return {
            volume: this._audio.getDefaultSinkVolume(),
            muted: this._audio.getDefaultSinkMuted(),
            maxScale: this.maxVolumeScale,
        };
    }

    setActiveVolume(value) {
        const target = this.getActiveTarget();
        if (target.type === 'mpris') {
            if (target.linkedStream)
                target.linkedStream.setVolumeNormalized(value, this.maxVolumeScale);
            else
                target.player.setVolume(value);
            return;
        }
        if (target.type === 'stream') {
            target.stream.setVolumeNormalized(value, this.maxVolumeScale);
            return;
        }
        this._audio.setDefaultSinkVolume(value);
    }

    toggleActiveMute() {
        const target = this.getActiveTarget();
        if (target.type === 'mpris') {
            if (target.player === this._localPlayer) {
                this._localPlayer.toggleMute();
            } else if (target.linkedStream) {
                target.linkedStream.toggleMute();
            } else {
                const muted = target.player.volume <= 0.001;
                target.player.setVolume(muted ? 0.5 : 0.0);
            }
            return;
        }
        if (target.type === 'stream') {
            target.stream.toggleMute();
            return;
        }
        this._audio.toggleDefaultSinkMute();
    }

    // ---- Master device audio helpers ----

    getDefaultSinkName() {
        return this._audio.getDefaultSinkName();
    }

    getDefaultSinkMuted() {
        return this._audio.getDefaultSinkMuted();
    }

    getDefaultSinkVolume() {
        return this._audio.getDefaultSinkVolume();
    }

    setDefaultSinkVolume(value) {
        this._audio.setDefaultSinkVolume(value);
    }

    toggleDefaultSinkMute() {
        this._audio.toggleDefaultSinkMute();
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;

        if (this._localPlayer) {
            if (this._localChangedId)
                this._localPlayer.disconnect(this._localChangedId);
            if (this._localPosChangedId)
                this._localPlayer.disconnect(this._localPosChangedId);
            this._localChangedId = 0;
            this._localPosChangedId = 0;
            this._localPlayer = null;
        }

        this._mpris?.destroy();
        this._mpris = null;

        this._audio?.destroy();
        this._audio = null;
    }
}
