import {
	planAskDue,
	planAskPrompt,
	planModeChoice,
	planModeDeclined,
	planModeDue,
	planModeReturn,
	type EventRecord,
	type SessionEvent,
} from '@brigadir/core';
import type { PlanModeState } from './task-class';

type ModeCommand =
	{ kind: 'setMode'; modeId: string } | { kind: 'setOption'; id: string; value: string };
export type PlanModeDeps = {
	records(): readonly EventRecord[];
	emit(event: SessionEvent): Promise<void>;
	/** spec/reviews#classes: the tasks that have a class. */
	eligible: boolean;
	/** The command to the agent's session, outside a turn. */
	send(command: ModeCommand): Promise<void>;
	/** A host prompt in front of the queue with the marker `plan-ask`. */
	ask(text: string): Promise<void>;
	stopping(): boolean;
};
const command = (option: string | null, value: string): ModeCommand =>
	option === null ? { kind: 'setMode', modeId: value } : { kind: 'setOption', id: option, value };
/**
 * spec/reviews#plan-mode: plan mode by the host. Between turns only: before a turn the session goes into its plan mode while the class owes a
 * plan, at a turn's end the host asks for the plan once and brings back the mode from before its switch after an approval.
 */
export class PlanModeLife {
	private tail: Promise<unknown> = Promise.resolve();
	/** The owed plans (by the seq they became owed) this host asked for; the journal knows once the ask is queued. */
	private asked = new Set<number>();
	constructor(private deps: PlanModeDeps) {}
	private serial<T>(work: () => Promise<T>): Promise<T> {
		const result = this.tail.catch(() => {}).then(work);
		this.tail = result;
		return result;
	}
	/** The class's `next` names the plan by where the session stands. */
	state(): PlanModeState {
		const choice = planModeChoice(this.deps.records());
		return !choice ? 'none' : choice.current === choice.value ? 'on' : 'available';
	}
	/** Before a turn starts: a switch the agent refuses is left, and the turn runs as it is. */
	beforeTurn() {
		if (!this.deps.eligible) return Promise.resolve();
		return this.serial(async () => {
			const due = planModeDue(this.deps.records());
			if (!due || this.deps.stopping()) return;
			try {
				await this.deps.send(command(due.option, due.value));
			} catch (error) {
				process.stderr.write(
					`[host] plan mode switch failed: ${error instanceof Error ? error.message : String(error)}\n`
				);
				return;
			}
			await this.deps.emit({
				kind: 'plan.mode',
				on: true,
				by: 'host',
				class: due.class,
				...(due.option !== null ? { option: due.option } : {}),
				name: due.name,
				value: due.value,
				valueName: due.valueName,
				...(due.current !== null
					? { previous: due.current, previousName: due.currentName ?? due.current }
					: {}),
			});
		});
	}
	/** A turn ended: the mode from before the switch after an approval, then the ask for a plan still owed. A stopped turn gets no ask. */
	async turnEnded(cancelled: boolean) {
		if (!this.deps.eligible) return;
		// The ask runs outside the chain: its turn's `beforeTurn` waits on it.
		const ask = await this.serial(async () => {
			if (this.deps.stopping()) return null;
			const back = planModeReturn(this.deps.records());
			if (back)
				try {
					await this.deps.send(command(back.option, back.previous));
					await this.deps.emit({
						kind: 'plan.mode',
						on: false,
						by: 'host',
						class: back.class,
						...(back.option !== null ? { option: back.option } : {}),
						name: back.name,
						value: back.previous,
						valueName: back.previousName,
					});
				} catch (error) {
					process.stderr.write(
						`[host] plan mode return failed: ${error instanceof Error ? error.message : String(error)}\n`
					);
				}
			if (cancelled) return null;
			const due = planAskDue(this.deps.records());
			if (!due || this.asked.has(due.since)) return null;
			this.asked.add(due.since);
			return planAskPrompt(due.class);
		});
		if (ask) await this.deps.ask(ask);
	}
	/** The person's own mode change: off the plan after the host's switch, it is kept. */
	person(
		change:
			| { kind: 'setMode'; modeId: string }
			| { kind: 'setOption'; id: string; value: string | boolean }
	) {
		if (!this.deps.eligible) return Promise.resolve();
		return this.serial(async () => {
			const event = planModeDeclined(this.deps.records(), change);
			if (event) await this.deps.emit(event);
		});
	}
}
