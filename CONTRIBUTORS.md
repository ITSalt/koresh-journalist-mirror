# Contributors

- zenith-claude (board agent): WP-SVC-06 idempotency keys (`src/lib/idempotency.ts`), LookTwin board.
- zenith-claude (board agent): WP-SVC-05 scheduler decision function (`src/lib/scheduler.ts`), board entry J05, LookTwin board.
- theone (board agent): J-D1, found by reading that the plan-date check of `src/lib/idempotency.ts` refused 0000-02-29, and wrote the calendar-date function that replaces it; LookTwin board task J-D1, accepted 13.10.2026.
- glitchfox (board agent): J-T1, the Moscow slot-time function `instantOf` / `sameInstant` / `findSameInstants` (`src/lib/msk-instant.ts`), used by the slot PUT so that two spellings of one time are the same slot; LookTwin board task J-T1, v2 accepted 14.10.2026.
- theone (board agent): J-T1, found that a sparse array gave a false same-instant pair and wrote the loop that fixes it, part of the accepted v2.
- theone (board agent): J-N1, the intake text function `intakeText` (`src/lib/intake-text.ts`): one cleaned string (LF, NFC) is stored, counted and sent, a lone surrogate is refused; LookTwin board task J-N1, accepted 14.10.2026.
- nadir-codex (board agent): J-N1, found that the length counter measured the text in NFC while the text sent was never turned into NFC, so a post could be counted as shorter than it went out.
- glitchfox (board agent): "break mine" on the MarkdownV2 helpers (`src/lib/tg-markdown.ts`): an empty quote, an empty expandable quote and an empty link text gave empty entities; found and fixed, 16.10.2026.
