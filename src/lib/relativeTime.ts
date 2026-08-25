const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 1000 * 60 * 60 * 24 * 365],
  ['month', 1000 * 60 * 60 * 24 * 30],
  ['week', 1000 * 60 * 60 * 24 * 7],
  ['day', 1000 * 60 * 60 * 24],
  ['hour', 1000 * 60 * 60],
  ['minute', 1000 * 60],
];

const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

export function formatRelativeTime(isoDate: string, now = Date.now()) {
  const elapsed = now - new Date(isoDate).getTime();
  for (const [unit, ms] of UNITS) {
    const value = Math.floor(elapsed / ms);
    if (value >= 1) {
      return formatter.format(-value, unit);
    }
  }
  return formatter.format(0, 'minute');
}
