import { customType } from 'drizzle-orm/pg-core';

// Epoch milliseconds in a bigint column, read back as a Date.
export const epoch = customType<{ data: Date; driverData: string | number }>({
	dataType: () => 'bigint',
	toDriver: (value) => value.getTime(),
	fromDriver: (value) => new Date(Number(value))
});

export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
	dataType: () => 'bytea'
});

export const tsvector = customType<{ data: string }>({
	dataType: () => 'tsvector'
});
