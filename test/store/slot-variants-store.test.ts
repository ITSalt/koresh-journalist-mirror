import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { finalizePlan, saveDraft, type PlanBase } from '../../src/plan/pipeline.js';
import type { PlanV2 } from '../../src/plan/schema.js';
import { createPublisher } from '../../src/publish/publisher.js';
import { DEFAULT_MIGRATIONS_DIR } from '../../src/store/migrate.js';
import { openStore, type SlotVariantInput, type Store } from '../../src/store/index.js';
import { createBotApi } from '../../src/telegram/bot-api.js';
import { DATE, validPlan } from '../plan/fixtures.js';
import {
  LINKEDIN_EN,
  LINKEDIN_RU,
  THREADS_RU,
  v1Input,
  v2Input,
  variant,
} from '../plan/variant-fixtures.js';
import { CHANNEL, msk, seedPlan, TOKEN } from '../publish/helpers.js';
import { blocks } from '../support/blocks.js';
import { FakeBotApi } from '../support/fake-bot-api.js';

// WP-PLAT-01 scope 4: the `slot_variants` table (migration 006) and its store functions.

const open: Store[] = [];
function mk(): Store {
  const s = openStore(':memory:');
  open.push(s);
  return s;
}
afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

const base: PlanBase = { version: 1, date: DATE, sourceWindow: validPlan().sourceWindow };
/** The fixture plan with the given variants on s1, finalized as the plan POST does. */
function v2Plan(variants?: unknown) {
  const f = finalizePlan(v2Input(variants), base, { variants: true });
  if (!f.plan) throw new Error(JSON.stringify(f.errors));
  return { plan: f.plan as PlanV2, md: f.md };
}
function v1Plan() {
  const f = finalizePlan(v1Input(), base);
  if (!f.plan) throw new Error(JSON.stringify(f.errors));
  return { plan: f.plan, md: f.md };
}
const row = (v: { platform: string; lang: string; at: string }, slotId = 's1') =>
  ({
    slotId,
    platform: v.platform,
    lang: v.lang,
    at: v.at,
    json: JSON.stringify(v),
  }) as SlotVariantInput;
const keys = (s: Store) =>
  s.slotVariants.listForPlan(DATE).map((v) => `${v.slotId}/${v.platform}/${v.lang}/${v.status}`);
const dump = (s: Store) => ({
  plan: s.plans.get(DATE),
  slots: s.slots.listForPlan(DATE),
  variants: s.slotVariants.listForPlan(DATE),
});

