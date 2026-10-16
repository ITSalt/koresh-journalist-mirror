# koresh-journalist

TypeScript (Node 22) Fastify service that prepares and publishes posts to a Telegram channel.
This scaffold provides config parsing, structured logs with secret redaction, and
`GET /health` (liveness) and `GET /ready` (per-component readiness, 503 if a required one is down).

## Environment

Names only; values are never committed. Secrets are optional at boot: a feature that needs a
missing secret reports not-ready instead of crashing.

| Name                    | Default                            | Secret |
| ----------------------- | ---------------------------------- | ------ |
| `PORT`                  | `8080`                             | no     |
| `HOST`                  | `127.0.0.1`                        | no     |
| `TZ_PLAN`               | `Europe/Moscow`                    | no     |
| `DATA_DIR`              |                                    | no     |
| `TELEGRAM_BOT_TOKEN`    |                                    | yes    |
| `TELEGRAM_CHANNEL`      | `@Channel1`                        | no     |
| `TELEGRAM_API_BASE_URL` | `https://api.telegram.org`         | no     |
| `TG_TRAILER`            | empty (D-17)                       | no     |
| `TEST_CHANNEL`          | unset: test-publish refuses        | no     |
| `OWNER_CHAT_ID`         | unset: no inbox poller, drafts 409 | no     |
| `OPENROUTER_API_KEY`    |                                    | yes    |
| `OPENROUTER_MODEL`      |                                    | no     |
| `OPENROUTER_BASE_URL`   | `https://openrouter.ai/api/v1`     | no     |
| `LLM_DAILY_CAP_USD`     | unset: every LLM call is refused   | no     |
| `LLM_ESTIMATE_USD`      | `0.10` (must be > 0)               | no     |
| `BAKEOFF_MODELS`        |                                    | no     |
| `JOURNALIST_API_TOKEN`  |                                    | yes    |
| `DRY_RUN`               | `true`                             | no     |
| `DRY_RUN_THREADS`       | `true`                             | no     |
| `DRY_RUN_LINKEDIN`      | `true`                             | no     |
| `THREADS_GRACE_MIN`     | `90`                               | no     |
| `THREADS_MIN_GAP_MIN`   | `20`                               | no     |
| `LINKEDIN_GRACE_MIN`    | `90`                               | no     |
| `LINKEDIN_MIN_GAP_MIN`  | `20`                               | no     |
| `THREADS_DISCLAIMER`    | `false`                            | no     |
| `LINKEDIN_LINK_URL`     | `https://t.me/Channel1/57`         | no     |
| `LINKEDIN_LINK_MODE`    | `inline`                           | no     |
| `LINKEDIN_VERSION`      | `202609`                           | no     |
| `LINKEDIN_TEXT_LIMIT`   | `3000`                             | no     |
| `LINKEDIN_AUTHOR_URN`   | unset: read from userinfo          | no     |

Also: `GIT_SHA` (reported as `version`, default `dev`), `LOG_LEVEL` (default `info`).

The Threads and LinkedIn settings (from `DRY_RUN_THREADS` down) never fail the boot: an invalid
value falls back to its default, which is the safe side, and one alert `platform_config` names
the keys (written once per changed value, not on every boot; the log line is written every boot). The account tokens of Threads and LinkedIn are not environment values: they live in the
encrypted token store of the account-connect package. The platform base URLs
(`THREADS_API_BASE_URL`, `LINKEDIN_API_BASE_URL`, `LINKEDIN_OAUTH_BASE_URL`) are that package's
settings (`src/config.ts`, defaults: the real hosts) and serve the adapters too.

## Development

```bash
npm ci
npm run lint    # eslint + prettier --check
npm test        # vitest
npm run build   # tsc -> dist/
npm start       # node dist/index.js
```

Layout: `src/lib/` for pure modules; `test/` mirrors `src/`.

## Plan core

