import { IpcConnection } from "@oh-my-pi/pi-natives";
import { createSurface, type Host, signal, startHost } from "@oh-my-pi/pi-tui";
import { PLAIN_THEME } from "@oh-my-pi/pi-tui/theme/plain";
import { LANGUAGE_ENV, parseLanguage, tr } from "../../omomp-shared/i18n.ts";
import { errorText } from "../fork-task/errors.ts";
import { boardNode } from "./board.ts";
import { MAX_FRAME_BYTES, parsePanelFrame } from "./channel.ts";
import type { FlowView, MonitorOutcome, MonitorRequest } from "./view.ts";

type Pending = { readonly resolve: (outcome: MonitorOutcome) => void; readonly reject: (error: Error) => void };

const [endpoint, lang] = process.argv.slice(2);
if (!endpoint) {
	console.error("usage: bun panel.ts <endpoint> [en|zh]");
	process.exit(2);
}
const chosen = parseLanguage(lang);
if (chosen) process.env[LANGUAGE_ENV] = chosen;

let connection: IpcConnection;
try {
	connection = await IpcConnection.connect(endpoint, { framing: "lines", maxFrameBytes: MAX_FRAME_BYTES });
} catch (error) {
	const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
	if (code === "ENOENT" || code === "ECONNREFUSED") process.exit(0);
	console.error(`${tr("The flow panel could not connect", "flow 面板无法连接")}: ${errorText(error)}`);
	process.exit(1);
}

const view = signal<FlowView | undefined>(undefined);
const pending = new Map<number, Pending>();
let nextId = 0;
let host: Host | undefined;
let ending = false;

const finish = async (): Promise<void> => {
	if (ending) return;
	ending = true;
	for (const entry of pending.values()) entry.reject(new Error(tr("the omp session closed", "omp 会话已关闭")));
	pending.clear();
	await host?.stop();
	process.exit(0);
};

const { promise: ready, resolve: firstView } = Promise.withResolvers<void>();

connection.start(
	(line) => {
		const frame = parsePanelFrame(line);
		if (frame === undefined) {
			console.error(`flow panel: dropped an invalid frame: ${line.slice(0, 200)}`);
			return;
		}
		switch (frame.kind) {
			case "view":
				view.set(frame.view);
				firstView();
				return;
			case "outcome":
				pending.get(frame.id)?.resolve(frame.outcome);
				pending.delete(frame.id);
				return;
			case "failed":
				pending.get(frame.id)?.reject(new Error(frame.message));
				pending.delete(frame.id);
				return;
			default: {
				const unreachable: never = frame;
				return unreachable;
			}
		}
	},
	() => {
		void finish();
	},
);

const port = {
	send: (request: MonitorRequest): Promise<MonitorOutcome> => {
		const { promise, resolve, reject } = Promise.withResolvers<MonitorOutcome>();
		if (connection.closed) {
			reject(new Error(tr("the omp session is not reachable", "无法连接 omp 会话")));
			return promise;
		}
		const id = nextId++;
		pending.set(id, { resolve, reject });
		connection.send(JSON.stringify({ kind: "request", id, request }));
		return promise;
	},
};

await ready;
const current = (): FlowView => {
	const latest = view();
	if (latest === undefined) throw new Error("flow panel: no view before the first frame");
	return latest;
};
const size = signal({ columns: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 });
const surface = createSurface(() => ({
	main: boardNode({ view: current, port, size, close: () => connection.end() }),
}));
host = await startHost({ surface, theme: () => PLAIN_THEME, title: tr("flow monitor", "flow 监控"), role: "omp.flow.panel" });
size.set({ columns: host.driver.columns, rows: host.driver.rows });
host.driver.onResize((columns, rows) => size.set({ columns, rows }));
surface.focus(surface.main()[0] ?? null);
