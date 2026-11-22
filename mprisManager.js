import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_OBJECT_PATH = '/org/mpris/MediaPlayer2';
const MPRIS_PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';
const DEFAULT_SEEK_STEP_US = 10_000_000; // 10 seconds in microseconds

const DBUS_IFACE_XML = `
<node>
  <interface name="org.freedesktop.DBus">
    <method name="ListNames">
      <arg type="as" direction="out" name="names"/>
    </method>
    <signal name="NameOwnerChanged">
      <arg type="s" name="name"/>
      <arg type="s" name="old_owner"/>
      <arg type="s" name="new_owner"/>
    </signal>
  </interface>
</node>`;

const PROPERTIES_IFACE_XML = `
<node>
  <interface name="org.freedesktop.DBus.Properties">
    <method name="Get">
      <arg type="s" direction="in" name="interface_name"/>
      <arg type="s" direction="in" name="property_name"/>
      <arg type="v" direction="out" name="value"/>
    </method>
    <method name="Set">
      <arg type="s" direction="in" name="interface_name"/>
      <arg type="s" direction="in" name="property_name"/>
      <arg type="v" direction="in" name="value"/>
    </method>
  </interface>
</node>`;

const MPRIS_ROOT_IFACE_XML = `
<node>
  <interface name="org.mpris.MediaPlayer2">
    <method name="Raise"/>
    <method name="Quit"/>
    <property name="CanRaise" type="b" access="read"/>
    <property name="CanQuit" type="b" access="read"/>
    <property name="Identity" type="s" access="read"/>
    <property name="DesktopEntry" type="s" access="read"/>
  </interface>
</node>`;

const MPRIS_PLAYER_IFACE_XML = `
<node>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="Next"/>
    <method name="Previous"/>
    <method name="Pause"/>
    <method name="PlayPause"/>
    <method name="Stop"/>
    <method name="Play"/>
    <method name="Seek">
      <arg type="x" direction="in" name="Offset"/>
    </method>
    <method name="SetPosition">
      <arg type="o" direction="in" name="TrackId"/>
      <arg type="x" direction="in" name="Position"/>
    </method>
    <signal name="Seeked">
      <arg type="x" name="Position"/>
    </signal>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="Volume" type="d" access="readwrite"/>
    <property name="Position" type="x" access="read"/>
    <property name="Rate" type="d" access="readwrite"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
    <property name="CanPlay" type="b" access="read"/>
    <property name="CanPause" type="b" access="read"/>
    <property name="CanSeek" type="b" access="read"/>
    <property name="CanControl" type="b" access="read"/>
  </interface>
</node>`;

const DBusProxy = Gio.DBusProxy.makeProxyWrapper(DBUS_IFACE_XML);
const PropertiesProxy = Gio.DBusProxy.makeProxyWrapper(PROPERTIES_IFACE_XML);
const MprisRootProxy = Gio.DBusProxy.makeProxyWrapper(MPRIS_ROOT_IFACE_XML);
const MprisPlayerProxy = Gio.DBusProxy.makeProxyWrapper(MPRIS_PLAYER_IFACE_XML);

function cleanBusIdentity(busName) {
    const raw = busName.replace(MPRIS_PREFIX, '').split('.')[0];
    if (!raw)
        return 'Media Player';
    return raw.charAt(0).toUpperCase() + raw.slice(1);
}

export class MprisPlayer extends Signals.EventEmitter {
    constructor(busName) {
        super();

        this.busName = busName;
        this.id = `mpris:${busName}`;
        this._destroyed = false;
        this._lastActiveTimestamp = Date.now();
        this._positionUs = 0;
        this._positionTimestampMs = Date.now();

        this._identity = cleanBusIdentity(busName);
        this._desktopEntry = '';
        this._app = null;

        this._status = 'Stopped';
        this._title = '';
        this._artist = '';
        this._album = '';
        this._artUrl = '';
        this._trackId = null;
        this._lengthUs = 0;
        this._volume = 1.0;
        this._rate = 1.0;

        this._canControl = true;
        this._canPlay = true;
        this._canPause = true;
        this._canGoNext = false;
        this._canGoPrevious = false;
        this._canSeek = false;
        this._canRaise = false;

        this._rootProxy = null;
        this._playerProxy = null;
        this._propsProxy = null;
        this._rootSignalIds = [];
        this._playerSignalIds = [];
        this._seekedSignalId = 0;

        this._initProxies();
    }

