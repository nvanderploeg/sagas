import { App } from '@modelcontextprotocol/ext-apps';

type State = { key: string; label: string; color: string; closed: boolean };
type Card = {
	key: string;
	url: string;
	title: string;
	state: string;
	substate: string | null;
	assignee: string | null;
	labels: string[];
};
type Board = {
	realm: { key: string; name: string; url: string; states: State[] };
	labours: Card[];
	total: number;
	truncated: boolean;
};

const root = document.getElementById('root')!;

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	props: Partial<HTMLElementTagNameMap[K]> = {},
	...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
	const node = Object.assign(document.createElement(tag), props);
	node.append(...children);
	return node;
}

function render(board: Board): void {
	const board_ = el('div', { className: 'board' });
	for (const state of board.realm.states) {
		const cards = board.labours.filter((l) => l.state === state.key);
		const column = el('section', { className: 'column' });
		column.style.borderTopColor = state.color;
		column.append(el('h2', {}, `${state.label} (${cards.length})`));
		if (!state.closed) {
			for (const l of cards) {
				const meta = [l.substate, l.assignee, ...l.labels].filter(Boolean).join(' · ');
				const card = el(
					'a',
					{ className: 'card', href: l.url, target: '_blank', rel: 'noreferrer' },
					el('div', { className: 'key' }, l.key),
					el('div', {}, l.title)
				);
				if (meta) card.append(el('div', { className: 'meta' }, meta));
				column.append(card);
			}
		}
		board_.append(column);
	}
	const title = el(
		'h1',
		{},
		el('a', { href: board.realm.url, target: '_blank', rel: 'noreferrer' }, board.realm.name)
	);
	root.replaceChildren(title, board_);
	if (board.truncated) {
		root.append(
			el('p', { className: 'note' }, `Showing ${board.labours.length} of ${board.total}.`)
		);
	}
}

const app = new App({ name: 'sagas-board', version: '0.1.0' });

// The host sandbox swallows anchor navigation; links open only through the host.
root.addEventListener('click', (event) => {
	const anchor = (event.target as Element).closest('a');
	if (anchor === null) return;
	event.preventDefault();
	void app.openLink({ url: anchor.href });
});

app.ontoolresult = (result) => {
	const data = result.structuredContent as Board | undefined;
	if (data?.realm) render(data);
	else root.replaceChildren(el('p', { className: 'note' }, 'No board to show.'));
};
await app.connect();
