/**
 * A date as the library lists it: "7 Nov 2026". In UTC, because the server
 * renders it and does not know the reader's zone; a day is the precision a
 * history list needs, and the full instant is in the `<time>` element.
 */
const DAY = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

export function dayWords(instant: string): string {
  return DAY.format(new Date(instant));
}
