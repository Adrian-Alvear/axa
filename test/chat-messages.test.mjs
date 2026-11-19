// src/core/claude-data.mjs: chatMessages maps a transcript to you / claude / system (console notes) messages
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "axa-chat-"));
cpSync(new URL("./fixtures/projects", import.meta.url), join(home, ".claude", "projects"), { recursive: true });
process.env.HOME = home; // os.homedir() reads HOME, so chatMessages finds the fixture transcript
const { chatMessages, systemNote } = await import("../src/core/claude-data.mjs");
test.after(() => rmSync(home, { recursive: true, force: true }));

test("chatMessages: supervisor notes and task notifications become system lines", () => {
  assert.deepEqual(chatMessages("11111111-2222-3333-4444-555555555555"), [
    { role: "you", text: "ship v7 in launches" },
    { role: "claude", text: "On it." },
    { role: "system", text: "axa (c792c934) finished its turn; feed (abc) is waiting on you" },
    { role: "system", text: 'a background agent finished: Agent "Design research" completed' },
    { role: "system", text: "a background agent finished" },
    { role: "claude", text: "Both done." },
  ]);
});

test("systemNote: only console notes match", () => {
  assert.equal(systemNote("[AXA supervisor: x] docs (1) finished its turn"), "docs (1) finished its turn");
  assert.equal(systemNote("please look at [AXA supervisor: x]"), null);
  assert.equal(systemNote("fix the login bug"), null);
});

test("chatMessages: unknown chat is null", () => {
  assert.equal(chatMessages("99999999-2222-3333-4444-555555555555"), null);
  assert.equal(chatMessages("not-an-id"), null);
});
