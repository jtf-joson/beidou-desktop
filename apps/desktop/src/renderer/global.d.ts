/// <reference types="react" />

interface DawApi {
  workspaceState(): Promise<Record<string, unknown>>;
  openWorkspace(): Promise<Record<string, unknown>>;
  search(q: string): Promise<{ hits: unknown[] }>;
  listSemantics(kind: string): Promise<{ items: unknown[] }>;
  auditTail(n: number): Promise<unknown[]>;
  listSkills(): Promise<{ skills: Array<{ name: string; content: string; enabled: boolean }> }>;
  readConfig(): Promise<{ ok: boolean; text?: string }>;
  saveConfig(text: string): Promise<{ ok: boolean }>;
  testConfig(): Promise<{ ok: boolean; results: Record<string, unknown> }>;
  whoami(): Promise<{ identity: unknown }>;
  authState(): Promise<Record<string, unknown>>;
  authLogin(): Promise<{ ok: boolean; error?: string; loginUrl?: string; userName?: string }>;
  authRefresh(): Promise<{ ok: boolean; error?: string }>;
  listSpaces(): Promise<Array<{ id: string; name: string; dir: string }>>;
  switchSpace(id: string): Promise<Record<string, unknown>>;
  createSpace(name: string): Promise<Record<string, unknown>>;
  removeSpace(id: string): Promise<Record<string, unknown>>;
  importSpace(): Promise<Record<string, unknown>>;
  readMembers(): Promise<{ ok: boolean; text?: string }>;
  importSemantics(): Promise<{ ok: boolean; copied?: number; error?: string }>;
  loadDemoSemantics(): Promise<{ ok: boolean; copied?: number; error?: string }>;
  readGlossary(): Promise<{ ok: boolean; text?: string }>;
  saveGlossary(text: string): Promise<{ ok: boolean; error?: string }>;
  saveSkill(name: string, content: string): Promise<{ ok: boolean; error?: string }>;
  toggleSkill(name: string, enabled: boolean): Promise<{ ok: boolean; error?: string }>;
  sessionList(): Promise<Array<{ id: string; title: string; lastTs: string; messageCount: number }>>;
  sessionRead(id: string): Promise<Record<string, unknown>[]>;
  sessionDelete(id: string): Promise<{ ok: boolean }>;
  sessionImport(id: string, bubbles: unknown): Promise<{ ok: boolean; count: number }>;
  exportReport(markdown: string): Promise<{ ok: boolean; file?: string; error?: string }>;
  listKnowledge(): Promise<Array<{ name: string; content: string }>>;
  saveKnowledge(name: string, content: string): Promise<{ ok: boolean; error?: string }>;
  listPlaybooks(): Promise<Array<{ name: string; content: string }>>;
  savePlaybook(name: string, content: string): Promise<{ ok: boolean; error?: string }>;
  readEntities(): Promise<{ ok: boolean; text?: string }>;
  saveEntities(text: string): Promise<{ ok: boolean; error?: string }>;
  saveMembers(text: string): Promise<{ ok: boolean; error?: string }>;
  send(sessionId: string, text: string): Promise<{ ok: boolean; error?: string }>;
  onAgentEvent(cb: (payload: { sessionId: string; ev: unknown }) => void): () => void;
}

declare global {
  interface Window {
    daw: DawApi;
  }
}

export {};
