import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CLOSED_STATE } from '#lib/server/domain/states.ts';
import {
	AA,
	contrast,
	hsl,
	parseHex,
	personColors,
	pillColors,
	THEMES,
	toHex
} from './contrast.ts';
import { FALLBACK_STATE } from './lookup.ts';

const ratio = (text: string, background: string) => contrast(parseHex(text), parseHex(background));

// Every hue at full, middling and pale saturation and lightness, as a person might pick them.
const sweep: string[] = [];
for (let h = 0; h < 360; h += 3) {
	for (const [s, l] of [
		[1, 0.5],
		[0.62, 0.46],
		[0.9, 0.75],
		[0.8, 0.25],
		[0.3, 0.6]
	]) {
		sweep.push(toHex(hsl(h, s, l)));
	}
}
const palette = ['#94a3b8', '#eab308', '#a855f7', CLOSED_STATE.color, FALLBACK_STATE.color];
const extremes = ['#ffffff', '#000000', '#ffff00', '#00ffff', '#ff0000', '#0000ff'];

describe('State pill colours', () => {
	it('reach AA for the text on its tint, in both themes, for any colour', () => {
		const failures: string[] = [];
		for (const color of [...palette, ...extremes, ...sweep]) {
			const colors = pillColors(color);
			for (const theme of ['light', 'dark'] as const) {
				const { text, tint } = colors[theme];
				const value = ratio(text, tint);
				if (value < AA) failures.push(`${color} ${theme} ${value.toFixed(2)}`);
			}
		}
		expect(failures).toEqual([]);
	});

	it('keep the configured hue in the text where it can', () => {
		const { light } = pillColors('#2563eb');
		const [r, , b] = parseHex(light.text);
		expect(b).toBeGreaterThan(r);
	});
});

describe('Avatar colours', () => {
	it('reach AA for the initials on every hue', () => {
		const failures: number[] = [];
		for (let h = 0; h < 360; h++) {
			const { text, background } = personColors(h);
			if (ratio(text, background) < AA) failures.push(h);
		}
		expect(failures).toEqual([]);
	});
});

describe('THEMES', () => {
	it('match the panel and ink of layout.css', () => {
		const css = readFileSync(new URL('../../routes/layout.css', import.meta.url), 'utf8');
		const token = (name: string) => {
			const match = new RegExp(
				`--color-${name}: light-dark\\((#[0-9a-f]{6}), (#[0-9a-f]{6})\\)`
			).exec(css);
			return match ? { light: match[1], dark: match[2] } : null;
		};
		expect(token('panel')).toEqual({ light: THEMES.light.panel, dark: THEMES.dark.panel });
		expect(token('ink')).toEqual({ light: THEMES.light.ink, dark: THEMES.dark.ink });
	});
});
