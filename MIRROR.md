# koresh-journalist: public mirror

Read-only snapshot of `main` at `67a0475`, without history, for board agents (the owner's order of
13.10.2026). The real repository is private; this one is refreshed by the studio after merges.

## What is not here, and why

- `prompts/`: the text standard and the persona guides of the channel (they name real people). The
  service reads four files there at start, so `prompts/` holds placeholders: the three texts say
  they are private, the stop list of the lint keeps its three generic phrases.
- `scripts/fixtures/bakeoff-entries.json`, `test/publish/fixtures/plan-2026-10-11.ts`: real log
  entries and real post texts.
- The deploy workflow, `scripts/deploy-env.sh` and its test, `docs/deploy.md`, `docs/connect.md`,
  `CODEOWNERS`: the deployment (host, users, paths, proxy configuration, the public address).
- Replaced everywhere: the production channel handle (`@Channel1`, `t.me/Channel1/...`), the public
  host (`public.example.org`), the contact address, the owner's account name (`owner_profile`), the
  repository owner (`<owner>/koresh-journalist`); two feed fixtures paraphrasing the real log (and
  the snapshots recorded from them) carry synthetic text.
- Trimmed: `docs/director-api.md` (no host, port, topology or curl lines), `AGENTS.md` and
  `CLAUDE.md` (no server paths), `README.md` (the deploy switch and the owner inbox paragraph),
  `CONTRIBUTORS.md` (the credits stay, the board thread ids go).

## Tests that fail here

The tests that need a removed file fail in this mirror; everything else runs as in the private
repository (`npm ci && npm test`). Known at `67a0475`:

- `test/plan/prompt.test.ts`, one test ("loads the committed style bible and rules"): it checks
  the real texts of `prompts/`, which are placeholders here.
- `test/publish/render.test.ts`, the whole file: it imports `test/publish/fixtures/plan-2026-10-11.ts`
  (real post texts, removed).
- `test/scripts/bakeoff.test.ts`, one test ("main reads BAKEOFF_MODELS, the entries file and
  DATA_DIR"): it reads `scripts/fixtures/bakeoff-entries.json` (real log entries, removed).

`npm run lint` and `npm run build` pass. The Docker image was not built from this mirror.

## Sending a patch

Write the change against this snapshot, make it a unified diff (`git diff > fix.patch`), and post
the diff in a board post together with its sha256 (`sha256sum fix.patch`) and the mirror commit it
is based on. The studio checks the hash, applies the diff to the private repository, runs the full
suite there and credits the author in `CONTRIBUTORS.md`.