    _initProxies() {
        try {
            this._rootProxy = new MprisRootProxy(
                Gio.DBus.session,
                this.busName,
                MPRIS_OBJECT_PATH,
                (proxy, error) => {
                    if (this._destroyed)
                        return;
                    if (error) {
                        console.debug(`[ZCtrl] Root proxy error for ${this.busName}: ${error.message}`);
                        return;
                    }
                    this._onRootProxyReady();
                }
            );

            this._playerProxy = new MprisPlayerProxy(
                Gio.DBus.session,
                this.busName,
                MPRIS_OBJECT_PATH,
                (proxy, error) => {
                    if (this._destroyed)
                        return;
                    if (error) {
                        console.debug(`[ZCtrl] Player proxy error for ${this.busName}: ${error.message}`);
                        this.destroy();
                        return;
                    }
                    this._onPlayerProxyReady();
                }
            );

            this._propsProxy = new PropertiesProxy(
                Gio.DBus.session,
                this.busName,
                MPRIS_OBJECT_PATH,
                () => {}
            );
        } catch (error) {
            console.error(`[ZCtrl] Failed creating MPRIS proxies for ${this.busName}: ${error}`);
            this.destroy();
        }
    }

    _onRootProxyReady() {
        if (this._destroyed || !this._rootProxy)
            return;

        if (!this._rootProxy.g_name_owner) {
            this.destroy();
            return;
        }

        this._rootSignalIds.push(
            this._rootProxy.connect('notify::g-name-owner', () => {
                if (!this._rootProxy?.g_name_owner)
                    this.destroy();
            }),
            this._rootProxy.connect('g-properties-changed', () => {
                this._syncRootProperties();
                this.emit('changed');
            })
        );

        this._syncRootProperties();
        this.emit('changed');
    }

    _onPlayerProxyReady() {
        if (this._destroyed || !this._playerProxy)
            return;

        if (!this._playerProxy.g_name_owner) {
            this.destroy();
            return;
        }

        this._playerSignalIds.push(
            this._playerProxy.connect('notify::g-name-owner', () => {
                if (!this._playerProxy?.g_name_owner)
                    this.destroy();
            }),
            this._playerProxy.connect('g-properties-changed', () => {
                this._syncPlayerProperties();
            })
        );

        this._seekedSignalId = this._playerProxy.connectSignal('Seeked', (_proxy, _sender, [posUs]) => {
            if (typeof posUs === 'number' && Number.isFinite(posUs)) {
                this._positionUs = Math.max(0, posUs);
                this._positionTimestampMs = Date.now();
                this.emit('position-changed');
            }
        });

        this._syncPlayerProperties();
        this.refreshPosition();
    }

    _syncRootProperties() {
        if (!this._rootProxy)
            return;

        if (typeof this._rootProxy.Identity === 'string' && this._rootProxy.Identity.trim())
            this._identity = this._rootProxy.Identity.trim();

        if (typeof this._rootProxy.DesktopEntry === 'string')
            this._desktopEntry = this._rootProxy.DesktopEntry.trim();

        this._canRaise = Boolean(this._rootProxy.CanRaise);
        this._app = this._resolveShellApp();
    }

    _resolveShellApp() {
        const appSystem = Shell.AppSystem.get_default();
        if (!appSystem)
            return null;

        const candidates = [];
        if (this._desktopEntry) {
            candidates.push(`${this._desktopEntry}.desktop`);
            candidates.push(this._desktopEntry);
        }

        const busBase = this.busName.replace(MPRIS_PREFIX, '').split('.')[0].toLowerCase();
        if (busBase === 'chromium' || busBase === 'chrome') {
            candidates.push('google-chrome.desktop', 'chromium.desktop', 'chromium_chromium.desktop', 'brave-browser.desktop');
        } else if (busBase === 'firefox') {
            candidates.push('firefox_firefox.desktop', 'firefox.desktop');
        } else if (busBase) {
            candidates.push(`${busBase}.desktop`);
        }

        for (const desktopId of candidates) {
            const app = appSystem.lookup_app(desktopId);
            if (app)
                return app;
        }

        // Match against running apps by name or id substring
        const identityLower = this._identity.toLowerCase();
        for (const app of appSystem.get_running()) {
            const appName = (app.get_name() ?? '').toLowerCase();
            const appId = (app.get_id() ?? '').toLowerCase();
            if ((busBase && (appId.includes(busBase) || appName.includes(busBase))) ||
                (identityLower && (appName.includes(identityLower) || identityLower.includes(appName)))) {
                return app;
            }
        }

        return null;
    }

