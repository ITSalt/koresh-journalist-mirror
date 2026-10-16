import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { textHash } from '../../src/lib/idempotency.js';
import { threadsLength } from '../../src/lib/threads-length.js';
import { canonicalJson, saveDraft, sha256Hex, signText } from '../../src/plan/pipeline.js';
import { PlanV2Schema, type PlanSlot } from '../../src/plan/schema.js';
import { createLinkedInAdapter } from '../../src/platforms/linkedin/adapter.js';
import { createLinkedInClient } from '../../src/platforms/linkedin/client.js';
import { createThreadsClient } from '../../src/platforms/threads/client.js';
import { composeText } from '../../src/publish/compose.js';
import { createPublisher } from '../../src/publish/publisher.js';
import { buildServer } from '../../src/server.js';
import { openStore, type Store } from '../../src/store/index.js';
import { createBotApi } from '../../src/telegram/bot-api.js';
import { DATE, validPlan } from '../plan/fixtures.js';
import { v2Input } from '../plan/variant-fixtures.js';
import { FakeLinkedIn } from '../platforms/linkedin/fake-linkedin.js';
import { TOKEN as BOT_TOKEN } from '../publish/helpers.js';
import { blocks } from '../support/blocks.js';
import { FakeBotApi } from '../support/fake-bot-api.js';
import { FakeThreads } from '../support/fake-threads.js';

// J-N1 wired into the plan intake: every slot and variant text is cleaned once, when the plan
// arrives (LF line ends, Unicode NFC), and that one string is stored, measured, hashed and sent.
// A lone surrogate is refused with HTTP 400, naming the slot, the variant and the index. Plans
// stored before are not touched.

const TOKEN = 'fake-api-token-for-tests-0123456789';
const auth = { authorization: `Bearer ${TOKEN}` };
const EVENING = new Date('2026-10-10T17:00:00Z'); // 20:00 MSK on the 10th
const E_ACUTE_NFD = 'é'; // e + COMBINING ACUTE ACCENT: two code points
const E_ACUTE = 'é'; // é: one code point

const open: Store[] = [];
const stops: (() => Promise<void>)[] = [];
function setup() {
  const store = openStore(':memory:');
  open.push(store);
  const app = buildServer({
    config: loadConfig({ JOURNALIST_API_TOKEN: TOKEN }),
    store,
    logLevel: 'silent',
    now: () => EVENING,
    preflight: { blocks, channel: '@test_channel' },
  });
  return { store, app };
}
afterEach(async () => {
  for (const s of open.splice(0)) s.close();
  for (const stop of stops.splice(0)) await stop();
});
const post = (app: ReturnType<typeof setup>['app'], payload: unknown) =>
  app.inject({
    method: 'POST',
    url: `/v1/plans/${DATE}`,
    headers: auth,
    payload: payload as object,
  });

/** The fixture v2 body with an NFD accent and CR LF line ends in the slot and a variant text. */
function dirtyBody() {
  const input = v2Input();
  const s1 = input.slots[0]!;
  s1.text = `Кафе${E_ACUTE_NFD} на углу.\r\nКто пришёл первым?`;
  const variants = s1.variants as Record<string, unknown>[];
  variants[0]!.text = `Кафе${E_ACUTE_NFD} молчит ☕\r\n\r\nКто нарушит тишину первым?`;
  variants[2]!.text = `Cafe${E_ACUTE_NFD} on the corner.\rWho came first?`;
  return input;
}
/** The text of a stored variant row (it lives in the row's json). */
const vtext = (v: { json: string }) => (JSON.parse(v.json) as { text: string }).text;
const storedSlot = (store: Store, id: string) =>
  JSON.parse(store.slots.listForPlan(DATE).find((s) => s.slotId === id)!.json) as PlanSlot;

