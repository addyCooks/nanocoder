import type {Message} from '@/types/core';
import {isFileMutationTool} from '@/utils/tool-approval';

/**
 * Completion evidence ledger.
 *
 * Models routinely declare a task done after editing code without ever
 * running the tests, linter, or type checker that would have caught a
 * mistake. This derives, by scanning the conversation's own persisted
 * messages (no new session-scoped state — sessions resume from disk, and a
 * fresh in-memory tracker would not survive that), whether every command
 * configured in `nanocoder.verify.required` has a passing (exit 0)
 * `execute_bash` run newer than the most recent file edit.
 * `conversation-loop.tsx` uses this at the point a turn would otherwise
 * naturally conclude, injecting one more corrective turn when evidence is
 * missing or stale — the same shape as the existing auto-diagnostics and
 * walkthrough-fallback nudges in that file. Opt-in: an empty/unconfigured
 * `required` list means there is nothing to enforce, not "guess at
 * something" — a wrong guess (the wrong test command, or a slow full
 * suite nobody asked to gate on) is worse than no gate at all.
 */

const EXECUTE_BASH_TOOL_NAME = 'execute_bash';

interface BashLedgerEntry {
	command: string;
	exitCode: number | null;
	/** Position in the messages array, for ordering against the last edit. */
	index: number;
}

function collectBashEntries(messages: Message[]): BashLedgerEntry[] {
	const entries: BashLedgerEntry[] = [];
	messages.forEach((message, index) => {
		if (message.role !== 'tool' || message.name !== EXECUTE_BASH_TOOL_NAME) {
			return;
		}
		const structured = message.structuredContent;
		if (
			!structured ||
			typeof structured !== 'object' ||
			Array.isArray(structured)
		) {
			return;
		}
		const {command, exitCode} = structured as Record<string, unknown>;
		if (typeof command !== 'string') return;
		entries.push({
			command,
			exitCode: typeof exitCode === 'number' ? exitCode : null,
			index,
		});
	});
	return entries;
}

/** Index of the message carrying the most recent file-mutating tool call. */
function lastMutationIndex(messages: Message[]): number {
	let last = -1;
	messages.forEach((message, index) => {
		if (
			message.tool_calls?.some(call => isFileMutationTool(call.function.name))
		) {
			last = index;
		}
	});
	return last;
}

/** Whether a command the model ran satisfies a required command. */
function commandSatisfies(required: string, ran: string): boolean {
	const trimmedRequired = required.trim();
	const trimmedRan = ran.trim();
	return (
		trimmedRan === trimmedRequired ||
		trimmedRan.startsWith(`${trimmedRequired} `)
	);
}

export interface CompletionLedgerStatus {
	/** Whether any file-mutating tool has run in this conversation at all. */
	hasMutations: boolean;
	/** Required commands with no exit-0 run newer than the last edit. */
	missing: string[];
}

/**
 * Evaluate the ledger against the conversation so far. Returns
 * `missing: []` whenever there is nothing to enforce — no mutations have
 * happened, or no commands are required — so callers never need a separate
 * "is the gate even applicable" check.
 */
export function evaluateCompletionLedger(
	messages: Message[],
	requiredCommands: string[],
): CompletionLedgerStatus {
	const mutationIndex = lastMutationIndex(messages);
	if (mutationIndex === -1 || requiredCommands.length === 0) {
		return {hasMutations: mutationIndex !== -1, missing: []};
	}

	const entries = collectBashEntries(messages);
	const missing = requiredCommands.filter(
		required =>
			!entries.some(
				entry =>
					entry.index > mutationIndex &&
					entry.exitCode === 0 &&
					commandSatisfies(required, entry.command),
			),
	);

	return {hasMutations: true, missing};
}

/**
 * Opening text of the synthetic message the loop injects when completion
 * evidence is missing or stale. Sent with `role: 'user'` so the model treats
 * it as an instruction, matching the auto-diagnostics nudge.
 */
const LEDGER_NUDGE_PREFIX =
	'Completion evidence is missing or stale for this turn.';

/** True for the synthetic ledger nudge message. */
export function isLedgerNudgeMessage(message: Message): boolean {
	return (
		message.role === 'user' && message.content.startsWith(LEDGER_NUDGE_PREFIX)
	);
}

/**
 * Consecutive ledger nudges tolerated before giving up and letting the turn
 * conclude anyway (with the gap reflected in the summary note). Without a
 * cap, a model that can't or won't run the required commands would loop
 * forever instead of ever reaching the user.
 */
const MAX_LEDGER_NUDGES = 2;

function countLedgerNudges(messages: Message[]): number {
	return messages.filter(isLedgerNudgeMessage).length;
}

export function buildLedgerNudgeMessage(missing: string[]): Message {
	const list = missing.map(command => `- ${command}`).join('\n');
	return {
		role: 'user',
		content:
			`${LEDGER_NUDGE_PREFIX} You must run the following and confirm a clean ` +
			`(exit code 0) result before marking this task complete:\n${list}\n\n` +
			'Run them with execute_bash now, then continue.',
	};
}

/**
 * The nudge to inject for an already-evaluated status, or null when the turn
 * may conclude without one: either evidence is already fresh, there was
 * nothing to verify, or the nudge cap has been reached. Takes `status` rather
 * than re-deriving it so a caller that also needs the summary note evaluates
 * the ledger once per turn, not twice.
 */
export function buildLedgerNudgeIfNeeded(
	status: CompletionLedgerStatus,
	messages: Message[],
): Message | null {
	if (status.missing.length === 0) return null;
	if (countLedgerNudges(messages) >= MAX_LEDGER_NUDGES) return null;
	return buildLedgerNudgeMessage(status.missing);
}

/** One line per required command, for the final response. Null when there's nothing to report. */
export function buildLedgerSummaryNote(
	status: CompletionLedgerStatus,
	requiredCommands: string[],
): string | null {
	if (!status.hasMutations || requiredCommands.length === 0) return null;

	const missingSet = new Set(status.missing);
	const lines = requiredCommands.map(
		required => `${missingSet.has(required) ? '✗' : '✓'} ${required}`,
	);
	return `Verification evidence:\n${lines.join('\n')}`;
}