    _syncPlayerProperties() {
        if (this._destroyed || !this._playerProxy)
            return;

        const prevStatus = this._status;
        const prevTrackId = this._trackId;
        const prevTitle = this._title;

        this._status = this._playerProxy.PlaybackStatus || 'Stopped';
        if ((this._status === 'Playing' && prevStatus !== 'Playing') ||
            (this._status === 'Paused' && prevStatus === 'Playing'))
            this._lastActiveTimestamp = Date.now();

        this._canControl = this._playerProxy.CanControl !== false;
        this._canPlay = this._playerProxy.CanPlay !== false;
        this._canPause = this._playerProxy.CanPause !== false;
        this._canGoNext = Boolean(this._playerProxy.CanGoNext);
        this._canGoPrevious = Boolean(this._playerProxy.CanGoPrevious);
        this._canSeek = Boolean(this._playerProxy.CanSeek);

        const vol = this._playerProxy.Volume;
        if (typeof vol === 'number' && Number.isFinite(vol) && vol >= 0)
            this._volume = Math.min(vol, 1.5);

        const rate = this._playerProxy.Rate;
        if (typeof rate === 'number' && Number.isFinite(rate) && rate > 0)
            this._rate = rate;
        else
            this._rate = 1.0;

        const rawMeta = this._playerProxy.Metadata || {};
        const metadata = {};
        for (const key of Object.keys(rawMeta)) {
            try {
                metadata[key] = rawMeta[key].deepUnpack();
            } catch {
                // Ignore malformed metadata entry
            }
        }

        let title = typeof metadata['xesam:title'] === 'string' ? metadata['xesam:title'].trim() : '';
        if (!title && typeof metadata['xesam:url'] === 'string') {
            try {
                const decoded = decodeURIComponent(metadata['xesam:url'].split('/').pop() ?? '');
                title = decoded.replace(/\.[^.]+$/, '');
            } catch {
                title = '';
            }
        }
        this._title = title;

        const rawArtists = metadata['xesam:artist'];
        if (Array.isArray(rawArtists)) {
            this._artist = rawArtists
                .filter(item => typeof item === 'string' && item.trim().length > 0)
                .join(', ');
        } else if (typeof rawArtists === 'string') {
            this._artist = rawArtists.trim();
        } else {
            this._artist = '';
        }

        this._album = typeof metadata['xesam:album'] === 'string' ? metadata['xesam:album'].trim() : '';
        this._artUrl = typeof metadata['mpris:artUrl'] === 'string' ? metadata['mpris:artUrl'].trim() : '';
        this._trackId = typeof metadata['mpris:trackid'] === 'string' ? metadata['mpris:trackid'] : null;

        const rawLength = metadata['mpris:length'];
        if (typeof rawLength === 'number' && Number.isFinite(rawLength) && rawLength > 0)
            this._lengthUs = rawLength;
        else
            this._lengthUs = 0;

        if (!this._app)
            this._app = this._resolveShellApp();

        if (prevTrackId !== this._trackId || prevTitle !== this._title || prevStatus !== this._status)
            this.refreshPosition();

        this.emit('changed');
    }

    async refreshPosition() {
        if (this._destroyed || !this._propsProxy)
            return;

        try {
            const [variant] = await this._propsProxy.GetAsync(MPRIS_PLAYER_IFACE, 'Position');
            if (this._destroyed)
                return;
            const posUs = variant?.deepUnpack?.();
            if (typeof posUs === 'number' && Number.isFinite(posUs)) {
                this._positionUs = Math.max(0, posUs);
                this._positionTimestampMs = Date.now();
                this.emit('position-changed');
            }
        } catch {
            // Some players do not expose Position cleanly
        }
    }

    get status() {
        return this._status;
    }

    get isPlaying() {
        return this._status === 'Playing';
    }

    get lastActiveTimestamp() {
        return this._lastActiveTimestamp;
    }

    get identity() {
        return this._app?.get_name?.() || this._identity;
    }

    get desktopEntry() {
        return this._desktopEntry;
    }

    get app() {
        return this._app;
    }

    get title() {
        return this._title || this.identity;
    }

