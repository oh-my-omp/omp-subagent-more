import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { type Signal, signal } from "@oh-my-pi/pi-tui";
import { tr } from "../../omomp-shared/i18n.ts";
import { errorText } from "../fork-task/errors.ts";
import { boardNode } from "./board.ts";
import type { Result } from "./defs.ts";
import type { MonitorFlow } from "./monitor.ts";
import { type TernPanel, ternPanel } from "./tern.ts";
import { trayNode } from "./tray.ts";
import type { FlowView } from "./view.ts";

export type MonitorAccess = {
	readonly load: (ctx: ExtensionContext) => Promise<MonitorFlow | undefined>;
	readonly attach: (listener: (flow: MonitorFlow) => void) => () => void;
	readonly started: (listener: (flow: MonitorFlow) => void) => () => void;
};

export type Placement = { readonly kind: "none" } | { readonly kind: "tern"; readonly pane: string } | { readonly kind: "terminal" };

const TRAY_KEY = "flow.tray";

export function placementOf(ctx: ExtensionContext): Placement {
	if (!ctx.hasUI || ctx.mode !== "tui") return { kind: "none" };
	const pane = process.env.TERN_PANE;
	return pane ? { kind: "tern", pane } : { kind: "terminal" };
}

type TernHome = {
	readonly sessionFile: string;
	readonly pane: string;
	readonly ctx: ExtensionContext;
	panel: TernPanel | undefined;
};

const NO_FLOW = (): string => tr("This session has no flow yet.", "本会话还没有 flow。");

type Watched = {
	readonly sessionFile: string;
	readonly view: Signal<FlowView | undefined>;
	flow: MonitorFlow | undefined;
	off: () => void;
};

export function registerMonitor(pi: ExtensionAPI, access: MonitorAccess): void {
	let watched: Watched | undefined;
	let boardOpen = false;
	let home: TernHome | undefined;

	const unwatch = (): void => {
		watched?.off();
		watched = undefined;
	};

	const leaveTern = (): void => {
		home?.panel?.close();
		home = undefined;
	};

	const settleTern = (pane: string, sessionFile: string | undefined, ctx: ExtensionContext): void => {
		if (home && home.sessionFile === sessionFile) {
			home = { sessionFile: home.sessionFile, pane, ctx, panel: home.panel };
			return;
		}
		leaveTern();
		if (sessionFile) home = { sessionFile, pane, ctx, panel: undefined };
	};

	const panelOf = (target: TernHome, flow: MonitorFlow): TernPanel => {
		if (target.panel && target.panel.flow === flow) return target.panel;
		target.panel?.close();
		const panel = ternPanel(flow, target.pane, (message, fields) => pi.logger.warn(message, fields));
		target.panel = panel;
		return panel;
	};

	const report = (ctx: ExtensionContext, result: Result<void>): void => {
		if (result.ok) return;
		const text = result.problems.join("; ");
		pi.logger.warn("flow panel failed", { error: text });
		if (ctx.hasUI) ctx.ui.notify(`${tr("Flow panel failed", "flow 面板失败")}: ${text}`, "error");
	};

	const follow = (target: Watched, flow: MonitorFlow): void => {
		if (target.flow) return;
		target.flow = flow;
		target.off = flow.feed.subscribe((view) => target.view.set(view));
	};

	const install = async (ctx: ExtensionContext): Promise<void> => {
		unwatch();
		const placement = placementOf(ctx);
		const sessionFile = ctx.sessionManager.getSessionFile();
		switch (placement.kind) {
			case "none":
				leaveTern();
				return;
			case "tern":
				settleTern(placement.pane, sessionFile, ctx);
				return;
			case "terminal":
				leaveTern();
				break;
			default: {
				const unreachable: never = placement;
				return unreachable;
			}
		}
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

	const showPanel = async (ctx: ExtensionContext): Promise<void> => {
		const target = home;
		const flow = target ? await access.load(ctx) : undefined;
		if (!target || !flow || flow.sessionFile !== target.sessionFile) {
			ctx.ui.notify(NO_FLOW(), "info");
			return;
		}
		report(ctx, await panelOf(target, flow).show());
	};

	const openBoard = async (ctx: ExtensionContext): Promise<void> => {
		const placement = placementOf(ctx);
		switch (placement.kind) {
			case "none":
				return;
			case "tern":
				return showPanel(ctx);
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
			ctx.ui.notify(NO_FLOW(), "info");
			return;
		}
		follow(target, flow);
		if (boardOpen) return;
		boardOpen = true;
		try {
			const view = (): FlowView => target.view() ?? flow.feed.current();
			await ctx.ui.custom<void>(
				(ui, _theme, _keys, done) => boardNode({ view, port: flow.port, size: () => ui.size(), close: () => done() }),
				{
					overlay: true,
					fullscreen: true,
				},
			);
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

	access.started((flow) => {
		const target = home;
		if (!target || target.sessionFile !== flow.sessionFile) return;
		void panelOf(target, flow)
			.open()
			.then((result) => report(target.ctx, result));
	});

	const reinstall = (_event: unknown, ctx: ExtensionContext): Promise<void> => guarded(install)(ctx);
	pi.on("session_start", reinstall);
	pi.on("session_switch", reinstall);
	pi.on("session_branch", reinstall);
	pi.on("session_tree", reinstall);
	pi.on("session_shutdown", (_event, ctx) => {
		unwatch();
		leaveTern();
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
