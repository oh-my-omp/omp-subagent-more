import * as path from "node:path";
import { type IpcConnection, IpcServer } from "@oh-my-pi/pi-natives";
import { ptree } from "@oh-my-pi/pi-utils";
import { language, tr } from "../../omomp-shared/i18n.ts";
import { errorText } from "../fork-task/errors.ts";
import { MAX_FRAME_BYTES, monitorEndpoint, type PanelFrame, parseExtensionFrame } from "./channel.ts";
import type { Result } from "./defs.ts";
import type { MonitorFlow } from "./monitor.ts";

const PANEL_ENTRY = path.join(import.meta.dir, "panel.ts");

export type PanelLog = (message: string, fields: Readonly<Record<string, string>>) => void;

type Link = { readonly kind: "idle" } | { readonly kind: "connected"; readonly connection: IpcConnection; readonly off: () => void };

type Open = { readonly kind: "open"; readonly server: IpcServer; pane: string | null; link: Link };

type PanelState = { readonly kind: "closed" } | { readonly kind: "opening" } | Open;

export type TernPanel = {
	readonly flow: MonitorFlow;
	readonly open: () => Promise<Result<void>>;
	readonly show: () => Promise<Result<void>>;
	readonly close: () => void;
};

const done: Result<void> = { ok: true, value: undefined };

async function tern(args: readonly string[]): Promise<Result<string>> {
	try {
		const { stdout, stderr, exitCode } = await ptree.exec(["tern", ...args], { env: process.env, allowNonZero: true, stderr: "full" });
		if (exitCode !== 0) {
			const said = stderr.trim() || stdout.trim();
			return {
				ok: false,
				problems: [tr(`tern ${args[0]} exited with code ${exitCode}: ${said}`, `tern ${args[0]} 以退出码 ${exitCode} 退出：${said}`)],
			};
		}
		return { ok: true, value: stdout };
	} catch (error) {
		return { ok: false, problems: [`tern: ${errorText(error)}`] };
	}
}

function blockOf(stdout: string): Result<string> {
	let json: unknown;
	try {
		json = JSON.parse(stdout);
	} catch {
		json = undefined;
	}
	if (typeof json === "object" && json !== null && "block" in json) {
		const block = json.block;
		if (typeof block === "string" && block.length > 0) return { ok: true, value: block };
		if (typeof block === "number" && Number.isSafeInteger(block)) return { ok: true, value: String(block) };
	}
	return {
		ok: false,
		problems: [tr(`tern split printed no block id: ${stdout.trim()}`, `tern split 没有给出 block id：${stdout.trim()}`)],
	};
}

export function ternPanel(flow: MonitorFlow, ownPane: string, log: PanelLog): TernPanel {
	let state: PanelState = { kind: "closed" };

	const release = (target: Open): void => {
		if (state !== target) return;
		state = { kind: "closed" };
		const link = target.link;
		target.link = { kind: "idle" };
		if (link.kind === "connected") {
			link.off();
			link.connection.end();
		}
		void target.server.close();
	};

	const reply = (connection: IpcConnection, frame: PanelFrame): void => {
		connection.send(JSON.stringify(frame));
	};

	const serve = (target: Open, connection: IpcConnection): void => {
		if (state !== target || target.link.kind === "connected") {
			connection.destroy();
			return;
		}
		connection.start(
			(line) => {
				const frame = parseExtensionFrame(line);
				if (frame === undefined) {
					log("flow panel: dropped an invalid frame", { frame: line.slice(0, 200) });
					return;
				}
				flow.port.send(frame.request).then(
					(outcome) => reply(connection, { kind: "outcome", id: frame.id, outcome }),
					(error: unknown) => reply(connection, { kind: "failed", id: frame.id, message: errorText(error) }),
				);
			},
			(reason) => {
				if (reason !== null) log("flow panel: the connection closed", { reason });
				release(target);
			},
		);
		const off = flow.feed.subscribe((view) => reply(connection, { kind: "view", view }));
		target.link = { kind: "connected", connection, off };
	};

	const open = async (): Promise<Result<void>> => {
		if (state.kind !== "closed") return done;
		state = { kind: "opening" };
		let target: Open | undefined;
		try {
			const server = await IpcServer.listen(
				monitorEndpoint(flow.dir),
				{ framing: "lines", maxFrameBytes: MAX_FRAME_BYTES },
				(connection) => {
					if (target === undefined) connection.destroy();
					else serve(target, connection);
				},
			);
			if (state.kind !== "opening") {
				void server.close();
				return done;
			}
			target = { kind: "open", server, pane: null, link: { kind: "idle" } };
			state = target;
		} catch (error) {
			state = { kind: "closed" };
			return {
				ok: false,
				problems: [tr(`the flow panel could not listen: ${errorText(error)}`, `flow 面板无法监听：${errorText(error)}`)],
			};
		}
		const split = await tern([
			"split",
			ownPane,
			"right",
			"--cwd",
			flow.dir,
			"--json",
			"--",
			"bun",
			PANEL_ENTRY,
			target.server.endpoint,
			language(),
		]);
		const pane = split.ok ? blockOf(split.value) : split;
		if (!pane.ok) {
			release(target);
			return pane;
		}
		if (state !== target) return done;
		target.pane = pane.value;
		const back = await tern(["focus", ownPane, "--json"]);
		return back.ok ? done : back;
	};

	const show = async (): Promise<Result<void>> => {
		const current = state;
		switch (current.kind) {
			case "closed":
				return open();
			case "opening":
				return done;
			case "open": {
				if (current.pane === null) return done;
				const focused = await tern(["focus", current.pane, "--json"]);
				if (focused.ok) return done;
				release(current);
				return open();
			}
			default: {
				const unreachable: never = current;
				return unreachable;
			}
		}
	};

	const close = (): void => {
		if (state.kind === "open") release(state);
		else state = { kind: "closed" };
	};

	return { flow, open, show, close };
}
