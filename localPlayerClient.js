import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

const LOCAL_PLAYER_ID = 'local:zctrl';

export class LocalPlayerClient extends Signals.EventEmitter {
    constructor(extensionPath, settings) {
        super();

        this._extensionPath = extensionPath;
        this._settings = settings;
        this._destroyed = false;

        this._proc = null;
        this._stdinStream = null;
        this._stdoutStream = null;
        this._readCancellable = null;
        this._pickerProc = null;
        this._pickerCancellable = null;

        this._folderPath = settings?.get_string('local-music-folder') || '';
        this._shuffle = settings?.get_boolean('local-music-shuffle') || false;
        this._repeat = settings?.get_string('local-music-repeat') || 'all';

        this._tracks = [];
        this._currentIndex = -1;
        this._status = 'Stopped'; // 'Playing' | 'Paused' | 'Stopped'
        this._title = 'ZCtrl Music';
        this._artist = '';
        this._album = '';
        this._artUrl = '';
        this._lengthUs = 0;
        this._positionUs = 0;
        this._positionTimestampMs = GLib.get_monotonic_time() / 1000;
        this._volume = 0.85;
        this._muted = false;
        this._lastActiveTimestamp = 0;
        this._lastError = '';
        this._folderLoadedInDaemon = false;
    }

    // ---- MprisPlayer-compatible identity & playback getters ----

    get id() {
        return LOCAL_PLAYER_ID;
    }

    get busName() {
        return 'zctrl.local.player';
    }

    get identity() {
        return 'ZCtrl Music';
    }

    get desktopEntry() {
        return 'zctrl-player';
    }

    get app() {
        return null;
    }

    get status() {
        return this._status;
    }

    get isPlaying() {
        return this._status === 'Playing';
    }

    get isActiveSession() {
        return this._status === 'Playing' || this._status === 'Paused';
    }

    get hasTracks() {
        return this._tracks.length > 0;
    }

    get hasSavedFolder() {
        const saved = this._folderPath || this._settings?.get_string('local-music-folder') || '';
        return Boolean(saved && GLib.file_test(saved, GLib.FileTest.IS_DIR));
    }

    get canPlay() {
        return this.hasTracks || this.hasSavedFolder;
    }

    get canPause() {
        return this.isPlaying;
    }

    get tracks() {
        return this._tracks;
    }

    get currentIndex() {
        return this._currentIndex;
    }

    get folderPath() {
        return this._folderPath;
    }

    get shuffle() {
        return this._shuffle;
    }

    get repeat() {
        return this._repeat;
    }

    get lastError() {
        return this._lastError;
    }

    get title() {
        return this._title || this._tracks[this._currentIndex]?.title || 'ZCtrl Music';
    }

    get hasTrackTitle() {
        return Boolean(this._tracks[this._currentIndex]);
    }

    get artist() {
        return this._artist;
    }

    get album() {
        return this._album;
    }

    get artUrl() {
        return this._artUrl;
    }

    get lengthUs() {
        return this._lengthUs;
    }

    get positionUs() {
        if (this._status === 'Playing' && this._lengthUs > 0) {
            const elapsedMs = (GLib.get_monotonic_time() / 1000) - this._positionTimestampMs;
            return Math.min(this._lengthUs, Math.max(0, this._positionUs + elapsedMs * 1000));
        }
        return this._positionUs;
    }

    get canSeek() {
        return this._lengthUs > 0 && this.isActiveSession;
    }

    get canGoNext() {
        return this._tracks.length > 1;
    }

    get canGoPrevious() {
        return this._tracks.length > 0;
    }

    get volume() {
        return this._muted ? 0 : this._volume;
    }

    get rawVolume() {
        return this._volume;
    }

    get isMuted() {
        return this._muted;
    }

    get lastActiveTimestamp() {
        return this._lastActiveTimestamp;
    }

    // ---- Lazy daemon lifecycle ----

    ensureFolderLoaded() {
        if (this._destroyed || this._folderLoadedInDaemon)
            return;
        const saved = this._settings?.get_string('local-music-folder') || this._folderPath;
        if (saved && GLib.file_test(saved, GLib.FileTest.IS_DIR)) {
            this._folderPath = saved;
            this._folderLoadedInDaemon = true;
            this._sendCommand({op: 'load-folder', path: saved, autoplay: false});
        }
    }

