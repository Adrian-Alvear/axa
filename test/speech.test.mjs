// src/core/speech.mjs: realistic AXA replies -> the exact text the voice says
import { test } from "node:test";
import assert from "node:assert/strict";
import { MORE, pronounce, sayPath, toSpeech } from "../src/core/speech.mjs";

const cases = [
  ["real: pushed branch and commit", "Pushed: GitHub's `axa-v2-hub` is now at `0ba68ea` and includes mouse support.",
    "Pushed: git hub's ax uh v2 hub is now at a commit and includes mouse support."],
  ["real: engine and mode bullets", "- **Engine:** Kokoro, with the voice **af_heart**.\n- **Mode: resident.** … about a second. The installer's own test sentence took 1.9 s.",
    "Engine: Kokoro, with the voice af heart. Mode: resident. about a second. The installer's own test sentence took 1.9 seconds."],
  ["real: download size and y/N", "It shows the download size (about 380 MB) and asks y/N.",
    "It shows the download size, about 380 megabytes, and asks yes or no."],
  ["real: restart the hub keys", "Restart your hub (`q`, then `axa`) after that to see everything.",
    "Restart your hub, Q, then ax uh, after that to see everything."],
  ["labels on their own line get a full stop", "Done:\n- the parser\n- the tests\n\nNext:\n- push",
    "Done. the parser. the tests. Next. push."],
  ["status glyphs keep their meaning", "✓ 52 tests pass\n✗ lint failed on 2 files\n⚠ macOS is not verified yet",
    "Done: 52 tests pass. Failed: lint failed on 2 files. Warning: mac O S is not verified yet."],
  ["spinner and middle dot", "⠹ Working on the reviewer · 2h 5m elapsed",
    "Working on the reviewer, 2 hours 5 minutes elapsed."],
  ["box separators and pointers", "Status: 3 sessions running │ 1 needs you ▸ axa-v2",
    "Status: 3 sessions running, 1 needs you, ax uh v2."],
  ["commit id and git stats", "Committed `e9eeb1e` (+40 −2).",
    "Committed a commit, 40 lines added, 2 removed."],
  ["two commit ids", "Two commits: c0d7d9c and 5fe6067.",
    "Two commits: some commits."],
  ["path with a line number and an upper-case doc", "The fix is in src/tui/app.mjs:148 and docs/HANDOFF.md.",
    "The fix is in app and the handoff file."],
  ["README and package.json", "I updated README.md and package.json.",
    "I updated the read me and package."],
  ["a long path", "Saved to /home/me/projects/some-really-long-folder-name/generated_report_for_the_whole_week.json for you.",
    "Saved to a file path for you."],
  ["a folder path", "Kokoro lives in ~/.cache/voices/kokoro/ now.",
    "Kokoro lives in the kokoro folder now."],
  ["a URL", "Read https://github.com/k2-fsa/sherpa-onnx/releases for details.",
    "Read a link for details."],
  ["a command and an env setting", "Run `npm test -- --watch` or set `AXA_VOICE=1`.",
    "Run a command or set a setting."],
  ["prefix keys and chords", "Press `Ctrl-b h` for help, then `Shift+Tab` and `Alt+V`.",
    "Press control B, H for help, then shift tab and alt V."],
  ["escape and control C", "Hit `Esc` to close or `Ctrl+C` to stop.",
    "Hit escape to close or control C to stop."],
  ["version and PR number", "sherpa-onnx v2.0.2 is pinned; see PR #123.",
    "sherpa onnx version 2.0.2 is pinned; see pull request number 123."],
  ["tokens, thousands, percent", "It used ~1.0M tokens, 130k cached (87% hit rate).",
    "It used about 1 million tokens, 130 thousand cached, 87 percent hit rate."],
  ["minutes and a clock time", "The review took 15 min and the build 30m, last run at 3:52 PM.",
    "The review took 15 minutes and the build 30 minutes, last run at 3 52 PM."],
  ["sizes with × and 2x", "The terminal is 196×66 and the window 2x larger.",
    "The terminal is 196 by 66 and the window 2 times larger."],
  ["arrow, ampersand, dash", "A → B, then build & test — all green.",
    "A to B, then build and test, all green."],
  ["slash between words, e.g., MCP, TTS", "Use the client/server split, e.g. for MCP and TTS.",
    "Use the client or server split, for example, for M C P and text to speech."],
  ["a long heading is not the whole short version", "## Kokoro voice install summary for this machine\n\nIt downloaded the model and played a test sentence on the speakers.\n\nMore below.",
    "Kokoro voice install summary for this machine. It downloaded the model and played a test sentence on the speakers. You can read the rest on screen."],
  ["heading then a table", "## Done\n\n| file | change |\n|---|---|\n| a | b |\n\nThat's all.",
    "Done. There's a table on screen. That's all."],
  ["emoji dropped", "🚀 Shipped! 🎉 The hub runs in tmux now.",
    "Shipped! The hub runs in tee mux now."],
  ["bold label", "Settings: **Voice** on, speed normal, engine Kokoro.",
    "Settings: Voice on, speed normal, engine Kokoro."],
  ["quotes removed, apostrophes kept", "Quote: \"it works\" and 'fine', it's GitHub’s copy.",
    "Quote: it works and fine, it's git hub's copy."],
  ["nested bullets collapse", "Pending (2):\n  - restart the daemon\n    - then the hub\n  - check the repo",
    "Pending, 2: restart the daemon. then the hub. check the repo."],
];
for (const [name, reply, said] of cases) test(`speech: ${name}`, () => assert.equal(toSpeech(reply), said));

