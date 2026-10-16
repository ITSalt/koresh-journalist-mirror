// Descriptions and health details pass through here before they leave the adapter. The platform
// echoes the token in some of its own error texts ("Malformed access token <token>"), so the
// request URL is not the only place it can come from.

const MASK = '[redacted]';

/** Removes every secret (as is and URL-encoded) and any `access_token=...` pair from the text. */
export function scrub(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) {
    if (!s) continue;
    out = out.split(s).join(MASK);
    const enc = encodeURIComponent(s);
    if (enc !== s) out = out.split(enc).join(MASK);
  }
  return out.replace(/(access_token|client_secret)=[^&\s"']+/gi, `$1=${MASK}`);
}
