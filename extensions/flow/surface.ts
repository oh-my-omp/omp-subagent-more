import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { type Signal, signal } from "@oh-my-pi/pi-tui";
import { tr } from "../../omomp-shared/i18n.ts";
import { errorText } from "../fork-task/errors.ts";
import { boardNode } from "./board.ts";
import type { MonitorFlow } from "./monitor.ts";
import { trayNode } from "./tray.ts";
import type { FlowView } from "./view.ts";

export type MonitorAccess = {
	readonly load: (ctx: ExtensionContext) => Promise<MonitorFlow | undefined>;
	readonly attach: (listener: (flow: MonitorFlow) => void) => () => void;
};

export type Placement = { readonly kind: "none" } | { readonly kind: "tern" } | { readonly kind: "terminal" };

const TRAY_KEY = "flow.tray";

export function placementOf(ctx: ExtensionContext): Placement {
	if (!ctx.hasUI || ctx.mode !== "tui") return { kind: "none" };
	return process.env.TERN_PANE ? { kind: "tern" } : { kind: "terminal" };
}

type Watched = {
	readonly sessionFile: string;
	readonly view: Signal<FlowView | undefined>;
	flow: MonitorFlow | undefined;
	off: () => void;
};

export function registerMonitor(pi: ExtensionAPI, access: MonitorAccess): void {
	let watched: Watched | undefined;
	let boardOpen = false;

	const unwatch = (): void => {
		watched?.off();
		watched = undefined;
	};

	const follow = (target: Watched, flow: MonitorFlow): void => {
		if (target.flow) return;
		target.flow = flow;
		target.off = flow.feed.subscribe((view) => target.view.set(view));
	};

	const install = async (ctx: ExtensionContext): Promise<void> => {
		unwatch();
		const placement = placementOf(ctx);
		switch (placement.kind) {
			case "none":
			case "tern":
				return;
			case "terminal":
				break;
			default: {
				const unreachable: never = placement;
				return unreachable;
			}
		}
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) {
			ctx.ui.setWidget(TRAY_KEY, undefined);
			return;
		}
		const target: Watched = { sessionFile, view: signal<FlowView | undefined>(undefined), flow: undefined, off: () => {} };
		watched = target;
		ctx.ui.setWidget(TRAY_KEY, () => trayNode(target.view), { placement: "aboveEditor" });
		const flow = await access.load(ctx);
		if (flow && watched === target) follow(target, flow);
	};

	const openBoard = async (ctx: ExtensionContext): Promise<void> => {
		const placement = placementOf(ctx);
		switch (placement.kind) {
			case "none":
			case "tern":
				return;
			case "terminal":
				break;
			default: {
				const unreachable: never = placement;
				return unreachable;
			}
		}
		const target = watched;
		const flow = target?.flow ?? (await access.load(ctx));
		if (!target || !flow) {
			ctx.ui.notify(tr("This session has no flow yet.", "本会话还没有 flow。"), "info");
			return;
		}
		follow(target, flow);
		if (boardOpen) return;
		boardOpen = true;
		try {
			const view = (): FlowView => target.view() ?? flow.feed.current();
			await ctx.ui.custom<void>((_ui, _theme, _keys, done) => boardNode({ view, port: flow.port, close: () => done() }), {
				overlay: true,
				fullscreen: true,
			});
		} finally {
			boardOpen = false;
		}
	};

	const guarded =
		(run: (ctx: ExtensionContext) => Promise<void>) =>
		async (ctx: ExtensionContext): Promise<void> => {
			try {
				await run(ctx);
			} catch (error) {
				pi.logger.warn("flow monitor failed", { error: errorText(error) });
				if (ctx.hasUI) ctx.ui.notify(`${tr("Flow monitor failed", "flow 监控失败")}: ${errorText(error)}`, "error");
			}
		};

	access.attach((flow) => {
		if (watched && watched.sessionFile === flow.sessionFile) follow(watched, flow);
	});

	const reinstall = (_event: unknown, ctx: ExtensionContext): Promise<void> => guarded(install)(ctx);
	pi.on("session_start", reinstall);
	pi.on("session_switch", reinstall);
	pi.on("session_branch", reinstall);
	pi.on("session_tree", reinstall);
	pi.on("session_shutdown", (_event, ctx) => {
		unwatch();
		if (ctx.hasUI) ctx.ui.setWidget(TRAY_KEY, undefined);
	});

	pi.registerShortcut("alt+w", {
		description: tr("Open the flow monitor", "打开 flow 监控"),
		handler: guarded(openBoard),
	});
	pi.registerCommand("flow-monitor", {
		description: tr("Open the flow monitor", "打开 flow 监控"),
		handler: (_args, ctx) => guarded(openBoard)(ctx),
	});
}
