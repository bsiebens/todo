/** Local calendar helpers working on YYYY-MM-DD strings ("floating" dates). */
export const pad = (n: number) => String(n).padStart(2, '0');

export function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseDateStr(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y!, m! - 1, d!);
}

export function addDays(s: string, n: number): string {
  const d = parseDateStr(s);
  d.setDate(d.getDate() + n);
  return toDateStr(d);
}

export function diffDays(a: string, b: string): number {
  return Math.round((parseDateStr(a).getTime() - parseDateStr(b).getTime()) / 86_400_000);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function formatDue(date: string | null, time: string | null, today: string): string {
  if (!date) return '';
  const diff = diffDays(date, today);
  let label: string;
  if (diff === 0) label = 'Today';
  else if (diff === 1) label = 'Tomorrow';
  else if (diff === -1) label = 'Yesterday';
  else if (diff > 1 && diff < 7) label = WEEKDAYS[parseDateStr(date).getDay()]!;
  else {
    const d = parseDateStr(date);
    label = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
    if (d.getFullYear() !== parseDateStr(today).getFullYear()) label += ` ${d.getFullYear()}`;
  }
  return time ? `${label} ${time}` : label;
}

export function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
