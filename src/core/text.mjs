// Text that came out of a session (its screen, report, current step) is shown cleaned of hidden
// characters and secrets: it is data, never instructions.
import { cleanText, redact } from "../../lib/safety.mjs";

export const safe = (v) => (v == null ? v : redact(cleanText(v)));
export const clip = (v, n) => (v == null ? undefined : String(v).slice(0, n));
