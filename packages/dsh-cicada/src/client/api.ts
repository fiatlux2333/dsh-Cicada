import type {
  Configuration,
  Confirmation,
  ConfirmRequest,
  ImportPreview,
  Persona,
  SaveRequest,
  View,
  Visit,
} from '../shared/types.ts';
export interface CicadaClient {
  view(): Promise<View>;
  checkin(): Promise<View>;
  pause(hours: number): Promise<View>;
  resume(): Promise<View>;
  save(request: SaveRequest): Promise<View>;
  safeMode(): Promise<View>;
  stopAutomation(): Promise<View>;
  prepare(kind: 'live' | 'authorize' | 'execute'): Promise<Confirmation>;
  confirm(request: ConfirmRequest): Promise<View>;
  drill(): Promise<View>;
  preview(persona: Persona, days: number): Promise<Visit[]>;
  importPreview(): Promise<ImportPreview>;
  prepareImport(): Promise<Confirmation>;
  resolveInterrupted(id: string, phrase: string): Promise<View>;
  resolveLegacy(
    level: number,
    mode: 'drill' | 'live',
    phrase: string,
    expectedRevision: number,
  ): Promise<View>;
}
export interface Draft {
  config: Configuration;
  revision: number;
  dirty: boolean;
}