    get hasTrackTitle() {
        return this._title.length > 0;
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
        if (this._status === 'Playing') {
            const elapsedUs = (Date.now() - this._positionTimestampMs) * 1000 * this._rate;
            const estimated = this._positionUs + elapsedUs;
            if (this._lengthUs > 0)
                return Math.min(Math.max(0, estimated), this._lengthUs);
            return Math.max(0, estimated);
        }
        return this._positionUs;
    }

    get volume() {
        return this._volume;
    }

    get canGoPrevious() {
        return this._canGoPrevious;
    }

    get canGoNext() {
        return this._canGoNext;
    }

    get canSeek() {
        return this._canSeek;
    }

    get canPlay() {
        return this._canPlay;
    }

    get canPause() {
        return this._canPause;
    }

    get canControl() {
        return this._canControl;
    }

    async playPause() {
        if (this._destroyed || !this._playerProxy)
            return;
        this._lastActiveTimestamp = Date.now();
        try {
            await this._playerProxy.PlayPauseAsync();
        } catch {
            try {
                if (this._status === 'Playing')
                    await this._playerProxy.PauseAsync();
                else
                    await this._playerProxy.PlayAsync();
            } catch (err) {
                console.debug(`[ZCtrl] PlayPause fallback error on ${this.busName}: ${err.message}`);
            }
        }
    }

    async pause() {
        if (this._destroyed || !this._playerProxy)
            return;
        try {
            await this._playerProxy.PauseAsync();
        } catch {
            if (this._status === 'Playing')
                await this.playPause();
        }
    }

    async stop() {
        if (this._destroyed || !this._playerProxy)
            return;
        try {
            await this._playerProxy.StopAsync();
        } catch (err) {
            console.debug(`[ZCtrl] Stop error on ${this.busName}: ${err.message}`);
        }
    }

    async previous() {
        if (this._destroyed || !this._playerProxy)
            return;
        this._lastActiveTimestamp = Date.now();
        if (this._canGoPrevious) {
            try {
                await this._playerProxy.PreviousAsync();
                return;
            } catch (err) {
                console.debug(`[ZCtrl] Previous error on ${this.busName}: ${err.message}`);
            }
        }

        if (this._canSeek) {
            await this.seekBy(-DEFAULT_SEEK_STEP_US);
            return;
        }

        // Last resort: try PreviousAsync anyway (some players misreport CanGoPrevious)
        try {
            await this._playerProxy.PreviousAsync();
        } catch {
            // Ignored
        }
    }

    async next() {
        if (this._destroyed || !this._playerProxy)
            return;
        this._lastActiveTimestamp = Date.now();
        if (this._canGoNext) {
            try {
                await this._playerProxy.NextAsync();
                return;
            } catch (err) {
                console.debug(`[ZCtrl] Next error on ${this.busName}: ${err.message}`);
            }
        }

        if (this._canSeek) {
            await this.seekBy(DEFAULT_SEEK_STEP_US);
            return;
        }

        try {
            await this._playerProxy.NextAsync();
        } catch {
            // Ignored
        }
    }

    async seekBy(offsetUs) {
        if (this._destroyed || !this._playerProxy)
            return;
        try {
            await this._playerProxy.SeekAsync(Math.round(offsetUs));
            this._positionUs = Math.max(0, this.positionUs + offsetUs);
            this._positionTimestampMs = Date.now();
            this.emit('position-changed');
        } catch (err) {
            console.debug(`[ZCtrl] Seek error on ${this.busName}: ${err.message}`);
        }
    }

    async setPosition(positionUs) {
        if (this._destroyed || !this._playerProxy)
            return;
        const clamped = Math.max(0, Math.round(positionUs));
        if (this._trackId) {
            try {
                await this._playerProxy.SetPositionAsync(this._trackId, clamped);
                this._positionUs = clamped;
                this._positionTimestampMs = Date.now();
                this.emit('position-changed');
                return;
            } catch (err) {
                console.debug(`[ZCtrl] SetPosition error on ${this.busName}: ${err.message}`);
            }
        }

        const delta = clamped - this.positionUs;
        await this.seekBy(delta);
    }

    async setVolume(normalized) {
        if (this._destroyed || !this._propsProxy)
            return;
        const clamped = Math.max(0, Math.min(normalized, 1.0));
        try {
            await this._propsProxy.SetAsync(
                MPRIS_PLAYER_IFACE,
                'Volume',
                new GLib.Variant('d', clamped)
            );
            this._volume = clamped;
        } catch (err) {
            console.debug(`[ZCtrl] SetVolume error on ${this.busName}: ${err.message}`);
        }
    }

