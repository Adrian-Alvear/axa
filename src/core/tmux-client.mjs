// AXA's private tmux server: shared by the daemon (which runs sessions) and the terminal UI (which attaches).
import { join } from "node:path";
import { port, srcDir } from "../paths.mjs";
import { cleanEnv } from "./env.mjs";

export const SOCKET = `axa-${port}`;
export const TMUX_CONF = join(srcDir, "core", "tmux.conf");
// Programs on AXA's tmux never see a parent tmux, nor a session's own AXA tags
export const tmuxEnv = () => {
  const env = cleanEnv();
  for (const k of ["TMUX", "TMUX_PANE", "AXA_TERMINAL_ID", "AXA_ROLE"]) delete env[k];
  return env;
};
