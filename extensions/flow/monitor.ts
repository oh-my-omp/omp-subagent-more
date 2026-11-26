import type { FlowView, MonitorPort } from "./view.ts";

export type ViewFeed = {
	readonly current: () => FlowView;
	readonly subscribe: (listener: (view: FlowView) => void) => () => void;
	readonly changed: () => void;
};

export type MonitorFlow = {
	readonly sessionFile: string;
	readonly dir: string;
	readonly feed: ViewFeed;
	readonly port: MonitorPort;
};

export function viewFeed(compute: () => FlowView): ViewFeed {
	const listeners = new Set<(view: FlowView) => void>();
	let scheduled = false;
	const publish = (): void => {
		scheduled = false;
		if (listeners.size === 0) return;
		const view = compute();
		for (const listener of listeners) listener(view);
	};
	return {
		current: compute,
		subscribe: (listener) => {
			listeners.add(listener);
			listener(compute());
			return () => {
				listeners.delete(listener);
			};
		},
		changed: () => {
			if (scheduled) return;
			scheduled = true;
			queueMicrotask(publish);
		},
	};
}
