import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';

export function consoleShell(
	shell: string,
	env: Record<string, string>,
	assets = resolve('packages/host/resources/shell')
) {
	if (!existsSync(assets)) return ['-l'];
	if (basename(shell) === 'zsh') {
		env.BRIGADIR_SHELL_HOME = env.ZDOTDIR || env.HOME || '';
		env.BRIGADIR_SHELL_ASSETS = assets;
		env.ZDOTDIR = assets;
		return ['-l'];
	}
	if (basename(shell) === 'bash')
		return ['-l', '-c', 'exec "$1" --rcfile "$2" -i', 'brigadir', shell, resolve(assets, 'bashrc')];
	if (basename(shell) === 'fish')
		return ['-l', '-C', `source '${resolve(assets, 'fish.fish').replace(/'/g, "\\'")}'`];
	return ['-l'];
}
