import { expect, it } from 'vitest';
import { keyStoreState } from './key-store';

it('refuses a Linux key store that is a plain file (spec/remote-access-and-mobile#architecture, spec/remote-access-and-mobile#identity-and-keys)', () => {
	const storage = (backend: string | undefined, available = true) => ({
		isEncryptionAvailable: () => available,
		...(backend ? { getSelectedStorageBackend: () => backend } : {}),
	});
	expect(keyStoreState('linux', storage('gnome_libsecret'))).toBe('ok');
	expect(keyStoreState('linux', storage('kwallet6'))).toBe('ok');
	expect(keyStoreState('linux', storage('basic_text'))).toBe('plain');
	expect(keyStoreState('linux', storage('unknown'))).toBe('plain');
	expect(keyStoreState('linux', storage('gnome_libsecret', false))).toBe('missing');
	// macOS and Windows are not asked (no Keychain prompt before pairing).
	expect(keyStoreState('win32', storage(undefined, false))).toBe('ok');
	expect(keyStoreState('darwin', storage(undefined, false))).toBe('ok');
	expect(keyStoreState('darwin', storage(undefined), 'plain')).toBe('plain');
	expect(keyStoreState('linux', storage('basic_text'), 'nonsense')).toBe('plain');
});
