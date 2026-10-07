import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'ava';
import {clearAppConfig} from '@/config/index';
import {processAssistantResponse} from '@/hooks/chat-handler/conversation/conversation-loop.js';
import {setToolRegistryGetter} from '@/message-handler.js';
import type {LLMChatResponse, Message, ToolCall} from '@/types/core';
import {resetShutdownManager} from '@/utils/shutdown/shutdown-manager.js';
import {
	buildLedgerNudgeIfNeeded,
	buildLedgerNudgeMessage,
	buildLedgerSummaryNote,
	evaluateCompletionLedger,
	isLedgerNudgeMessage,
} from './completion-ledger.js';

test.before(() => {
	resetShutdownManager();
});

test.after.always(() => {
	resetShutdownManager();
});

const TMP_ROOT = realpathSync(tmpdir());

// ============================================================================
// evaluateCompletionLedger / isLedgerNudgeMessage / buildLedgerNudgeIfNeeded /
// buildLedgerSummaryNote
// ============================================================================

const toolCall = (
	id: string,
	name: string,
	args: Record<string, unknown> = {},
): ToolCall => ({id, function: {name, arguments: args}});

const assistantToolCallMessage = (call: ToolCall): Message => ({
	role: 'assistant',
	content: '',
	tool_calls: [call],
});

const toolResultMessage = (
	id: string,
	name: string,
	overrides: Partial<Message> = {},
): Message => ({
	role: 'tool',
	tool_call_id: id,
	name,
	content: 'ok',
	...overrides,
});

const bashResultMessage = (id: string, command: string, exitCode: number) =>
	toolResultMessage(id, 'execute_bash', {
		structuredContent: {command, exitCode},
		...(exitCode !== 0 ? {isError: true} : {}),
	});

test('evaluateCompletionLedger reports nothing missing when nothing has mutated', t => {
	const messages: Message[] = [
		{role: 'user', content: 'hi'},
		{role: 'assistant', content: 'hello'},
	];
	t.deepEqual(evaluateCompletionLedger(messages, ['npm test']), {
		hasMutations: false,
		missing: [],
	});
});

test('evaluateCompletionLedger reports nothing missing when no commands are required', t => {
	const messages: Message[] = [
		assistantToolCallMessage(toolCall('1', 'write_file')),
		toolResultMessage('1', 'write_file'),
	];
	t.deepEqual(evaluateCompletionLedger(messages, []), {
		hasMutations: true,
		missing: [],
	});
});

test('evaluateCompletionLedger flags a required command with no run at all', t => {
	const messages: Message[] = [
		assistantToolCallMessage(toolCall('1', 'write_file')),
		toolResultMessage('1', 'write_file'),
	];
	t.deepEqual(evaluateCompletionLedger(messages, ['pnpm run test:all']), {
		hasMutations: true,
		missing: ['pnpm run test:all'],
	});
});

test('evaluateCompletionLedger is satisfied by a passing run after the edit', t => {
	const messages: Message[] = [
		assistantToolCallMessage(toolCall('1', 'write_file')),
		toolResultMessage('1', 'write_file'),
		assistantToolCallMessage(
			toolCall('2', 'execute_bash', {command: 'pnpm run test:all'}),
		),
		bashResultMessage('2', 'pnpm run test:all', 0),
	];
	t.deepEqual(evaluateCompletionLedger(messages, ['pnpm run test:all']), {
		hasMutations: true,
		missing: [],
	});
});

test('evaluateCompletionLedger treats a run from before the edit as stale', t => {
	const messages: Message[] = [
		assistantToolCallMessage(
			toolCall('1', 'execute_bash', {command: 'pnpm run test:all'}),
		),
		bashResultMessage('1', 'pnpm run test:all', 0),
		assistantToolCallMessage(toolCall('2', 'write_file')),
		toolResultMessage('2', 'write_file'),
	];
	t.deepEqual(evaluateCompletionLedger(messages, ['pnpm run test:all']), {
		hasMutations: true,
		missing: ['pnpm run test:all'],
	});
});

