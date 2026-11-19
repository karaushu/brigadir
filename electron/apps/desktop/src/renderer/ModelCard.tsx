import { useState } from 'react';
import {
	agentProviders,
	autoRootName,
	crewLabel,
	selectOption,
	t,
	type AgentTask,
	type AutoModelRequest,
	type Locale,
	type SessionCommand,
} from '@brigadir/core';
import { ModelQuestion } from './ui/SessionInputs';
import { toastError } from './ui/Toast';
import { useHelperSettings, useProviderCatalogs } from './HelperAgent';
import { catalogModels, modelAnswer, modelEfforts, type ModelChoice } from './hire-card';
/**
 * spec/chat-turns-plans-and-questions#model-card: the Auto agent asks for a model outside its roles. The list is the catalogs of the enabled
 * providers (rule 7); `Save as role` also saves the role to the library.
 */
export function ModelCard({
	request,
	task,
	since,
	submitShortcut,
	locale,
	disabled,
	send,
}: {
	request: AutoModelRequest;
	task: AgentTask;
	since: number;
	submitShortcut: string | null;
	locale: Locale;
	disabled: boolean;
	send(command: SessionCommand): void;
}) {
	const settings = useHelperSettings(),
		catalogs = useProviderCatalogs(settings?.enabled ?? null);
	const enabled = agentProviders.filter((provider) => settings?.enabled[provider]);
	const base = task.auto?.roles.find((role) => role.name === request.role),
		taskModel = task.launchOptions?.find(
			(option) => option.id === selectOption(task.agentOptions ?? [], 'model')?.id
		)?.value,
		baseModel = (provider: string) => {
			if (!base || base.provider !== provider) return undefined;
			const id = selectOption(catalogs[base.provider]?.options ?? [], 'model')?.id;
			return id ? base.requestedChoices.configOptions?.[id] : undefined;
		};
	const models = catalogModels(catalogs, enabled);
	const key = (model: ModelChoice) => `${model.provider}:${model.value}`;
	const preferred = models.find(
		(model) =>
			(!request.provider || model.provider === request.provider) &&
			!!request.model &&
			[model.value, model.name].some(
				(item) => item.toLocaleLowerCase() === request.model!.toLocaleLowerCase()
			)
	);
	const [picked, setPicked] = useState<string | null>(null),
		[effort, setEffort] = useState<string | null>(null),
		[saveAs, setSaveAs] = useState<string | null>(null);
	const selected = picked ?? (preferred ? key(preferred) : null),
		model = models.find((item) => key(item) === selected) ?? null,
		levels = model ? modelEfforts(catalogs[model.provider], model.value) : null,
		level =
			(effort && levels?.choices.some((choice) => choice.value === effort) ? effort : null) ??
			levels?.choices.find(
				(choice) =>
					!!request.effort &&
					[choice.value, choice.name].some(
						(item) => item.toLocaleLowerCase() === request.effort!.toLocaleLowerCase()
					)
			)?.value ??
			null;
	const roleName = crewLabel(locale, request.role);
	const use = () => {
		const catalog = model ? catalogs[model.provider] : null;
		if (!model || !catalog || disabled) return;
		const name = saveAs === null ? null : saveAs.trim() || `${request.role} · ${model.name}`;
		const answer = modelAnswer(catalog, model, level, name);
		// spec/crew#auto-model: `Save as role` puts the role into the library too; the task gets it from the answer either way.
		if (name && base)
			void window.brigadir
				.saveAgentTemplate({
					id: `role-${crypto.randomUUID()}`,
					name,
					role: base.role,
					provider: answer.provider,
					choices: {
						configOptions: Object.fromEntries(
							[answer.model, answer.effort].flatMap((item) => (item ? [[item.id, item.value]] : []))
						),
					},
					choiceNames: Object.fromEntries(
						[answer.model, answer.effort].flatMap((item) => (item ? [[item.id, item.name]] : []))
					),
					...(base.summary ? { summary: base.summary } : {}),
					instructions: base.instructions,
					builtin: false,
				})
				.catch(() => toastError(t(locale, 'The role could not be saved to the library.')));
		send({ kind: 'answerModel', id: request.id, answer });
	};
	return (
		<ModelQuestion
			title={t(locale, '{agent} asks for another model').replace(
				'{agent}',
				autoRootName(task.provider ?? 'claude')
			)}
			part={request.part}
			reason={request.reason}
			groups={
				!settings
					? null
					: enabled.map((provider) => ({
							label: provider === 'claude' ? 'Claude' : 'Codex',
							glyph: provider === 'claude' ? ('claude' as const) : ('openai' as const),
							// spec/chat-turns-plans-and-questions#model-card: a provider whose catalog loads shows `Loading models…` in its place.
							rows:
								catalogs[provider] === undefined
									? null
									: models
											.filter((item) => item.provider === provider)
											.map((item) => ({
												key: key(item),
												name: item.name,
												...(item.provider === task.provider && item.value === taskModel
													? { note: t(locale, 'the model of this task') }
													: item.value === baseModel(provider)
														? {
																note: t(locale, 'the model of role {role}').replace(
																	'{role}',
																	roleName
																),
															}
														: {}),
											})),
						}))
			}
			selected={selected}
			onSelect={(value) => {
				setPicked(value);
				setEffort(null);
			}}
			efforts={levels?.choices ?? null}
			effort={level}
			onEffort={setEffort}
			saveAs={saveAs}
			onSaveAs={setSaveAs}
			keepLabel={t(locale, 'Keep {role}').replace('{role}', roleName)}
			onKeep={() => send({ kind: 'answerModel', id: request.id, answer: null })}
			onUse={use}
			onSettings={() =>
				window.dispatchEvent(new CustomEvent('brigadir:open-settings', { detail: 'agents' }))
			}
			since={since}
			submitShortcut={submitShortcut}
			disabled={disabled}
			locale={locale}
		/>
	);
}
