import type { WilayahConfig } from "../../types";
import { regenciesOfProvince, type RegionRegency } from "./regions";

export const DEFAULT_WILAYAH: WilayahConfig = {
  level1: [],
  level2: [],
  splitLevel1: true,
  splitLevel2: true,
};

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateWilayah(value: unknown): ValidationResult {
  const errors: string[] = [];
  if (!value || typeof value !== "object") return { valid: false, errors: ["Konfigurasi wilayah tidak valid."] };
  const candidate = value as Partial<WilayahConfig>;
  validateCodes(candidate.level1, "Level 1", errors);
  validateCodes(candidate.level2, "Level 2", errors);
  if (candidate.splitLevel1 !== undefined && typeof candidate.splitLevel1 !== "boolean") {
    errors.push("Pilihan pisah provinsi harus berupa boolean.");
  }
  if (candidate.splitLevel2 !== undefined && typeof candidate.splitLevel2 !== "boolean") {
    errors.push("Pilihan pisah kabupaten/kota harus berupa boolean.");
  }
  return { valid: errors.length === 0, errors };
}

function validateCodes(value: unknown, label: string, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push(`${label} harus berupa daftar.`);
    return;
  }
  if (value.some((code) => typeof code !== "string" || !/^\d+$/.test(code))) {
    errors.push(`Semua kode ${label} harus berisi angka.`);
  }
  if (new Set(value).size !== value.length) errors.push(`Kode ${label} tidak boleh duplikat.`);
}

export function normalizeWilayah(value: unknown): WilayahConfig | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { level1?: unknown; level2?: unknown; splitLevel1?: unknown; splitLevel2?: unknown };
  const migrated = {
    level1: typeof candidate.level1 === "string"
      ? (candidate.level1.trim() ? [candidate.level1.trim()] : [])
      : candidate.level1,
    level2: candidate.level2,
    splitLevel1: candidate.splitLevel1 === undefined ? true : Boolean(candidate.splitLevel1),
    splitLevel2: candidate.splitLevel2 === undefined ? true : Boolean(candidate.splitLevel2),
  };
  return validateWilayah(migrated).valid ? migrated as WilayahConfig : null;
}

export function addWilayahCode(config: WilayahConfig, level: "level1" | "level2", code: string): WilayahConfig {
  const normalized = code.trim();
  if (!/^\d+$/.test(normalized) || config[level].includes(normalized)) return config;
  return { ...config, [level]: [...config[level], normalized] };
}

// ponytail: level2 takes precedence over level1; add nested regency loops if multi-regency batching is needed.
export function targetProvinceCodes(config: WilayahConfig): (string | null)[] {
  if (config.splitLevel1 === false || config.level2.length > 0 || config.level1.length === 0) return [null];
  const list = config.level1.map((code) => code.trim()).filter(Boolean);
  return list.length > 0 ? list : [null];
}

export function targetRegencyCodes(config: WilayahConfig): (string | null)[] {
  if (config.splitLevel2 === false || config.level2.length === 0) return [null];
  const list = config.level2.map((code) => code.trim()).filter(Boolean);
  return list.length > 0 ? list : [null];
}

export interface WilayahTarget {
  code: string | null;
  kind: "prov" | "kab" | "all";
  label: string;
  config: WilayahConfig;
}

export interface RegencyExpansion {
  /** Regencies resolved from known province codes, in Level 1 order. */
  regencies: RegionRegency[];
  /** Level 1 codes absent from the master data (typo or newer pemekaran). */
  unknownProvinces: string[];
}

/**
 * Resolves Level 1 province codes to their regencies via the bundled BPS master
 * data. ONLY explicitly listed provinces are expanded — never the whole country,
 * since each user can access a different subset of regions.
 */
export function expandProvincesToRegencies(level1: string[]): RegencyExpansion {
  const regencies: RegionRegency[] = [];
  const unknownProvinces: string[] = [];
  for (const code of level1.map((entry) => entry.trim()).filter(Boolean)) {
    const resolved = regenciesOfProvince(code);
    if (resolved.length === 0) unknownProvinces.push(code);
    else regencies.push(...resolved);
  }
  return { regencies, unknownProvinces };
}