test('evaluateCompletionLedger does not accept a failing run', t => {
	const messages: Message[] = [
		assistantToolCallMessage(toolCall('1', 'write_file')),
		toolResultMessage('1', 'write_file'),
		assistantToolCallMessage(
			toolCall('2', 'execute_bash', {command: 'pnpm run test:all'}),
		),
		bashResultMessage('2', 'pnpm run test:all', 1),
	];
	t.deepEqual(evaluateCompletionLedger(messages, ['pnpm run test:all']), {
		hasMutations: true,
		missing: ['pnpm run test:all'],
	});
});

test('evaluateCompletionLedger requires every configured command independently', t => {
	const messages: Message[] = [
		assistantToolCallMessage(toolCall('1', 'write_file')),
		toolResultMessage('1', 'write_file'),
		assistantToolCallMessage(
			toolCall('2', 'execute_bash', {command: 'pnpm run test:ava'}),
		),
		bashResultMessage('2', 'pnpm run test:ava', 0),
	];
	t.deepEqual(
		evaluateCompletionLedger(messages, [
			'pnpm run test:ava',
			'pnpm run test:lint',
		]),
		{hasMutations: true, missing: ['pnpm run test:lint']},
	);
});

test('evaluateCompletionLedger matches a required command run with extra arguments', t => {
	const messages: Message[] = [
		assistantToolCallMessage(toolCall('1', 'write_file')),
		toolResultMessage('1', 'write_file'),
		assistantToolCallMessage(
			toolCall('2', 'execute_bash', {
				command: 'pnpm run test:ava source/foo.spec.ts',
			}),
		),
		bashResultMessage('2', 'pnpm run test:ava source/foo.spec.ts', 0),
	];
	t.deepEqual(evaluateCompletionLedger(messages, ['pnpm run test:ava']), {
		hasMutations: true,
		missing: [],
	});
});

test('evaluateCompletionLedger does not match an unrelated command sharing a prefix word', t => {
	const messages: Message[] = [
		assistantToolCallMessage(toolCall('1', 'write_file')),
		toolResultMessage('1', 'write_file'),
		assistantToolCallMessage(
			toolCall('2', 'execute_bash', {command: 'pnpm run test:ava-coverage'}),
		),
		bashResultMessage('2', 'pnpm run test:ava-coverage', 0),
	];
	t.deepEqual(evaluateCompletionLedger(messages, ['pnpm run test:ava']), {
		hasMutations: true,
		missing: ['pnpm run test:ava'],
	});
});

test('isLedgerNudgeMessage identifies only the synthetic nudge', t => {
	t.true(isLedgerNudgeMessage(buildLedgerNudgeMessage(['pnpm run test:all'])));
	t.false(
		isLedgerNudgeMessage({
			role: 'assistant',
			content: 'Completion evidence is missing or stale for this turn.',
		}),
	);
	t.false(isLedgerNudgeMessage({role: 'user', content: 'something else'}));
});

test('buildLedgerNudgeIfNeeded returns null when nothing is missing', t => {
	t.is(
		buildLedgerNudgeIfNeeded({hasMutations: true, missing: []}, []),
		null,
	);
});

test('buildLedgerNudgeIfNeeded names the missing commands', t => {
	const status = {hasMutations: true, missing: ['pnpm run test:all']};
	const nudge = buildLedgerNudgeIfNeeded(status, []);
	t.truthy(nudge);
	t.is(nudge?.role, 'user');
	t.true(nudge?.content.includes('pnpm run test:all'));
	t.true(isLedgerNudgeMessage(nudge as Message));
});

test('buildLedgerNudgeIfNeeded stops nudging once the cap is reached', t => {
	const status = {hasMutations: true, missing: ['pnpm run test:all']};
	const oneNudge = [buildLedgerNudgeMessage(['pnpm run test:all'])];
	t.truthy(
		buildLedgerNudgeIfNeeded(status, oneNudge),
		'still under the cap after one nudge',
	);

	const twoNudges = [...oneNudge, buildLedgerNudgeMessage(['pnpm run test:all'])];
	t.is(
		buildLedgerNudgeIfNeeded(status, twoNudges),
		null,
		'cap reached after two nudges',
	);
});

