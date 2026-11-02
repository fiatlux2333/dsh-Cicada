import type { Context } from '@deepseek-ai/cordis';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { CicadaEngine } from './engine.ts';
import { readLegacy } from './import.ts';
import type {
  Confirmation,
  ConfirmRequest,
  ImportPreview,
  SaveRequest,
  View,
  Visit,
  Persona,
  Status,
} from '../shared/types.ts';

declare module '@deepseek-ai/cordis' {
  interface Context {
    cicada: CicadaService;
  }
}

/** Owner-only management surface. No method here is exposed as a model tool. */
export class CicadaService extends TypertRemoteService {
  constructor(
    ctx: Context,
    private readonly engine: CicadaEngine,
  ) {
    super(ctx, 'cicada');
  }
  private owner(): string {
    const invocation = this.ctx.invocation;
    if (!invocation || invocation.peer.principal.kind !== 'owner')
      throw new Error('仅本机宿主所有者可管理 Cicada');
    return String(invocation.peer.id);
  }
  @Remote
  async status(): Promise<Status> {
    this.owner();
    return this.engine.status();
  }
  @Remote
  async view(): Promise<View> {
    this.owner();
    return this.engine.view();
  }
  @Remote
  async checkin(): Promise<View> {
    this.owner();
    return this.engine.checkin();
  }
  @Remote
  async pause(hours: number): Promise<View> {
    this.owner();
    return this.engine.pause(hours);
  }
  @Remote
  async resume(): Promise<View> {
    this.owner();
    return this.engine.resume();
  }
  @Remote
  async save(request: SaveRequest): Promise<View> {
    this.owner();
    return this.engine.save(request);
  }
  @Remote
  async safeMode(): Promise<View> {
    this.owner();
    return this.engine.safeMode();
  }
  @Remote
  async stopAutomation(): Promise<View> {
    this.owner();
    return this.engine.stopAutomation();
  }
  @Remote
  async prepare(kind: 'live' | 'authorize' | 'execute'): Promise<Confirmation> {
    const peer = this.owner();
    return this.engine.prepare(kind, peer);
  }
  @Remote
  async confirm(request: ConfirmRequest): Promise<View> {
    const peer = this.owner();
    return this.engine.confirm(request, peer);
  }
  @Remote
  async drill(): Promise<View> {
    this.owner();
    return this.engine.drill();
  }
  @Remote
  async preview(persona: Persona, days: number): Promise<Visit[]> {
    this.owner();
    return this.engine.preview(persona, days);
  }
  @Remote
  async importPreview(): Promise<ImportPreview> {
    this.owner();
    return readLegacy();
  }
  @Remote
  async prepareImport(): Promise<Confirmation> {
    const peer = this.owner();
    return this.engine.prepare('import', peer, await readLegacy());
  }
  @Remote
  async resolveInterrupted(id: string, phrase: string): Promise<View> {
    this.owner();
    return this.engine.resolveInterrupted(id, phrase);
  }
  @Remote
  async resolveLegacy(
    level: number,
    mode: 'drill' | 'live',
    phrase: string,
    expectedRevision: number,
  ): Promise<View> {
    this.owner();
    return this.engine.resolveLegacy(level, mode, phrase, expectedRevision);
  }
}
