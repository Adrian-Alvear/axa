// `axa voice install kokoro` / `axa voice uninstall kokoro` / `axa voice status` (run by you, never by a session).
// Install: a Python venv with sherpa-onnx (or, without python3 -m venv, sherpa-onnx's prebuilt CLI), the Kokoro
// model, a test sentence, then ui.json "voiceEngine": "kokoro", "voiceName": "af_heart". Safe to run again.
// AXA_KOKORO_DIR moves the install; AXA_KOKORO_MODEL_SRC (a .tar.bz2 or an extracted model folder) skips the download.
// Every download is checked before it is unpacked: its sha256 must match the digest GitHub publishes for the
// release asset (the releases API's "digest") and the pinned value below, when there is one; a mismatch, or
// no digest to check against at all, and nothing is unpacked.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInterface } from "node:readline/promises";
import { files, tilde } from "../paths.mjs";
import * as K from "./kokoro.mjs";

const MB = 1024 * 1024;
const MODEL_MB = 334, MODEL_DISK_MB = 384, RUNTIME_MB = 30;
const out = process.stdout;

// sha256 of the exact assets the installer uses, for when the releases API can't be reached (computed from
// the downloaded files, and equal to the digests GitHub publishes for them)
export const PINNED = {
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2": "60703707bc05ccd48d60e1eb723f38b07d6e474795a0b6a588d7220400e0f7a4",
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.2/sherpa-onnx-v2.0.2-linux-x64-shared.tar.bz2": "e7f65778bfb891ec98db56c2cfc37b968d7f56e57271986a8dd2cd0c21d002c9",
};
// what the installer reaches outside itself (tests put a fake fetch in)
export const net = { fetch: (...a) => globalThis.fetch(...a), pinned: PINNED };

// the prebuilt sherpa-onnx CLI for this machine (only used when python3 -m venv isn't available)
export function cliTarball(platform = process.platform, arch = process.arch) {
  const v = K.SHERPA_VERSION;
  const name = platform === "linux" && arch === "x64" ? "linux-x64-shared"
    : platform === "linux" && arch === "arm64" ? "linux-aarch64-shared"
    : platform === "darwin" && arch === "arm64" ? "osx-arm64-shared"
    : platform === "darwin" ? "osx-universal2-shared"
    : platform === "win32" && arch === "x64" ? "win-x64-shared"
    : null;
  return name && { name: `sherpa-onnx-v${v}-${name}`, url: `https://github.com/k2-fsa/sherpa-onnx/releases/download/v${v}/sherpa-onnx-v${v}-${name}.tar.bz2` };
}

// ui.json, merged (the hub and the daemon share it)
export function setUi(patch) {
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(files.ui, "utf8")); } catch {}
  for (const [k, v] of Object.entries(patch)) if (v === undefined) delete cfg[k]; else cfg[k] = v;
  mkdirSync(resolve(files.ui, ".."), { recursive: true });
  writeFileSync(files.ui, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  return cfg;
}
const ui = () => { try { return JSON.parse(readFileSync(files.ui, "utf8")); } catch { return {}; } };

