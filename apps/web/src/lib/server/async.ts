export async function filterAsync<T>(
	items: readonly T[],
	keep: (item: T) => Promise<boolean>
): Promise<T[]> {
	const kept = await Promise.all(items.map(keep));
	return items.filter((_, index) => kept[index]);
}

export async function mapAll<T, R>(
	items: readonly T[] | undefined,
	map: (item: T) => Promise<R>
): Promise<R[] | undefined> {
	return items === undefined ? undefined : Promise.all(items.map(map));
}