test("speech: the closing hint is clear, and can be turned off (ui.json voiceMoreHint)", () => {
  assert.equal(MORE, "You can read the rest on screen.");
  const long = "The build is fixed and every test passes now.\n\nHere is the long story of how.";
  assert.equal(toSpeech(long), `The build is fixed and every test passes now. ${MORE}`);
  assert.equal(toSpeech(long, { more: false }), "The build is fixed and every test passes now.");
  assert.equal(toSpeech("All done, the tests pass.", { more: true }), "All done, the tests pass.");
});

test("speech: the short version is picked after cleanup (a heading or a label never stands alone)", () => {
  assert.equal(toSpeech("## A heading that is quite long and descriptive, really\n\nThe actual answer is here.\n\nMore."),
    `A heading that is quite long and descriptive, really. The actual answer is here. ${MORE}`);
  assert.equal(toSpeech("Summary:\n\nEverything works and the tests pass on this machine.\n\nDetails follow."),
    `Summary. Everything works and the tests pass on this machine. ${MORE}`);
  // a paragraph of glyphs only says nothing and doesn't count
  assert.equal(toSpeech("⠹ ◆ ▲\n\nThe review finished without findings."), "The review finished without findings.");
});

test("speech: path names", () => {
  assert.deepEqual(["src/tui/app.mjs", "docs/HANDOFF.md", "README.md", "./notes/README", "src/core/", "C:\\Users\\me\\out.txt", "~/", "a/b/0ba68ea9.json"].map(sayPath),
    ["app", "the handoff file", "the README", "the README", "the core folder", "out", "home folder", "a file path"]);
});

test("speech: the word map (AXA is said 'ax uh'; PR only when it's the abbreviation)", () => {
  assert.equal(pronounce("AXA, tmux, MCP, TTS, sherpa-onnx, Kokoro, PRs and a PR."), "ax uh, tee mux, M C P, text to speech, sherpa onnx, Kokoro, pull requests and a pull request.");
  assert.equal(pronounce("a pr and prs stay"), "a pr and prs stay");
  const once = pronounce("AXA on WSL2 with Node.js, HTTPS and venv");
  assert.equal(once, "ax uh on W S L 2 with node J S, H T T P S and vee env");
  assert.equal(pronounce(once), once);
});
