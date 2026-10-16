const KEY = 'sagas-advanced';

class AdvancedView {
	// Stays false until start() runs: the first client render must match the server's.
	on = $state(false);

	start(): () => void {
		this.on = stored();
		const follow = (event: StorageEvent) => {
			if (event.key === KEY || event.key === null) this.on = stored();
		};
		addEventListener('storage', follow);
		return () => removeEventListener('storage', follow);
	}

	set(on: boolean): void {
		this.on = on;
		try {
			if (on) localStorage.setItem(KEY, 'on');
			else localStorage.removeItem(KEY);
		} catch {
			// storage blocked: the choice lasts this page only
		}
	}
}

function stored(): boolean {
	try {
		return localStorage.getItem(KEY) === 'on';
	} catch {
		return false;
	}
}

export const advanced = new AdvancedView();