describe('plan intake cleans every text once (J-N1)', () => {
  it('e + U+0301 is stored as one code point, CR LF and CR as LF, in the slot and in each variant', async () => {
    const { store, app } = setup();
    const res = await post(app, dirtyBody());
    expect(res.statusCode).toBe(201);

    const slot = storedSlot(store, 's1');
    expect(slot.text.startsWith(`Кафе${E_ACUTE} на углу.\nКто пришёл первым?`)).toBe(true);
    const variants = store.slotVariants.listForPlan(DATE).filter((v) => v.slotId === 's1');
    const byKey = Object.fromEntries(variants.map((v) => [`${v.platform}/${v.lang}`, vtext(v)]));
    expect(byKey['threads/ru']!.startsWith(`Кафе${E_ACUTE} молчит ☕\n\nКто нарушит`)).toBe(true);
    expect(byKey['linkedin/en']!.startsWith(`Cafe${E_ACUTE} on the corner.\nWho came first?`)).toBe(
      true,
    );
    // The plan json holds the same strings.
    const plan = PlanV2Schema.parse(JSON.parse(store.plans.get(DATE)!.json));
    expect(plan.slots[0]!.text).toBe(slot.text);
    expect(plan.slots[0]!.variants!.map((v) => v.text).sort()).toEqual(variants.map(vtext).sort());
    for (const text of [slot.text, ...variants.map(vtext)]) {
      expect(text).not.toContain(E_ACUTE_NFD);
      expect(text).not.toContain('\r');
      expect(text).toBe(text.normalize('NFC'));
    }
  });

  it('what is counted is what is stored: one code point for the accent, no hidden second one', async () => {
    const { store, app } = setup();
    await post(app, dirtyBody());
    const threads = vtext(
      store.slotVariants.listForPlan(DATE).find((v) => v.platform === 'threads')!,
    );
    // The length counter normalizes to NFC itself; on the stored text that changes nothing,
    // so the counted string and the string that will be sent are one and the same.
    expect(threadsLength(threads)).toBe(threadsLength(threads.normalize('NFD').normalize('NFC')));
    expect([...threads.split(' ')[0]!]).toEqual([...`Кафе${E_ACUTE}`]);
    expect([...`Кафе${E_ACUTE}`]).toHaveLength(5);
  });

  it('the exact stored string survives Telegram, Threads and LinkedIn serialisation', async () => {
    const { store, app } = setup();
    await post(app, dirtyBody());
    const slotText = storedSlot(store, 's1').text;
    const variants = store.slotVariants.listForPlan(DATE);
    const threadsText = vtext(variants.find((v) => v.platform === 'threads')!);
    const linkedinText = vtext(variants.find((v) => v.platform === 'linkedin' && v.lang === 'ru')!);

    // Telegram: the Bot API JSON body.
    const tg = await new FakeBotApi(BOT_TOKEN).start();
    stops.push(() => tg.stop());
    const sent = await createBotApi({ token: BOT_TOKEN, baseUrl: tg.baseUrl }).call('sendMessage', {
      chat_id: '@test_channel',
      text: slotText,
    });
    expect(sent.ok).toBe(true);
    expect(tg.channel[0]!.text).toBe(slotText);

    // Threads: the container's text parameter.
    const th = await new FakeThreads('fake-threads-token-for-tests').start();
    stops.push(() => th.stop());
    const container = await createThreadsClient({
      token: () => 'fake-threads-token-for-tests',
      baseUrl: th.baseUrl,
    }).createContainer(threadsText);
    expect(container.ok).toBe(true);
    expect([...th.containers.values()][0]!.text).toBe(threadsText);

    // LinkedIn: the commentary, escaped as little text, read back as a reader sees it.
    const li = await new FakeLinkedIn({
      token: 'li-tok',
      clientId: 'ci',
      clientSecret: 'cs',
    }).start();
    stops.push(() => li.stop());
    const published = await createLinkedInAdapter({
      client: createLinkedInClient({
        token: 'li-tok',
        apiBaseUrl: li.baseUrl,
        oauthBaseUrl: li.baseUrl,
        retry: { sleep: async () => undefined },
      }),
    }).publish({ key: `linkedin:${DATE}:s1:0`, text: linkedinText, lang: 'ru' });
    expect(published.ok).toBe(true);
    expect(li.feed[0]!.text).toBe(linkedinText.trimEnd());

    for (const t of [
      tg.channel[0]!.text!,
      [...th.containers.values()][0]!.text,
      li.feed[0]!.text,
    ]) {
      expect(t).not.toContain(E_ACUTE_NFD);
      expect(t).not.toContain('\r');
    }
  });

  it('the idempotency hash is taken over the cleaned body: the clean body again is "unchanged"', async () => {
    const { store, app } = setup();
    const dirty = dirtyBody();
    expect((await post(app, dirty)).statusCode).toBe(201);
    const stored = store.plans.get(DATE)!;
    // The same body with the texts already clean: the same hash, nothing stored again.
    const clean = structuredClone(dirty);
    const s1 = clean.slots[0]!;
    s1.text = (s1.text as string).normalize('NFC').replace(/\r\n?/g, '\n');
    for (const v of s1.variants as Record<string, string>[]) {
      v.text = v.text!.normalize('NFC').replace(/\r\n?/g, '\n');
    }
    expect(stored.inputSha256).toBe(sha256Hex(canonicalJson(clean)));
    const again = await post(app, clean);
    expect(again.statusCode).toBe(200);
    expect(store.plans.get(DATE)!.updatedAt).toBe(stored.updatedAt);
  });

  it('the publication text hash comes from the stored text', async () => {
    const { store, app } = setup();
    await post(app, dirtyBody());
    store.plans.setStatus(DATE, 'approved');
    const slot = storedSlot(store, 's1');
    const at = new Date(slot.at);
    const publisher = createPublisher({
      store,
      blocks,
      channel: '@test_channel',
      dryRun: true,
      tz: 'Europe/Moscow',
      now: () => new Date(at.getTime() + 30_000),
      sleep: async () => undefined,
    });
    await publisher.runOnce();
    const [pub] = store.publications.listForPlan(DATE);
    expect(pub).toBeDefined();
    expect(pub!.textSha256).toBe(textHash(composeText(slot.text)));
  });
});

