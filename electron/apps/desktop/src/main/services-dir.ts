import { app } from 'electron';
import { join } from 'node:path';
/** spec/architecture-and-platform#packaging: packaged, the helpers live outside app.asar in Contents/Resources/services, because zsh, the agent's CLI
 *  and node-pty run them by path and cannot read an archive; in dev they sit next to out/main. */
export const servicesDir = app.isPackaged
	? join(process.resourcesPath, 'services')
	: join(__dirname, '../services');
