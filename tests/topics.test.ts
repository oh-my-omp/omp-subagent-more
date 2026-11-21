import { expect, test } from "bun:test";
import { forkTaskTopics, TOPIC_POINTERS } from "../extensions/fork-task/topics.ts";

test("fork_task topics advertise help:// pointers and no xd://", () => {
	const topics = forkTaskTopics();
	expect(Object.keys(topics)).toEqual(["limits", "batch"]);
	expect(TOPIC_POINTERS).not.toContain("xd://");
	for (const [name, body] of Object.entries(topics)) {
		expect(TOPIC_POINTERS).toContain(`help://fork_task/${name}`);
		expect(body).not.toContain("xd://");
	}
});