- `src/plan/schema.ts`: plan.json v1 and v2 (zod); `src/plan/render.ts`: plan.md for the owner (Russian, MSK).
- `src/plan/prompt.ts`: messages from `prompts/style-bible.md` (copy of `journalist/STYLE-BIBLE.md`),
  `prompts/rules.md` (BRIEF as a checklist), the entries, feedback of the last 14 days, the previous
  3 plans and the last open question.
- `src/llm/openrouter.ts`: JSON chat completion with `usage.include`, 120 s timeout.
- `src/llm/budget.ts`: daily cap that fails closed. Before a call one transaction checks
  `spent(today MSK) + LLM_ESTIMATE_USD <= LLM_DAILY_CAP_USD` and books the estimate; after it the
  estimate is replaced by `usage.cost` (kept when the cost is unknown). Over the cap: no request,
  a row in `alerts` (kind `llm_cap`).
- `src/plan/pipeline.ts`: the one post-processing pipeline for every plan (`finalizePlan`, `saveDraft`):
  schema -> question check -> signature by code (D-9) -> 3500 raw limit -> plan.md -> store `draft`.
  All faults are collected at once. A post's last line must end with `?` (closing quotes/brackets
  trimmed), optionally followed only by the answer deadline of the style bible §3.6, exactly
  `Ответ — ДД.ММ` or `Ответ — ДД.ММ в ЧЧ:ММ` (em dash); a `?` in a URL is no question. Every line containing the signature is stripped before it is appended once.
- `src/plan/build.ts`: `buildPlan({ date, entries, now }, deps)`: prompt, LLM, parse, the pipeline,
  one repair retry with the errors. It never stores (the fallback job does, via `saveDraft`).
- `src/plan/intake.ts`: `POST /v1/plans/:date` from the director's subagent, the primary author (D-14);
  see `docs/director-api.md`.
- `src/plan/replace.ts`: `PUT /v1/plans/:date/slots/:slotId` (WP-SVC-22): the text of one
  not-yet-started slot of an approved plan is replaced, for an owner-requested edit after approval
  (P-10). The same text rules as a plan POST (`finalizeSlot` in the pipeline); the plan stays
  `approved` and no other slot is written; see `docs/director-api.md`.
- Illustrations (WP-SVC-24, D-32): `POST /v1/images` stores one PNG or JPEG under the sha256 of its
  bytes (table `images`, migration 005; checks in `src/lib/image.ts`); a post slot names it with
  `image: {sha256, credit}` in the plan POST or the slot PUT (`resolveImage` in the pipeline).
  The slot json then holds the image, so it is approved, replaced and claimed with the text.
- Variants (WP-PLAT-01, plan.json v2): a post slot of a plan POST may carry
  `variants: [{platform: threads | linkedin, lang: ru | en, at, text}]`, its texts for the
  platforms outside Telegram. Same lint, question rule and signature as a Telegram text, plus the
  length rule of the platform (`src/plan/variants.ts`; the Threads count is
  `src/lib/threads-length.ts`). Stored in the plan json (`version: 2`) and one row each in
  `slot_variants` (migration 006); the slot row stays the Telegram slot, so a plan without
  variants is stored and published exactly as before. plan.md shows every variant. They are
  published by the variant loops below; see `docs/director-api.md`. LinkedIn length is counted
  after "little text" escaping, as the adapter counts it. Two variants of one platform closer
  than its minimum gap (`THREADS_MIN_GAP_MIN`, `LINKEDIN_MIN_GAP_MIN`) are refused with
  `variant_gap`: the publish loop would hold the second one back.

## Evening jobs

`src/jobs/evening.ts`: one in-process scheduler wakes every minute; times are in `TZ_PLAN`, all
for tomorrow's plan.

