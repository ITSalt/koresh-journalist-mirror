import { describe, expect, it } from 'vitest';
import { renderPlanMd } from '../../src/plan/render.js';
import { validPlan } from './fixtures.js';

describe('renderPlanMd', () => {
  it('renders date, arc and every slot with MSK time, kind, full text and poll', () => {
    const md = renderPlanMd(validPlan());
    expect(md).toMatchSnapshot();
    expect(md).toContain('План Кореша на 11.10.2026 (воскресенье)');
    expect(md).toContain('Дело №1 «Тишина»');
    expect(md).toContain('09:07 МСК · пост · s1');
    expect(md).toContain('19:09 МСК · опрос · s2');
    for (const s of validPlan().slots) expect(md).toContain(s.text);
    expect(md).toContain('1. ИИ ленится');
  });

  it('is deterministic', () => {
    expect(renderPlanMd(validPlan())).toBe(renderPlanMd(validPlan()));
  });

  it('says so when there are no slots', () => {
    const md = renderPlanMd({
      ...validPlan(),
      slots: [],
      sourceWindow: { from: '2026-10-08T00:00:00Z', to: '2026-10-08T00:00:00Z', entryIds: [] },
    });
    expect(md).toContain('Публикаций нет.');
    expect(md).toMatchSnapshot();
  });

  it('shows the source window in MSK whatever the offset', () => {
    const p = validPlan();
    p.sourceWindow.from = '2026-10-08T19:02:00Z';
    expect(renderPlanMd(p)).toContain('08.10 22:02');
  });
});
