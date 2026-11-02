import { appendFile, mkdir, open, readdir, rm } from 'node:fs/promises';
import {
	isId,
	isRecord,
	isSchedule,
	isScheduleId,
	isScheduleRun,
	type Schedule,
	type ScheduleRun,
} from '@brigadir/core';
import { atomicJson, readDocument, safePath, SessionStore } from './session';
import { ReadFailure } from './index';
const missing = (e: unknown) => isRecord(e) && e.code === 'ENOENT';
/** The history read back for one schedule: the newest lines of `runs.jsonl`. */
const runsTailBytes = 256 * 1024;
/**
 * spec/notifications-slack-notes-and-schedules#schedules: `projects/<p>/schedules/<id>/schedule.json` (`{schemaVersion: 1, schedule}`, atomic) and `runs.jsonl`
 * beside it (append-only). Writes go one after another, so a timer pass never overtakes the person's edit.
 */
export class SchedulesStore {
	private tail: Promise<unknown> = Promise.resolve();
	constructor(readonly root: string) {}
	static async at(dataDir?: string) {
		return new SchedulesStore((await SessionStore.at(dataDir)).root);
	}
	waitForWrites() {
		return this.tail;
	}
	private serial<T>(work: () => Promise<T>) {
		const result = this.tail.catch(() => {}).then(work);
		this.tail = result;
		return result;
	}
	private async dir(projectId: string, id: string, make = false) {
		if (!isId(projectId) || !isScheduleId(id)) throw new ReadFailure('unsafe_path');
		const dir = await safePath(this.root, 'projects', projectId, 'schedules', id);
		if (make) await mkdir(dir, { recursive: true, mode: 0o700 });
		return dir;
	}
	async read(projectId: string, id: string): Promise<Schedule> {
		const doc = await readDocument(await safePath(await this.dir(projectId, id), 'schedule.json'));
		if (!isSchedule(doc.schedule) || doc.schedule.id !== id || doc.schedule.projectId !== projectId)
			throw new ReadFailure('invalid_document');
		return doc.schedule;
	}
	/** Every readable schedule of every project; a broken file is left out, not fatal. */
	async list(): Promise<Schedule[]> {
		let projects: string[];
		try {
			projects = (await readdir(await safePath(this.root, 'projects'))).filter(isId);
		} catch (e) {
			if (missing(e)) return [];
			throw e;
		}
		const out: Schedule[] = [];
		for (const projectId of projects) {
			let ids: string[];
			try {
				ids = (await readdir(await safePath(this.root, 'projects', projectId, 'schedules'))).filter(
					isScheduleId
				);
			} catch (e) {
				if (missing(e)) continue;
				throw e;
			}
			for (const id of ids) {
				try {
					out.push(await this.read(projectId, id));
				} catch {
					/* unreadable: skipped */
				}
			}
		}
		return out.sort(
			(a, b) =>
				a.projectId.localeCompare(b.projectId) ||
				a.name.localeCompare(b.name) ||
				a.id.localeCompare(b.id)
		);
	}
	save(schedule: Schedule) {
		return this.serial(async () => {
			if (!isSchedule(schedule)) throw new ReadFailure('invalid_document');
			const dir = await this.dir(schedule.projectId, schedule.id, true);
			await atomicJson(await safePath(dir, 'schedule.json'), { schemaVersion: 1, schedule });
			return schedule;
		});
	}
	/** Read, change and write back as one step: the timer and the person never write over each other. */
	update(projectId: string, id: string, change: (schedule: Schedule) => Schedule) {
		return this.serial(async () => {
			const next = change(await this.read(projectId, id));
			if (!isSchedule(next) || next.id !== id || next.projectId !== projectId)
				throw new ReadFailure('invalid_document');
			await atomicJson(await safePath(await this.dir(projectId, id), 'schedule.json'), {
				schemaVersion: 1,
				schedule: next,
			});
			return next;
		});
	}
	delete(projectId: string, id: string) {
		return this.serial(async () => {
			await rm(await this.dir(projectId, id), { recursive: true, force: true });
		});
	}
	appendRuns(projectId: string, id: string, runs: ScheduleRun[]) {
		if (!runs.length) return Promise.resolve();
		return this.serial(async () => {
			const dir = await this.dir(projectId, id, true);
			await appendFile(
				await safePath(dir, 'runs.jsonl'),
				runs.map((run) => `${JSON.stringify(run)}\n`).join(''),
				{ mode: 0o600 }
			);
		});
	}
	/** The newest runs first, at most `limit`. */
	async runs(projectId: string, id: string, limit = 200): Promise<ScheduleRun[]> {
		let text: string;
		try {
			const file = await open(await safePath(await this.dir(projectId, id), 'runs.jsonl'), 'r');
			try {
				const size = (await file.stat()).size,
					from = Math.max(0, size - runsTailBytes),
					buffer = Buffer.alloc(size - from);
				await file.read(buffer, 0, buffer.length, from);
				text = buffer.toString('utf8');
				if (from > 0) text = text.slice(text.indexOf('\n') + 1);
			} finally {
				await file.close();
			}
		} catch (e) {
			if (missing(e)) return [];
			throw e;
		}
		const out: ScheduleRun[] = [];
		for (const line of text.split('\n').reverse()) {
			if (!line) continue;
			try {
				const run: unknown = JSON.parse(line);
				if (isScheduleRun(run)) out.push(run);
			} catch {
				/* a torn last line */
			}
			if (out.length >= limit) break;
		}
		return out;
	}
}