/** Summary for UI hints without building full run targets. */
export function describeRegencyExpansion(config: WilayahConfig): RegencyExpansion {
  if (config.level2.length > 0 || config.splitLevel2 === false) return { regencies: [], unknownProvinces: [] };
  return expandProvincesToRegencies(config.level1);
}

/**
 * Single combined config for hemat-request runs: one query carries all
 * selected provinces (pipe-joined by applyWilayahConfig) instead of looping
 * per region. Level 2 passes through untouched; empty filters pass through.
 */
export function combinedWilayahConfig(config: WilayahConfig): WilayahConfig {
  const level1 = config.level1.map((code) => code.trim()).filter(Boolean);
  if (config.level2.length === 0 && level1.length > 0) {
    return { level1, level2: [], splitLevel1: config.splitLevel1, splitLevel2: config.splitLevel2 };
  }
  return { ...config, level1, level2: config.level2.map((code) => code.trim()).filter(Boolean) };
}

export function targetWilayahTargets(config: WilayahConfig): WilayahTarget[] {
  const regencies = targetRegencyCodes(config);
  if (config.level2.length > 0 && !(regencies.length === 1 && regencies[0] === null)) {
    return regencies.map((code) => ({
      code,
      kind: "kab" as const,
      label: code ? `Kab ${code}` : "",
      config: code ? { level1: [], level2: [code], splitLevel1: config.splitLevel1, splitLevel2: config.splitLevel2 } : config,
    }));
  }
  // Auto-expand: kab-split is on but no explicit kab list — resolve regencies
  // from the selected provinces. Finer grain wins over the province loop when
  // both split checkboxes are on; each kab file still belongs to one province.
  if (config.splitLevel2 !== false) {
    const { regencies: expanded, unknownProvinces } = expandProvincesToRegencies(config.level1);
    if (expanded.length > 0 || unknownProvinces.length > 0) {
      const kabTargets = expanded.map((entry) => ({
        code: entry.code as string | null,
        kind: "kab" as const,
        label: `Kab ${entry.code}`,
        config: { level1: [], level2: [entry.code], splitLevel1: config.splitLevel1, splitLevel2: config.splitLevel2 },
      }));
      // Unknown province codes cannot be expanded; run them at province level
      // instead of failing so typos stay visible in the run log.
      const provFallbacks = unknownProvinces.map((code) => ({
        code: code as string | null,
        kind: "prov" as const,
        label: `Provinsi ${code}`,
        config: { level1: [code], level2: [], splitLevel1: config.splitLevel1, splitLevel2: config.splitLevel2 },
      }));
      return [...kabTargets, ...provFallbacks];
    }
  }
  const provinces = targetProvinceCodes(config);
  if (!(provinces.length === 1 && provinces[0] === null)) {
    return provinces.map((code) => ({
      code,
      kind: "prov" as const,
      label: code ? `Provinsi ${code}` : "",
      config: code ? { level1: [code], level2: [], splitLevel1: config.splitLevel1, splitLevel2: config.splitLevel2 } : config,
    }));
  }
  return [{ code: null, kind: "all", label: "", config }];
}

export function targetHematTargets(config: WilayahConfig): WilayahTarget[] {
  if (config.level2.length > 0) {
    const list = config.level2.map((code) => code.trim()).filter(Boolean);
    const code = list.length === 1 ? list[0]! : null;
    return [{
      code,
      kind: code ? "kab" : "all",
      label: code ? `Kab ${code}` : "",
      config: combinedWilayahConfig(config),
    }];
  }
  if (config.splitLevel1 !== false && config.level1.length > 0) {
    const list = config.level1.map((code) => code.trim()).filter(Boolean);
    if (list.length > 0) {
      return list.map((code) => ({
        code,
        kind: "prov" as const,
        label: `Provinsi ${code}`,
        config: { level1: [code], level2: [], splitLevel1: config.splitLevel1, splitLevel2: config.splitLevel2 },
      }));
    }
  }
  const list = config.level1.map((code) => code.trim()).filter(Boolean);
  const singleCode = list.length === 1 ? list[0]! : null;
  return [{
    code: singleCode,
    kind: singleCode ? "prov" : "all",
    label: singleCode ? `Provinsi ${singleCode}` : "",
    config: combinedWilayahConfig(config),
  }];
}
