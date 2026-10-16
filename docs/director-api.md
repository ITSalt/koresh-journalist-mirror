# Director API

All `/v1` routes need `Authorization: Bearer $JOURNALIST_API_TOKEN`; a missing or wrong token is
401, and repeated failures are rate limited. The token is compared in constant time and never
logged. (Host, port, deployment and the curl lines of the director are not part of this mirror.)

## Routes

| Route                               | Request                                                                                                                           | Answers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/feed`                     | `FeedEntry[]` (`{id, at, source, title?, text, private?}`)                                                                        | 200 `{stored}`; 400 invalid; 413 over 2 MB; 422 any `private: true` entry (batch refused)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `GET /v1/plans/:date`               | -                                                                                                                                 | 200 `{date, status, createdAt, plan, slots[], variants[]?}` (`variants` only for a plan with variants); 404; 400 bad date                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `GET /v1/plans/:date.md`            | -                                                                                                                                 | 200 `text/markdown`, header `X-Plan-Status`; 404                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `POST /v1/plans/:date/reject`       | `{reason}`                                                                                                                        | 200 plan `rejected`, slots and planned variants skipped (`skippedVariants[]` when there are any); 409 `{error, startedOn[], skipped[], skippedVariants[]?, status}`: a post of some platform is out or may be out (`startedOn` names the platforms, e.g. `["threads"]`), the rest is skipped all the same; 404; 400                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `POST /v1/feedback`                 | `{planDate, slotId?, verdict: like or dislike, note?}`                                                                            | 201 the stored row; 404 unknown plan or slot; 400                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `GET /v1/publications?date=`        | -                                                                                                                                 | 200 `{date, publications[]}`; 400                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `POST /v1/images`                   | `{imageBase64, mime: image/png or image/jpeg}` (max 8 MB JSON, unknown keys refused)                                              | 201 `{sha256, mime, size, width, height}` stored once under the sha256 of its bytes; 200 the same for an image that is stored already (one row); 413 `too_large` over 5 MB decoded (or a body over 8 MB); 422 `{error, message}`: `bad_base64`, `mime_mismatch` (bytes are not the declared type: PNG `89504E470D0A1A0A`, JPEG `FFD8FF`), `unreadable_image` (no size in the header), `too_small` (a side under 200 px), `too_big` (width + height over 10000), `bad_ratio` (sides ratio over 20), `invalid_body` (an unknown key, a missing field, a mime that is not allowed). Sends nothing; the bytes are never logged (only sha256, mime, size, pixel size)                                                                                                                                                                              |
| `POST /v1/plans/:date`              | `{arc, slots, sourceEntryIds?}` (max 512 KB); a post slot may carry `image: {sha256, credit}`                                     | 201 stored `{status: draft, date, md, warnings[]}`; 200 same body again (with `warnings[]`); 422 `{errors[]}`; 409 approved, rejected or `too_late`; 400                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `PUT /v1/plans/:date/slots/:slotId` | `{text?, poll?, image?, at?, eventDate?, reason}` (max 64 KB; at least one of text, poll, image, at, eventDate)                   | 200 `{date, slotId, status: approved, md}`; 422 `{errors[]}` as the plan POST; 409 `not_approved`, `slot_started` or `too_close`; 404 unknown plan or slot; 400 bad date                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `GET /v1/alerts?since=`             | -                                                                                                                                 | 200 `{alerts[]}` after `since` (all when absent), oldest first, max 500; 400                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `GET /v1/plans/:date/preview?now=`  | -                                                                                                                                 | 200 `{date, now, planStatus, decision, slot?: {image?, parts[]}, refused?, schedulerError?, variants?}`; `variants` (a day with variants only) is per platform `{dryRun, adapter, decision, due: [{id, slotId, lang, at, key, text, length, link?, issues[]}]}`; a part is `{index, kind: photo, text or poll, text, length, problems}` (for a photo `text` is the caption, plus `image`); sends and writes nothing; 400                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `POST /v1/test-publish`             | `{date, slotId}`                                                                                                                  | 200 `{chat, messageIds}` sent to `TEST_CHANNEL` only (the photo of a slot with an image included); 409 `TEST_CHANNEL` unset or the production chat (name or getChat id); 404; 422 cannot compose or the image is not stored; 502 send failed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `POST /v1/owner/drafts`             | `{text: 1..20000, label?: <=64, ref?: <=200}`                                                                                     | 201 `{draftId, messageIds[]}` sent to `OWNER_CHAT_ID` only (plain text, no parse_mode, previews off, first line `[label] ref`, split at 4096, every part stored); 409 `OWNER_CHAT_ID` or token unset, or the chat is not private / is the channel; 502 `{error, draftId, status: partial or failed, messageIds[]}`; 400. Works whatever `DRY_RUN` is; writes no publication row                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `POST /v1/owner/drafts/photo`       | `{imageBase64, mime: image/png or image/jpeg, caption?: <=1024, label?: <=64, ref?: <=200}` (max 8 MB JSON, unknown keys refused) | 201 `{draftId, messageIds: [id]}`: one picture, multipart `sendPhoto`, to `OWNER_CHAT_ID` only (plain caption, no parse_mode; `label`/`ref` are stored, not shown); 409 `OWNER_CHAT_ID` or token unset, or the chat is not private / is the channel; 413 decoded image over 5 MB; 422 unknown key (a `chatId` included), bad base64, mime not allowed, bytes not matching the mime (PNG `89504E470D0A1A0A`, JPEG `FFD8FF`), caption too long; 502 `{error, draftId, status: failed, messageIds: []}`. Same private-chat guard as the text drafts, run before the send. Stores one draft (text = `[photo <mime> <bytes> B sha256:<hex>]` + caption) and one part, so the owner's reply maps to it in `/v1/inbox`. The image bytes are never stored or logged (only mime, size, sha256). Works whatever `DRY_RUN` is; writes no publication row |
| `GET /v1/inbox?after=&limit=`       | -                                                                                                                                 | 200 `{messages: [{id, at, text, kind: text or other, replyToMessageId, draftId, draftRef, draftLabel}], next}`, oldest first, `id > after` (default 0), `limit` 1..500 (default 100); 400 on an invalid `after` or `limit`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

## Semantics

- Feed: upsert by `id`. Store row = `{id, source, title: title ?? first line of text, summary: text, publishedAt: at}`.
  A batch with any `private: true` entry is refused with 422 before the store and nothing of it is stored (D-6).
- Reject: accepted while no slot of that day has started. "Started" means a publication of the plan is
  `sent`, `intent` or `unknown` (a post may be out); a `done` slot with only `dry` publications does not count. After that: 409, the remaining
  `planned` slots are marked `skipped`, the plan status is left as it is. A successful reject sets the plan
  `rejected`, skips all planned slots and records a `dislike` feedback `rejected: <reason>`
  (so the plan step reads it); repeating a reject is a 200 without a second feedback row.
- A `rejected` plan stays `rejected`: `store.plans.upsert` keeps the status and `store.plans.setStatus`
  throws for any other status, so no re-run, re-post or the 23:00 job can undo a reject.
- Plan POST (D-14): the body is plan.json v1 without `version`, `date`, `sourceWindow`; the server
  fills them, `sourceWindow` from `sourceEntryIds` looked up in the stored feed (unknown ids are
  errors; private entries are never stored, so they are unknown too; no entry text is echoed).
  Then the same pipeline as the fallback: schema, question check, signature by code, 3500 limit
  after signing, plan.md, stored as `draft` with its slots.
  - 422 lists every fault at once: `{errors: [{path, slotId?, code, message, excerpt?}]}`; codes are zod
    codes plus `no_question`, `too_long`, `unknown_entry`, `unrecognized_key`, `date_not_future`
    (the date must be after today in `TZ_PLAN`), `round_time` and the text-standard codes below (D-26).
  - Human timing (WP-SVC-25, D-33): round publication times read as a robot.
    - `round_time` (422, path `slots.N.at`, every slot, polls included): an `at` whose seconds are
      `00` or absent AND whose minutes are 00, 15, 30 or 45 (`19:00`, `19:00:00`, `09:15:00`,
      `12:30`, `18:45:00`). Fine: `19:00:07`, `19:07`, `12:03:00`, `19:09:53`. The fallback plan
      author gets the same error in its repair message. Pick a time inside a reading window.
    - `warnings` (not an error; the plan is stored): `[{path, slotId, code: 'same_time_as_yesterday',
message}]`, empty when there are none, for every slot whose HH:MM equals the HH:MM of any slot
      of the previous calendar day's stored plan (any plan status except `failed`). The same warnings
      are listed under the title of plan.md ("Предупреждения"). A repeated identical POST (200)
      returns them again.
  - Text standard (D-26). `no_question`: the last non-empty line before the signature must end with
    `?` (after closing quotes and brackets); a `?` inside a URL does not count; polls are exempt.
    The signature `ИИ-журналист-правдорубец Кореш Шпандент` is added by the code on its own line
    with no dash; a signature line you write is replaced. The lint runs on the text you send (before
    signing), on every slot text and on poll `question` and `options`; each fault has `path`
    (e.g. `slots.0.text`, `slots.1.poll.options.2`), `slotId` and `excerpt`. One example each:
    - `em_dash`: `Ответ — 12.10` (U+2014 anywhere; the hyphen `-` and `-` are fine);
    - `en_dash`: `09:00–10:00` (U+2013 anywhere);
    - `guillemets`: `«Тишина»` (use plain `"quotes"`);
    - `list_line`: a line starting `- пункт`, `• пункт`, `* пункт`, `— пункт`, `1. пункт` or `1) пункт`;
    - `stop_phrase`: `Важно отметить, что…` (case-insensitive; phrases in `prompts/stop-phrases.txt`).
      Example: `{"errors":[{"path":"slots.0.text","slotId":"s1","code":"em_dash","message":"…","excerpt":"…Ответ — 12.10"}]}`.
  - Deadline (P-7): the plan for tomorrow is accepted until 22:00 MSK the evening before; from 22:00
    a POST for tomorrow is a 409 `{error: 'too_late'}`. Later dates stay open.
  - Idempotent on (date, sha256 of the canonical body, key order ignored): the same body over the
    stored draft is a 200 and changes nothing. A different body over a `draft` or `failed` plan
    replaces it (slots too). Any POST over `approved` or `rejected` is a 409.
- Slot replacement (WP-SVC-22, P-10): `PUT /v1/plans/:date/slots/:slotId` replaces the text of one
  slot of an approved plan. Use it only for an edit the owner asked for after the approval; a plan
  that is still a draft is replaced with a plan POST instead.
  - Allowed while the plan is `approved`, the slot is `planned`, the slot has no publication row of
    any status (`intent`, `sent`, `unknown`, `dry`, `failed`) and it is at least 10 minutes before
    the slot's `at`. Otherwise 409 `{error}`: `not_approved` (draft, rejected or failed plan, with
    `status`), `slot_started` (slot `done` or `skipped`, or a publication row exists, with
    `slotStatus` and `publications`), `too_close` (with `at`). The state is checked before the
    body, in that order.
  - Body: `text` (the new post text, without the signature), `reason` (1..1000 chars, who asked and
    why), and for a poll slot optionally `poll` (`{question, options, allowsMultiple}`; when absent
    the stored poll stays). The slot keeps its `id`, `platform` and `kind`; `at` and `eventDate`
    stay unless sent (below). `poll` for a post slot is `poll_not_allowed`. `text` is optional
    (WP-SVC-25) when `poll`, `image`, `at` or `eventDate` is sent: the stored text then stays and is
    not checked again; with none of the five the answer is 422 `text: invalid_type`.
  - `at` (WP-SVC-25, D-33): ISO `YYYY-MM-DDTHH:MM[:SS]+03:00`, seconds allowed and honoured by the
    publisher to within about a second. 422 codes besides the schema ones: `at_not_on_plan_date`,
    `at_too_soon` (less than 10 minutes after now, or in the past), `round_time` (as above),
    `at_not_unique` (another slot of the plan goes out at that instant). The old time must still be
    at least 10 minutes away (`too_close`). The same instant as the stored `at` is not a move and is
    not checked again. `eventDate` is `YYYY-MM-DD`. The `at` column, the slot json, the plan json
    (kept sorted by `at`) and plan.md are written in the one transaction; the publisher claims a slot
    only while its json is unchanged, so a move that races the publisher sends the slot once, at the
    old or at the new time, never twice. A late move is allowed only on the owner's word or as the
    director's timing decision under D-33: say which in `reason` (D-30).
    A slot moved to less than 20 minutes after another sent slot is not refused: the scheduler's
    minimum gap delays it until 20 minutes after the last post, and it is still sent once.
  - For a post slot optionally `image` (WP-SVC-24): `{sha256, credit}` sets or replaces the
    illustration, `null` removes it, no key keeps the stored one (`text` is always sent, also when
    only the image changes). `image` for a poll slot is `image_not_allowed`. The alert then also
    holds `image sha256 <old or none> -> <new or none>`.
  - The text goes through the rules of the plan POST: slot schema, lint (D-26), the question rule
    (polls exempt), the signature by code, 3500 chars after signing. 422 lists every fault at once
    in the same shape, with paths relative to the slot: `{"errors":[{"path":"text","slotId":"s2","code":"em_dash","message":"…","excerpt":"…"}]}`.
    Extra codes: `unrecognized_key`, `poll_not_allowed`, and zod codes on `reason`.
  - Writes, in one transaction with the checks: the slot's json, the plan's json and plan.md
    (rendered again), `updatedAt`. The plan stays `approved`; no other slot, no publication row and
    no feedback row is written. The same body again is a 200 that writes nothing.
  - One alert `slot_replaced` per replacement: the reason, `changed: <fields>` (text, poll, image,
    at, eventDate), the old and new `at` / `eventDate` when they moved, and the sha256 of the old and
    the new text and slot json (no text). The old slot json itself is written once to the service log
    (info, `slot replaced`, field `oldSlotJson`); it is stored nowhere else.
  - Against the publisher: it writes its intent only while the slot still holds the json it read,
    so the slot goes out with the old or with the new text, never a mix; a replacement that comes
    after the intent is a 409 `slot_started`. After a 200, check `GET /v1/plans/$D/preview`.
- Variants (WP-PLAT-01, plan.json v2): a post slot of a plan POST may carry `variants`, the
  texts of that slot for the platforms outside Telegram. Each platform has its own publish loop
  (WP-PLAT-02) that sends a variant at its `at`; see "Publishing of variants" below.
  - `variants: [{platform, lang, at, text}]`: `platform` is `threads` or `linkedin`, `lang` is
    `ru` or `en`, `at` is a time on the plan date with `+03:00` (seconds allowed), `text` is the
    post for that platform without the signature. No other key (no image, no first comment). At
    most one variant per `(platform, lang)` in a slot; a poll slot has none. No key, `null` or
    `[]` means no variants.
  - A plan without variants is plan.json v1 and is stored and published exactly as before
    (Telegram only). With at least one variant the stored plan has `version: 2` and the variants
    stay on their slot in `GET /v1/plans/:date`; a slot row (and so the Telegram publisher) never
    holds them. Each variant is also one row of the table `slot_variants` (plan date, slot id,
    platform, lang, at, json, status), written in the same transaction as the plan.
  - Text rules per variant, as for a Telegram text: the lint (D-26), the question rule (the last
    line before the signature ends with `?`), the signature added by the code. The stored text is
    body + signature; the profile frame (header, disclaimer, link) is added at publish time and
    is not in the plan.
  - Length, measured on the text with the signature: Threads at most 500 units as Threads counts
    them (rule R1: a letter is 1, an emoji takes the bytes of its UTF-8 encoding, so 👍 is 4);
    LinkedIn at most 2700 chars, which is `LINKEDIN_TEXT_LIMIT` 3000 minus 300 kept for the frame.
    LinkedIn counts the text after escaping: each of `| { } @ [ ] ( ) < > # \ * _ ~` takes two
    (a backslash is put before it), so `(#тег)` counts 9, not 6. plan.md shows that count.
  - Hashtags on LinkedIn: every `#` is escaped and shown as plain text (D-3). Do not rely on a
    hashtag there; ask the director if hashtags are wanted as a reach choice.
  - Faults (422, same shape, all at once), paths `slots.N.variants.M...`: the text-standard
    codes and `no_question`, `too_long` on `.text`; `duplicate_variant` on the second variant of
    one `(platform, lang)`; `wrong_date` on `.at`; `variant_gap` on `.at` (below);
    `variants_not_allowed` on `slots.N.variants`
    of a poll slot; zod codes on the shape (`unrecognized_keys`, `invalid_value` for an unknown
    platform or language, `invalid_format` for `at`).
  - plan.md shows every variant under its slot, a heading and then the text, so the 23:00
    approval covers every platform at once. The heading names the platform, the language, the
    time and the length used of the length allowed: `### Threads · RU · 09:21:17 МСК · длина 312/500`.
  - The idempotency hash covers the variants. A new POST over a draft replaces them; an
    `approved` or `rejected` plan is locked, variants included. The slot PUT cannot change
    variants (`variants` in its body is `unrecognized_key`): after the approval they stay as
    approved, and replacing the Telegram text of the slot keeps them. The fallback plan never
    carries variants.
  - Publication keys of a variant: `<platform>:<date>:<slot>-<lang>:<part>`, e.g.
    `threads:2026-10-13:s1-ru:0`.
