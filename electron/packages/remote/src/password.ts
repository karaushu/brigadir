/**
 * spec/remote-access-and-mobile#architecture: the remote access password is kept only as a scrypt hash, checked inside mutual TLS, with a growing
 * pause after wrong tries and a block after ten in a row.
 */
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { isRemotePassword } from '@brigadir/core';

export type PasswordHash = {
	algorithm: 'scrypt';
	/** CPU/memory cost (N), block size (r), parallelization (p). */
	N: number;
	r: number;
	p: number;
	salt: string;
	hash: string;
};
/** N = 2^15, r = 8: 32 MiB and roughly 50–100 ms per check on a laptop — a stolen file is slow to brute force. */
export const scryptCost = { N: 1 << 15, r: 8, p: 1 } as const;
const keyLength = 32;
function derive(password: string, salt: Buffer, cost: { N: number; r: number; p: number }) {
	const options: ScryptOptions = { ...cost, maxmem: 128 * cost.N * cost.r * 2 };
	return new Promise<Buffer>((resolve, reject) =>
		scrypt(password.normalize('NFC'), salt, keyLength, options, (error, key) =>
			error ? reject(error) : resolve(key)
		)
	);
}
export async function hashPassword(
	password: string,
	cost: { N: number; r: number; p: number } = scryptCost
): Promise<PasswordHash> {
	if (!isRemotePassword(password)) throw new Error('The password needs at least 10 characters.');
	const salt = randomBytes(16);
	const key = await derive(password, salt, cost);
	return {
		algorithm: 'scrypt',
		...cost,
		salt: salt.toString('base64'),
		hash: key.toString('base64'),
	};
}
export function isPasswordHash(value: unknown): value is PasswordHash {
	if (typeof value !== 'object' || value === null) return false;
	const v = value as Record<string, unknown>;
	return (
		v.algorithm === 'scrypt' &&
		Number.isSafeInteger(v.N) &&
		Number(v.N) >= 1 << 10 &&
		Number(v.N) <= 1 << 20 &&
		Number.isSafeInteger(v.r) &&
		Number(v.r) >= 1 &&
		Number(v.r) <= 32 &&
		Number.isSafeInteger(v.p) &&
		Number(v.p) >= 1 &&
		Number(v.p) <= 4 &&
		typeof v.salt === 'string' &&
		typeof v.hash === 'string' &&
		Buffer.from(v.hash, 'base64').length === keyLength
	);
}
export async function verifyPassword(password: string, stored: PasswordHash): Promise<boolean> {
	if (typeof password !== 'string' || password.length === 0 || password.length > 1024) return false;
	const expected = Buffer.from(stored.hash, 'base64');
	const key = await derive(password, Buffer.from(stored.salt, 'base64'), stored);
	return key.length === expected.length && timingSafeEqual(key, expected);
}

/** spec/remote-access-and-mobile#architecture: ten wrong passwords in a row block the device until «Unblock» on the working machine. */
export const blockAfterFailures = 10;
/** The pause before the next try after `failures` wrong ones in a row: 1 s, 2 s, 4 s … up to 5 min. */
export function passwordPauseMs(failures: number): number {
	if (failures <= 0) return 0;
	return Math.min(1000 * 2 ** (failures - 1), 5 * 60_000);
}
