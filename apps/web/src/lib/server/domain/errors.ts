export type DomainErrorCode = 'invalid' | 'not_found' | 'conflict' | 'forbidden';

export class DomainError extends Error {
	readonly code: DomainErrorCode;

	constructor(code: DomainErrorCode, message: string) {
		super(message);
		this.name = 'DomainError';
		this.code = code;
	}
}
