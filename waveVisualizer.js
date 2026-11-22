import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {WAVE_STYLES, getWaveColorPreset, getWaveStyleMeta} from './themeConfig.js';

const SAMPLE_RATE = 16000;
const FFT_SIZE = 256;
const NUM_BANDS = 16;
const NUM_WAVE_POINTS = 44;
const READ_CHUNK_BYTES = 1024; // 512 s16le samples (~32ms at 16kHz)
const FRAME_INTERVAL_MS = 33;  // ~30 FPS smooth animation
const RESTART_DELAY_MS = 1500;
const SILENCE_TIMEOUT_MS = 140;

// Precomputed Radix-2 FFT tables (256 points, zero per-frame allocations)
const HANN_WINDOW = new Float64Array(FFT_SIZE);
const BIT_REV = new Uint16Array(FFT_SIZE);
const COS_TABLE = new Float64Array(FFT_SIZE / 2);
const SIN_TABLE = new Float64Array(FFT_SIZE / 2);

(() => {
    const bits = Math.round(Math.log2(FFT_SIZE));
    for (let i = 0; i < FFT_SIZE; i++) {
        HANN_WINDOW[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)));
        let rev = 0;
        let x = i;
        for (let b = 0; b < bits; b++) {
            rev = (rev << 1) | (x & 1);
            x >>= 1;
        }
        BIT_REV[i] = rev;
    }
    for (let i = 0; i < FFT_SIZE / 2; i++) {
        const angle = (-2 * Math.PI * i) / FFT_SIZE;
        COS_TABLE[i] = Math.cos(angle);
        SIN_TABLE[i] = Math.sin(angle);
    }
})();

// Precomputed logarithmically-spaced FFT bin ranges for NUM_BANDS (from ~70Hz to ~6800Hz)
const BAND_BINS = (() => {
    const minFreq = 70;
    const maxFreq = 6800;
    const binHz = SAMPLE_RATE / FFT_SIZE; // 62.5 Hz per bin
    const ranges = [];
    for (let b = 0; b < NUM_BANDS; b++) {
        const f0 = minFreq * Math.pow(maxFreq / minFreq, b / NUM_BANDS);
        const f1 = minFreq * Math.pow(maxFreq / minFreq, (b + 1) / NUM_BANDS);
        const start = Math.max(1, Math.floor(f0 / binHz));
        const end = Math.min(FFT_SIZE / 2 - 1, Math.max(start, Math.ceil(f1 / binHz)));
        const boost = 0.85 + (b / (NUM_BANDS - 1)) * 1.15;
        ranges.push({start, end, boost});
    }
    return ranges;
})();

function drawRoundedRect(cr, x, y, w, h, r) {
    const radius = Math.min(r, w / 2, h / 2);
    cr.newSubPath();
    cr.arc(x + w - radius, y + radius, radius, -Math.PI / 2, 0);
    cr.arc(x + w - radius, y + h - radius, radius, 0, Math.PI / 2);
    cr.arc(x + radius, y + h - radius, radius, Math.PI / 2, Math.PI);
    cr.arc(x + radius, y + radius, radius, Math.PI, (3 * Math.PI) / 2);
    cr.closePath();
}

/**
 * Lightweight PipeWire default-sink monitor audio capture using pw-record.
 * Uses application.id="org.gnome.VolumeControl" + node.passive=true so GNOME Shell
 * does NOT show a false microphone-recording privacy indicator and audio hardware
 * can still suspend cleanly when idle.
 */
class AudioWaveCapture {
    constructor(onFrame) {
        this._onFrame = onFrame;
        this._running = false;
        this._proc = null;
        this._stdout = null;
        this._cancellable = null;
        this._restartTimeoutId = 0;
        this._leftoverByte = -1;

        this._sampleRing = new Float64Array(FFT_SIZE);
        this._ringPos = 0;
        this._fftRe = new Float64Array(FFT_SIZE);
        this._fftIm = new Float64Array(FFT_SIZE);
        this._bands = new Float64Array(NUM_BANDS);
        this._waveform = new Float64Array(NUM_WAVE_POINTS);

        this._autoGainBand = 0.22;
        this._autoGainWave = 0.14;
    }

    start() {
        if (this._running)
            return;
        this._running = true;
        this._spawn();
    }

    stop() {
        this._running = false;
        this._cancelRestart();
        this._teardownProcess();
    }