| Time        | Job              | What it does                                                                                                                                                         |
| ----------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 20:30-21:00 | `fallback`       | no `draft`/`approved`/`rejected` plan: `buildPlan` with entries of the `windowEntries` port, stored as `draft`; after 21:00 it is marked skipped and never runs late |
| 21:00       | `no_plan`        | no plan, or a `failed` one: `alerts` row `no_plan` (no posts that day, D-10)                                                                                         |
| 22:00       | -                | deadline of the director's POST for tomorrow (P-7): later POSTs get 409 `too_late`                                                                                   |
| 23:00       | `approve`        | a `draft` stored before 22:00 becomes `approved` (a later one: `draft_too_late` alert); `rejected` stays `rejected`                                                  |
| startup     | `approve_missed` | today's plan is still a `draft` (the 23:00 approval was missed): one `approve_missed` alert                                                                          |

Each (job, date) is claimed in `job_runs` (migration 003) before it runs, so it runs once across
restarts and processes on one DB file; a restart later the same evening runs what is due (no
catch-up after midnight). Until WP-SVC-17 plugs the board's `selectWindow` + `redact` into the
port, the port is "unavailable": the fallback makes no LLM call and writes `fallback_unavailable`.
An LLM failure writes `fallback_failed` and stores nothing.

## Telegram publisher

`src/publish/publisher.ts` (WP-SVC-11): one loop for today's plan (Moscow day). It wakes at the
scheduler's `wakeAt`, at most every 60 s (an unapproved or rejected day has no `wakeAt`, so it
polls and re-reads the plan status), and handles one slot per iteration:

1. Reconcile: `intent` rows older than 2 min (a crash between intent and result) become
   `unknown` with an alert `publish_unknown`; they are never resent.
2. Resume: a `planned` slot whose parts so far are all `sent` continues with its next part.
3. `decide()` (`src/lib/scheduler.ts`) with `done` = slots that are not `planned` or have any
   publication row; every returned `skip` id is stored as slot status `skipped` (alert
   `slot_skipped`). A `SchedulerError` (BAD_TIME, DUP_SLOT, BAD_RULES) writes one
   `scheduler_error` alert and publishes nothing that day.
4. Per part: plan `approved` and slot `planned` (re-read before every part, so a reject stops the
   rest) -> `beginIntent(telegram:<date>:<slot>:<part>)` -> send -> `sent` with the message id.
   The intent is inserted only while the slot row still holds the json the parts were composed
   from (one SQL statement, `expectSlotJson`): a slot replaced by the PUT route after it was read
   is not sent with the old text, the iteration stops and the next one reads the new text.
   Text: plan text (already signed) + `TG_TRAILER` after the signature, rendered by
   `renderPlanText` (`src/publish/render.ts`, D-21: `**bold**` -> `md.bold`, consecutive `> ` lines ->
   one `md.quote`, all else escaped, URLs stay text), split raw by `chunkText` at 4096 rendered chars (a boundary inside `**…**` moves before the
   opening `**`), each part rendered and checked by `mdv2Problems` (else `publish_refused`); the last part must carry the
   signature line (D-9), otherwise nothing is sent (`publish_refused`). A poll slot sends its text,
   then a regular anonymous `sendPoll`. Link previews are off; parts are 1.1 s apart.
   A slot with an image (WP-SVC-24; `composeSlot` in `src/publish/compose.ts`, `src/publish/items.ts`)
   starts with a `sendPhoto` (multipart, MarkdownV2 caption) as part 0: when the rendered text plus
   the plain credit line `Иллюстрация: <credit>` fits 1024 chars the photo carries all of it and is
   the only part; otherwise its caption is the credit line and the text parts follow as above. The
   photo has its own intent row and outcome like any part; a slot without an image is unchanged.
5. Failures: 429 waits `retry_after`, 5xx and refused connections back off (1, 2, 4 s ...), up
   to 5 attempts / 90 s, then `failed`; another 4xx is `failed` at once; a lost answer after the
   request left (reset, timeout) is `unknown` and never resent. A `failed` or `unknown` row
   blocks only its own slot. Errors are scrubbed of secret values before they are stored.

Pre-flight (scope item 15, director bearer token):

