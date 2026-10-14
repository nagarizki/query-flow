import type { RepositorySnapshot, WilayahConfig } from "../../types";
import { compareFilenames } from "../../utils/filename-order";
import { validateSnapshot } from "./validation";
import { deserializeSnapshot, serializeSnapshot } from "./serialization";
import { DEFAULT_WILAYAH, normalizeWilayah, validateWilayah } from "../wilayah";

const SNAPSHOT_KEY = "repositorySnapshot";
const WILAYAH_KEY = "wilayahConfig";

export async function loadSnapshot(): Promise<RepositorySnapshot | null> {
  const stored = await chrome.storage.local.get(SNAPSHOT_KEY);
  const value: unknown = stored[SNAPSHOT_KEY];
  const snapshot = deserializeSnapshot(value);
  if (!snapshot) return null;
  const filtered = withoutRoot(snapshot);
  if (filtered.repository.sqlCount !== snapshot.repository.sqlCount) {
    await saveSnapshot(filtered);
  }
  return filtered;
}

export async function saveSnapshot(snapshot: RepositorySnapshot): Promise<void> {
  if (!validateSnapshot(snapshot)) throw new Error("Snapshot repository tidak valid.");
  await chrome.storage.local.set({ [SNAPSHOT_KEY]: serializeSnapshot(withoutRoot(snapshot)) });
}

function withoutRoot(snapshot: RepositorySnapshot): RepositorySnapshot {
  const groups = snapshot.groups.filter((group) => group.path !== "." && group.path !== "")
    .map((group) => ({ ...group, files: [...group.files].sort((a, b) => compareFilenames(a.name, b.name)) }));
  return {
    ...snapshot,
    groups,
    repository: { ...snapshot.repository, sqlCount: groups.reduce((count, group) => count + group.files.length, 0) },
  };
}

export async function loadWilayah(): Promise<WilayahConfig> {
  const stored = await chrome.storage.local.get(WILAYAH_KEY);
  const value: unknown = stored[WILAYAH_KEY];
  const normalized = normalizeWilayah(value);
  if (!normalized) return structuredClone(DEFAULT_WILAYAH);
  if (JSON.stringify(normalized) !== JSON.stringify(value)) {
    await chrome.storage.local.set({ [WILAYAH_KEY]: normalized });
  }
  return normalized;
}

export async function saveWilayah(config: WilayahConfig): Promise<void> {
  const result = validateWilayah(config);
  if (!result.valid) throw new Error(result.errors.join(" "));
  await chrome.storage.local.set({ [WILAYAH_KEY]: config });
}

export const FOLDER_CONFIGS_KEY = "folderConfigs";
export const DEFAULT_SPLIT_COLUMN = "kode_kabupaten";

export const storageKeys = { snapshot: SNAPSHOT_KEY, wilayah: WILAYAH_KEY, folderConfigs: FOLDER_CONFIGS_KEY } as const;

export interface StoredFolderConfig {
  hematRequest?: boolean;
  splitColumn?: string;
}

export interface ResolvedFolderConfig {
  hematRequest: boolean;
  splitColumn: string;
}

/** Hemat-request defaults ON; folders without stored config inherit it. */
export function resolveFolderConfig(stored: StoredFolderConfig | undefined): ResolvedFolderConfig {
  const column = stored?.splitColumn?.trim();
  return {
    hematRequest: stored?.hematRequest ?? true,
    splitColumn: column ? stored!.splitColumn!.trim() : DEFAULT_SPLIT_COLUMN,
  };
}

function normalizeFolderConfigs(value: unknown): Record<string, StoredFolderConfig> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const configs: Record<string, StoredFolderConfig> = {};
  for (const [path, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const candidate = entry as Partial<StoredFolderConfig>;
    const normalized: StoredFolderConfig = {};
    if (typeof candidate.hematRequest === "boolean") normalized.hematRequest = candidate.hematRequest;
    if (typeof candidate.splitColumn === "string" && candidate.splitColumn.trim()) {
      normalized.splitColumn = candidate.splitColumn.trim().slice(0, 64);
    }
    configs[path] = normalized;
  }
  return configs;
}

export async function loadFolderConfigs(): Promise<Record<string, StoredFolderConfig>> {
  const stored = await chrome.storage.local.get(FOLDER_CONFIGS_KEY);
  return normalizeFolderConfigs(stored[FOLDER_CONFIGS_KEY]);
}

export async function saveFolderConfigs(configs: Record<string, StoredFolderConfig>): Promise<void> {
  await chrome.storage.local.set({ [FOLDER_CONFIGS_KEY]: normalizeFolderConfigs(configs) });
}
