import { expect, it } from 'vitest';
import { gateRefusal, lowMemory, passGate, shareReason } from './simulator-gate';
it('reads memory pressure from the system signal, not free memory (spec/browser-and-simulator#sim-cap)', async () => {
	const mac = (level: string) =>
		lowMemory({ platform: 'darwin', run: async () => `${level}\n`, read: async () => '' });
	expect(await mac('1')).toBe(false);
	expect(await mac('2')).toBe(true);
	expect(await mac('4')).toBe(true);
	// An unreadable signal is no signal.
	expect(
		await lowMemory({
			platform: 'darwin',
			run: async () => {
				throw new Error('no sysctl');
			},
			read: async () => '',
		})
	).toBe(false);
	const linux = (files: Record<string, string>) =>
		lowMemory({
			platform: 'linux',
			run: async () => '',
			read: async (path) => {
				if (!(path in files)) throw new Error('ENOENT');
				return files[path]!;
			},
		});
	expect(
		await linux({
			'/proc/pressure/memory': 'some avg10=12.50 avg60=3.00 avg300=1.00 total=1\nfull avg10=0.00',
		})
	).toBe(true);
	expect(
		await linux({ '/proc/pressure/memory': 'some avg10=0.20 avg60=0.00 avg300=0.00 total=1' })
	).toBe(false);
	// Without pressure stall information: MemAvailable under 10 % of MemTotal.
	expect(
		await linux({ '/proc/meminfo': 'MemTotal:       16000000 kB\nMemAvailable:    1000000 kB\n' })
	).toBe(true);
	expect(
		await linux({ '/proc/meminfo': 'MemTotal:       16000000 kB\nMemAvailable:    8000000 kB\n' })
	).toBe(false);
	expect(await lowMemory({ platform: 'win32', run: async () => '4', read: async () => '' })).toBe(
		false
	);
});
it('waits at the gate until a device may start, says why while it waits, and gives up with a sentence (spec/browser-and-simulator#sim-cap)', async () => {
	const seen: boolean[] = [];
	let reads = 0;
	const gate = await passGate({
		device: 'iPad',
		read: async () => ({ running: ++reads < 3 ? 2 : 1, max: 2, lowMemory: false }),
		sleep: async () => {},
		waiting: (on) => seen.push(on),
	});
	expect(gate.running).toBe(1);
	expect(seen).toEqual([true, false]);
	await expect(
		passGate({
			device: 'iPad',
			read: async () => ({ running: 1, max: 2, lowMemory: true }),
			sleep: async () => {},
			waitMs: 10,
			stepMs: 2,
		})
	).rejects.toThrow(
		'Cannot start iPad: memory is low. Retry later, or ask the person to start it.'
	);
	// The person's «Start anyway» passes low memory, never the cap.
	expect(
		(
			await passGate({
				device: 'iPad',
				anyway: true,
				read: async () => ({ running: 1, max: 2, lowMemory: true }),
			})
		).lowMemory
	).toBe(true);
	await expect(
		passGate({
			device: 'iPad',
			anyway: true,
			waitMs: 0,
			read: async () => ({ running: 2, max: 2, lowMemory: true }),
		})
	).rejects.toThrow('2 of 2 local devices run');
	expect(gateRefusal('iPad', { running: 2, max: 2, lowMemory: false })).toContain(
		'Use a running device'
	);
	expect(shareReason({ running: 1, max: 1, lowMemory: false })).toBe('1 of 1 local devices run');
	expect(shareReason({ running: 0, max: 2, lowMemory: true })).toBe('memory is low');
});
