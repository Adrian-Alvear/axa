// Notifications (console/tui/notify.mjs): the bell when the window isn't focused, the opt-in Windows
// toast built as an encoded command with its text in env vars. PowerShell is never started here.
import test from "node:test";
import assert from "node:assert/strict";
import { decide, toastCommand, toastAllowed, createNotifier } from "../console/tui/notify.mjs";

const started = [{ name: "launches", why: "Do you want to proceed?" }];

test("bell only when the window isn't known to be focused; toast only when opted in", () => {
  assert.deepEqual(decide({ started, focused: true, cfg: { bell: true, toast: true } }), { bell: false, toast: null });
  assert.equal(decide({ started, focused: false, cfg: { bell: true, toast: false } }).bell, true);
  assert.equal(decide({ started, focused: null, cfg: { bell: true } }).bell, true); // terminal never said: ring
  assert.equal(decide({ started, focused: false, cfg: { bell: false } }).bell, false);
  assert.equal(decide({ started, focused: false, cfg: { bell: true } }).toast, null); // off by default
  const d = decide({ started, focused: false, cfg: { bell: true, toast: true } });
  assert.equal(d.toast.title, "AXA · launches needs you");
  assert.match(d.toast.body, /Do you want to proceed/);
  assert.equal(decide({ started: [], focused: false, cfg: { bell: true } }).bell, false);
});

test("the toast command: encoded script, text only in env vars passed through WSLENV", () => {
  const c = toastCommand("AXA · x needs you", "it's \"quoted\" <b>&\x1b[31m", { WSLENV: "FOO/p" });
  assert.equal(c.cmd, "powershell.exe");
  const enc = c.args[c.args.indexOf("-EncodedCommand") + 1];
  const script = Buffer.from(enc, "base64").toString("utf16le");
  assert.match(script, /ToastNotificationManager/);
  assert.match(script, /SecurityElement\]::Escape\(\$env:AXA_T\)/);
  assert.ok(!c.args.join(" ").includes("quoted")); // the text never reaches the command line
  assert.equal(c.env.AXA_B, "it's \"quoted\" <b>& [31m"); // control characters stripped
  assert.equal(c.env.WSLENV, "FOO/p:AXA_T:AXA_B");
});

test("the notifier rings and calls the (stubbed) toast runner; tests never start PowerShell", () => {
  const writes = [], runs = [];
  const notify = createNotifier({ out: { write: (s) => writes.push(s) }, run: (c) => runs.push(c), env: { WSL_DISTRO_NAME: "Ubuntu" } });
  notify({ started, focused: false, cfg: { bell: true, toast: true } });
  assert.deepEqual(writes, ["\x07"]);
  assert.equal(runs.length, 1);
  notify({ started, focused: true, cfg: { bell: true, toast: true } });
  assert.equal(writes.length, 1);
  assert.equal(runs.length, 1);
  // under the test runner (or AXA_NO_TOAST) the real runner is never reached
  assert.equal(toastAllowed(process.env), false);
  assert.equal(toastAllowed({ WSL_DISTRO_NAME: "U", AXA_NO_TOAST: "1" }), false);
  const runs2 = [];
  createNotifier({ out: { write() {} }, run: (c) => runs2.push(c), env: { WSL_DISTRO_NAME: "U", NODE_TEST_CONTEXT: "child" } })({ started, focused: false, cfg: { bell: true, toast: true } });
  assert.equal(runs2.length, 0);
});
