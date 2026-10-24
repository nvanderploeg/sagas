import { RELOAD, type Applied } from './apply.ts';
import type { LiveEvent } from './types.ts';

type ScrollsView = { realm: { id: number }; scroll?: { id: number } };

// The rules are "Events" in docs/scrolls.md.
export function applyToScrollView<T extends ScrollsView>(view: T, event: LiveEvent): Applied<T> {
	const realmId = view.realm.id;
	switch (event.type) {
		case 'realm.deleted':
			return event.data.realmId === realmId ? null : view;
		case 'scroll.deleted':
			if (event.data.realmId !== realmId) return view;
			return view.scroll && event.data.ids.includes(view.scroll.id) ? null : RELOAD;
		case 'scroll.created':
		case 'scroll.updated':
		case 'scroll.moved':
			return event.data.scroll.realmId === realmId ? RELOAD : view;
		default:
			return view;
	}
}

// The Path a Scroll has after the Event, when the Event changed it.
export function movedTo(event: LiveEvent, scrollId: number): string | null {
	const changes =
		event.type === 'scroll.moved'
			? event.data.paths
			: event.type === 'scroll.deleted'
				? event.data.moved
				: [];
	return changes.find((change) => change.id === scrollId)?.path ?? null;
}
