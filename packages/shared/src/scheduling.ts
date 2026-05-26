// Helpers for time-of-day publishing slots.
//
// A "slot" is a string like "09:00" interpreted in the Content Plan's
// timezone (e.g. America/New_York). nextSlotUtc(slot, tz, ref) returns the
// UTC Date for the next occurrence of that wall-clock time at or after
// `ref`. Handles DST correctly via Intl.DateTimeFormat.

// Parse "HH:MM" → [hour, minute]. Returns null if malformed.
export function parseSlot(slot: string): { h: number; m: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(slot.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return { h, m };
}

// Convert wall-clock components in `tz` to the corresponding UTC instant.
// Returns a Date. DST-aware.
export function localToUtc(year: number, month1to12: number, day: number, hour: number, minute: number, tz: string): Date {
  const guess = new Date(Date.UTC(year, month1to12 - 1, day, hour, minute));
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = fmt.formatToParts(guess);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const observedUtcEquiv = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  const offsetMs = observedUtcEquiv - guess.getTime();
  return new Date(guess.getTime() - offsetMs);
}

// Get the YYYY-MM-DD components of a given UTC instant rendered in `tz`.
function dateComponentsInTz(date: Date, tz: string): { y: number; mo: number; d: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { y: get("year"), mo: get("month"), d: get("day") };
}

// Given a slot like "09:00", a timezone, and a reference timestamp,
// returns the next UTC Date at which "today (or later) at HH:MM in tz"
// is at or after `ref`. If today's slot is already in the past relative
// to `ref`, rolls to tomorrow. This is the "skip to tomorrow's slot"
// rule the admin selected.
export function nextSlotUtc(slot: string, tz: string, ref: Date = new Date()): Date | null {
  const parsed = parseSlot(slot);
  if (!parsed) return null;
  const { y, mo, d } = dateComponentsInTz(ref, tz);
  const todayUtc = localToUtc(y, mo, d, parsed.h, parsed.m, tz);
  if (todayUtc.getTime() > ref.getTime()) return todayUtc;
  // Roll to tomorrow: add 24h to the wall-clock date, recompute UTC for
  // that day at the same slot (handles DST transitions correctly).
  const oneDayLater = new Date(ref.getTime() + 24 * 3600_000);
  const { y: y2, mo: mo2, d: d2 } = dateComponentsInTz(oneDayLater, tz);
  return localToUtc(y2, mo2, d2, parsed.h, parsed.m, tz);
}

// Resolves an array of slot strings into a sorted list of UTC Dates,
// each being the next occurrence of that slot at or after `ref`. Slots
// that fail to parse are dropped silently.
export function nextSlotsUtc(slots: string[], tz: string, ref: Date = new Date()): Date[] {
  const dates: Date[] = [];
  for (const s of slots) {
    const next = nextSlotUtc(s, tz, ref);
    if (next) dates.push(next);
  }
  dates.sort((a, b) => a.getTime() - b.getTime());
  return dates;
}
