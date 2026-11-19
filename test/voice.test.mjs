// src/core/voice.mjs: toSpeech (a reply made speakable) and the commands built for each backend
import { test } from "node:test";
import assert from "node:assert/strict";
import { command, psScript, sayArgs, toSpeech } from "../src/core/voice.mjs";

test("toSpeech: markdown stripped", () => {
  const s = toSpeech("## Done\n\nI fixed **the bug** in the `parser` and _tidied_ the [docs page](https://example.com/docs).\n\n- first thing\n- second thing");
  assert.equal(s, "Done. I fixed the bug in the parser and tidied the docs page. The details are on screen.");
  assert.doesNotMatch(s, /[*`#\[\]]/);
});

test("toSpeech: bullets become sentences", () => {
  assert.equal(toSpeech("Here's what changed, in short:\n- the parser\n- the tests"), "Here's what changed, in short: the parser. the tests.");
});

test("toSpeech: code and tables are replaced, once each", () => {
  const s = toSpeech("Two changes:\n\n```js\nconst a = 1;\n```\n\n```\nmore\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n| c |\n|---|");
  assert.match(s, /^Two changes: There's code on screen\./);
  assert.doesNotMatch(s, /const a|more|\|/);
  assert.equal(s.match(/code on screen/g).length, 1);
  const t = toSpeech("| a | b |\n|---|---|\n| 1 | 2 |\n\nThat's the comparison of both options, side by side.");
  assert.equal(t, "There's a table on screen. That's the comparison of both options, side by side.");
});

test("toSpeech: an unclosed code fence is dropped too", () => {
  assert.equal(toSpeech("Here it is, ready for you to copy:\n```\nsecret stuff"), "Here it is, ready for you to copy: There's code on screen.");
});

test("toSpeech: paths and URLs replaced", () => {
  const s = toSpeech("Changed /home/me/axa/src/core/voice.mjs:42 and src/tui/app.mjs, see https://github.com/x/y/pull/3 or ~/notes/today.md.");
  assert.equal(s, "Changed some file paths, see a link or a file path.");
  assert.equal(toSpeech("Saved it to C:\\Users\\me\\out.txt for you."), "Saved it to a file path for you.");
  assert.equal(toSpeech("Fixed it and/or improved it."), "Fixed it and/or improved it.");
});

test("toSpeech: long text is cut at a sentence, with a pointer to the screen", () => {
  const sentence = "This sentence is about fifty characters long, ok. ";
  const s = toSpeech(sentence.repeat(12));
  assert.ok(s.endsWith("ok. The details are on screen."), s);
  assert.ok(s.length <= 350 + " The details are on screen.".length);
  // a short reply is said whole, with nothing added
  assert.equal(toSpeech("All done, the tests pass."), "All done, the tests pass.");
  // a later paragraph is left for the screen
  assert.equal(toSpeech("The build is fixed and every test passes now.\n\nHere is the long story of how."), "The build is fixed and every test passes now. The details are on screen.");
});

test("toSpeech: nothing speakable gives an empty string", () => {
  assert.equal(toSpeech(""), "");
  assert.equal(toSpeech("---\n\n***"), "");
});

test("say: arguments for macOS", () => {
  assert.deepEqual(sayArgs({ file: "/tmp/a.txt" }), ["-r", "190", "-f", "/tmp/a.txt"]);
  assert.deepEqual(sayArgs({ name: "Samantha", rate: 1, file: "/tmp/a.txt" }), ["-v", "Samantha", "-r", "230", "-f", "/tmp/a.txt"]);
  assert.deepEqual(sayArgs({ name: "Daniel", rate: -2, file: "/f" }), ["-v", "Daniel", "-r", "110", "-f", "/f"]);
  assert.deepEqual(command({ name: "say" }, { name: "", rate: 0, file: "/f" }), ["say", ["-r", "190", "-f", "/f"]]);
});

test("powershell: text read from the file, never on the command line; quotes escaped", () => {
  const ps = psScript({ name: "Microsoft Zira Desktop", rate: 2, winFile: "\\\\wsl.localhost\\Ubuntu\\tmp\\axa-voice-1.txt" });
  assert.match(ps, /SelectVoice\('Microsoft Zira Desktop'\)/);
  assert.match(ps, /\$s\.Rate = 6/);
  assert.ok(ps.includes("ReadAllText('\\\\wsl.localhost\\Ubuntu\\tmp\\axa-voice-1.txt'"));
  assert.match(psScript({ name: "it's", winFile: "C:\\o'k.txt" }), /SelectVoice\('it''s'\).*'C:\\o''k\.txt'/);
  const [cmd, args] = command({ name: "powershell", wsl: true }, { name: "", rate: 0, file: "/tmp/x", winFile: "C:\\x" });
  assert.equal(cmd, "powershell.exe");
  assert.equal(args.at(-1), psScript({ rate: 0, winFile: "C:\\x" }));
});