async function confirm(q, yes) {
  if (yes) return true;
  if (!process.stdin.isTTY) { console.error(`${q} (no terminal to ask in: add --yes)`); return false; }
  const rl = createInterface({ input: process.stdin, output: out });
  const a = await rl.question(`${q} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(a.trim());
}
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { stdio: "inherit", ...opts }).status === 0;
const quiet = (cmd, args) => spawnSync(cmd, args, { stdio: "ignore" }).status === 0;

// The sha256 GitHub publishes for a release asset (https://github.com/<owner>/<repo>/releases/download/<tag>/<name>),
// or null (not a GitHub release URL, the API unreachable or rate-limited, no digest published)
export async function publishedDigest(url) {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/releases\/download\/([^/]+)\/([^/?#]+)$/.exec(url);
  if (!m) return null;
  const [, owner, repo, tag, name] = m;
  try {
    const res = await net.fetch(`https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(decodeURIComponent(tag))}`, { headers: { accept: "application/vnd.github+json", "user-agent": "axa-installer" } });
    if (!res.ok) return null;
    const asset = ((await res.json())?.assets || []).find((a) => a?.name === decodeURIComponent(name));
    const d = /^sha256:([0-9a-f]{64})$/i.exec(String(asset?.digest || ""));
    return d ? d[1].toLowerCase() : null;
  } catch { return null; }
}
// The digests a download must match: the published one and the pinned one (both, when both are known)
export async function expectedDigests(url) {
  const want = [await publishedDigest(url), net.pinned[url]].filter(Boolean).map((d) => d.toLowerCase());
  return [...new Set(want)];
}

async function download(url, file, label) {
  const res = await net.fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`download failed: ${res.status} ${res.statusText} (${url})`);
  const total = Number(res.headers.get("content-length")) || 0;
  let got = 0, shown = -1;
  const body = Readable.fromWeb(res.body), hash = createHash("sha256");
  body.on("data", (c) => {
    got += c.length; hash.update(c);
    const pct = total ? Math.floor((got / total) * 100) : -1;
    if (pct !== shown) { shown = pct; out.write(`\r  ${label}: ${total ? `${pct}% (${Math.round(got / MB)} of ${Math.round(total / MB)} MB)` : `${Math.round(got / MB)} MB`}   `); }
  });
  await pipeline(body, createWriteStream(file));
  out.write("\n");
  return hash.digest("hex");
}
// Download, check the sha256, then unpack; on a mismatch the file is deleted and nothing is unpacked
export async function fetchAndExtract(url, into, label, dir) {
  mkdirSync(join(dir, "dl"), { recursive: true });
  const want = await expectedDigests(url);
  if (!want.length) throw new Error(`no sha256 to check ${url.split("/").pop()} against (GitHub's releases API didn't answer and it isn't pinned); try again later`);
  const file = join(dir, "dl", url.split("/").pop());
  const got = await download(url, file, label);
  if (want.some((d) => d !== got)) {
    try { unlinkSync(file); } catch {}
    throw new Error(`${label}: the download's sha256 (${got}) doesn't match the expected ${want.join(" / ")}; not unpacked`);
  }
  console.log(`  ✓ sha256 checked; unpacking ${label}…`);
  mkdirSync(into, { recursive: true });
  if (!run("tar", ["-xjf", file, "-C", into])) throw new Error(`couldn't unpack ${file} (is bzip2 installed?)`);
  unlinkSync(file);
}

// ---------- the steps ----------
function venvReady(py) { return !!py && quiet(py, ["-I", "-c", "import sherpa_onnx"]); }
function installRuntime(dir) {
  const venv = join(dir, "venv"), py = K.layout(dir).python;
  if (venvReady(py)) { console.log("✓ sherpa-onnx (Python) already installed"); return "resident"; }
  if (K.layout(dir).cli) { console.log("✓ sherpa-onnx CLI already installed"); return "cli"; }
  const python = ["python3", "python"].find((p) => quiet(p, ["--version"]));
  if (python) {
    console.log(`• creating a Python venv in ${tilde(venv)} and installing sherpa-onnx ${K.SHERPA_VERSION}…`);
    if (run(python, ["-m", "venv", venv])) {
      const vpy = K.layout(dir).python;
      if (vpy && run(vpy, ["-m", "pip", "install", "--disable-pip-version-check", "-q", `sherpa-onnx==${K.SHERPA_VERSION}`]) && venvReady(vpy)) return "resident";
      console.log("  pip couldn't install sherpa-onnx; trying the prebuilt CLI instead");
    } else console.log("  python3 -m venv isn't available (on Debian/Ubuntu: sudo apt install python3-venv); trying the prebuilt CLI instead");
    rmSync(venv, { recursive: true, force: true });
  }
  const t = cliTarball();
  if (!t) throw new Error(`no prebuilt sherpa-onnx CLI for ${process.platform}/${process.arch}, and no working python3 venv`);
  return fetchAndExtract(t.url, join(dir, "bin"), "sherpa-onnx CLI", dir).then(() => {
    if (!K.layout(dir).cli) throw new Error("the sherpa-onnx CLI archive didn't contain sherpa-onnx-offline-tts");
    return "cli";
  });
}
async function installModel(dir) {
  if (K.layout(dir).model) { console.log("✓ the Kokoro model is already there"); return; }
  const into = join(dir, "model"), src = process.env.AXA_KOKORO_MODEL_SRC;
  if (src) {
    mkdirSync(into, { recursive: true });
    if (statSync(src).isDirectory()) { console.log(`• using the model in ${src} (AXA_KOKORO_MODEL_SRC)`); symlinkSync(resolve(src), join(into, K.MODEL)); }
    else { console.log(`• unpacking ${src} (AXA_KOKORO_MODEL_SRC)`); if (!run("tar", ["-xjf", src, "-C", into])) throw new Error(`couldn't unpack ${src}`); }
  } else {
    console.log(`• downloading the Kokoro model (${K.MODEL})`);
    await fetchAndExtract(K.MODEL_URL, into, "model", dir);
  }
  if (!K.layout(dir).model) throw new Error(`the model files aren't where they should be (${tilde(into)})`);
}
async function testSentence(dir) {
  const st = K.state(dir);
  if (!st.installed) throw new Error(st.why);
  const wav = join(tmpdir(), `axa-kokoro-test-${process.pid}.wav`), text = "Kokoro is installed.";
  const t0 = Date.now();
  if (st.mode === "resident") {
    const sp = new K.Speaker({ python: st.python, model: st.model });
    try { await sp.synth({ text, sid: K.sidOf(K.DEFAULT_VOICE), out: wav }, 60000); } finally { sp.kill(); }
  } else await K.cliSynth({ cli: st.cli, model: st.model, text, sid: K.sidOf(K.DEFAULT_VOICE), speed: 1, out: wav }, 60000);
  const secs = Math.round((Date.now() - t0) / 100) / 10;
  try { unlinkSync(wav); } catch {}
  const r = { mode: st.mode, secs, at: new Date().toISOString() };
  writeFileSync(join(dir, "status.json"), JSON.stringify(r) + "\n");
  return r;
}

export async function install({ yes = false } = {}) {
  const dir = K.kokoroDir(), l = K.layout(dir);
  console.log(`Kokoro: an offline neural voice for AXA (Apache-2.0), installed in ${tilde(dir)}`);
  const need = [!l.model && `the model (~${MODEL_MB} MB download, ~${MODEL_DISK_MB} MB on disk)`, !l.python && !l.cli && `sherpa-onnx (~${RUNTIME_MB} MB)`].filter(Boolean);
  if (need.length && !(await confirm(`It needs ${need.join(" and ")}. Download now?`, yes))) { console.log("Nothing installed."); return 1; }
  mkdirSync(dir, { recursive: true });
  const mode = await installRuntime(dir);
  await installModel(dir);
  console.log("• testing: one short sentence…");
  const r = await testSentence(dir);
  console.log(`✓ Kokoro works (${r.mode === "resident" ? "resident speaker" : "CLI"}: ${r.secs}s for the first sentence, model load included${mode === "cli" ? "; every reply loads the model again" : ""})`);
  setUi({ voiceEngine: "kokoro", voiceName: K.DEFAULT_VOICE });
  console.log(`✓ AXA's voice is now Kokoro (${K.DEFAULT_VOICE}). Turn the voice on with m on Control or in , settings; switch back to the system voices there (Voice engine) or with: axa voice uninstall kokoro`);
  console.log("  If the AXA daemon was already running, `axa restart` makes sure it picks this up.");
  return 0;
}

export async function uninstall({ yes = false } = {}) {
  const dir = K.kokoroDir();
  const parts = ["model", "venv", "bin", "dl", "status.json"].map((p) => join(dir, p)).filter(existsSync);
  if (!parts.length) console.log(`Kokoro isn't installed (${tilde(dir)}).`);
  else {
    if (!(await confirm(`Remove Kokoro from ${tilde(dir)}?`, yes))) { console.log("Nothing removed."); return 1; }
    for (const p of parts) rmSync(p, { recursive: true, force: true });
    try { rmdirSync(dir); } catch {} // only if nothing else is in there
    console.log(`✓ removed ${tilde(dir)}`);
  }
  const cfg = ui();
  if (cfg.voiceEngine === "kokoro" || K.VOICES.includes(cfg.voiceName)) {
    setUi({ voiceEngine: undefined, voiceName: K.VOICES.includes(cfg.voiceName) ? "" : cfg.voiceName });
    console.log("✓ AXA's voice is back to the system voices");
  }
  return 0;
}

export async function status() {
  const { settings } = await import("./voice.mjs");
  const s = settings(), st = K.state(), t = K.lastTest();
  console.log(`voice:   ${s.on ? "on" : "off"}${s.forced ? " (AXA_VOICE)" : ""}`);
  console.log(`engine:  ${s.engine}${s.engineChoice ? "" : " (automatic: Kokoro when it's installed)"}`);
  console.log(`kokoro:  ${st.installed ? `installed (${st.mode === "resident" ? "resident speaker, Python venv" : "CLI: slower, loads the model per reply"}) in ${tilde(st.dir)}` : st.why}`);
  if (t) console.log(`test:    ${t.secs}s for the first sentence, model load included (${t.at.slice(0, 16).replace("T", " ")})`);
  console.log(`name:    ${s.name || (s.engine === "kokoro" ? K.DEFAULT_VOICE : "the system's default")}`);
  return 0;
}

export async function main(args) {
  const [sub, what = "kokoro"] = args.filter((a) => !a.startsWith("-"));
  const yes = args.includes("--yes") || args.includes("-y");
  const usage = "usage: axa voice install kokoro [--yes] · axa voice uninstall kokoro [--yes] · axa voice status";
  if (sub === "status" || !sub) return status();
  if (what !== "kokoro") { console.error(`only "kokoro" can be installed. ${usage}`); return 1; }
  try {
    if (sub === "install") return await install({ yes });
    if (sub === "uninstall" || sub === "remove") return await uninstall({ yes });
  } catch (e) { console.error(`\n✗ ${e.message}`); return 1; }
  console.error(usage);
  return 1;
}
