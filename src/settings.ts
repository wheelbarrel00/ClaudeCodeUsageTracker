export interface NumberBounds {
  fallback: number;
  min: number;
  max: number;
}

export const REFRESH_INTERVAL_S: NumberBounds = { fallback: 30, min: 5, max: 3600 };
export const LIVE_API_MIN_INTERVAL_S: NumberBounds = { fallback: 180, min: 60, max: 3600 };
export const ACTIVITY_WINDOW_MIN: NumberBounds = { fallback: 15, min: 1, max: 300 };

export function numberSetting(raw: unknown, { fallback, min, max }: NumberBounds): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, raw));
}
