const yekaterinburgOffsetMs = 5 * 60 * 60 * 1000;
const dayMs = 24 * 60 * 60 * 1000;

export type WeekPeriod = {
  weekKey: string;
  startIso: string;
  endIso: string;
  label: string;
};

export function currentYekaterinburgWeek(now = new Date()): WeekPeriod {
  const startMs = weekStartMs(now);
  return buildPeriod(startMs, now.getTime());
}

export function previousYekaterinburgWeek(now = new Date()): WeekPeriod {
  const currentStartMs = weekStartMs(now);
  return buildPeriod(currentStartMs - 7 * dayMs, currentStartMs);
}

function weekStartMs(value: Date) {
  const shifted = new Date(value.getTime() + yekaterinburgOffsetMs);
  const localMidnightMs = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  const day = shifted.getUTCDay() || 7;
  return localMidnightMs - (day - 1) * dayMs - yekaterinburgOffsetMs;
}

function buildPeriod(startMs: number, endMs: number): WeekPeriod {
  return {
    weekKey: localDateKey(startMs),
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(endMs).toISOString(),
    label: `${formatLocalDate(startMs)} - ${formatLocalDate(endMs - 1)}`,
  };
}

function localDateKey(ms: number) {
  return new Date(ms + yekaterinburgOffsetMs).toISOString().slice(0, 10);
}

function formatLocalDate(ms: number) {
  const [year, month, day] = localDateKey(ms).split("-");
  return `${day}.${month}.${year}`;
}
