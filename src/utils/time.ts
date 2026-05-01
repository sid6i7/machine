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
