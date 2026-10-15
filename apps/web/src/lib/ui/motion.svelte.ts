import { browser } from '$app/env';

class Motion {
	reduced = $state(false);

	constructor() {
		if (!browser) return;
		const media = window.matchMedia('(prefers-reduced-motion: reduce)');
		this.reduced = media.matches;
		media.addEventListener('change', () => (this.reduced = media.matches));
	}

	// A duration, or 0 when the User asks for reduced motion.
	ms(value: number): number {
		return this.reduced ? 0 : value;
	}
}

export const motion = new Motion();
