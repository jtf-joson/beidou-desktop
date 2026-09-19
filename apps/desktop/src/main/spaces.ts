/**
 * 空间注册表(userData/spaces.json):多空间管理的持久层。
 * 空间 = 目录 + 注册项;资产隔离见 core/spaces/scope(文件层/资产层/查询层三层)。
 */
import { randomUUID } from "node:crypto";

export interface SpaceEntry {
  id: string;
  name: string;
  dir: string;
  createdAt: string;
}

export interface SpacesRegistry {
  spaces: SpaceEntry[];
  activeId?: string;
}

export const emptyRegistry = (): SpacesRegistry => ({ spaces: [] });

export function loadSpaces(readText: () => string | null): SpacesRegistry {
  const text = readText();
  if (!text) return emptyRegistry();
  try {
    const parsed = JSON.parse(text) as Partial<SpacesRegistry>;
    const spaces = Array.isArray(parsed.spaces)
      ? parsed.spaces.filter(
          (s): s is SpaceEntry =>
            s && typeof s.id === "string" && typeof s.name === "string" && typeof s.dir === "string",
        )
      : [];
    return { spaces, activeId: parsed.activeId };
  } catch {
    return emptyRegistry();
  }
}

export function saveSpaces(registry: SpacesRegistry): string {
  return JSON.stringify(registry, null, 2);
}

export function createSpace(
  registry: SpacesRegistry,
  input: { name: string; dir: string },
  now: () => string,
): { registry: SpacesRegistry; entry: SpaceEntry } {
  const entry: SpaceEntry = {
    id: randomUUID(),
    name: input.name.trim() || "新空间",
    dir: input.dir,
    createdAt: now(),
  };
  return {
    registry: { spaces: [...registry.spaces, entry], activeId: entry.id },
    entry,
  };
}

export function switchSpace(registry: SpacesRegistry, id: string): SpacesRegistry {
  return registry.spaces.some((s) => s.id === id) ? { ...registry, activeId: id } : registry;
}

/** 删除空间只移除注册,不删磁盘目录(数据安全) */
export function removeSpace(registry: SpacesRegistry, id: string): SpacesRegistry {
  const spaces = registry.spaces.filter((s) => s.id !== id);
  const activeId = registry.activeId === id ? spaces[0]?.id : registry.activeId;
  return { spaces, activeId };
}

export function activeSpace(registry: SpacesRegistry): SpaceEntry | undefined {
  return registry.spaces.find((s) => s.id === registry.activeId) ?? registry.spaces[0];
}
