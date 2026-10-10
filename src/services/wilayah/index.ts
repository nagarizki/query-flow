import type { WilayahConfig } from "../../types";

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