    _cancelRestart() {
        if (this._restartTimeoutId) {
            GLib.source_remove(this._restartTimeoutId);
            this._restartTimeoutId = 0;
        }
    }

    _teardownProcess() {
        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }

        if (this._stdout) {
            const stream = this._stdout;
            this._stdout = null;
            try {
                stream.close_async(GLib.PRIORITY_DEFAULT, null, (src, res) => {
                    try {
                        src.close_finish(res);
                    } catch {
                        // Ignored
                    }
                });
            } catch {
                // Ignored
            }
        }

        if (this._proc) {
            const proc = this._proc;
            this._proc = null;
            try {
                proc.force_exit();
                proc.wait_async(null, (p, res) => {
                    try {
                        p.wait_finish(res);
                    } catch {
                        // Already reaped
                    }
                });
            } catch {
                // Already exited
            }
        }

        this._leftoverByte = -1;
    }

    _spawn() {
        if (!this._running)
            return;

        this._teardownProcess();

        if (!GLib.find_program_in_path('pw-record')) {
            console.warn('[ZCtrl] pw-record not found; install pipewire-bin for live sound waves.');
            return;
        }

        const argv = [
            'pw-record',
            `--rate=${SAMPLE_RATE}`,
            '--channels=1',
            '--format=s16',
            '--latency=25ms',
            '-P',
            '{ stream.capture.sink=true node.passive=true application.id="org.gnome.VolumeControl" node.name="zctrl-visualizer" media.name="ZCtrl Sound Waves" }',
            '-',
        ];

        try {
            this._proc = new Gio.Subprocess({
                argv,
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
            });
            this._proc.init(null);
        } catch (err) {
            console.error(`[ZCtrl] Failed to spawn pw-record for sound waves: ${err.message}`);
            this._proc = null;
            this._scheduleRestart();
            return;
        }

        this._cancellable = new Gio.Cancellable();
        this._stdout = this._proc.get_stdout_pipe();
        this._readNextChunk();
    }

    _scheduleRestart() {
        if (!this._running || this._restartTimeoutId)
            return;
        this._restartTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RESTART_DELAY_MS, () => {
            this._restartTimeoutId = 0;
            if (this._running)
                this._spawn();
            return GLib.SOURCE_REMOVE;
        });
    }

    _readNextChunk() {
        if (!this._running || !this._stdout || !this._cancellable)
            return;

        const stream = this._stdout;
        const cancellable = this._cancellable;

        stream.read_bytes_async(READ_CHUNK_BYTES, GLib.PRIORITY_DEFAULT_IDLE, cancellable, (src, res) => {
            if (!this._running || cancellable.is_cancelled())
                return;

            let bytes;
            try {
                bytes = src.read_bytes_finish(res);
            } catch {
                this._teardownProcess();
                this._scheduleRestart();
                return;
            }

            if (!bytes || bytes.get_size() === 0) {
                this._teardownProcess();
                this._scheduleRestart();
                return;
            }

            const data = bytes.get_data();
            if (data && data.length > 0)
                this._processPcmBytes(data);

            this._readNextChunk();
        });
    }

    _processPcmBytes(data) {
        let offset = 0;
        const len = data.length;

        const pushSample = int16Val => {
            const norm = int16Val / 32768.0;
            this._sampleRing[this._ringPos] = norm;
            this._ringPos = (this._ringPos + 1) & (FFT_SIZE - 1);
        };

        if (this._leftoverByte >= 0 && len > 0) {
            let v = this._leftoverByte | (data[0] << 8);
            if (v & 0x8000)
                v -= 0x10000;
            pushSample(v);
            this._leftoverByte = -1;
            offset = 1;
        }

        const end = len - 1;
        for (let i = offset; i < end; i += 2) {
            let v = data[i] | (data[i + 1] << 8);
            if (v & 0x8000)
                v -= 0x10000;
            pushSample(v);
        }

        if ((len - offset) % 2 === 1)
            this._leftoverByte = data[len - 1];

        this._analyzeRing();
    }

    _analyzeRing() {
        const ring = this._sampleRing;
        const re = this._fftRe;
        const im = this._fftIm;
        const startPos = this._ringPos;

        let sumSq = 0;
        let peakAbs = 0;
        for (let i = 0; i < FFT_SIZE; i++) {
            const s = ring[(startPos + i) & (FFT_SIZE - 1)];
            sumSq += s * s;
            const absS = Math.abs(s);
            if (absS > peakAbs)
                peakAbs = absS;
            const idx = BIT_REV[i];
            re[idx] = s * HANN_WINDOW[i];
            im[idx] = 0;
        }

        const rms = Math.sqrt(sumSq / FFT_SIZE);

        this._autoGainWave = Math.max(0.035, Math.max(peakAbs * 1.12, this._autoGainWave * 0.965));
        const step = FFT_SIZE / NUM_WAVE_POINTS;
        for (let p = 0; p < NUM_WAVE_POINTS; p++) {
            const idx0 = Math.floor(p * step);
            const idx1 = Math.min(FFT_SIZE - 1, Math.floor((p + 1) * step));
            let acc = 0;
            let count = 0;
            for (let k = idx0; k <= idx1; k++) {
                acc += ring[(startPos + k) & (FFT_SIZE - 1)];
                count++;
            }
            const avg = count > 0 ? acc / count : 0;
            const t = p / (NUM_WAVE_POINTS - 1);
            const edgeTaper = Math.sin(Math.PI * t);
            const scaled = Math.max(-1, Math.min(1, (avg / this._autoGainWave) * (0.45 + 0.55 * edgeTaper)));
            this._waveform[p] = scaled;
        }

        if (rms < 0.0005) {
            this._bands.fill(0);
            this._waveform.fill(0);
            this._onFrame(this._bands, this._waveform, 0);
            return;
        }

        for (let size = 2; size <= FFT_SIZE; size <<= 1) {
            const halfSize = size >> 1;
            const tableStep = FFT_SIZE / size;
            for (let i = 0; i < FFT_SIZE; i += size) {
                for (let j = 0, k = 0; j < halfSize; j++, k += tableStep) {
                    const twRe = COS_TABLE[k];
                    const twIm = SIN_TABLE[k];
                    const evenIdx = i + j;
                    const oddIdx = evenIdx + halfSize;
                    const tRe = re[oddIdx] * twRe - im[oddIdx] * twIm;
                    const tIm = re[oddIdx] * twIm + im[oddIdx] * twRe;
                    re[oddIdx] = re[evenIdx] - tRe;
                    im[oddIdx] = im[evenIdx] - tIm;
                    re[evenIdx] += tRe;
                    im[evenIdx] += tIm;
                }
            }
        }

        let frameMax = 0;
        const rawBands = this._bands;
        for (let b = 0; b < NUM_BANDS; b++) {
            const {start, end, boost} = BAND_BINS[b];
            let peak = 0;
            let avg = 0;
            for (let bin = start; bin <= end; bin++) {
                const mag = Math.hypot(re[bin], im[bin]) / (FFT_SIZE * 0.5);
                avg += mag;
                if (mag > peak)
                    peak = mag;
            }
            avg /= (end - start + 1);
            const combined = (peak * 0.65 + avg * 0.35) * boost;
            const logVal = Math.log1p(combined * 26.0);
            rawBands[b] = logVal;
            if (logVal > frameMax)
                frameMax = logVal;
        }

        this._autoGainBand = Math.max(0.10, Math.max(frameMax * 1.04, this._autoGainBand * 0.975));
        for (let b = 0; b < NUM_BANDS; b++) {
            const norm = Math.min(1.0, rawBands[b] / this._autoGainBand);
            rawBands[b] = Math.pow(norm, 1.12);
        }

        this._onFrame(rawBands, this._waveform, rms);
    }
}

