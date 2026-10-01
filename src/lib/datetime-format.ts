/**
 * Formatter construction is not free: `new Intl.DateTimeFormat(...)` and the
 * `Date#toLocale*` shortcuts that build one internally cost tens of
 * microseconds each (measured ~18µs for a short time, ~36µs for a
 * date+time pair). List rows call them once per row per render, so a session
 * drawer or a git commit list would rebuild the same formatter hundreds of
 * times. Format once per (locale, options) pair instead.
 */
const formatterCache = new Map<string, Intl.DateTimeFormat>();

export function cachedDateTimeFormat(
  locale: string | undefined,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const key = `${locale ?? ""}\u0000${JSON.stringify(options)}`;
  const cached = formatterCache.get(key);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat(locale, options);
  formatterCache.set(key, formatter);
  return formatter;
}

/** `Oct 2 14:30` style row meta used by the session list. */
export function formatRowDateTime(iso: string, locale: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const day = cachedDateTimeFormat(locale, { month: "short", day: "numeric" }).format(date);
  const time = cachedDateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(date);
  return `${day} ${time}`;
}

/** Local date+time for a tooltip/title attribute. */
export function formatFullDateTime(value: number | string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return cachedDateTimeFormat(locale, {}).format(date);
}
