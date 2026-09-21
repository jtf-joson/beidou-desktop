import { contextBridge, ipcRenderer } from "electron";

const api = {
  workspaceState: (): Promise<Record<string, unknown>> => ipcRenderer.invoke("workspace:state"),
  openWorkspace: (): Promise<Record<string, unknown>> => ipcRenderer.invoke("workspace:open"),
  search: (q: string): Promise<{ hits: unknown[] }> => ipcRenderer.invoke("semantics:search", q),
  listSemantics: (kind: string): Promise<{ items: unknown[] }> => ipcRenderer.invoke("semantics:list", kind),
  auditTail: (n: number): Promise<unknown[]> => ipcRenderer.invoke("audit:tail", n),
  listSkills: (): Promise<{ skills: Array<{ name: string; content: string }> }> => ipcRenderer.invoke("skills:list"),
  readConfig: (): Promise<{ ok: boolean; text?: string }> => ipcRenderer.invoke("config:read"),
  saveConfig: (text: string): Promise<{ ok: boolean }> => ipcRenderer.invoke("config:save", text),
  testConfig: (): Promise<{ ok: boolean; results: Record<string, unknown> }> => ipcRenderer.invoke("config:test"),
  modelRead: (): Promise<{ ok: boolean; provider?: string; baseUrl?: string; model?: string; keyConfigured?: boolean; keySource?: "auth_token" | "env" | "none"; envVar?: string | null }> =>
    ipcRenderer.invoke("model:read"),
  modelSave: (patch: { baseUrl?: string; model?: string; apiKey?: string }): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("model:save", patch),
  modelTest: (): Promise<{ ok: boolean; message?: string }> => ipcRenderer.invoke("model:test"),
  whoami: (): Promise<{ identity: unknown }> => ipcRenderer.invoke("identity:whoami"),
  authState: (): Promise<Record<string, unknown>> => ipcRenderer.invoke("auth:state"),
  authLogin: (): Promise<{ ok: boolean; error?: string; loginUrl?: string; userName?: string }> =>
    ipcRenderer.invoke("auth:login"),
  authRefresh: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("auth:refresh"),
  listSpaces: (): Promise<Array<{ id: string; name: string; dir: string }>> => ipcRenderer.invoke("spaces:list"),
  switchSpace: (id: string): Promise<Record<string, unknown>> => ipcRenderer.invoke("spaces:switch", id),
  createSpace: (name: string): Promise<Record<string, unknown>> => ipcRenderer.invoke("spaces:create", name),
  removeSpace: (id: string): Promise<Record<string, unknown>> => ipcRenderer.invoke("spaces:remove", id),
  importSpace: (): Promise<Record<string, unknown>> => ipcRenderer.invoke("spaces:import"),
  readMembers: (): Promise<{ ok: boolean; text?: string }> => ipcRenderer.invoke("members:read"),
  saveMembers: (text: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("members:save", text),
  readGlossary: (): Promise<{ ok: boolean; text?: string }> => ipcRenderer.invoke("glossary:read"),
  saveGlossary: (text: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("glossary:save", text),
  importSemantics: (): Promise<{ ok: boolean; copied?: number; error?: string }> => ipcRenderer.invoke("semantics:import"),
  loadDemoSemantics: (): Promise<{ ok: boolean; copied?: number; error?: string }> => ipcRenderer.invoke("semantics:loadDemo"),
  listKnowledge: (): Promise<Array<{ name: string; content: string }>> => ipcRenderer.invoke("knowledge:list"),
  saveKnowledge: (name: string, content: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("knowledge:save", name, content),
  listPlaybooks: (): Promise<Array<{ name: string; content: string }>> => ipcRenderer.invoke("playbook:list"),
  savePlaybook: (name: string, content: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("playbook:save", name, content),
  readEntities: (): Promise<{ ok: boolean; text?: string }> => ipcRenderer.invoke("entities:read"),
  saveEntities: (text: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("entities:save", text),
  saveSkill: (name: string, content: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("skills:save", name, content),
  toggleSkill: (name: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("skills:toggle", name, enabled),
  sessionList: (): Promise<Array<{ id: string; title: string; lastTs: string; messageCount: number }>> => ipcRenderer.invoke("session:list"),
  sessionRead: (id: string): Promise<Array<Record<string, unknown>>> => ipcRenderer.invoke("session:read", id),
  sessionDelete: (id: string): Promise<{ ok: boolean }> => ipcRenderer.invoke("session:delete", id),
  sessionImport: (id: string, bubbles: unknown): Promise<{ ok: boolean; count: number }> => ipcRenderer.invoke("session:import", id, bubbles),
  exportReport: (markdown: string): Promise<{ ok: boolean; file?: string; error?: string }> => ipcRenderer.invoke("report:export", markdown),
  dshAttach: (rect: { x: number; y: number; width: number; height: number }): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("dsh:attach", rect),
  dshBounds: (rect: { x: number; y: number; width: number; height: number }): Promise<void> =>
    ipcRenderer.invoke("dsh:bounds", rect),
  dshHide: (): Promise<void> => ipcRenderer.invoke("dsh:hide"),
  onDshRestart: (cb: (payload: { workspaceDir?: string; crashed?: boolean }) => void): (() => void) => {
    const listener = (_e: unknown, payload: { workspaceDir?: string; crashed?: boolean }) => cb(payload);
    ipcRenderer.on("dsh:restart", listener);
    return () => ipcRenderer.removeListener("dsh:restart", listener);
  },
};

contextBridge.exposeInMainWorld("daw", api);
export type DawApi = typeof api;
