import type { Config } from '../config.js';
import type { FeedEntry } from '../lib/feed-types.js';
import { guardedCall } from '../llm/budget.js';
import { createOpenRouterClient, type ChatMessage, type LlmClient } from '../llm/openrouter.js';
import type { Store } from '../store/index.js';
import { finalizePlan, issueLine, sourceWindowOf, type PlanBase } from './pipeline.js';
import { buildPrompt, loadPromptContext, loadPromptTexts, type PromptTexts } from './prompt.js';
import { renderPlanMd } from './render.js';
import { yesterdayTimes } from './timing.js';
import { PlanV1Schema, type PlanDoc, type PlanV1 } from './schema.js';

export { endsWithQuestion, signText, SIGNATURE_LINE, TEXT_MAX_RAW } from './pipeline.js';

export interface BuildPlanInput {
  /** Plan date, YYYY-MM-DD. */
  date: string;
  /** Already windowed and redacted by the caller. */
  entries: FeedEntry[];
  now: Date;
}

export interface BuildPlanResult {
  status: 'draft' | 'failed';
  /** Always plan.json v1: the fallback writes Telegram only, no variants (WP-PLAT-01). */
  plan?: PlanDoc;
  md?: string;
  reason?: string;
  /** USD booked against the daily cap by this run (actual costs, estimates when unknown). */
  costUsd: number;
}

export interface BuildPlanDeps {
  store: Store;
  /** Undefined when OPENROUTER_API_KEY or the model is missing: the run fails without a call. */
  llm: LlmClient | undefined;
  capUsd: number | undefined;
  estimateUsd: number;
  prompts: PromptTexts;
}

/** Dependencies from config: OpenRouter client, cap, estimate, committed prompt texts. */
export function planDepsFromConfig(
  config: Config,
  store: Store,
  opts: { model?: string } = {},
): BuildPlanDeps {
  const model = opts.model ?? config.OPENROUTER_MODEL;
  return {
    store,
    llm:
      config.OPENROUTER_API_KEY && model
        ? createOpenRouterClient({
            apiKey: config.OPENROUTER_API_KEY,
            model,
            baseUrl: config.OPENROUTER_BASE_URL,
          })
        : undefined,
    capUsd: config.LLM_DAILY_CAP_USD,
    estimateUsd: config.LLM_ESTIMATE_USD,
    prompts: loadPromptTexts(),
  };
}

type Checked =
  { plan: PlanDoc; md: string; errors?: undefined } | { plan?: undefined; errors: string[] };

/** Parse the answer, then the shared post-processing (`finalizePlan`, also used by POST). */
function check(content: string, base: PlanBase, yesterday: ReadonlySet<string>): Checked {
  const raw = content
    .trim()
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?```\s*$/, '');
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    return { errors: [`the answer is not valid JSON: ${(e as Error).message}`] };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { errors: ['the answer must be one JSON object with "arc" and "slots"'] };
  }
  const { arc, slots } = obj as { arc?: unknown; slots?: unknown };
  const f = finalizePlan({ arc, slots }, base, { yesterday });
  return f.errors ? { errors: f.errors.map(issueLine) } : { plan: f.plan, md: f.md };
}

function repairMessage(errors: string[]): ChatMessage {
  return {
    role: 'user',
    content: [
      'Ответ не прошёл проверку (JSON / схема plan.json / правила текста):',
      ...errors.map((e) => `- ${e}`),
      '',
      'Исправь эти ошибки и верни весь JSON-объект заново, без пояснений.',
    ].join('\n'),
  };
}

const NO_LLM = 'config: OPENROUTER_API_KEY or OPENROUTER_MODEL is not set; no plan without an LLM';

/**
 * Evening plan: prompt -> LLM -> parse -> zod, one repair retry with the errors, then the
 * signature on every text. Never stores the plan (that is WP-SVC-10's job).
 */
export async function buildPlan(
  input: BuildPlanInput,
  deps: BuildPlanDeps,
): Promise<BuildPlanResult> {
  const entries = input.entries.filter((e) => !e.private);
  const base = {
    version: 1 as const,
    date: input.date,
    sourceWindow: sourceWindowOf(entries, input.now),
  };

  if (!entries.length) {
    const plan: PlanV1 = { ...base, arc: { title: 'Нет материала', beat: 'пауза' }, slots: [] };
    return {
      status: 'draft',
      plan: PlanV1Schema.parse(plan),
      md: renderPlanMd(plan),
      reason: 'no entries in the source window',
      costUsd: 0,
    };
  }
  const llm = deps.llm;
  if (!llm) return { status: 'failed', reason: NO_LLM, costUsd: 0 };

  const messages = buildPrompt({
    date: input.date,
    entries,
    ...deps.prompts,
    ...loadPromptContext(deps.store, input.date, input.now),
  });

  // WP-SVC-25: warnings of the fallback plan land in its plan.md like those of a POSTed one.
  const yesterday = yesterdayTimes(deps.store, input.date);
  let costUsd = 0;
  let errors: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    let g;
    try {
      g = await guardedCall(
        { store: deps.store, capUsd: deps.capUsd, estimateUsd: deps.estimateUsd, now: input.now },
        () => llm.complete(messages),
      );
    } catch (e) {
      costUsd += deps.estimateUsd; // unknown actual cost: the estimate stays booked
      return { status: 'failed', reason: `llm: ${(e as Error).message}`, costUsd };
    }
    if (!g.ok) return { status: 'failed', reason: 'cap', costUsd };
    costUsd += g.costUsd;

    const checked = check(g.result.content, base, yesterday);
    if (checked.plan) {
      return { status: 'draft', plan: checked.plan, md: checked.md, costUsd };
    }
    errors = checked.errors;
    messages.push({ role: 'assistant', content: g.result.content }, repairMessage(errors));
  }
  return { status: 'failed', reason: `invalid: ${errors.slice(0, 5).join('; ')}`, costUsd };
}
