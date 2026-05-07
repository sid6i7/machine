const TZ = process.env.SCHEDULER_TZ || 'Asia/Kolkata';

const DAY_MAP: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6
};

const WORKING_DAYS_RAW = (process.env.WORKING_DAYS || 'mon,tue,wed,thu,fri')
  .toLowerCase()
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const WORKING_DOW = new Set<number>(
  WORKING_DAYS_RAW.map(d => DAY_MAP[d]).filter(n => n !== undefined)
);

function parseHHMM(s: string): { h: number; m: number } {
  const [h, m] = s.split(':').map(Number);
  return { h, m };
}

const START = parseHHMM(process.env.WORKING_HOURS_START || '09:00');
const END = parseHHMM(process.env.WORKING_HOURS_END || '19:00');

interface IstParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: string;
}

const TS_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  weekday: 'short',
  hour12: false
});

function istParts(tsMs: number): IstParts {
  const parts = TS_FORMATTER.formatToParts(new Date(tsMs)).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {} as Record<string, string>);

  const hour = Number(parts.hour);
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: hour === 24 ? 0 : hour,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: parts.weekday.toLowerCase().slice(0, 3)
  };
}

export function istDateString(tsMs: number = Date.now()): string {
  const p = istParts(tsMs);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function formatIST(tsMs: number = Date.now()): string {
  const p = istParts(tsMs);
  return `${istDateString(tsMs)} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}:${String(p.second).padStart(2, '0')} IST`;
}

export function isWorkingDay(tsMs: number = Date.now()): boolean {
  const p = istParts(tsMs);
  const dow = DAY_MAP[p.weekday];
  return dow !== undefined && WORKING_DOW.has(dow);
}

export function isWithinWorkingHours(tsMs: number = Date.now()): boolean {
  if (!isWorkingDay(tsMs)) return false;
  const p = istParts(tsMs);
  const minOfDay = p.hour * 60 + p.minute;
  const startMin = START.h * 60 + START.m;
  const endMin = END.h * 60 + END.m;
  return minOfDay >= startMin && minOfDay < endMin;
}

// Working ms elapsed between two timestamps. Walks forward in 1-minute
// increments — fine for the multi-day windows we care about (mention SLAs,
// reminder catch-up). Not designed for spans of months.
export function workingMillisBetween(startTs: number, endTs: number): number {
  if (endTs <= startTs) return 0;
  const stepMs = 60_000;
  let elapsed = 0;
  for (let t = startTs; t < endTs; t += stepMs) {
    if (isWithinWorkingHours(t)) elapsed += stepMs;
  }
  return elapsed;
}

export function workingHoursBetween(startTs: number, endTs: number): number {
  return workingMillisBetween(startTs, endTs) / 3_600_000;
}

export function nowMs(): number {
  return Date.now();
}

// Returns the IST date string of the Monday of the week containing tsMs.
// Mon-anchored weeks (ISO weekday 1).
export function weekStartDate(tsMs: number = Date.now()): string {
  const p = istParts(tsMs);
  const dow = DAY_MAP[p.weekday]; // 0=Sun..6=Sat
  // Days since Monday: Mon=0, Tue=1, ..., Sun=6
  const sinceMonday = (dow + 6) % 7;
  // Subtract that many days at midnight IST. Anchor to noon IST to dodge DST/edge cases.
  const noonIstOnDay = new Date(p.year, p.month - 1, p.day, 12, 0, 0).getTime();
  const monday = noonIstOnDay - sinceMonday * 86_400_000;
  return istDateString(monday);
}

// Returns the IST date string of the Saturday in the week containing tsMs
// (Mon-anchored weeks — Saturday is Monday + 5 days).
export function weekSaturdayDate(tsMs: number = Date.now()): string {
  const monday = weekStartDate(tsMs);
  const noon = new Date(monday + 'T12:00:00').getTime();
  return istDateString(noon + 5 * 86_400_000);
}

// Yields each working-day date string in [startDate, endDate] inclusive (IST).
// Uses WORKING_DOW set already computed at module load.
export function workingDaysInRange(startDate: string, endDate: string): string[] {
  const out: string[] = [];
  const start = new Date(startDate + 'T12:00:00').getTime();
  const end = new Date(endDate + 'T12:00:00').getTime();
  for (let t = start; t <= end; t += 86_400_000) {
    const p = istParts(t);
    const dow = DAY_MAP[p.weekday];
    if (dow !== undefined && WORKING_DOW.has(dow)) {
      out.push(istDateString(t));
    }
  }
  return out;
}