test('buildLedgerSummaryNote returns null when nothing mutated', t => {
	t.is(
		buildLedgerSummaryNote({hasMutations: false, missing: []}, [
			'pnpm run test:all',
		]),
		null,
	);
});

test('buildLedgerSummaryNote returns null when nothing is required', t => {
	t.is(buildLedgerSummaryNote({hasMutations: true, missing: []}, []), null);
});

test('buildLedgerSummaryNote marks passing and missing commands distinctly', t => {
	const note = buildLedgerSummaryNote(
		{hasMutations: true, missing: ['pnpm run test:lint']},
		['pnpm run test:ava', 'pnpm run test:lint'],
	);
	t.truthy(note);
	t.true(note?.includes('✓ pnpm run test:ava'));
	t.true(note?.includes('✗ pnpm run test:lint'));
});

// ============================================================================
// End-to-end: the gate wired into processAssistantResponse's natural-end branch
// ============================================================================

function withVerifyConfig<T>(
	required: string[],
	body: () => Promise<T>,
): Promise<T> {
	const root = mkdtempSync(join(TMP_ROOT, 'nanocoder-ledger-'));
	const configDir = join(root, 'config');
	mkdirSync(configDir, {recursive: true});
	writeFileSync(
		join(root, 'agents.config.json'),
		JSON.stringify({nanocoder: {verify: {required}}}),
		'utf-8',
	);

	const originalCwd = process.cwd();
	const originalConfigDir = process.env.NANOCODER_CONFIG_DIR;
	process.chdir(root);
	process.env.NANOCODER_CONFIG_DIR = configDir;
	clearAppConfig();

	return body().finally(() => {
		process.chdir(originalCwd);
		if (originalConfigDir === undefined) {
			delete process.env.NANOCODER_CONFIG_DIR;
		} else {
			process.env.NANOCODER_CONFIG_DIR = originalConfigDir;
		}
		clearAppConfig();
		rmSync(root, {recursive: true, force: true});
	});
}

const createLoopParams = (overrides = {}) => ({
	systemMessage: {role: 'system', content: 'You are a helpful assistant'} as Message,
	messages: [{role: 'user', content: 'Hello'}] as Message[],
	client: null as any,
	toolManager: null,
	abortController: null,
	setAbortController: () => {},
	setIsGenerating: () => {},
	setStreamingReasoning: () => {},
	setStreamingContent: () => {},
	setTokenCount: () => {},
	setMessages: () => {},
	addToChatQueue: () => {},
	currentModel: 'test-model',
	currentProvider: 'openai',
	developmentMode: 'normal' as const,
	nonInteractiveMode: false,
	conversationStateManager: {
		current: {
			updateAssistantMessage: () => {},
			updateAfterToolExecution: () => {},
		},
	} as any,
	onConversationComplete: () => {},
	...overrides,
});

const createLoopToolManager = (availableTools: string[]) =>
	({
		hasTool: (name: string) => availableTools.includes(name),
		getToolNames: () => availableTools,
		getToolEntry: (name: string) => ({
			name,
			approval: false,
		}),
		getToolValidator: () => undefined,
		getToolFormatter: () => undefined,
		getAvailableToolNames: () => availableTools,
		getFilteredTools: (names: string[]) => {
			const tools: Record<string, unknown> = {};
			for (const name of names) {
				tools[name] = {
					name,
					description: `Mock tool ${name}`,
					input_schema: {type: 'object', properties: {}},
				};
			}
			return tools;
		},
		isReadOnly: () => false,
	}) as any;

const assistantTurn = (content: string, calls?: ToolCall[]): LLMChatResponse => ({
	choices: [
		{
			message: {
				role: 'assistant',
				content,
				tool_calls: calls,
			},
		},
	],
	toolsDisabled: false,
});

