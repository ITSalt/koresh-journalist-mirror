// The three pure blocks the publisher uses, typed exactly as the Contract rows of WP-SVC-03
// (`escapeMdV2`), WP-SVC-04 (`chunkText`) and WP-SVC-05 (`decide`). The publisher receives them
// injected (`src/publish/blocks.ts` binds the real modules), so the contract is the only coupling.

export interface DecideInput {
  day: { date: string; approved: boolean; rejected: boolean };
  slots: { id: string; at: string /* ISO with offset */ }[];
  done: string[];
  lastPublishedAt?: string;
  now: string;
  rules?: { graceMin?: number; minGapMin?: number };
}

export interface DecideOutput {
  publish?: string;
  skip: string[];
  wakeAt?: string;
}

export interface ChunkOptions {
  limit: number;
  reserve?: number;
  measure?: (s: string) => number;
}

/** The `md` helpers of WP-SVC-03 the publisher uses (D-21): raw text in, MarkdownV2 out. */
export interface MdHelpers {
  bold(s: string): string;
  quote(lines: string[]): string;
}

export interface Blocks {
  escapeMdV2(text: string): string;
  md: MdHelpers;
  chunkText(text: string, opts: ChunkOptions): string[];
  decide(input: DecideInput): DecideOutput;
}
