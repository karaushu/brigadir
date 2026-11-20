/**
 * spec/composer-steering-queue-and-ghost#steering-conditions: whether a message can go into the running turn. `steering` drives the composer's keys and
 * placeholder; `sendNow` the deck's `Send now`, which a waiting plan also refuses (a message answers the plan instead, spec/chat-turns-plans-and-questions#plan-chat).
 */
export function steeringState(input: {
	/** A turn of ours runs. */ busy: boolean;
	/** The running turn is an adopted one (a steer Codex ran as its own turn). */ adopted: boolean;
	/** The agent advertised steering (`session.started.steering`). */ steering: boolean;
	/** The person paused the queue. */ paused: boolean;
	/** A rate limit blocks. */ rateLimited: boolean;
	/** spec/agents-and-providers#budget-reached: the task is held at its budget — steering is refused. */ budgetHeld: boolean;
	/** A plan waits for approval. */ planWaiting: boolean;
}): { steering: boolean; sendNow: boolean } {
	const steering =
		input.busy &&
		!input.adopted &&
		input.steering &&
		!input.paused &&
		!input.rateLimited &&
		!input.budgetHeld;
	return { steering, sendNow: steering && !input.planWaiting };
}
