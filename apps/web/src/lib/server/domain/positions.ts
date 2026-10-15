import { DomainError } from './errors.ts';

// Rows are parked on negative positions first: the unique index would otherwise reject a row
// moving onto a slot another row still holds.
export function writePositions(ids: number[], write: (id: number, position: number) => void): void {
	ids.forEach((id, index) => write(id, -(index + 1)));
	ids.forEach((id, index) => write(id, index));
}

export function placeAt(order: number[], id: number, index: number | undefined): number[] {
	const at = index ?? order.length;
	if (!Number.isInteger(at) || at < 0 || at > order.length) {
		throw new DomainError('invalid', `index must be between 0 and ${order.length}`);
	}
	return [...order.slice(0, at), id, ...order.slice(at)];
}
