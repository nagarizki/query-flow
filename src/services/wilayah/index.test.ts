import { describe, expect, it } from "vitest";
import { addWilayahCode, normalizeWilayah, targetProvinceCodes, targetRegencyCodes, targetWilayahTargets, validateWilayah } from ".";

describe("wilayah validation", () => {
  it("accepts numeric level 1 and zero or more unique level 2 codes", () => {
    expect(validateWilayah({ level1: [], level2: [] }).valid).toBe(true);
    expect(validateWilayah({ level1: ["32", "35"], level2: ["3507", "3515"] }).valid).toBe(true);
  });

  it("rejects missing, non-numeric, and duplicate values", () => {
    expect(validateWilayah({ level1: "", level2: [] }).valid).toBe(false);
    expect(validateWilayah({ level1: ["ID"], level2: [] }).valid).toBe(false);
    expect(validateWilayah({ level1: ["35", "35"], level2: [] }).valid).toBe(false);
    expect(validateWilayah({ level1: ["35"], level2: ["3507", "3507"] }).valid).toBe(false);
    expect(validateWilayah({ level1: ["35"], level2: ["35-07"] }).valid).toBe(false);
    expect(validateWilayah({ level1: [], level2: [], splitLevel2: "yes" }).valid).toBe(false);
  });

  it("prevents duplicate additions", () => {
    const config = { level1: ["35"], level2: ["3507"] };
    expect(addWilayahCode(config, "level2", "3507")).toBe(config);
    expect(addWilayahCode(config, "level2", "3515").level2).toEqual(["3507", "3515"]);
    expect(addWilayahCode(config, "level1", "32").level1).toEqual(["35", "32"]);
  });

  it("migrates the previous single-province storage format", () => {
    expect(normalizeWilayah({ level1: "35", level2: ["3507"] })).toEqual({ level1: ["35"], level2: ["3507"], splitLevel1: true, splitLevel2: true });
  });

  it("migrates stored configs without splitLevel2 to split per kabupaten/kota", () => {
    expect(normalizeWilayah({ level1: ["35"], level2: ["3507"], splitLevel1: false })).toEqual({ level1: ["35"], level2: ["3507"], splitLevel1: false, splitLevel2: true });
  });

  it("extracts target provinces for sequential execution or falls back to single run", () => {
    expect(targetProvinceCodes({ level1: [], level2: [] })).toEqual([null]);
    expect(targetProvinceCodes({ level1: ["91", "92"], level2: [] })).toEqual(["91", "92"]);
    expect(targetProvinceCodes({ level1: ["91", "92"], level2: [], splitLevel1: false })).toEqual([null]);
    expect(targetProvinceCodes({ level1: ["91", "92"], level2: ["9101"] })).toEqual([null]);
    expect(targetProvinceCodes({ level1: ["   "], level2: [] })).toEqual([null]);
  });

  it("extracts target regencies for sequential execution or falls back to single run", () => {
    expect(targetRegencyCodes({ level1: [], level2: [] })).toEqual([null]);
    expect(targetRegencyCodes({ level1: [], level2: ["3507", "3515"] })).toEqual(["3507", "3515"]);
    expect(targetRegencyCodes({ level1: [], level2: ["3507", "3515"], splitLevel2: false })).toEqual([null]);
    expect(targetRegencyCodes({ level1: ["35"], level2: [] })).toEqual([null]);
    expect(targetRegencyCodes({ level1: [], level2: ["   "] })).toEqual([null]);
  });

  it("prioritizes regency targets over province targets", () => {
    const targets = targetWilayahTargets({ level1: ["35", "32"], level2: ["3507", "3515"] });
    expect(targets.map((target) => target.code)).toEqual(["3507", "3515"]);
    expect(targets.map((target) => target.kind)).toEqual(["kab", "kab"]);
    expect(targets[0]?.config).toEqual({ level1: [], level2: ["3507"], splitLevel1: undefined, splitLevel2: undefined });
    expect(targets[0]?.label).toBe("Kab 3507");
  });

  it("falls back to province targets when no regency is selected", () => {
    const targets = targetWilayahTargets({ level1: ["91", "92"], level2: [] });
    expect(targets.map((target) => target.code)).toEqual(["91", "92"]);
    expect(targets.map((target) => target.kind)).toEqual(["prov", "prov"]);
  });

  it("merges regencies into a single run when splitLevel2 is off", () => {
    const targets = targetWilayahTargets({ level1: ["35"], level2: ["3507", "3515"], splitLevel2: false });
    expect(targets).toHaveLength(1);
    expect(targets[0]?.code).toBeNull();
    expect(targets[0]?.kind).toBe("all");
  });
});