export class WaveAudioHub {
    constructor() {
        this._listeners = new Set();
        this._destroyed = false;
        this._capture = new AudioWaveCapture((bands, waveform, rms) => {
            if (this._destroyed)
                return;
            for (const listener of this._listeners)
                listener(bands, waveform, rms);
        });
    }

    subscribe(listener) {
        if (this._destroyed)
            return;
        const wasEmpty = this._listeners.size === 0;
        this._listeners.add(listener);
        if (wasEmpty && this._listeners.size > 0)
            this._capture.start();
    }

    unsubscribe(listener) {
        if (!this._listeners.delete(listener))
            return;
        if (this._listeners.size === 0)
            this._capture.stop();
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        this._listeners.clear();
        this._capture.stop();
    }
}

export const SoundWaveWidget = GObject.registerClass({
    Signals: {
        'style-changed-custom': {},
    },
}, class SoundWaveWidget extends St.DrawingArea {
    _init(waveHub) {
        super._init({
            style_class: 'zcontroller-wave-canvas',
            reactive: true,
            can_focus: true,
            track_hover: true,
            y_align: Clutter.ActorAlign.CENTER,
            accessible_name: 'Live Sound Waves (click to change style)',
        });

        this._waveHub = waveHub;
        this._active = false;
        this._destroyed = false;
        this._styleId = 'mirrored';
        this._colorPreset = getWaveColorPreset('ubuntu');
        this._sensitivity = 1.2;
        this._lightSurface = false;

        this._animTimerId = 0;
        this._lastAudioMs = 0;
        this._settled = true;

        this._targetBands = new Float64Array(NUM_BANDS);
        this._displayBands = new Float64Array(NUM_BANDS);
        this._peakCaps = new Float64Array(NUM_BANDS);

        this._targetWave = new Float64Array(NUM_WAVE_POINTS);
        this._displayWave = new Float64Array(NUM_WAVE_POINTS);

        this._onAudioFrame = (bands, waveform, rms) => {
            if (this._destroyed || !this._active)
                return;
            const sens = this._sensitivity;
            for (let i = 0; i < NUM_BANDS; i++)
                this._targetBands[i] = Math.min(1.0, bands[i] * sens);
            for (let i = 0; i < NUM_WAVE_POINTS; i++)
                this._targetWave[i] = Math.max(-1.0, Math.min(1.0, waveform[i] * sens));

            if (rms >= 0.0005) {
                this._lastAudioMs = Date.now();
                this._settled = false;
            }
        };

        this.connect('button-press-event', (_actor, event) => {
            if (event.get_button() === 1 || event.get_button() === 3) {
                this.cycleStyle();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this.connect('destroy', () => this._onDestroy());

        this.width = 96;
        this.hide();
    }

    get isShown() {
        return this._active;
    }

    get styleId() {
        return this._styleId;
    }

    get currentStyleLabel() {
        return getWaveStyleMeta(this._styleId).label;
    }

    setStyleId(styleId) {
        const meta = getWaveStyleMeta(styleId);
        if (this._styleId === meta.id)
            return;
        this._styleId = meta.id;
        this._settled = false;
        this.queue_repaint();
    }

    cycleStyle() {
        const idx = WAVE_STYLES.findIndex(s => s.id === this._styleId);
        const nextIdx = (idx + 1) % WAVE_STYLES.length;
        this._styleId = WAVE_STYLES[nextIdx].id;
        this._settled = false;
        this.queue_repaint();
        this.emit('style-changed-custom');
    }

    setColorPreset(colorId) {
        this._colorPreset = getWaveColorPreset(colorId);
        this._settled = false;
        this.queue_repaint();
    }

    setWaveWidth(widthPx) {
        const clamped = Math.max(56, Math.min(180, Math.round(widthPx)));
        if (this.width !== clamped) {
            this.width = clamped;
            this._settled = false;
            this.queue_repaint();
        }
    }

    setSensitivity(multiplier) {
        this._sensitivity = Math.max(0.4, Math.min(2.6, Number(multiplier) || 1.2));
    }

    setLightSurface(isLight) {
        const val = Boolean(isLight);
        if (this._lightSurface !== val) {
            this._lightSurface = val;
            this._settled = false;
            this.queue_repaint();
        }
    }

    setShown(shown) {
        const next = Boolean(shown);
        if (this._active === next)
            return;

        this._active = next;
        if (this._active) {
            this._settled = false;
            this.show();
            this._waveHub?.subscribe(this._onAudioFrame);
            this._startAnimTimer();
            this.queue_repaint();
        } else {
            this._stopAnimTimer();
            this._waveHub?.unsubscribe(this._onAudioFrame);
            this._resetBuffers();
            this.hide();
        }
    }

    toggle() {
        this.setShown(!this._active);
        return this._active;
    }

    _resetBuffers() {
        this._targetBands.fill(0);
        this._displayBands.fill(0);
        this._peakCaps.fill(0);
        this._targetWave.fill(0);
        this._displayWave.fill(0);
    }

    _startAnimTimer() {
        this._stopAnimTimer();
        this._animTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FRAME_INTERVAL_MS, () => {
            if (this._destroyed || !this._active) {
                this._animTimerId = 0;
                return GLib.SOURCE_REMOVE;
            }
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopAnimTimer() {
        if (this._animTimerId) {
            GLib.source_remove(this._animTimerId);
            this._animTimerId = 0;
        }
    }

    _tick() {
        const now = Date.now();
        const isSilent = (now - this._lastAudioMs) > SILENCE_TIMEOUT_MS;
        let maxLevel = 0;

        for (let i = 0; i < NUM_BANDS; i++) {
            const target = isSilent ? 0 : this._targetBands[i];
            const current = this._displayBands[i];
            const coeff = target > current ? 0.62 : 0.22;
            const next = current + (target - current) * coeff;
            this._displayBands[i] = next < 0.004 ? 0 : next;

            if (this._displayBands[i] >= this._peakCaps[i])
                this._peakCaps[i] = this._displayBands[i];
            else
                this._peakCaps[i] = Math.max(0, this._peakCaps[i] - 0.025);

            if (this._displayBands[i] > maxLevel)
                maxLevel = this._displayBands[i];
            if (this._peakCaps[i] > maxLevel)
                maxLevel = this._peakCaps[i];
        }

        for (let i = 0; i < NUM_WAVE_POINTS; i++) {
            const target = isSilent ? 0 : this._targetWave[i];
            const current = this._displayWave[i];
            const next = current + (target - current) * 0.45;
            this._displayWave[i] = Math.abs(next) < 0.004 ? 0 : next;
            if (Math.abs(this._displayWave[i]) > maxLevel)
                maxLevel = Math.abs(this._displayWave[i]);
        }

        if (maxLevel === 0 && isSilent) {
            if (!this._settled) {
                this._settled = true;
                this.queue_repaint();
            }
            return;
        }

        this._settled = false;
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();

        if (width <= 0 || height <= 0) {
            cr.$dispose();
            return;
        }

        if (this._styleId === 'mirrored')
            this._paintMirroredWaves(cr, width, height);
        else if (this._styleId === 'wave')
            this._paintOscilloscope(cr, width, height);
        else
            this._paintSpectrumBars(cr, width, height);

        cr.$dispose();
    }

    _createWaveGradient(cr, width, height, vertical = false) {
        const preset = this._colorPreset;
        const useHorizontal = preset.id === 'rainbow' || !vertical;
        const grad = useHorizontal
            ? new Cairo.LinearGradient(0, 0, width, 0)
            : new Cairo.LinearGradient(0, 0, 0, height);

        if (this._lightSurface && preset.id === 'frost') {
            grad.addColorStopRGBA(0.0, 0.25, 0.30, 0.38, 0.92);
            grad.addColorStopRGBA(0.5, 0.14, 0.18, 0.24, 0.96);
            grad.addColorStopRGBA(1.0, 0.30, 0.36, 0.44, 0.92);
            return grad;
        }

        for (const [pos, r, g, b, a] of preset.stops)
            grad.addColorStopRGBA(pos, r, g, b, a);
        return grad;
    }

    _getRestingColor() {
        if (this._lightSurface && this._colorPreset.id === 'frost')
            return [0.22, 0.26, 0.34, 0.45];
        return this._colorPreset.restingRgba;
    }

    _paintMirroredWaves(cr, width, height) {
        const padX = 4;
        const padY = 2;
        const usableW = Math.max(1, width - padX * 2);
        const maxBarH = Math.max(2, height - padY * 2);
        const centerY = height / 2;

        const gap = width >= 110 ? 2.4 : 2.0;
        const barW = Math.max(1.8, (usableW - gap * (NUM_BANDS - 1)) / NUM_BANDS);
        const stepX = (usableW - barW) / Math.max(1, NUM_BANDS - 1);

        // Subtle baseline guide
        if (this._lightSurface)
            cr.setSourceRGBA(0, 0, 0, 0.14);
        else
            cr.setSourceRGBA(1, 1, 1, 0.14);
        cr.setLineWidth(1);
        cr.moveTo(padX, centerY);
        cr.lineTo(width - padX, centerY);
        cr.stroke();

        const grad = this._createWaveGradient(cr, width, height, false);
        const [rr, rg, rb, ra] = this._getRestingColor();

        for (let i = 0; i < NUM_BANDS; i++) {
            const level = this._displayBands[i];
            const x = padX + i * stepX;
            const minH = 2.6;
            const barH = Math.max(minH, level * maxBarH);
            const y = centerY - barH / 2;

            if (level < 0.02)
                cr.setSourceRGBA(rr, rg, rb, ra);
            else
                cr.setSource(grad);

            drawRoundedRect(cr, x, y, barW, barH, barW / 2);
            cr.fill();
        }
    }

    _paintOscilloscope(cr, width, height) {
        const padX = 4;
        const padY = 2.5;
        const usableW = Math.max(1, width - padX * 2);
        const maxAmp = Math.max(1, (height / 2) - padY);
        const centerY = height / 2;

        let peak = 0;
        for (let i = 0; i < NUM_WAVE_POINTS; i++) {
            const a = Math.abs(this._displayWave[i]);
            if (a > peak)
                peak = a;
        }

        if (peak < 0.01) {
            const [rr, rg, rb, ra] = this._getRestingColor();
            cr.setSourceRGBA(rr, rg, rb, ra);
            cr.setLineWidth(1.6);
            cr.setLineCap(Cairo.LineCap.ROUND);
            cr.moveTo(padX, centerY);
            cr.lineTo(width - padX, centerY);
            cr.stroke();
            return;
        }

        const stepX = usableW / (NUM_WAVE_POINTS - 1);

        // Soft mirrored aura under the live wave
        cr.newPath();
        cr.moveTo(padX, centerY);
        for (let i = 0; i < NUM_WAVE_POINTS; i++) {
            const x = padX + i * stepX;
            const y = centerY - this._displayWave[i] * maxAmp;
            cr.lineTo(x, y);
        }
        cr.lineTo(padX + usableW, centerY);
        cr.closePath();
        const [gr, gg, gb, ga] = this._colorPreset.glowRgba;
        cr.setSourceRGBA(gr, gg, gb, ga);
        cr.fill();

        const grad = this._createWaveGradient(cr, width, height, false);
        cr.setSource(grad);
        cr.setLineWidth(1.9);
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineJoin(Cairo.LineJoin.ROUND);

        cr.newPath();
        cr.moveTo(padX, centerY - this._displayWave[0] * maxAmp);
        for (let i = 1; i < NUM_WAVE_POINTS - 1; i++) {
            const xc = padX + i * stepX;
            const yc = centerY - this._displayWave[i] * maxAmp;
            const xn = padX + (i + 1) * stepX;
            const yn = centerY - this._displayWave[i + 1] * maxAmp;
            cr.curveTo(xc, yc, xc, yc, (xc + xn) / 2, (yc + yn) / 2);
        }
        cr.lineTo(padX + (NUM_WAVE_POINTS - 1) * stepX, centerY - this._displayWave[NUM_WAVE_POINTS - 1] * maxAmp);
        cr.stroke();
    }

    _paintSpectrumBars(cr, width, height) {
        const padX = 4;
        const padY = 2;
        const usableW = Math.max(1, width - padX * 2);
        const maxBarH = Math.max(2, height - padY * 2);
        const bottomY = height - padY;

        const gap = width >= 110 ? 2.4 : 2.0;
        const barW = Math.max(1.8, (usableW - gap * (NUM_BANDS - 1)) / NUM_BANDS);
        const stepX = (usableW - barW) / Math.max(1, NUM_BANDS - 1);

        const grad = this._createWaveGradient(cr, width, height, true);
        const [rr, rg, rb, ra] = this._getRestingColor();
        const [pr, pg, pb, pa] = this._lightSurface && this._colorPreset.id === 'frost'
            ? [0.15, 0.18, 0.24, 0.85]
            : this._colorPreset.peakRgba;

        for (let i = 0; i < NUM_BANDS; i++) {
            const level = this._displayBands[i];
            const x = padX + i * stepX;
            const barH = Math.max(2.2, level * maxBarH);
            const y = bottomY - barH;

            if (level < 0.02)
                cr.setSourceRGBA(rr, rg, rb, ra);
            else
                cr.setSource(grad);

            drawRoundedRect(cr, x, y, barW, barH, Math.min(2, barW / 2));
            cr.fill();

            const peak = this._peakCaps[i];
            if (peak > 0.08) {
                const capY = Math.max(padY, bottomY - peak * maxBarH - 1.5);
                cr.setSourceRGBA(pr, pg, pb, pa);
                drawRoundedRect(cr, x, capY, barW, 1.8, 1);
                cr.fill();
            }
        }
    }

    _onDestroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        this._active = false;
        this._stopAnimTimer();
        this._waveHub?.unsubscribe(this._onAudioFrame);
        this._waveHub = null;
    }
});
