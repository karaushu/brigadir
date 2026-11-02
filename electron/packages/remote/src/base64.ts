/**
 * spec/remote-access-and-mobile#phone-network: base64 for the gateway's frames and the phone's WebAuthn values, the same in Node and in a browser
 * (`Buffer` where it is, `btoa`/`atob` otherwise). Decoding refuses anything but the alphabet it is asked for.
 */
const hasBuffer = typeof Buffer !== 'undefined';
export function toBase64(data: Uint8Array): string {
	if (hasBuffer) return Buffer.from(data.buffer, data.byteOffset, data.length).toString('base64');
	let text = '';
	for (let index = 0; index < data.length; index += 0x8000)
		text += String.fromCharCode(...data.subarray(index, index + 0x8000));
	return btoa(text);
}
export function fromBase64(text: string): Uint8Array {
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 === 1) throw new Error('Not base64');
	if (hasBuffer) return new Uint8Array(Buffer.from(text, 'base64'));
	const binary = atob(text);
	const out = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) out[index] = binary.charCodeAt(index);
	return out;
}
/** RFC 4648 spec/diff-and-review#review-comments without padding: WebAuthn's ids and challenges, Web Push keys. */
export function toBase64Url(data: Uint8Array): string {
	return toBase64(data).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function fromBase64Url(text: string): Uint8Array {
	if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) throw new Error('Not base64url');
	const plain = text.replace(/-/g, '+').replace(/_/g, '/');
	return fromBase64(plain + '='.repeat((4 - (plain.length % 4)) % 4));
}