- Publishing of variants (WP-PLAT-02): one loop per platform, independent of Telegram and of
  each other.
  - A variant goes out at its `at` (within the platform's grace window, default 90 minutes).
  - `variant_gap` (422, path `slots.N.variants.M.at`, on the later of the two): two variants of
    the same platform on one day, in one slot or in different slots, closer than that platform's
    minimum gap (`THREADS_MIN_GAP_MIN`, `LINKEDIN_MIN_GAP_MIN`, default 20 minutes). The publish
    loop would hold the second one back until the gap has passed, so the plan is refused in the
    evening instead. The message names both variants and the gap, e.g. `linkedin variants s1/ru
at 10:12:09 and s1/en at 10:22:09 are 10 min 0 s apart; the minimum gap on linkedin is 20 min`.
    Variants of different platforms may stand as close as you like.
  - What is sent: on LinkedIn the header line, the stored text, the disclaimer line and, in the
    default link mode, the link to the owner's Telegram post as the last line; on Threads the
    stored text only.
  - `GET /v1/publications?date=` lists the rows of every platform: each row has `platform`,
    `slotId` (the slot's own id, also for a variant), `status`, `messageId` (the platform's post
    id) and, for a sent variant, `url`. A first comment is its own row with `part: 1`.
  - `GET /v1/plans/:date` has `variants: [{slotId, platform, lang, at, status}]` for a plan with
    variants: `planned`, `done` or `skipped`.
  - Nothing is resent automatically. `unknown` (alert `publish_unknown`): the post may be out,
    look at the profile. `failed` (alert `publish_failed`): nothing was sent and the variant is
    lost for the day.
  - A reject stops the variants of the day as it stops the slots, in both answers (200 and 409):
    the answer lists them in `skippedVariants`. A row of any platform that is `sent`, `intent` or
    `unknown` counts as "started".
  - Alerts of the variant loops: `publish_unknown`, `publish_failed`, `publish_refused`,
    `variant_skipped`; for a first comment `comment_unknown`, `comment_failed`, `comment_skipped`
    and the LinkedIn probe's `linkedin_comment_*`. `expiry_reminder_failed`: the reminder that the
    LinkedIn token is about to end did not reach the owner's chat; send him a connect link by hand.
  - While `DRY_RUN_THREADS` / `DRY_RUN_LINKEDIN` are `true` (the default) the rows are `dry` and
    nothing is sent. `GET /v1/plans/:date/preview` shows per platform what would go out.
- Illustrations (WP-SVC-24, D-32): the Journalist picks the illustration of its own post, the
  artist is credited, the owner keeps a brand veto.
  - Upload first (`POST /v1/images`), then name the image in the slot: `image: {sha256, credit}`.
    The server stores `image: {sha256, mime, width, height, credit}` inside the slot (and so in
    `GET /v1/plans/:date`); send only `sha256` and `credit` (other keys: `unrecognized_keys`).
    `image: null` or no key means no image. Images are never deleted and never sent anywhere by
    the upload itself.
  - The image is approved with the plan: it is part of the draft the 23:00 job approves, plan.md
    shows one line per illustrated slot (`Иллюстрация: 1280×720 PNG · sha256 <12 hex> · автор:
<credit>`), and a rejected or draft plan sends no photo. A late image (the slot PUT after the
    approval) needs the owner's explicit ok (D-30), like a late text; put who agreed in `reason`.
  - Faults (422, same shape as the text faults, path `slots.N.image...`; on the PUT `image...`):
    `unknown_image` (the sha256 was never uploaded), `image_not_allowed` (a poll slot), zod codes
    on the shape (`sha256`: 64 lowercase hex; `credit`: one line, 1..80 chars after trimming) and
    the text-standard codes on `credit` (`em_dash`, `en_dash`, `guillemets`, `list_line`,
    `stop_phrase`). The fallback plan never carries an image.
  - What goes out: the credit is the plain line `Иллюстрация: <credit>` (escaped, never markup).
    When the rendered text with the signature (and `TG_TRAILER`) plus the credit line fits 1024
    chars, the slot is ONE message: the photo with that caption (MarkdownV2). Otherwise the photo
    goes first with the credit line as its caption and the text parts follow exactly as for a slot
    without an image. One publication row per message, parts numbered from 0 in that order; the
    photo row's `textSha256` is the sha256 of `<image sha256>\n<caption as written>`.
  - Safety: the photo goes through the same steps as a text part (guarded intent, send, result).
    The image is named inside the slot json, so a slot PUT that changes it between the publisher's
    read and its intent stops that iteration: the slot goes out as the old image with the old text
    or the new image with the new text, never a mix; after any publication row the PUT is a 409
    `slot_started`. A lost answer on the photo is `unknown` and never resent (the text parts are
    then not sent either); after a restart only the parts without a row are sent. `DRY_RUN`
    writes `dry` rows and sends nothing. A slot whose image is not in the store, or a poll slot
    with an image, is refused (`publish_refused`, nothing sent).
  - A slot without `image` behaves exactly as before: the same messages and the same
    publication keys.
- Evening jobs (see `README.md`): fallback 20:30-21:00 only, 21:00 `no_plan` alert, 23:00 a draft
  stored before 22:00 -> approved; at startup a draft for today -> `approve_missed`.
- Alerts kinds: `llm_cap`, `fallback_unavailable`, `fallback_failed`, `no_plan`, `draft_too_late`,
  `approve_missed`, `job_error`, `inbox_conflict` (getUpdates 409: another poller or a webhook
  uses the bot token; at most one per hour).
  `slot_replaced` (WP-SVC-22: a slot of an approved plan was replaced; reason and sha256 only).
  Relay: keep the `at` of the last alert seen and pass it as `since`.

## Account connect (WP-PLAT-06)

Threads and LinkedIn are connected through the service itself; the full sequence, the public
paths and the deploy-side steps are in the private deployment notes. The director's routes (bearer,
the host only, like every `/v1` route):