- `GET /v1/plans/:date/preview?now=<ISO with offset>`: the real `decide()` on the stored plan and
  publication log at `now`, plus the rendered parts of the slot it would publish (lengths,
  `mdv2Problems`). Sends and writes nothing.
- `POST /v1/test-publish {date, slotId}`: sends that slot (the photo if it has an image, text parts, then the poll) to
  `TEST_CHANNEL` only, whatever `DRY_RUN` and the plan status are; 409 when `TEST_CHANNEL` is unset,
  names `TELEGRAM_CHANNEL`, or `getChat` resolves both to the same chat id (or fails). No
  publication row, no slot change; one `test_publish` alert with the message ids.

Tests use a local fake Bot API (`test/support/fake-bot-api.ts`) and a child process that is
killed mid-publish (`test/publish/restart.test.ts`, `test/publish/restart-image.test.ts`); they
never call the real Telegram API. `test/publish/no-image-golden.test.ts` holds a snapshot recorded
before WP-SVC-24: every request and row of a day without images must stay byte for byte the same.

Tests use a local fake OpenRouter (`test/llm/fake-openrouter.ts`); they never call the real API.

## Threads and LinkedIn publishers

`src/platforms/` (WP-PLAT-02). Telegram is not rewritten: its publisher above runs as before and
reads, claims and reconciles Telegram rows only (`test/publish/platform-isolation.test.ts`).

- `src/platforms/types.ts`: the adapter contract (`PlatformAdapter`: `validate`, `publish`,
  `comment?`, `health`), the one copy. `src/platforms/threads/` and `src/platforms/linkedin/` are
  the adapters; each imports only its own directory and that contract (Threads also the length
  counter `src/lib/threads-length.ts`).
- `src/platforms/registry.ts`: built from the config and the encrypted token store of the
  account-connect package (`connectWiring`: one store per account, and the LinkedIn app id and
  secret for token introspection). It starts Telegram's publisher first, then one variant loop
  per platform. An account that is not connected answers "not connected" (a refused post with an
  alert in live mode; `health` not ok); an adapter without a token store at all is absent. `/ready` says so
  (`components.threads`, `components.linkedin`: `adapter`, `dryRun`, `detail`, `tokenExpiresAt`,
  always `required: false`), and nothing of it can make the service not ready or delay Telegram.
  Health is read once an hour (`adapter.health()`), never per request.
- `src/publish/variant-publisher.ts`: the loop of one platform over the `slot_variants` of today's
  approved plan. Each iteration handles one item:
  1. Reconcile: this platform's `intent` rows older than 2 min become `unknown` with an alert
     that names the platform. Never resent.
  2. First comment (LinkedIn only): its own item, key `<platform>:<date>:<slot>-<lang>:1`, claimed
     only while the post row is `sent`, the plan `approved` and the variant still `planned`. A
     failed or unknown comment writes its own row and one alert; the post row is never touched.
  3. `decide()` (the same scheduler as Telegram) over this platform's variants and rows only, with
     the platform's own grace and min gap; a variant past its grace is `skipped` (alert
     `variant_skipped`).
  4. Publish: frame composed (`src/platforms/frame.ts`: on LinkedIn the header, the stored text
     and the disclaimer; on Threads the stored text only, plus the disclaimer line when
     `THREADS_DISCLAIMER=true`; the fixed lines are one table, `FRAME_TEXTS`, per language and, for the disclaimer, per link mode, with the director's wording of 14.10; the inline wording ends with the link, `{link}`, so the adapter is not given it a second time) -> claim (`beginVariantIntent`: one statement, plan approved,
     variant planned, json unchanged) -> `adapter.validate` -> `adapter.publish` -> `sent` with the
     platform id (`messageId`) and `url`. The claim is the status re-read before every send, so a
     reject of the day (either branch of the route) wins.
  5. Outcomes: `unknown` blocks only that variant and alerts (`publish_unknown`); `refused` and
     `failed` mark the row `failed`, the variant `skipped` and alert (`publish_failed`: the
     variant is lost for the day, also after a 429). Nothing is ever resent automatically.
