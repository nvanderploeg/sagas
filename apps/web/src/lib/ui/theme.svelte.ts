import { browser } from '$app/env';

export type Theme = 'system' | 'light' | 'dark';

// app.html applies the stored choice before first paint; keep its key in step with KEY.
const KEY = 'workload-theme';

class ThemeChoice {
	value = $state<Theme>('system');

	constructor() {
		if (!browser) return;
		try {
			const stored = localStorage.getItem(KEY);
			if (stored === 'light' || stored === 'dark') this.value = stored;
		} catch {
			// storage blocked: stay on system
		}
	}

	set(theme: Theme): void {
		this.value = theme;
		const root = document.documentElement;
		if (theme === 'system') delete root.dataset.theme;
		else root.dataset.theme = theme;
		try {
			if (theme === 'system') localStorage.removeItem(KEY);
			else localStorage.setItem(KEY, theme);
		} catch {
			// storage blocked: the choice lasts this page only
		}
	}
}

export const theme = new ThemeChoice();