describe('store.slotVariants', () => {
  it('migration 006 creates the table', () => {
    const s = mk();
    expect(s.migrationsApplied).toContain('006_slot_variants.sql');
    expect(s.slotVariants.listForPlan(DATE)).toEqual([]);
  });

  it('replaceForPlan stores the variants as planned; listForPlan returns them by time', () => {
    const s = mk();
    saveDraft(s, v1Plan());
    s.slotVariants.replaceForPlan(DATE, [row(LINKEDIN_EN), row(THREADS_RU), row(LINKEDIN_RU)]);
    expect(s.slotVariants.listForPlan(DATE)).toEqual([
      { planDate: DATE, status: 'planned', ...row(THREADS_RU) },
      { planDate: DATE, status: 'planned', ...row(LINKEDIN_RU) },
      { planDate: DATE, status: 'planned', ...row(LINKEDIN_EN) },
    ]);
    expect(s.slotVariants.listForPlan('2026-10-12')).toEqual([]);
  });

  it('listForPlan breaks ties of time by slot, platform and language', () => {
    const s = mk();
    saveDraft(s, v1Plan());
    const at = `${DATE}T10:10:10+03:00`;
    const same = [THREADS_RU, LINKEDIN_RU, LINKEDIN_EN].map((v) => variant(v, { at }));
    s.slotVariants.replaceForPlan(DATE, [
      ...same.map((v) => row(v, 's2')),
      ...same.map((v) => row(v, 's1')),
    ]);
    expect(keys(s)).toEqual([
      's1/linkedin/en/planned',
      's1/linkedin/ru/planned',
      's1/threads/ru/planned',
      's2/linkedin/en/planned',
      's2/linkedin/ru/planned',
      's2/threads/ru/planned',
    ]);
  });

  it('replaceForPlan replaces every variant of that date and of no other', () => {
    const s = mk();
    saveDraft(s, v1Plan());
    const other = '2026-10-12';
    const next = finalizePlan(v1Input(), { ...base, date: DATE });
    saveDraft(s, { plan: { ...next.plan!, date: other }, md: '' });
    s.slotVariants.replaceForPlan(other, [row(THREADS_RU)]);
    s.slotVariants.replaceForPlan(DATE, [row(THREADS_RU), row(LINKEDIN_RU)]);
    s.slotVariants.setStatus(DATE, 's1', 'threads', 'ru', 'done');

    s.slotVariants.replaceForPlan(DATE, [row(LINKEDIN_EN)]);
    expect(keys(s)).toEqual(['s1/linkedin/en/planned']);
    expect(s.slotVariants.listForPlan(other)).toHaveLength(1);
    s.slotVariants.replaceForPlan(DATE, []);
    expect(keys(s)).toEqual([]);
    expect(s.slotVariants.listForPlan(other)).toHaveLength(1);
  });

  it('replaceForPlan is all or nothing', () => {
    const s = mk();
    saveDraft(s, v1Plan());
    s.slotVariants.replaceForPlan(DATE, [row(THREADS_RU)]);
    // The second row repeats the key of the first.
    expect(() => s.slotVariants.replaceForPlan(DATE, [row(LINKEDIN_RU), row(LINKEDIN_RU)])).toThrow(
      /UNIQUE|PRIMARY/,
    );
    expect(keys(s)).toEqual(['s1/threads/ru/planned']);
  });

  it('setStatus changes one variant; an unknown one is an error', () => {
    const s = mk();
    saveDraft(s, v2Plan());
    s.slotVariants.setStatus(DATE, 's1', 'linkedin', 'ru', 'done');
    s.slotVariants.setStatus(DATE, 's1', 'linkedin', 'en', 'skipped');
    expect(keys(s)).toEqual([
      's1/threads/ru/planned',
      's1/linkedin/ru/done',
      's1/linkedin/en/skipped',
    ]);
    expect(() => s.slotVariants.setStatus(DATE, 's1', 'threads', 'en', 'done')).toThrow(
      `variant "${DATE}/s1/threads/en" not found`,
    );
    expect(() => s.slotVariants.setStatus(DATE, 's2', 'threads', 'ru', 'done')).toThrow(
      /not found/,
    );
    expect(() => s.slotVariants.setStatus('2026-10-12', 's1', 'threads', 'ru', 'done')).toThrow(
      /not found/,
    );
    expect(() => s.slotVariants.setStatus(DATE, 's1', 'threads', 'ru', 'sent' as 'done')).toThrow(
      /CHECK/,
    );
  });

  it('a variant belongs to a stored slot', () => {
    const s = mk();
    saveDraft(s, v1Plan());
    expect(() => s.slotVariants.replaceForPlan(DATE, [row(THREADS_RU, 'nope')])).toThrow(/FOREIGN/);
    expect(() => s.slotVariants.replaceForPlan('2026-10-12', [row(THREADS_RU)])).toThrow(/FOREIGN/);
    expect(keys(s)).toEqual([]);
  });

  it('replacing the slots of a plan removes the variants of the old slots', () => {
    const s = mk();
    saveDraft(s, v2Plan());
    expect(keys(s)).toHaveLength(3);
    const slots = s.slots.listForPlan(DATE);
    s.slots.replaceForPlan(DATE, slots);
    expect(keys(s)).toEqual([]);
    expect(s.slots.listForPlan(DATE)).toEqual(slots);
  });
});

describe('saveDraft and variants', () => {
  it('writes the plan, its slots and its variants', () => {
    const s = mk();
    const f = v2Plan();
    saveDraft(s, f, 'hash', new Date('2026-10-10T17:00:00Z'));
    expect(JSON.parse(s.plans.get(DATE)!.json)).toEqual(f.plan);
    expect(s.slotVariants.listForPlan(DATE).map((v) => JSON.parse(v.json))).toEqual(
      f.plan.slots[0]!.variants,
    );
    // The slot row holds the Telegram slot only.
    const s1 = JSON.parse(s.slots.listForPlan(DATE)[0]!.json);
    expect(s1).toEqual({ ...f.plan.slots[0], variants: undefined });
    expect(Object.keys(s1)).not.toContain('variants');
  });

  it('a plan without variants over a draft with variants leaves no variant behind', () => {
    const s = mk();
    saveDraft(s, v2Plan());
    saveDraft(s, v1Plan());
    expect(keys(s)).toEqual([]);
    expect(JSON.parse(s.plans.get(DATE)!.json).version).toBe(1);
  });

  it('plan, slots and variants are one transaction: a failing variant leaves the old draft whole', () => {
    const s = mk();
    saveDraft(s, v2Plan(), 'first', new Date('2026-10-10T17:00:00Z'));
    const before = dump(s);
    expect(before.variants).toHaveLength(3);

    // A plan the pipeline would never return: two variants with one key. The second insert
    // into slot_variants fails, after the plan row and the slots were already written.
    const broken = v2Plan([THREADS_RU]);
    broken.plan.arc.title = 'Другое дело';
    broken.plan.slots[0]!.variants!.push(broken.plan.slots[0]!.variants![0]!);
    expect(() => saveDraft(s, broken, 'second', new Date('2026-10-10T17:05:00Z'))).toThrow(
      /UNIQUE|PRIMARY/,
    );
    expect(dump(s)).toEqual(before);
  });
});

