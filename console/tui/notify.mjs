// Telling you something needs you when you aren't looking. The app turns on focus reporting
// (CSI ? 1004 h): the terminal says CSI I / CSI O as its window gains or loses focus. When a session
// starts needing you and the window isn't known to be focused, the bell rings (settings: bell), and,
// if you opted in (settings: toast, off by default), a Windows toast pops up through powershell.exe.
// The toast's text travels in environment variables (WSLENV passes them to Windows), never in the
// command line, and the script is sent as -EncodedCommand (base64 UTF-16LE), so nothing is quoted.
// Tests never start PowerShell: run() is injected, and AXA_NO_TOAST=1 or a test runner turn it off.
import { spawn } from "node:child_process";

// the Windows PowerShell app id: toasts from it need no registration
const APP_ID = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";
const SCRIPT = `
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$t = [Security.SecurityElement]::Escape($env:AXA_T); $b = [Security.SecurityElement]::Escape($env:AXA_B)
$x = New-Object Windows.Data.Xml.Dom.XmlDocument
$x.LoadXml("<toast><visual><binding template='ToastGeneric'><text>$t</text><text>$b</text></binding></visual></toast>")
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${APP_ID}').Show([Windows.UI.Notifications.ToastNotification]::new($x))
`;
const plain = (s, n) => String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

// the command for one toast: { cmd, args, env } (pure)
export function toastCommand(title, body, env = process.env) {
  const enc = Buffer.from(SCRIPT, "utf16le").toString("base64");
  const wslenv = [env.WSLENV, "AXA_T", "AXA_B"].filter(Boolean).join(":");
  return { cmd: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", enc], env: { ...env, AXA_T: plain(title, 120), AXA_B: plain(body, 240), WSLENV: wslenv } };
}
// toasts are possible here: WSL (or Windows) and not under a test
export const toastAllowed = (env = process.env) => !env.AXA_NO_TOAST && !env.NODE_TEST_CONTEXT && (process.platform === "win32" || !!env.WSL_DISTRO_NAME);

// Who to tell, given the sessions that just started needing you. focused: true / false / null (the
// terminal never said). Returns what to do: { bell, toast: {title, body} | null }
export function decide({ started, focused, cfg }) {
  if (!started.length || focused === true) return { bell: false, toast: null };
  const names = started.map((s) => s.name).filter(Boolean);
  const title = started.length === 1 ? `AXA · ${names[0] || "a session"} needs you` : `AXA · ${started.length} sessions need you`;
  const body = started.map((s) => `${s.name}: ${s.why || "needs you"}`).join(" · ");
  return { bell: !!cfg.bell, toast: cfg.toast ? { title, body } : null };
}

export function createNotifier({ out, run = (c) => { const p = spawn(c.cmd, c.args, { env: c.env, stdio: "ignore", detached: false }); p.on("error", () => {}); p.unref?.(); }, env = process.env } = {}) {
  return function notify({ started, focused, cfg }) {
    const d = decide({ started, focused, cfg });
    if (d.bell) out.write("\x07");
    if (d.toast && toastAllowed(env)) { try { run(toastCommand(d.toast.title, d.toast.body, env)); } catch {} }
    return d;
  };
}
