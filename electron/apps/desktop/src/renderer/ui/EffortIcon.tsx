/** spec/agents-and-providers#catalog: a disk filled by the level's place among the model's own levels, so every
 *  level of a list reads differently; the provider's `default` (no pin) is a dot. The order is the provider's (rule 7). */
export function EffortIcon({
	value,
	levels,
	size = 14,
}: {
	value: string;
	levels: readonly { value: string }[];
	size?: number;
}) {
	const ranked = levels.filter((level) => level.value !== 'default'),
		index = ranked.findIndex((level) => level.value === value);
	const ratio = index < 0 ? 0 : (index + 1) / ranked.length;
	const angle = ratio * Math.PI * 2 - Math.PI / 2,
		x = 7 + 4.1 * Math.cos(angle),
		y = 7 + 4.1 * Math.sin(angle);
	return (
		<svg
			data-effort-icon={value}
			aria-hidden="true"
			width={size}
			height={size}
			viewBox="0 0 14 14"
			fill="currentColor"
			style={{ flex: 'none' }}>
			<circle
				cx="7"
				cy="7"
				r="5.25"
				stroke="currentColor"
				strokeWidth="1.15"
				opacity=".45"
				fill="none"
			/>
			{ratio === 1 ? (
				<circle cx="7" cy="7" r="4.1" />
			) : ratio ? (
				<path d={`M7 7V2.9A4.1 4.1 0 ${ratio > 0.5 ? 1 : 0} 1 ${x} ${y}Z`} />
			) : (
				<circle cx="7" cy="7" r="1.8" opacity=".6" />
			)}
		</svg>
	);
}
/** Popup options of an effort select, each row with its level icon. */
export function effortOptions(choices: readonly { value: string; name: string }[], size = 12) {
	return choices.map((choice) => ({
		value: choice.value,
		label: choice.name,
		icon: <EffortIcon value={choice.value} levels={choices} size={size} />,
	}));
}
