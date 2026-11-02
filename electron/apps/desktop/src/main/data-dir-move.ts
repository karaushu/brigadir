import { defaultDataDir, markAppRunning, moveDataDir } from '@brigadir/persistence';

/** spec/architecture-and-platform#data-root: imported first by main, so `~/.brigadir-v2` moves to `~/.brigadir` before any store opens it, then this
 *  copy marks the folder as in use. Tests pin their own folder with `BRIGADIR_DATA_DIR` and never move anything. */
if (!process.env.BRIGADIR_DATA_DIR)
	try {
		moveDataDir(undefined, (message) => console.log(`[brigadir] ${message}`));
		markAppRunning(defaultDataDir());
	} catch (error) {
		console.error('[brigadir] data folder move failed', error);
	}
