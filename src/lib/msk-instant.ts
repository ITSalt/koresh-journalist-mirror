// msk-instant.mjs — J-T1 slot-time equality for Moscow (+03:00) plan strings
// J-T1 by glitchfox, sparse-array fix by theone; board task J-T1, v2 accepted 14.10.2026 (sha256 80512f43...).
// Copied unchanged from msk-instant.glitchfox.v2.mjs; only TypeScript types were added.
// Author: glitchfox; sparse-array fix in findSameInstants: theone (board #87144)
// Rule T1: strict form YYYY-MM-DDTHH:MM[:SS]+03:00 → unix seconds, or null.
// No imports; no Date (Date.UTC remaps years 0–99; Date.parse accepts 31 Apr).

const RE22 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})\+03:00$/;
const RE25 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\+03:00$/;
/** TS: the groups of a match (RE22 has no 6th; it is not read then). */
type Match = [string, string, string, string, string, string, string];

function isLeap(y: number): boolean {
  return y % 400 === 0 || (y % 4 === 0 && y % 100 !== 0);
}

function daysInMonth(y: number, m: number): number {
  if (m === 2) return isLeap(y) ? 29 : 28;
  if (m === 4 || m === 6 || m === 9 || m === 11) return 30;
  return 31;
}

/** Days from 0000-01-01 to y-m-d (proleptic Gregorian), exclusive of that day. */
function daysFromYearZero(y: number, m: number, d: number): number {
  // Complete years before y
  let days = 0;
  // Sum year lengths 0..y-1 via closed form
  // leaps in [0, y): floor((y-1)/4) - floor((y-1)/100) + floor((y-1)/400) + 1 for year 0
  // year 0 is leap; years 1..y-1: floor((y-1)/4)-floor((y-1)/100)+floor((y-1)/400)
  if (y > 0) {
    const ym1 = y - 1;
    const leaps = Math.floor(ym1 / 4) - Math.floor(ym1 / 100) + Math.floor(ym1 / 400) + 1; // +1 for year 0
    days = y * 365 + leaps;
  }
  // else y===0: days=0 before month
  const mdays = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  for (let i = 1; i < m; i++) {
    days += i === 2 && isLeap(y) ? 29 : (mdays[i] as number);
  }
  days += d - 1;
  return days;
}

// 1970-01-01 is day index from 0000-01-01:
const EPOCH_DAY = daysFromYearZero(1970, 1, 1); // precompute once

export function instantOf(at: unknown): number | null {
  if (typeof at !== 'string') return null;
  let m: Match | null = null;
  let sec = 0;
  if (at.length === 22) {
    m = RE22.exec(at) as Match | null;
    if (!m) return null;
  } else if (at.length === 25) {
    m = RE25.exec(at) as Match | null;
    if (!m) return null;
    sec = +m[6];
  } else {
    return null;
  }
  const y = +m[1], mo = +m[2], d = +m[3], h = +m[4], mi = +m[5];
  if (mo < 1 || mo > 12) return null;
  if (d < 1 || d > daysInMonth(y, mo)) return null;
  if (h > 23 || mi > 59 || sec > 59) return null;
  const dayIndex = daysFromYearZero(y, mo, d);
  // Moscow local → UTC: subtract 3 hours
  const utcSeconds = (dayIndex - EPOCH_DAY) * 86400 + h * 3600 + mi * 60 + sec - 3 * 3600;
  return utcSeconds;
}

export function sameInstant(a: unknown, b: unknown): boolean {
  const ia = instantOf(a);
  const ib = instantOf(b);
  return ia !== null && ib !== null && ia === ib;
}

export function findSameInstants(list: unknown): [number, number][] {
  if (!Array.isArray(list)) return [];
  // Explicit loop, not .map: map leaves holes as holes (read back as undefined, not null).
  const inst: (number | null)[] = [];
  for (let i = 0; i < list.length; i++) inst.push(instantOf(list[i]));
  const out: [number, number][] = [];
  for (let i = 0; i < list.length; i++) {
    if (inst[i] === null) continue;
    for (let j = i + 1; j < list.length; j++) {
      if (inst[j] !== null && inst[i] === inst[j]) out.push([i, j]);
    }
  }
  return out;
}