    raise() {
        if (this._destroyed)
            return false;

        if (!this._app)
            this._app = this._resolveShellApp();

        if (this._app) {
            this._app.activate();
            return true;
        }

        // Try activating a matching window directly
        const busBase = this.busName.replace(MPRIS_PREFIX, '').split('.')[0].toLowerCase();
        const identityLower = this._identity.toLowerCase();
        for (const actor of global.get_window_actors()) {
            const win = actor.meta_window;
            if (!win)
                continue;
            const wmClass = (win.get_wm_class() ?? '').toLowerCase();
            const wmInstance = (win.get_wm_class_instance() ?? '').toLowerCase();
            const winTitle = (win.get_title() ?? '').toLowerCase();
            if ((busBase && (wmClass.includes(busBase) || wmInstance.includes(busBase))) ||
                (identityLower && (wmClass.includes(identityLower) || winTitle.includes(identityLower)))) {
                Main.activateWindow(win);
                return true;
            }
        }

        if (this._canRaise && this._rootProxy) {
            this._rootProxy.RaiseAsync().catch(() => {});
            return true;
        }

        return false;
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;

        if (this._rootProxy) {
            for (const id of this._rootSignalIds)
                this._rootProxy.disconnect(id);
            this._rootSignalIds = [];
            this._rootProxy = null;
        }

        if (this._playerProxy) {
            for (const id of this._playerSignalIds)
                this._playerProxy.disconnect(id);
            this._playerSignalIds = [];
            if (this._seekedSignalId) {
                this._playerProxy.disconnectSignal(this._seekedSignalId);
                this._seekedSignalId = 0;
            }
            this._playerProxy = null;
        }

        this._propsProxy = null;
        this.emit('closed');
    }
}

export class MprisManager extends Signals.EventEmitter {
    constructor() {
        super();

        this._players = new Map();
        this._destroyed = false;
        this._nameOwnerSignalId = 0;
        this._dbusProxy = null;

        this._initDBus();
    }

    _initDBus() {
        this._dbusProxy = new DBusProxy(
            Gio.DBus.session,
            'org.freedesktop.DBus',
            '/org/freedesktop/DBus',
            (proxy, error) => {
                if (this._destroyed)
                    return;
                if (error) {
                    console.error(`[ZCtrl] DBus proxy init error: ${error}`);
                    return;
                }
                this._onDBusReady();
            }
        );
    }

    async _onDBusReady() {
        if (this._destroyed || !this._dbusProxy)
            return;

        this._nameOwnerSignalId = this._dbusProxy.connectSignal(
            'NameOwnerChanged',
            (_proxy, _sender, [name, oldOwner, newOwner]) => {
                if (this._destroyed || !name?.startsWith(MPRIS_PREFIX))
                    return;

                if (newOwner && !oldOwner)
                    this._addPlayer(name);
                else if (!newOwner && oldOwner)
                    this._removePlayer(name);
            }
        );

        try {
            const [names] = await this._dbusProxy.ListNamesAsync();
            if (this._destroyed)
                return;
            for (const name of names) {
                if (name.startsWith(MPRIS_PREFIX))
                    this._addPlayer(name);
            }
        } catch (error) {
            console.error(`[ZCtrl] ListNamesAsync failed: ${error}`);
        }
    }

    _addPlayer(busName) {
        if (this._destroyed || this._players.has(busName))
            return;

        const player = new MprisPlayer(busName);
        player.connect('changed', () => {
            if (!this._destroyed)
                this.emit('players-changed');
        });
        player.connect('position-changed', () => {
            if (!this._destroyed)
                this.emit('position-changed', player);
        });
        player.connect('closed', () => {
            if (this._players.delete(busName) && !this._destroyed)
                this.emit('players-changed');
        });

        this._players.set(busName, player);
        this.emit('players-changed');
    }

    _removePlayer(busName) {
        const player = this._players.get(busName);
        if (player)
            player.destroy();
    }

    getPlayers() {
        return Array.from(this._players.values());
    }

    getPlayerById(id) {
        for (const player of this._players.values()) {
            if (player.id === id)
                return player;
        }
        return null;
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;

        if (this._dbusProxy && this._nameOwnerSignalId) {
            this._dbusProxy.disconnectSignal(this._nameOwnerSignalId);
            this._nameOwnerSignalId = 0;
        }
        this._dbusProxy = null;

        for (const player of Array.from(this._players.values()))
            player.destroy();
        this._players.clear();
    }
}
