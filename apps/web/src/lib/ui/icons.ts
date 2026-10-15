// State and Substate icons are names (validate.ts ICON); these are the ones the UI draws.
export const ICONS: Record<string, string> = {
	circle: '○',
	dot: '•',
	quarter: '◔',
	half: '◑',
	'three-quarters': '◕',
	full: '●',
	check: '✓',
	cross: '✕',
	alert: '!',
	question: '?',
	star: '★',
	diamond: '◆',
	square: '■',
	triangle: '▲',
	play: '▶',
	pause: '‖',
	eye: '◉',
	flag: '⚑',
	clock: '◷',
	bolt: 'ϟ',
	heart: '♥'
};

export const ICON_NAMES = Object.keys(ICONS);

// An icon name the UI does not know draws as its first letter.
export function glyph(icon: string): string {
	return ICONS[icon] ?? icon.charAt(0).toUpperCase();
}
