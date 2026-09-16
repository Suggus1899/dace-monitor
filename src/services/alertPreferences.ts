export type AlertFrequency = 15 | 30 | 60;

export interface AlertPreferencesSnapshot {
  inscriptionsEnabled: boolean;
  frequency: AlertFrequency;
  quietHoursEnabled: boolean;
}

export function isQuietHour(hour: number): boolean {
  return hour >= 22 || hour < 7;
}
