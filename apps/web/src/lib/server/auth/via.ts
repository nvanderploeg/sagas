import { AsyncLocalStorage } from 'node:async_hooks';

const store = new AsyncLocalStorage<{ name: string } | undefined>();

// Run `body` as a write made through an API token. Every attributed row written inside records the
// token's name; outside, rows record none.
export function withVia<T>(via: { name: string } | undefined, body: () => T): T {
	return store.run(via, body);
}

export function currentVia(): string | null {
	return store.getStore()?.name ?? null;
}
