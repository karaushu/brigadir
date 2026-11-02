import type { RemoteKeyStore } from '@brigadir/core';
/** The part of Electron's `safeStorage` this reads; `getSelectedStorageBackend` exists on Linux only. */
export type KeyStorage = {
	isEncryptionAvailable(): boolean;
	getSelectedStorageBackend?(): string;
};
/**
 * spec/remote-access-and-mobile#architecture, spec/remote-access-and-mobile#identity-and-keys: whether this computer can seal its remote access key. On Linux Chromium falls back to
 * `basic_text` — a plain file — without GNOME Keyring or KWallet; remote access refuses it (`electronVault` throws), so the
 * list of machines says so before anyone types a code. Windows (DPAPI) and macOS (Keychain) always have a store; Linux
 * with a secret service that is not running reads as `missing`.
 * `forced` — e2e only: the state to show (`BRIGADIR_TEST_KEY_STORE`, unpackaged with its own data folder).
 */
export function keyStoreState(
	platform: NodeJS.Platform,
	storage: KeyStorage,
	forced: string | undefined = undefined
): RemoteKeyStore {
	if (forced === 'ok' || forced === 'plain' || forced === 'missing') return forced;
	// macOS and Windows are not asked: reading the Keychain item early could prompt before anyone pairs (spec/remote-access-and-mobile#pairing).
	if (platform !== 'linux') return 'ok';
	const backend = storage.getSelectedStorageBackend?.();
	if (backend === 'basic_text' || backend === 'unknown') return 'plain';
	return storage.isEncryptionAvailable() ? 'ok' : 'missing';
}
