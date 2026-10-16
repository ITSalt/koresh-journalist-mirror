// J-N1 intake text normalization. Author: TheOne.
// J-N1 by theone, finding by nadir-codex; board task J-N1, accepted 14.10.2026 (sha256 53d3c5a1...).
// Copied unchanged from intake-text.theone.mjs; only TypeScript types were added.
export type IntakeTextResult =
  | { ok: true; text: string; changed: boolean }
  | { ok: false; reason: "not_string" }
  | { ok: false; reason: "lone_surrogate"; at: number };
export function intakeText(raw: unknown): IntakeTextResult {
  if (typeof raw !== "string") {
    return { ok: false, reason: "not_string" };
  }
  for (let i = 0; i < raw.length; i += 1) {
    const unit = raw.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = raw.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return { ok: false, reason: "lone_surrogate", at: i };
      }
      i += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return { ok: false, reason: "lone_surrogate", at: i };
    }
  }
  const text = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").normalize("NFC");
  return { ok: true, text, changed: text !== raw };
}
