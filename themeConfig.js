export const CONTROLLER_POSITIONS = [
    {id: 'top', label: 'Top (Date)'},
    {id: 'bottom', label: 'Bottom Bar'},
    {id: 'both', label: 'Both'},
];

export const WAVE_STYLES = [
    {id: 'mirrored', label: 'Waves'},
    {id: 'wave', label: 'Line'},
    {id: 'bars', label: 'Bars'},
];

export const WAVE_WIDTH_PRESETS = [
    {id: 'compact', label: 'S', width: 72},
    {id: 'medium', label: 'M', width: 96},
    {id: 'wide', label: 'L', width: 136},
];

export const WAVE_COLOR_PRESETS = [
    {
        id: 'ubuntu',
        label: 'Ubuntu Orange',
        swatchCss: 'background-color: #e95420;',
        stops: [
            [0.0, 1.0, 0.72, 0.42, 0.96],
            [0.5, 0.91, 0.33, 0.13, 0.98],
            [1.0, 1.0, 0.61, 0.44, 0.96],
        ],
        restingRgba: [1.0, 0.65, 0.46, 0.48],
        glowRgba: [0.91, 0.33, 0.13, 0.28],
        peakRgba: [1.0, 0.88, 0.72, 0.92],
    },
    {
        id: 'cyan',
        label: 'Ocean Cyan',
        swatchCss: 'background-color: #06b6d4;',
        stops: [
            [0.0, 0.40, 0.91, 0.98, 0.96],
            [0.5, 0.02, 0.71, 0.83, 0.98],
            [1.0, 0.22, 0.74, 0.97, 0.96],
        ],
        restingRgba: [0.35, 0.84, 0.96, 0.48],
        glowRgba: [0.02, 0.71, 0.83, 0.28],
        peakRgba: [0.75, 0.96, 1.0, 0.92],
    },
    {
        id: 'purple',
        label: 'Neon Violet',
        swatchCss: 'background-color: #a855f7;',
        stops: [
            [0.0, 0.75, 0.52, 0.99, 0.96],
            [0.5, 0.66, 0.33, 0.97, 0.98],
            [1.0, 0.96, 0.45, 0.71, 0.96],
        ],
        restingRgba: [0.76, 0.54, 0.98, 0.48],
        glowRgba: [0.66, 0.33, 0.97, 0.28],
        peakRgba: [0.93, 0.82, 1.0, 0.92],
    },
    {
        id: 'emerald',
        label: 'Emerald Mint',
        swatchCss: 'background-color: #10b981;',
        stops: [
            [0.0, 0.43, 0.91, 0.72, 0.96],
            [0.5, 0.06, 0.73, 0.51, 0.98],
            [1.0, 0.20, 0.83, 0.60, 0.96],
        ],
        restingRgba: [0.32, 0.85, 0.65, 0.48],
        glowRgba: [0.06, 0.73, 0.51, 0.28],
        peakRgba: [0.76, 0.98, 0.88, 0.92],
    },
    {
        id: 'rose',
        label: 'Crimson Rose',
        swatchCss: 'background-color: #f43f5e;',
        stops: [
            [0.0, 0.99, 0.64, 0.69, 0.96],
            [0.5, 0.96, 0.25, 0.37, 0.98],
            [1.0, 0.98, 0.44, 0.52, 0.96],
        ],
        restingRgba: [0.98, 0.52, 0.60, 0.48],
        glowRgba: [0.96, 0.25, 0.37, 0.28],
        peakRgba: [1.0, 0.82, 0.86, 0.92],
    },
    {
        id: 'gold',
        label: 'Solar Gold',
        swatchCss: 'background-color: #f59e0b;',
        stops: [
            [0.0, 0.99, 0.88, 0.28, 0.96],
            [0.5, 0.96, 0.62, 0.04, 0.98],
            [1.0, 0.98, 0.57, 0.24, 0.96],
        ],
        restingRgba: [0.98, 0.76, 0.30, 0.48],
        glowRgba: [0.96, 0.62, 0.04, 0.28],
        peakRgba: [1.0, 0.95, 0.72, 0.92],
    },
    {
        id: 'rainbow',
        label: 'Rainbow',
        swatchCss: 'background-gradient-direction: horizontal; background-gradient-start: #f43f5e; background-gradient-end: #06b6d4;',
        stops: [
            [0.0, 0.96, 0.27, 0.37, 0.98],
            [0.22, 0.98, 0.58, 0.16, 0.98],
            [0.45, 0.98, 0.84, 0.20, 0.98],
            [0.66, 0.16, 0.82, 0.54, 0.98],
            [0.84, 0.14, 0.74, 0.94, 0.98],
            [1.0, 0.68, 0.38, 0.98, 0.98],
        ],
        restingRgba: [0.78, 0.66, 0.96, 0.5],
        glowRgba: [0.55, 0.42, 0.96, 0.24],
        peakRgba: [1.0, 1.0, 1.0, 0.9],
    },
    {
        id: 'frost',
        label: 'Pure Frost',
        swatchCss: 'background-color: #e2e8f0;',
        stops: [
            [0.0, 0.95, 0.97, 1.0, 0.96],
            [0.5, 0.82, 0.88, 0.94, 0.98],
            [1.0, 0.98, 0.99, 1.0, 0.96],
        ],
        restingRgba: [0.82, 0.86, 0.92, 0.45],
        glowRgba: [0.85, 0.90, 0.96, 0.22],
        peakRgba: [1.0, 1.0, 1.0, 0.95],
    },
];

export const ACCENT_COLOR_PRESETS = [
    {id: 'ubuntu', label: 'Ubuntu Orange', swatchHex: '#e95420'},
    {id: 'cyan', label: 'Ocean Cyan', swatchHex: '#06b6d4'},
    {id: 'purple', label: 'Neon Violet', swatchHex: '#a855f7'},
    {id: 'emerald', label: 'Emerald Mint', swatchHex: '#10b981'},
    {id: 'rose', label: 'Crimson Rose', swatchHex: '#f43f5e'},
    {id: 'gold', label: 'Solar Gold', swatchHex: '#f59e0b'},
    {id: 'frost', label: 'Cool Slate', swatchHex: '#94a3b8'},
];

export const CONTROLLER_THEMES = [
    {id: 'dark', label: 'Dark', blurRadius: 36, blurBrightness: 0.56},
    {id: 'glass', label: 'Glass', blurRadius: 44, blurBrightness: 0.62},
    {id: 'transparent', label: 'Transparent', blurRadius: 44, blurBrightness: 0.66},
    {id: 'light', label: 'Light', blurRadius: 46, blurBrightness: 1.0},
    {id: 'oled', label: 'OLED', blurRadius: 34, blurBrightness: 0.36},
];

export function getWaveColorPreset(id) {
    return WAVE_COLOR_PRESETS.find(p => p.id === id) ?? WAVE_COLOR_PRESETS[0];
}

export function getWaveStyleMeta(id) {
    return WAVE_STYLES.find(s => s.id === id) ?? WAVE_STYLES[0];
}

export function getAccentPreset(id) {
    return ACCENT_COLOR_PRESETS.find(a => a.id === id) ?? ACCENT_COLOR_PRESETS[0];
}

export function getThemeMeta(id) {
    return CONTROLLER_THEMES.find(t => t.id === id) ?? CONTROLLER_THEMES[0];
}
