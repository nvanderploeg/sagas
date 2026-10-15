export type Notice = { id: number; text: string; tone: 'error' | 'info' };

class Notices {
	list = $state<Notice[]>([]);
	#next = 1;

	show(text: string, tone: Notice['tone'] = 'info', ms = 5000): void {
		const id = this.#next++;
		this.list = [...this.list, { id, text, tone }];
		setTimeout(() => this.dismiss(id), ms);
	}

	error(error: unknown): void {
		this.show(error instanceof Error ? error.message : String(error), 'error', 7000);
	}

	dismiss(id: number): void {
		this.list = this.list.filter((n) => n.id !== id);
	}
}

export const notices = new Notices();
