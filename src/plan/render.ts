import type { PlanDoc, PlanSlot, PlanSlotV2, SlotImage, Variant } from './schema.js';
import { hhmmOf, type PlanWarning } from './timing.js';
import { variantLength } from './variants.js';

const WEEKDAYS = [
  'воскресенье',
  'понедельник',
  'вторник',
  'среда',
  'четверг',
  'пятница',
  'суббота',
] as const;
const KIND_RU: Record<PlanSlot['kind'], string> = { post: 'пост', poll: 'опрос' };

const ddmm = (isoDate: string) => `${isoDate.slice(8, 10)}.${isoDate.slice(5, 7)}`;

/** `DD.MM HH:MM` in Moscow time (fixed UTC+3) for any ISO instant. */
function mskShort(iso: string): string {
  const t = new Date(Date.parse(iso) + 3 * 3600_000).toISOString();
  return `${ddmm(t.slice(0, 10))} ${t.slice(11, 16)}`;
}

function weekday(isoDate: string): string {
  return WEEKDAYS[new Date(`${isoDate}T00:00:00Z`).getUTCDay()] as string;
}

/** One line per illustrated slot (D-32): pixel size, format, short sha256 and the credit. */
function illustrationLine(i: SlotImage): string {
  const format = i.mime === 'image/png' ? 'PNG' : 'JPEG';
  return `Иллюстрация: ${i.width}×${i.height} ${format} · sha256 ${i.sha256.slice(0, 12)} · автор: ${i.credit}`;
}

const PLATFORM_LABEL: Record<Variant['platform'], string> = {
  threads: 'Threads',
  linkedin: 'LinkedIn',
};

/**
 * One block per variant of a slot (plan.json v2): platform, language, its own time as written
 * (seconds kept), the length of the stored text against what it may use, then the text.
 */
function renderVariant(v: Variant): string {
  const { used, max } = variantLength(v.platform, v.text);
  return [
    `### ${PLATFORM_LABEL[v.platform]} · ${v.lang.toUpperCase()} · ${v.at.slice(11, -6)} МСК · длина ${used}/${max}`,
    '',
    v.text.trim(),
  ].join('\n');
}

function renderSlot(s: PlanSlot | PlanSlotV2): string {
  const lines = [
    `## ${s.at.slice(11, 16)} МСК · ${KIND_RU[s.kind]} · ${s.id}`,
    '',
    `Площадка: Telegram · события от ${ddmm(s.eventDate)}`,
    '',
    ...(s.image ? [illustrationLine(s.image), ''] : []),
    s.text.trim(),
  ];
  if (s.poll) {
    lines.push(
      '',
      `**Опрос:** ${s.poll.question}`,
      '',
      ...s.poll.options.map((o, i) => `${i + 1}. ${o}`),
      '',
      `Несколько ответов: ${s.poll.allowsMultiple ? 'да' : 'нет'}`,
    );
  }
  if ('variants' in s) {
    for (const v of s.variants ?? []) lines.push('', renderVariant(v));
  }
  return lines.join('\n');
}

/** The warnings block at the top of plan.md (WP-SVC-25); nothing when there are none. */
function warningsBlock(plan: PlanDoc, warnings: readonly PlanWarning[]): string[] {
  if (!warnings.length) return [];
  const lines = warnings.map((w) => {
    const slot = plan.slots.find((s) => s.id === w.slotId);
    const at = slot ? hhmmOf(slot.at) : '?';
    return `- слот ${w.slotId ?? '?'}, ${at} МСК: то же время, что во вчерашнем плане`;
  });
  return ['**Предупреждения:**', '', ...lines];
}

/**
 * Human rendering of a plan (plan.json v1 or v2) for the owner, in Russian, times in MSK.
 * Deterministic. A slot without variants is rendered as it always was. `warnings` (WP-SVC-25) are
 * listed under the title; without any the text is unchanged.
 */
export function renderPlanMd(plan: PlanDoc, warnings: readonly PlanWarning[] = []): string {
  const [y, m, d] = plan.date.split('-');
  const w = plan.sourceWindow;
  const head = [
    `# План Кореша на ${d}.${m}.${y} (${weekday(plan.date)})`,
    '',
    `**${plan.arc.title}** · такт: ${plan.arc.beat}`,
    '',
    `Источники: записей ${w.entryIds.length}, ${mskShort(w.from)} – ${mskShort(w.to)} МСК`,
    ...(warnings.length ? ['', ...warningsBlock(plan, warnings)] : []),
  ].join('\n');
  const body = plan.slots.length ? plan.slots.map(renderSlot) : ['Публикаций нет.'];
  return [head, ...body].join('\n\n---\n\n') + '\n';
}
