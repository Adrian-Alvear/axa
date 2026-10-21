// The terminal app's status vocabulary and text helpers (console/tui/theme.mjs)
import test from "node:test";
import assert from "node:assert/strict";
import { look, URGENCY, byUrgency, width, cut, pad } from "../console/tui/theme.mjs";

test("shell sessions show as shell, dim, never starting", () => {
  assert.deepEqual(look({ status: "shell", mode: "shell" }), ["○", "shell", "dim"]);
  // older consoles reported starting/ready for shells
  assert.equal(look({ status: "starting", mode: "shell" })[1], "shell");
  assert.equal(look({ status: "ready", mode: "shell" })[1], "shell");
  // a shell that's doing something keeps that status
  assert.equal(look({ status: "waiting", mode: "shell" })[1], "needs you");
  assert.equal(look({ status: "starting", mode: "claude" })[1], "starting");
});

test("shell sorts after ready and before starting", () => {
  assert.ok(URGENCY.indexOf("ready") < URGENCY.indexOf("shell"));
  assert.ok(URGENCY.indexOf("shell") < URGENCY.indexOf("starting"));
  const sorted = ["starting", "shell", "exited", "ready", "waiting"].map((status, i) => ({ status, created: i })).sort(byUrgency).map((s) => s.status);
  assert.deepEqual(sorted, ["waiting", "ready", "shell", "starting", "exited"]);
  // an older console's "starting" shell sorts as a shell too
  const mixed = [{ status: "starting", mode: "claude", created: 1 }, { status: "starting", mode: "shell", created: 2 }, { status: "ready", mode: "claude", created: 3 }].sort(byUrgency).map((s) => s.mode);
  assert.deepEqual(mixed, ["claude", "shell", "claude"]);
});

test("width-aware cut and pad", () => {
  assert.equal(width("ab界"), 4);
  assert.equal(cut("abcdef", 4), "abc…");
  assert.equal(pad("ab", 4), "ab  ");
  assert.equal(width(pad("界界界", 5)), 5);
});
