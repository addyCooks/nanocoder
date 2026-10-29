import type {
	AgentCapabilities,
	McpServer,
	ProtocolVersion,
	SessionModeId,
} from '@agentclientprotocol/sdk';
import {PROTOCOL_VERSION} from '@agentclientprotocol/sdk';
import type {DevelopmentMode} from '@/types/core';
import type {MCPServer} from '@/types/index';

const ACP_MODES: SessionModeId[] = [
	'normal',
	'auto-accept',
	'yolo',
	'plan',
	'architect',
];

const MODE_MAP: Record<SessionModeId, DevelopmentMode> = {
	normal: 'normal',
	'auto-accept': 'auto-accept',
	yolo: 'yolo',
	plan: 'plan',
	architect: 'architect',
};

export function getAgentCapabilities(): AgentCapabilities {
	return {
		loadSession: true,
		// stdio is always supported; Nanocoder has no SSE transport.
		mcpCapabilities: {http: true},
		providers: {},
		sessionCapabilities: {
			close: {},
			list: {},
			delete: {},
			resume: {},
		},
	};
}

/**
 * The MCP servers a client sent, as Nanocoder's own server config. Stdio and
 * HTTP map across; the rest (SSE, MCP-over-ACP) are returned by name in
 * `skipped` so the caller can say they were left out.
 */
export function acpMcpServersToConfig(servers: McpServer[] = []): {
	servers: MCPServer[];
	skipped: string[];
} {
	const toRecord = (pairs: Array<{name: string; value: string}> = []) =>
		Object.fromEntries(pairs.map(({name, value}) => [name, value]));
	const mapped: MCPServer[] = [];
	const skipped: string[] = [];

	for (const server of servers) {
		if (!('type' in server)) {
			mapped.push({
				name: server.name,
				transport: 'stdio',
				command: server.command,
				args: server.args ?? [],
				env: toRecord(server.env),
			});
		} else if (server.type === 'http') {
			mapped.push({
				name: server.name,
				transport: 'http',
				url: server.url,
				headers: toRecord(server.headers),
			});
		} else {
			skipped.push(`${server.name} (${server.type})`);
		}
	}

	return {servers: mapped, skipped};
}

export function getAvailableModes(): SessionModeId[] {
	return ACP_MODES;
}

/**
 * Resolve the protocol version to report back to the client. We must never
 * claim support for a newer protocol than this SDK implements, so clamp the
 * client's requested version down to ours.
 */
export function negotiateProtocolVersion(
	requested: ProtocolVersion,
): ProtocolVersion {
	if (typeof requested === 'number' && requested < PROTOCOL_VERSION) {
		return requested;
	}
	return PROTOCOL_VERSION;
}

export function acpModeToDevelopmentMode(
	modeId: SessionModeId,
): DevelopmentMode {
	return MODE_MAP[modeId] ?? 'auto-accept';
}

export function developmentModeToAcpMode(mode: DevelopmentMode): SessionModeId {
	if (mode === 'headless') return 'auto-accept';
	return mode;
}