    _ensureDaemon() {
        if (this._destroyed)
            return false;
        if (this._proc)
            return true;

        const scriptPath = GLib.build_filenamev([this._extensionPath, 'zctrl-player-service']);
        if (!GLib.file_test(scriptPath, GLib.FileTest.IS_REGULAR)) {
            this._lastError = 'Player service script not found';
            return false;
        }

        try {
            const launcher = new Gio.SubprocessLauncher({
                flags: Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE,
            });
            this._proc = launcher.spawnv(['gjs', '-m', scriptPath]);
            this._stdinStream = new Gio.DataOutputStream({
                base_stream: this._proc.get_stdin_pipe(),
            });
            this._stdoutStream = new Gio.DataInputStream({
                base_stream: this._proc.get_stdout_pipe(),
            });
            this._readCancellable = new Gio.Cancellable();
            this._readNextEvent();

            const procRef = this._proc;
            procRef.wait_check_async(null, (proc, res) => {
                try {
                    proc.wait_check_finish(res);
                } catch {
                    // Isolated child exited / crashed — GNOME Shell stays 100% safe!
                }
                if (this._proc === procRef) {
                    this._proc = null;
                    this._stdinStream = null;
                    this._stdoutStream = null;
                    this._folderLoadedInDaemon = false;
                    if (!this._destroyed && this._status !== 'Stopped') {
                        this._status = 'Stopped';
                        this._positionUs = 0;
                        this.emit('changed');
                    }
                }
            });

            // Sync persisted playback preferences immediately
            this._writeRaw({op: 'set-shuffle', shuffle: this._shuffle});
            this._writeRaw({op: 'set-repeat', repeat: this._repeat});
            this._writeRaw({op: 'set-volume', volume: this._volume});
            return true;
        } catch (e) {
            this._lastError = e.message || 'Failed to launch player service';
            this._proc = null;
            return false;
        }
    }

    _writeRaw(payload) {
        if (!this._stdinStream)
            return false;
        try {
            this._stdinStream.put_string(`${JSON.stringify(payload)}\n`, null);
            this._stdinStream.flush(null);
            return true;
        } catch {
            return false;
        }
    }

    _sendCommand(payload) {
        if (!this._ensureDaemon())
            return false;
        return this._writeRaw(payload);
    }

    _readNextEvent() {
        if (this._destroyed || !this._stdoutStream || !this._readCancellable)
            return;
        const cancellable = this._readCancellable;
        this._stdoutStream.read_line_async(GLib.PRIORITY_DEFAULT, cancellable, (stream, res) => {
            if (this._destroyed || cancellable.is_cancelled())
                return;
            try {
                const [line] = stream.read_line_finish_utf8(res);
                if (line === null)
                    return;
                const trimmed = line.trim();
                if (trimmed.length > 0)
                    this._handleDaemonEvent(JSON.parse(trimmed));
                this._readNextEvent();
            } catch {
                // Pipe closed or cancelled; wait_check_async handles cleanup
            }
        });
    }

    _handleDaemonEvent(evt) {
        if (!evt || typeof evt.type !== 'string')
            return;

        if (evt.type === 'playlist') {
            this._folderPath = evt.folderPath || this._folderPath;
            this._tracks = Array.isArray(evt.tracks) ? evt.tracks : [];
            this._lastError = '';
            this.emit('playlist-changed');
            this.emit('changed');
            return;
        }

        if (evt.type === 'state') {
            const prevStatus = this._status;
            this._status = evt.status || 'Stopped';
            this._currentIndex = typeof evt.currentIndex === 'number' ? evt.currentIndex : -1;
            this._folderPath = evt.folderPath ?? this._folderPath;
            this._title = evt.title || 'ZCtrl Music';
            this._artist = evt.artist || '';
            this._album = evt.album || '';
            this._artUrl = evt.artUrl || '';
            this._lengthUs = Number(evt.lengthUs) || 0;
            this._positionUs = Number(evt.positionUs) || 0;
            this._positionTimestampMs = GLib.get_monotonic_time() / 1000;
            if (typeof evt.volume === 'number')
                this._volume = evt.volume;
            if (typeof evt.muted === 'boolean')
                this._muted = evt.muted;
            if (typeof evt.shuffle === 'boolean')
                this._shuffle = evt.shuffle;
            if (typeof evt.repeat === 'string')
                this._repeat = evt.repeat;

            if (this._status === 'Playing' || (prevStatus === 'Playing' && this._status === 'Paused'))
                this._lastActiveTimestamp = Date.now();

            this.emit('changed');
            return;
        }

        if (evt.type === 'position') {
            this._positionUs = Number(evt.positionUs) || 0;
            if (typeof evt.lengthUs === 'number' && evt.lengthUs > 0)
                this._lengthUs = evt.lengthUs;
            this._positionTimestampMs = GLib.get_monotonic_time() / 1000;
            this.emit('position-changed');
            return;
        }

        if (evt.type === 'error') {
            this._lastError = evt.message || 'Playback error';
            this.emit('changed');
        }
    }

