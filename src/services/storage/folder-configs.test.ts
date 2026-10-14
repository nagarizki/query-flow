import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_SPLIT_COLUMN, loadFolderConfigs, resolveFolderConfig, saveFolderConfigs } from ".";
import type { StoredFolderConfig } from ".";

function stubStorage(stored: Record<string, unknown>) {
  vi.stubGlobal("chrome", { storage: { local: {
    get: async () => structuredClone(stored),
    set: async (values: Record<string, unknown>) => { Object.assign(stored, structuredClone(values)); },
  } } });
}

afterEach(() => { vi.unstubAllGlobals(); });

it("defaults folders without stored config to hemat-request ON", () => {
  expect(resolveFolderConfig(undefined)).toEqual({ hematRequest: true, splitColumn: DEFAULT_SPLIT_COLUMN });
  expect(resolveFolderConfig({})).toEqual({ hematRequest: true, splitColumn: DEFAULT_SPLIT_COLUMN });
  expect(resolveFolderConfig({ hematRequest: false })).toEqual({ hematRequest: false, splitColumn: DEFAULT_SPLIT_COLUMN });
  expect(resolveFolderConfig({ hematRequest: true, splitColumn: "  kode_kab  " })).toEqual({ hematRequest: true, splitColumn: "kode_kab" });
});

it("round-trips folder configs while dropping invalid entries", async () => {
  const stored: Record<string, unknown> = {};
  stubStorage(stored);
  const configs: Record<string, StoredFolderConfig> = {
    "Agregat/A": { hematRequest: false, splitColumn: "kode_kab" },
    "Agregat/B": {},
  };
  await saveFolderConfigs({ ...configs, "Bad": "yes" as unknown as StoredFolderConfig, "Empty": null as unknown as StoredFolderConfig });
  const restored = await loadFolderConfigs();
  expect(restored).toEqual(configs);
  expect(resolveFolderConfig(restored["Agregat/A"])).toEqual({ hematRequest: false, splitColumn: "kode_kab" });
  expect(resolveFolderConfig(restored["Agregat/B"])).toEqual({ hematRequest: true, splitColumn: DEFAULT_SPLIT_COLUMN });
  expect(resolveFolderConfig(restored["Missing"])).toEqual({ hematRequest: true, splitColumn: DEFAULT_SPLIT_COLUMN });
});

it("returns empty configs for missing or malformed storage", async () => {
  const stored: Record<string, unknown> = {};
  stubStorage(stored);
  expect(await loadFolderConfigs()).toEqual({});
  stored.folderConfigs = ["not", "an", "object"];
  expect(await loadFolderConfigs()).toEqual({});
});