describe('a lone surrogate is refused at intake', () => {
  it('in a variant text: HTTP 400 with the slot, the variant and the index; nothing stored', async () => {
    const { store, app } = setup();
    const input = v2Input();
    const variants = input.slots[0]!.variants as Record<string, unknown>[];
    variants[1]!.text = 'Дело №1.\r\n' + String.fromCharCode(0xd83d) + ' тишина';
    const res = await post(app, input);
    expect(res.statusCode).toBe(400);
    expect(res.json().errors).toEqual([
      {
        path: 'slots.0.variants.1.text',
        slotId: 's1',
        code: 'lone_surrogate',
        index: 10,
        message:
          'slot "s1", variant linkedin/ru: the text has a lone surrogate at index 10 (a broken emoji or a cut character): it cannot be sent, fix the text',
      },
    ]);
    expect(store.plans.get(DATE)).toBeUndefined();
  });

  it('in a slot text, and every one is named at once', async () => {
    const { store, app } = setup();
    const p = validPlan();
    const body = { arc: p.arc, slots: p.slots.map((s) => ({ ...s })) };
    body.slots[0]!.text = String.fromCharCode(0xdc00) + 'x';
    body.slots[1]!.text = 'ok ' + String.fromCharCode(0xdbff);
    const res = await post(app, body);
    expect(res.statusCode).toBe(400);
    expect(
      res.json().errors.map((e: { path: string; index: number }) => [e.path, e.index]),
    ).toEqual([
      ['slots.0.text', 0],
      ['slots.1.text', 3],
    ]);
    expect(store.plans.get(DATE)).toBeUndefined();
  });

  it('a well-formed emoji (a surrogate pair) is fine', async () => {
    const { app } = setup();
    const input = v2Input();
    input.slots[0]!.text = 'Кафе на углу 👨‍💻 молчит.\nКто пришёл первым?';
    const res = await post(app, input);
    expect(res.statusCode, res.body).toBe(201);
  });
});

describe('the slot PUT cleans its text the same way', () => {
  const put = (app: ReturnType<typeof setup>['app'], payload: unknown) =>
    app.inject({
      method: 'PUT',
      url: `/v1/plans/${DATE}/slots/s1`,
      headers: auth,
      payload: payload as object,
    });

  it('NFD and CR LF are stored as NFC and LF; a lone surrogate is refused with its index', async () => {
    const { store, app } = setup();
    expect((await post(app, v2Input())).statusCode).toBe(201);
    store.plans.setStatus(DATE, 'approved');
    const ok = await put(app, {
      text: `Кафе${E_ACUTE_NFD} на углу.\r\nКто пришёл первым?`,
      reason: 'owner edit',
    });
    expect(ok.statusCode, ok.body).toBe(200);
    const text = storedSlot(store, 's1').text;
    expect(text.startsWith(`Кафе${E_ACUTE} на углу.\nКто пришёл первым?`)).toBe(true);
    const bad = await put(app, { text: 'x' + String.fromCharCode(0xd800), reason: 'owner edit' });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().errors).toContainEqual(
      expect.objectContaining({ path: 'text', slotId: 's1', code: 'lone_surrogate', index: 1 }),
    );
    expect(storedSlot(store, 's1').text).toBe(text);
  });
});

describe('plans stored before are not re-normalised', () => {
  it('an NFD text already in the database is read, previewed and sent as it is', async () => {
    const { store, app } = setup();
    const plan = validPlan();
    plan.slots[0]!.text = signText(`Кафе${E_ACUTE_NFD} на углу.\nКто первый?`);
    saveDraft(store, { plan, md: '' }, null, EVENING);
    store.plans.setStatus(DATE, 'approved');
    expect(storedSlot(store, 's1').text).toContain(E_ACUTE_NFD);
    const at = encodeURIComponent(new Date(plan.slots[0]!.at).toISOString());
    const res = await app.inject({
      method: 'GET',
      url: `/v1/plans/${DATE}/preview?now=${at}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const parts = res.json().slot.parts as { text: string }[];
    expect(parts.map((p) => p.text).join('')).toContain(`Кафе${E_ACUTE_NFD}`);
    // Still the same in the store after the read.
    expect(storedSlot(store, 's1').text).toContain(E_ACUTE_NFD);
  });
});