- Publication rows of a variant carry the slot's id (`slotId`) and the platform; migration 008
  adds `url` and `step` to `publications`. `step` holds the two recorded steps of a Threads
  publish (container, then the publish call): the record of step `publish` is on the row before
  the request leaves, so a restart never sends it again.
- `DRY_RUN_THREADS` and `DRY_RUN_LINKEDIN` (default `true`, written by the deploy from the GitHub
  variables of the same names, like `DRY_RUN`): `dry` rows, no method of the adapter is called.
  `DRY_RUN=false` does not switch them.
- LinkedIn link (D-2): `LINKEDIN_LINK_URL` ends the disclaimer, the last line of the post (`LINKEDIN_LINK_MODE=inline`,
  the default). The first live post also tries the first comment once (the probe): an accepted
  comment writes the alert `linkedin_comment_works` (switch the variable to `comment`), a 403
  writes `linkedin_comment_forbidden`; either settles the probe (`bot_state`
  `linkedin_comment_probe_settled`). In `comment` mode the post has no link and every post gets
  the first comment. Every reserved character is escaped, `#` included: a hashtag written by the
  Journalist is shown as plain text on LinkedIn (D-3).
- `GET /v1/plans/:date/preview` shows, per platform, the decision of its loop at `now` and every
  due variant with the composed text and the adapter's `validate` result.
- LinkedIn token expiry (`src/platforms/expiry-reminder.ts`): the token lives 60 days and the
  service cannot renew it. With the hourly health check the service looks at the expiry and sends
  the owner one plain message in his private chat (`OWNER_CHAT_ID`, the same guard as the drafts,
  recorded with `ref: linkedin-token-expiry`) 7 days before, 1 day before and when it has ended:
  once per state, also across restarts. The message carries a fresh connect link when one can be
  made, otherwise it asks him to write to the director; he never handles a token. A message that
  does not reach him writes one alert `expiry_reminder_failed` and is tried again.

Tests use two scripted fake adapters (`test/support/fake-adapter.ts`), a child process that is
killed between the intent and the result (`test/publish/variant-restart.test.ts`,
`test/platforms/threads-step-row.test.ts`) and the adapters' own fake servers for the wiring
(`test/platforms/registry.test.ts`); they never call a real platform.

### Bake-off (D-7)

```bash
BAKEOFF_MODELS=vendor/model-a,vendor/model-b npm run bakeoff -- --date 2026-10-11 \
  [--entries scripts/fixtures/bakeoff-entries.json] [--out bakeoff]
```

Runs `buildPlan` per model under the same daily cap (the store in `DATA_DIR`), writes
`bakeoff/<date>/<model>.{json,md}` and `summary.md` with the costs, and never stores plans.

## Account connect (Threads, LinkedIn)

The owner's accounts are connected through the service: one link from the director, the
platform's consent page, our HTTPS callback, the token exchanged on the server and stored
encrypted (AES-256-GCM). See `docs/connect.md`. Settings, all optional (names only):

| Name                        | Default | Secret |
| --------------------------- | ------- | ------ |
| `PUBLIC_BASE`               |         | no     |
| `PUBLIC_PORT`               | `8081`  | no     |
| `TOKEN_STORE_KEY`           |         | yes    |
| `THREADS_APP_ID`            |         | no     |
| `THREADS_APP_SECRET`        |         | yes    |
| `LINKEDIN_CLIENT_ID`        |         | no     |
| `LINKEDIN_CLIENT_SECRET`    |         | yes    |
| `THREADS_EXPECTED_USERNAME` |         | no     |
| `LINKEDIN_EXPECTED_SUB`     |         | no     |

The public surface is four exact paths under `PUBLIC_BASE` (two policy pages from `public/`,
two OAuth callbacks), served by a listener of their own on `PUBLIC_PORT` that has nothing else;
the director API, `/health` and `/ready` are on `PORT` only.