| Route                              | Request | Answers                                                                                                                                                                                                                                           |
| ---------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/connect/:platform/start` | -       | 200 `{url, expiresAt}`: the platform's authorize link with a one-time state (30 minutes, one use), fixed scopes and our redirect address; nothing of the request is read. 409 `{error, missing[]}` when a setting is absent; 404 unknown platform |
| `DELETE /v1/connect/:platform`     | -       | 200 `{platform, disconnected}`: the stored token and account record are deleted at once, links made before are cancelled, alert `platform_disconnected`. 200 with `disconnected: false` when nothing was stored; 404 unknown platform             |
| `GET /v1/connect`                  | -       | 200 `{threads, linkedin}`, each `{connected, configured, missing?, account?: {id, name}, tokenExpiresAt?, connectedAt?, lastRefreshAt?, lastError?, reminder?}`; never a token                                                                    |

Alert kinds added: `platform_connected`, `platform_connect_failed`, `platform_disconnected`,
`platform_refresh_failed`, `platform_token_expiring`, `platform_token_unreadable` (a stored
token cannot be decrypted: once when it starts, not on every check), `public_listener_failed`
(the public port could not be opened). None holds a token, a code or a state.
`/ready` shows `components.connect: {ok, required: false, threads, linkedin}` (informational).

## Owner inbox with pictures

The owner's photos and image files to the bot are kept as Telegram file references, never as
bytes: a photo (its largest size) or a document of type `image/jpeg`, `image/png` or
`image/webp`, from the owner's private chat only (everything else is dropped as before). An
album arrives as one message per picture; they share `mediaGroupId`. A document of any other
type stays `kind: other` with no file. File ids, captions and texts are never logged. The routes
are on the main listener only (the main listener, bearer); the public listener answers 404.

| Route                                | Request | Answers                                                                                                                                                                                                                                                                          |
| ------------------------------------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/owner/inbox?since=&limit=`  | -       | 200 `{messages: [{id, at, kind: text, photo, document or other, mediaGroupId, text, replyToMessageId, draftId, files: [{idx, mime, width, height}]}], next}`: rows with `id > since` (default 0), oldest first, `limit` 1..500 (default 100). No Telegram file id. 400 bad query |
| `GET /v1/owner/inbox/:id/files/:idx` | -       | 200 the picture's bytes, fetched with getFile and the Bot API file download and streamed through (nothing stored), `Content-Type` read from the bytes (JPEG, PNG, WebP). 404 no such file; 409 `TELEGRAM_BOT_TOKEN` unset; 413 over 20 MB; 415 not an image; 502 Telegram failed |

`mime` is `null` for a photo (a photo message does not state its type; the download reads it from
the bytes) and `width`/`height` are `null` for a document. The log line of a download holds the
status and the size only.
