export type Persona = 'worker' | 'student' | 'designer' | 'trader' | 'gamer' | 'lifestyle';
export type Level = 1 | 2 | 3 | 4;
export type RunMode = 'drill' | 'live';
export type RunState = 'pending' | 'started' | 'completed' | 'failed' | 'interrupted' | 'cancelled';
export interface Actions {
  fakeHistory: boolean;
  clearBrowsing: boolean;
  cleanCookies: boolean;
  shredFolders: boolean;
  cleanTraces: boolean;
  cleanEventLogs: boolean;
  uninstallApps: boolean;
}
export interface Settings {
  dryRun: boolean;
  autoTrigger: boolean;
  levels: number[];
  actions: Actions;
  browsers: { chrome: boolean; edge: boolean };
  persona: Persona;
  reminderEnabled: boolean;
  reminderHour: number;
}
export interface Targets {
  folders: string[];
  apps: string[];
  keywords: string[];
}
export interface Configuration extends Settings {
  targets: Targets;
}
export interface CheckinState {
  cycle: string;
  lastCheckin: number;
  pausedUntil: number | null;
  lastObserved: number;
  remindedOn: string;
  reminderPending: boolean;
  legacyLevels: number[];
}
export interface StepResult {
  action: string;
  status: 'completed' | 'skipped' | 'failed';
  count: number;
  detail: string;
}
export interface RunRecord {
  id: string;
  cycle: string;
  revision: number;
  level: number;
  mode: RunMode;
  source: 'manual' | 'automatic' | 'legacy';
  state: RunState;
  createdAt: number;
  finishedAt: number | null;
  steps: StepResult[];
}
export interface LogEntry {
  id: number;
  at: number;
  level: 'info' | 'warning' | 'error';
  text: string;
}
export interface Status {
  lastCheckin: number;
  silenceDays: number;
  level: number;
  nextLevel: number | null;
  remainingDays: number | null;
  pausedUntil: number | null;
  dryRun: boolean;
  autoTrigger: boolean;
  authorized: boolean;
  busy: boolean;
  writable: boolean;
  revision: number;
  clockWarning: boolean;
  secretError: boolean;
  reminderPending: boolean;
  blocked: string;
}
export interface Visit {
  url: string;
  title: string;
  at: number;
  dwellSeconds: number;
  session: number;
}
export interface View {
  status: Status;
  config: Configuration;
  legacyLevels: number[];
  runs: RunRecord[];
  logs: LogEntry[];
}
export interface SaveRequest {
  section: 'rules' | 'targets' | 'history';
  config: Configuration;
  expectedRevision: number;
}
export interface Confirmation {
  token: string;
  kind: 'live' | 'authorize' | 'execute' | 'import';
  summary: string;
  expiresAt: number;
  revision: number;
}
export interface ConfirmRequest {
  token: string;
  phrase: string;
}
export interface ImportPreview {
  config: Configuration;
  lastCheckin: number | null;
  pausedUntil: number | null;
  executedLevels: number[];
  warnings: string[];
}
export interface Document {
  version: 1;
  revision: number;
  settings: Settings;
  encryptedTargets: string;
  state: CheckinState;
  authorization: { hash: string; at: number } | null;
  runs: RunRecord[];
  logs: LogEntry[];
}
