import { describe, expect, it, vi } from "vitest";
import { resolveSplitColumnIndex, SplitAfterExport, validateSplitColumnInput } from "./split-export";
import type { QueryResult } from "./excel";

const result = (filename: string, columns: string[], rows: unknown[][]): QueryResult => ({ filename, title: filename, columns, rows });
const serialize = async (results: QueryResult[]): Promise<Uint8Array> => new TextEncoder().encode(JSON.stringify(results));

function setup(options: { keepCombined?: boolean } = {}) {
  const saved: { path: string; results: QueryResult[] }[] = [];
  const download = vi.fn(async (path: string, buffer: Uint8Array) => {
    saved.push({ path, results: JSON.parse(new TextDecoder().decode(buffer)) as QueryResult[] });
  });
  const output = new SplitAfterExport("20261014_1432_DBNAS", "kode_kab", { serialize, download, ...options });
  return { output, saved, download };
}

describe("split column resolution", () => {
  it("matches headers case-insensitively and trims whitespace", () => {
    expect(resolveSplitColumnIndex([" KODE_KAB ", "nilai"], "kode_kab", "a.sql")).toBe(0);
    expect(resolveSplitColumnIndex(["kab", "nilai"], " KAB ", "a.sql")).toBe(0);
  });

  it("resolves the first matching candidate when multiple identifiers are configured", () => {
    const multi = "level_2_full_code, kode_kabkot, kode_kab";
    expect(resolveSplitColumnIndex(["level_2_full_code", "nilai"], multi, "q1.sql")).toBe(0);
    expect(resolveSplitColumnIndex(["kode_kabkot", "nilai"], multi, "q2.sql")).toBe(0);
    expect(resolveSplitColumnIndex(["id", "kode_kab"], multi, "q3.sql")).toBe(1);
  });

  it("fails when none of the candidates match", () => {
    expect(() => resolveSplitColumnIndex(["id", "nilai"], "level_2_full_code, kode_kabkot", "q.sql"))
      .toThrow(/level_2_full_code, kode_kabkot.*q\.sql.*id, nilai/i);
  });

  it("fails when the header is absent or ambiguous", () => {
    expect(() => resolveSplitColumnIndex(["kab", "nilai"], "kategori", "c.sql"))
      .toThrow(/kategori.*c\.sql.*kab, nilai/i);
    expect(() => resolveSplitColumnIndex(["kab", " KAB "], "kab", "c.sql"))
      .toThrow(/ambigu.*c\.sql/i);
  });

  it("rejects an empty column input", () => {
    expect(validateSplitColumnInput("   ")).toMatch(/kolom/i);
    expect(validateSplitColumnInput("kode_kab")).toBeNull();
  });

  it("rejects an empty column in the constructor", () => {
    expect(() => new SplitAfterExport("base", "  ", { serialize })).toThrow(/kolom/i);
  });
});

describe("split-after export", () => {
  it("groups by column value across pages and SQL files", async () => {
    const { output, saved } = setup();
    await output.append(result("q1.sql", ["kode_kab", "nilai"], [["3507", 1], ["9708", 2]]));
    await output.append(result("q1.sql", ["KODE_KAB", "nilai"], [["3507", 3]]));
    await output.append(result("q2.sql", ["kode_kab", "nilai"], [["3507", 4]]));
    expect(output.totalRows).toBe(4);
    expect(output.groupCount).toBe(2);
    await output.flush(true);
    expect(saved).toHaveLength(2);
    const group3507 = saved.find((entry) => entry.path.includes("3507"));
    expect(group3507?.results).toEqual([
      result("q1.sql", ["kode_kab", "nilai"], [["3507", 1], ["3507", 3]]),
      result("q2.sql", ["kode_kab", "nilai"], [["3507", 4]]),
    ]);
  });

  it("keeps null and blank values in the same explicit group", async () => {
    const { output, saved } = setup();
    await output.append(result("q.sql", ["kode_kab", "nilai"], [[null, 1], ["  ", 2]]));
    await output.flush(true);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.path).toContain("blank");
    expect(saved[0]?.results[0]?.rows).toHaveLength(2);
  });

  it("saves a file unsplit instead of aborting when the split column is absent", async () => {
    const saved: { path: string; results: QueryResult[] }[] = [];
    const download = vi.fn(async (path: string, buffer: Uint8Array) => {
      saved.push({ path, results: JSON.parse(new TextDecoder().decode(buffer)) as QueryResult[] });
    });
    const onFallback = vi.fn();
    const output = new SplitAfterExport("20261014_1432_DBNAS", "kode_kab", { serialize, download, onFallback });
    await output.append(result("q1.sql", ["kode_kab", "nilai"], [["3507", 1]]));
    await expect(output.append(result("q3.sql", ["kab", "nilai"], [["3507", 2]]))).resolves.toBeUndefined();
    expect(onFallback).toHaveBeenCalledWith(expect.stringMatching(/q3\.sql/));
    await output.flush(true);
    expect(saved.some((entry) => entry.path.includes("unsplit"))).toBe(true);
    expect(saved.find((entry) => entry.path.includes("unsplit"))?.results[0]?.rows).toEqual([["3507", 2]]);
    expect(output.totalRows).toBe(2);
  });

  it("rejects changing headers during pagination of the same file", async () => {
    const { output } = setup();
    await output.append(result("q1.sql", ["kode_kab", "nilai"], [["3507", 1]]));
    await expect(output.append(result("q1.sql", ["kode_kab", "other"], [["3507", 2]]))).rejects.toThrow(/berubah.*q1\.sql/i);
  });

  it("gives each group stable collision-free paths", async () => {
    const { output, saved } = setup();
    await output.append(result("q.sql", ["kode_kab", "nilai"], [["A ", 1], ["a", 2]]));
    await output.flush(true);
    expect(saved).toHaveLength(2);
    expect(saved[0]?.path).not.toBe(saved[1]?.path);
    expect(saved.every((entry) => entry.path.startsWith("20261014_1432_DBNAS_"))).toBe(true);
  });

  it("keeps and downloads combined workbook alongside groups when keepCombined is true", async () => {
    const { output, saved } = setup({ keepCombined: true });
    await output.append(result("q1.sql", ["kode_kab", "nilai"], [["3507", 1], ["9708", 2]]));
    expect(output.totalRows).toBe(2);
    expect(output.groupCount).toBe(2);
    await output.flush(true);
    expect(saved).toHaveLength(3);
    const combined = saved.find((entry) => entry.path === "20261014_1432_DBNAS");
    expect(combined?.results[0]?.rows).toEqual([["3507", 1], ["9708", 2]]);
    const group3507 = saved.find((entry) => entry.path.includes("3507"));
    expect(group3507?.results[0]?.rows).toEqual([["3507", 1]]);
    const group9708 = saved.find((entry) => entry.path.includes("9708"));
    expect(group9708?.results[0]?.rows).toEqual([["9708", 2]]);
    expect(output.parts).toBe(3);
  });
});
