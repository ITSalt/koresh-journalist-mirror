import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from '../../src/store/index.js';

let store: Store;
beforeEach(() => {
  store = openStore(':memory:');
});
afterEach(() => store.close());

const m = (updateId: number, over = {}) => ({
  updateId,
  messageId: updateId,
  at: '2026-10-11T10:00:00.000Z',
  text: `t${updateId}`,
  kind: 'text' as const,
  ...over,
});

describe('migration 004', () => {
  it('is applied', () => {
    const rows = store.db.prepare('SELECT name FROM schema_migrations').all() as {
      name: string;
    }[];
    expect(rows.map((n) => n.name)).toContain('004_owner_inbox.sql');
  });
});

describe('ownerDrafts', () => {
  it('adds, reads, updates the status, and maps message ids back', () => {
    const d = store.ownerDrafts.add({ label: 'L', ref: 'R', text: 'body', status: 'partial' });
    expect(store.ownerDrafts.get(d.id)).toMatchObject({
      label: 'L',
      ref: 'R',
      text: 'body',
      error: null,
    });
    store.ownerDrafts.addPart(d.id, 0, 11);
    store.ownerDrafts.addPart(d.id, 1, 12);
    store.ownerDrafts.setStatus(d.id, 'sent');
    expect(store.ownerDrafts.get(d.id)?.status).toBe('sent');
    expect(store.ownerDrafts.byMessageId(12)?.id).toBe(d.id);
    expect(store.ownerDrafts.byMessageId(13)).toBeUndefined();
    expect(store.ownerDrafts.messageIds(d.id)).toEqual([11, 12]);
    expect(store.ownerDrafts.get(999)).toBeUndefined();
  });

  it('allows null label/ref; rejects a duplicate message id or part and a bad status', () => {
    const a = store.ownerDrafts.add({ text: 'x', status: 'sent' });
    expect(a.label).toBeNull();
    store.ownerDrafts.addPart(a.id, 0, 1);
    const b = store.ownerDrafts.add({ text: 'y', status: 'sent' });
    expect(() => store.ownerDrafts.addPart(b.id, 0, 1)).toThrow();
    expect(() => store.ownerDrafts.addPart(a.id, 0, 2)).toThrow();
    expect(() => store.ownerDrafts.add({ text: 'z', status: 'weird' as never })).toThrow();
  });
});

describe('inbox', () => {
  it('ignores a duplicate update_id; lists after an id, oldest first, limited', () => {
    expect(store.inbox.add(m(1))).toBe(true);
    expect(store.inbox.add(m(1, { text: 'other' }))).toBe(false);
    store.inbox.add(m(2));
    store.inbox.add(m(3));
    expect(store.inbox.listAfter(0).map((x) => x.text)).toEqual(['t1', 't2', 't3']);
    expect(store.inbox.listAfter(store.inbox.listAfter(0)[0]!.id, 1).map((x) => x.text)).toEqual([
      't2',
    ]);
    expect(store.inbox.listAfter(store.inbox.listAfter(0).at(-1)!.id)).toEqual([]);
  });

  it('joins the draft ref and label', () => {
    const d = store.ownerDrafts.add({ label: 'L', ref: 'R', text: 'x', status: 'sent' });
    store.inbox.add(m(1, { draftId: d.id, replyToMessageId: 5 }));
    expect(store.inbox.listAfter(0)[0]).toMatchObject({
      draftId: d.id,
      draftRef: 'R',
      draftLabel: 'L',
      replyToMessageId: 5,
    });
  });
});

describe('botState', () => {
  it('gets and overwrites', () => {
    expect(store.botState.get('k')).toBeUndefined();
    store.botState.set('k', '1');
    store.botState.set('k', '2');
    expect(store.botState.get('k')).toBe('2');
  });
});