    // ---- Library & Picker actions (isolated zenity subprocess) ----

    loadFolder(folderPath, autoplay = false) {
        if (!folderPath)
            return;
        this._folderPath = folderPath;
        this._folderLoadedInDaemon = true;
        this._settings?.set_string('local-music-folder', folderPath);
        this._sendCommand({op: 'load-folder', path: folderPath, autoplay});
    }

    loadFiles(paths, autoplay = true) {
        if (!Array.isArray(paths) || paths.length === 0)
            return;
        this._folderLoadedInDaemon = true;
        this._sendCommand({op: 'load-files', paths, autoplay});
    }

    getDefaultMusicDir() {
        const musicDir = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_MUSIC);
        if (musicDir && GLib.file_test(musicDir, GLib.FileTest.IS_DIR))
            return musicDir;
        const fallback = GLib.build_filenamev([GLib.get_home_dir(), 'Music']);
        return GLib.file_test(fallback, GLib.FileTest.IS_DIR) ? fallback : '';
    }

    pickFolder() {
        const startDir = (this._folderPath && GLib.file_test(this._folderPath, GLib.FileTest.IS_DIR))
            ? this._folderPath
            : (this.getDefaultMusicDir() || GLib.get_home_dir());

        this._runZenity(
            [
                'zenity',
                '--file-selection',
                '--directory',
                '--title=Choose Music Folder — ZCtrl',
                `--filename=${startDir.endsWith('/') ? startDir : `${startDir}/`}`,
            ],
            output => {
                const chosen = output.trim();
                if (chosen)
                    this.loadFolder(chosen, false);
            }
        );
    }

    pickFiles() {
        const startDir = (this._folderPath && GLib.file_test(this._folderPath, GLib.FileTest.IS_DIR))
            ? this._folderPath
            : (this.getDefaultMusicDir() || GLib.get_home_dir());

        this._runZenity(
            [
                'zenity',
                '--file-selection',
                '--multiple',
                '--separator=\n',
                '--title=Select Audio Files — ZCtrl',
                `--filename=${startDir.endsWith('/') ? startDir : `${startDir}/`}`,
                '--file-filter=Audio Files (MP3, FLAC, WAV, OGG, M4A, OPUS) | *.mp3 *.MP3 *.flac *.FLAC *.wav *.WAV *.ogg *.OGG *.oga *.opus *.m4a *.M4A *.aac *.wma *.aiff',
                '--file-filter=All Files | *',
            ],
            output => {
                const paths = output
                    .split('\n')
                    .map(s => s.trim())
                    .filter(Boolean);
                if (paths.length > 0)
                    this.loadFiles(paths, true);
            }
        );
    }

    _runZenity(argv, onResult) {
        this._cancelPicker();
        try {
            const proc = Gio.Subprocess.new(
                argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE
            );
            const cancellable = new Gio.Cancellable();
            this._pickerProc = proc;
            this._pickerCancellable = cancellable;

            proc.communicate_utf8_async(null, cancellable, (p, res) => {
                if (this._pickerProc === p) {
                    this._pickerProc = null;
                    this._pickerCancellable = null;
                }
                if (this._destroyed || cancellable.is_cancelled())
                    return;
                try {
                    const [ok, stdout] = p.communicate_utf8_finish(res);
                    if (ok && p.get_successful() && stdout)
                        onResult(stdout);
                } catch {
                    // User cancelled dialog or zenity unavailable
                }
            });
        } catch (e) {
            this._lastError = 'File picker (zenity) unavailable';
            this.emit('changed');
        }
    }

    _cancelPicker() {
        if (this._pickerCancellable) {
            this._pickerCancellable.cancel();
            this._pickerCancellable = null;
        }
        if (this._pickerProc) {
            try {
                this._pickerProc.force_exit();
            } catch {
                // Already exited
            }
            this._pickerProc = null;
        }
    }

    // ---- Playback controls ----

    playIndex(index) {
        this._lastActiveTimestamp = Date.now();
        this._sendCommand({op: 'play-index', index});
    }

    playPause() {
        if (!this.hasTracks) {
            const saved = this._folderPath || this._settings?.get_string('local-music-folder') || '';
            if (saved && GLib.file_test(saved, GLib.FileTest.IS_DIR)) {
                this._folderPath = saved;
                this._folderLoadedInDaemon = true;
                this._lastActiveTimestamp = Date.now();
                this._sendCommand({op: 'load-folder', path: saved, autoplay: true});
            }
            return;
        }
        this._lastActiveTimestamp = Date.now();
        this._sendCommand({op: 'play-pause'});
    }

    play() {
        if (!this.hasTracks) {
            const saved = this._folderPath || this._settings?.get_string('local-music-folder') || '';
            if (saved && GLib.file_test(saved, GLib.FileTest.IS_DIR)) {
                this._folderPath = saved;
                this._folderLoadedInDaemon = true;
                this._lastActiveTimestamp = Date.now();
                this._sendCommand({op: 'load-folder', path: saved, autoplay: true});
            }
            return;
        }
        this._lastActiveTimestamp = Date.now();
        this._sendCommand({op: 'play'});
    }

    pause() {
        if (this._proc)
            this._sendCommand({op: 'pause'});
    }

    stop() {
        if (this._proc)
            this._sendCommand({op: 'stop'});
    }

    next() {
        if (this.hasTracks)
            this._sendCommand({op: 'next'});
    }

    previous() {
        if (this.hasTracks)
            this._sendCommand({op: 'previous'});
    }

    setPosition(positionUs) {
        if (!this._proc)
            return;
        this._positionUs = Math.max(0, positionUs);
        this._positionTimestampMs = GLib.get_monotonic_time() / 1000;
        this._sendCommand({op: 'seek', positionUs: this._positionUs});
    }

    refreshPosition() {
        if (this._proc && this.isActiveSession)
            this._writeRaw({op: 'query-position'});
    }

    setVolume(vol) {
        const clamped = Math.max(0, Math.min(1.5, vol));
        this._volume = clamped;
        if (clamped > 0.001 && this._muted)
            this._muted = false;
        if (this._proc)
            this._writeRaw({op: 'set-volume', volume: clamped});
        this.emit('changed');
    }

    toggleMute() {
        this._muted = !this._muted;
        if (this._proc)
            this._writeRaw({op: 'set-muted', muted: this._muted});
        this.emit('changed');
    }

    toggleShuffle() {
        this._shuffle = !this._shuffle;
        this._settings?.set_boolean('local-music-shuffle', this._shuffle);
        if (this._proc)
            this._writeRaw({op: 'set-shuffle', shuffle: this._shuffle});
        this.emit('changed');
    }

    cycleRepeat() {
        const order = ['off', 'all', 'one'];
        const idx = order.indexOf(this._repeat);
        this._repeat = order[(idx + 1) % order.length];
        this._settings?.set_string('local-music-repeat', this._repeat);
        if (this._proc)
            this._writeRaw({op: 'set-repeat', repeat: this._repeat});
        this.emit('changed');
    }

    raise() {
        return false;
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;

        this._cancelPicker();

        if (this._readCancellable) {
            this._readCancellable.cancel();
            this._readCancellable = null;
        }

        if (this._proc) {
            this._writeRaw({op: 'quit'});
            try {
                this._stdinStream?.close(null);
            } catch {
                // Ignore
            }
            try {
                this._proc.force_exit();
            } catch {
                // Already exited
            }
            this._proc = null;
        }

        this._stdinStream = null;
        this._stdoutStream = null;
        this._settings = null;
    }
}
