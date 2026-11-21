import type { AgentSession, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { isLocalAgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session-handle";

export function callerSession(ctx: ExtensionContext): AgentSession | undefined {
	const session = AgentRegistry.global().get(ctx.agent.id)?.session;
	return session && isLocalAgentSession(session) ? session : undefined;
}
