// One at a time: a transaction's client runs a single statement at once.
export async function mapSeq<T, R>(
	items: readonly T[],
	map: (item: T, index: number) => Promise<R>
): Promise<R[]> {
	const out: R[] = [];
	for (const [index, item] of items.entries()) out.push(await map(item, index));
	return out;
}

export async function filterAsync<T>(
	items: readonly T[],
	keep: (item: T) => Promise<boolean>
): Promise<T[]> {
	const kept = await mapSeq(items, keep);
	return items.filter((_, index) => kept[index]);
}

export async function mapAll<T, R>(
	items: readonly T[] | undefined,
	map: (item: T) => Promise<R>
): Promise<R[] | undefined> {
	return items === undefined ? undefined : mapSeq(items, map);
}
