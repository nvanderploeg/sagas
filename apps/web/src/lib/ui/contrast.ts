export type Rgb = [number, number, number];
export type Theme = 'light' | 'dark';

// WCAG 2.x AA for normal text.
export const AA = 4.5;

// The panel and ink of each theme; keep in step with --color-panel and --color-ink in
// routes/layout.css.
export const THEMES: Record<Theme, { panel: string; ink: string }> = {
	light: { panel: '#ffffff', ink: '#121c25' },
	dark: { panel: '#151b20', ink: '#e8eef2' }
};

export function parseHex(value: string): Rgb {
	const n = Number.parseInt(value.slice(1), 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function toHex(rgb: Rgb): string {
	return `#${rgb
		.map((c) =>
			Math.round(Math.min(255, Math.max(0, c)))
				.toString(16)
				.padStart(2, '0')
		)
		.join('')}`;
}

// As CSS color-mix(in srgb, a <weight>, b).
export function mix(a: Rgb, b: Rgb, weight: number): Rgb {
	return [0, 1, 2].map((i) => a[i] * weight + b[i] * (1 - weight)) as Rgb;
}

export function luminance(rgb: Rgb): number {
	const [r, g, b] = rgb.map((v) => {
		const c = Math.round(v) / 255;
		return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: Rgb, b: Rgb): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];

export function hsl(h: number, s: number, l: number): Rgb {
	const k = (n: number) => (n + h / 30) % 12;
	const a = s * Math.min(l, 1 - l);
	const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
	return [f(0) * 255, f(8) * 255, f(4) * 255];
}

function toHsl([r, g, b]: Rgb): [number, number, number] {
	const [rn, gn, bn] = [r / 255, g / 255, b / 255];
	const max = Math.max(rn, gn, bn);
	const min = Math.min(rn, gn, bn);
	const l = (max + min) / 2;
	const d = max - min;
	if (d === 0) return [0, 0, l];
	const s = d / (1 - Math.abs(2 * l - 1));
	const h =
		max === rn ? ((gn - bn) / d + 6) % 6 : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4;
	return [h * 60, s, l];
}

// `text` itself when it reaches `min` on `background`; otherwise `text` lightened or darkened,
// keeping its hue, toward whichever of white and black stands out more, until it does.
export function readable(text: Rgb, background: Rgb, min = AA): Rgb {
	const passes = (c: Rgb) => contrast(parseHex(toHex(c)), background) >= min;
	if (passes(text)) return text;
	const lighten = contrast(WHITE, background) >= contrast(BLACK, background);
	const [h, s, l] = toHsl(text);
	for (let step = 1; step <= 100; step++) {
		const next = lighten ? Math.min(1, l + step / 100) : Math.max(0, l - step / 100);
		const candidate = hsl(h, s, next);
		if (passes(candidate)) return candidate;
		if (next === 0 || next === 1) break;
	}
	return lighten ? WHITE : BLACK;
}

export type PillColors = { tint: string; text: string };

const HEX = /^#[0-9a-fA-F]{6}$/;

// A State pill's background and text in each theme, for any configured colour.
export function pillColors(color: string): Record<Theme, PillColors> {
	const sc = parseHex(HEX.test(color) ? color : '#9ca3af');
	const one = (theme: Theme): PillColors => {
		const { panel, ink } = THEMES[theme];
		const tint = parseHex(toHex(mix(sc, parseHex(panel), 0.2)));
		const text = readable(mix(sc, parseHex(ink), 0.58), tint);
		return { tint: toHex(tint), text: toHex(text) };
	};
	return { light: one('light'), dark: one('dark') };
}

// A person's avatar: a background of their hue, and initials that read on it.
export function personColors(hue: number): { background: string; text: string } {
	const background = parseHex(toHex(hsl(hue, 0.62, 0.46)));
	const text = contrast(WHITE, background) >= AA ? WHITE : readable(background, background);
	return { background: toHex(background), text: toHex(text) };
}