test.serial(
	'processAssistantResponse nudges, then gives up, when verification evidence never appears',
	async t => {
		await withVerifyConfig(['npm run test'], async () => {
			let chatCallCount = 0;
			const seenMessages: Message[][] = [];

			setToolRegistryGetter(() => ({
				write_file: async () => 'Wrote file',
			}));

			const trackingClient = {
				chat: async (messages: Message[]): Promise<LLMChatResponse> => {
					chatCallCount += 1;
					seenMessages.push(messages);
					if (chatCallCount === 1) {
						return assistantTurn('', [
							toolCall('1', 'write_file', {path: 'a.ts'}),
						]);
					}
					return assistantTurn('Done.');
				},
			};

			await processAssistantResponse(
				createLoopParams({
					client: trackingClient,
					toolManager: createLoopToolManager(['write_file', 'execute_bash']),
				}),
			);

			t.is(
				chatCallCount,
				4,
				'edit turn, two nudge retries, then gives up on the third',
			);
			const turnsSeeingNudges = seenMessages.filter(messages =>
				messages.some(isLedgerNudgeMessage),
			);
			t.is(
				turnsSeeingNudges.length,
				2,
				'two nudges were injected before the cap stopped a third',
			);
		});
	},
);

test.serial(
	'processAssistantResponse concludes without nudging once verification evidence is fresh',
	async t => {
		await withVerifyConfig(['pnpm run test:all'], async () => {
			let chatCallCount = 0;
			const queuedComponents: any[] = [];

			setToolRegistryGetter(() => ({
				write_file: async () => 'Wrote file',
				execute_bash: async () => ({
					llmContent: 'EXIT_CODE: 0\nall good',
					structured: {command: 'pnpm run test:all', exitCode: 0},
				}),
			}));

			const trackingClient = {
				chat: async (): Promise<LLMChatResponse> => {
					chatCallCount += 1;
					if (chatCallCount === 1) {
						return assistantTurn('', [
							toolCall('1', 'write_file', {path: 'a.ts'}),
						]);
					}
					if (chatCallCount === 2) {
						return assistantTurn('', [
							toolCall('2', 'execute_bash', {command: 'pnpm run test:all'}),
						]);
					}
					return assistantTurn('All done.');
				},
			};

			await processAssistantResponse(
				createLoopParams({
					client: trackingClient,
					toolManager: createLoopToolManager(['write_file', 'execute_bash']),
					addToChatQueue: (component: any) => queuedComponents.push(component),
				}),
			);

			t.is(
				chatCallCount,
				3,
				'edit, verify, then a clean final turn with no extra nudge round',
			);
			const summary = queuedComponents.find(
				(c: any) =>
					typeof c.props?.message === 'string' &&
					c.props.message.includes('Verification evidence'),
			);
			t.truthy(
				summary,
				'should surface the ledger summary alongside the completion note',
			);
			t.true(summary.props.message.includes('✓ pnpm run test:all'));
		});
	},
);

test.serial(
	'processAssistantResponse nudges for missing verification evidence in headless mode too',
	async t => {
		await withVerifyConfig(['npm run test'], async () => {
			let chatCallCount = 0;
			const seenMessages: Message[][] = [];

			setToolRegistryGetter(() => ({
				write_file: async () => 'Wrote file',
				execute_bash: async () => ({
					llmContent: 'EXIT_CODE: 0',
					structured: {command: 'npm run test', exitCode: 0},
				}),
			}));

			const trackingClient = {
				chat: async (messages: Message[]): Promise<LLMChatResponse> => {
					chatCallCount += 1;
					seenMessages.push(messages);
					if (chatCallCount === 1) {
						return assistantTurn('', [
							toolCall('1', 'write_file', {path: 'a.ts'}),
						]);
					}
					if (chatCallCount === 2) {
						// Tries to conclude without running the required command.
						return assistantTurn('Done.');
					}
					if (chatCallCount === 3) {
						// Responds to the nudge by running it.
						return assistantTurn('', [
							toolCall('2', 'execute_bash', {command: 'npm run test'}),
						]);
					}
					return assistantTurn('All set.');
				},
			};

			await processAssistantResponse(
				createLoopParams({
					client: trackingClient,
					toolManager: createLoopToolManager(['write_file', 'execute_bash']),
					developmentMode: 'headless',
					nonInteractiveMode: true,
				}),
			);

			t.is(
				chatCallCount,
				4,
				'edit, premature final (nudged), verify run, clean final turn',
			);
			t.true(
				seenMessages.some(messages => messages.some(isLedgerNudgeMessage)),
				'the gate fires in headless mode just like the interactive one',
			);
		});
	},
);