// Acceptance 3: migration 006 on a database that is at schema 005 and holds an approved plan, as
// the live one will at the deploy. It is additive: the old rows are untouched and the old plan
// still publishes on Telegram.
describe('migration 006 on a database at schema 005', () => {
  let dir: string;
  let fake: FakeBotApi;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'jrn-mig6-'));
    fake = await new FakeBotApi(TOKEN).start();
  });
  afterEach(async () => {
    await fake.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('applies alone, keeps every old row, and the old plan publishes as before', async () => {
    const old = join(dir, 'migrations-005');
    mkdirSync(old);
    for (const f of readdirSync(DEFAULT_MIGRATIONS_DIR)) {
      if (f < '006') cpSync(join(DEFAULT_MIGRATIONS_DIR, f), join(old, f));
    }
    expect(readdirSync(old)).toHaveLength(5);
    const db = join(dir, 'journalist.db');

    const before = openStore(db, { migrationsDir: old });
    expect(before.migrationsApplied).toHaveLength(5);
    expect(() => before.db.prepare('SELECT 1 FROM slot_variants').get()).toThrow(/no such table/);
    seedPlan(before, [
      { id: 's1', at: '09:00', text: 'Утро. Кто первый?' },
      { id: 's2', at: '19:00', text: 'Вечер. Кто последний?' },
    ]);
    // s1 went out before the deploy.
    const key = `telegram:${DATE}:s1:0`;
    before.publications.beginIntent(
      { key, platform: 'telegram', planDate: DATE, slotId: 's1', textSha256: 'x' },
      msk('09:00:01'),
    );
    before.publications.markSent(key, '41', msk('09:00:02'));
    before.slots.setStatus(DATE, 's1', 'done');
    const state = (s: Store) => ({
      plan: s.plans.get(DATE),
      slots: s.slots.listForPlan(DATE),
      pubs: s.publications.listForPlan(DATE),
    });
    const was = state(before);
    expect(was.plan!.status).toBe('approved');
    before.close();

    const after = openStore(db);
    try {
      // 007 (WP-PLAT-06) and 008 (WP-PLAT-02) are later migrations that the same boot applies
      // after 006.
      expect(after.migrationsApplied).toEqual([
        '006_slot_variants.sql',
        '007_connect.sql',
        '008_publication_url_step.sql',
        '009_owner_inbox_files.sql',
      ]);
      expect(state(after)).toEqual(was);
      expect(after.slotVariants.listForPlan(DATE)).toEqual([]);

      // Store level: the old slot can still be claimed as the publisher claims it.
      const s2 = was.slots.find((s) => s.slotId === 's2')!;
      const probe = `telegram:${DATE}:s2:9`;
      after.db.exec('SAVEPOINT probe');
      expect(
        after.publications.beginIntent({
          key: probe,
          platform: 'telegram',
          planDate: DATE,
          slotId: 's2',
          part: 9,
          textSha256: 'x',
          expectSlotJson: s2.json,
        }).status,
      ).toBe('intent');
      after.db.exec('ROLLBACK TO probe; RELEASE probe');
      expect(after.publications.get(probe)).toBeUndefined();

      const publisher = createPublisher({
        store: after,
        blocks,
        api: createBotApi({ token: TOKEN, baseUrl: fake.baseUrl, timeoutMs: 5000 }),
        channel: CHANNEL,
        dryRun: false,
        tz: 'Europe/Moscow',
        now: () => msk('19:00:30'),
        sleep: async () => undefined,
      });
      expect(await publisher.runOnce()).toMatchObject({ slot: 's2', result: 'sent' });
      expect(fake.requests.map((r) => r.method)).toEqual(['sendMessage']);
      expect(fake.channel[0]!.text).toContain('Вечер\\. Кто последний?');
      expect(after.publications.listForPlan(DATE).map((p) => [p.slotId, p.status])).toEqual([
        ['s1', 'sent'],
        ['s2', 'sent'],
      ]);
    } finally {
      after.close();
    }

    // A second boot applies nothing.
    const third = openStore(db);
    expect(third.migrationsApplied).toEqual([]);
    third.close();
  });
});
