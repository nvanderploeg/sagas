import { DomainError } from './errors.ts';

export const LABEL = /^[a-z0-9][a-z0-9:._-]{0,39}$/;
export const LABELS_MAX = 20;

// Lowercases and trims each label, drops repeats and sorts.
export function normalizeLabels(input: readonly string[]): string[] {
	const labels = new Set<string>();
	for (const raw of input) {
		const label = raw.trim().toLowerCase();
		if (!LABEL.test(label)) {
			throw new DomainError(
				'invalid',
				`Label "${raw}" must be 1 to 40 characters: lowercase letters, digits and : . _ -, starting with a letter or digit`
			);
		}
		labels.add(label);
	}
	if (labels.size > LABELS_MAX) {
		throw new DomainError('invalid', `A Labour has at most ${LABELS_MAX} Labels`);
	}
	return [...labels].sort();
}
