import { describe, expect, it } from "vitest";
import { addWilayahCode, combinedWilayahConfig, describeRegencyExpansion, expandProvincesToRegencies, normalizeWilayah, targetProvinceCodes, targetRegencyCodes, targetWilayahTargets, validateWilayah } from ".";
import { provinceName, regenciesOfProvince } from "./regions";

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

  it("falls back to province targets when kab split is off", () => {
    const targets = targetWilayahTargets({ level1: ["91", "92"], level2: [], splitLevel2: false });
    expect(targets.map((target) => target.code)).toEqual(["91", "92"]);
    expect(targets.map((target) => target.kind)).toEqual(["prov", "prov"]);
  });

  it("auto-expands provinces to regencies when no kab list is given", () => {
    const targets = targetWilayahTargets({ level1: ["91", "92"], level2: [] });
    expect(targets).toHaveLength(13);
    expect(targets.every((target) => target.kind === "kab")).toBe(true);
    expect(targets.map((target) => target.code)).toContain("9101");
    expect(targets.map((target) => target.code)).toContain("9271");
    expect(targets[0]?.config).toEqual({ level1: [], level2: ["9101"], splitLevel1: undefined, splitLevel2: undefined });
  });

  it("expands the full Papua scope to 42 regency targets", () => {
    const targets = targetWilayahTargets({ level1: ["91", "92", "94", "95", "96", "97"], level2: [] });
    expect(targets).toHaveLength(42);
    expect(targets.every((target) => target.kind === "kab")).toBe(true);
  });

  it("runs unknown province codes at province level instead of failing", () => {
    const targets = targetWilayahTargets({ level1: ["99"], level2: [] });
    expect(targets).toHaveLength(1);
    expect(targets[0]?.kind).toBe("prov");
    expect(targets[0]?.code).toBe("99");
    const mixed = targetWilayahTargets({ level1: ["91", "99"], level2: [] });
    expect(mixed.filter((target) => target.kind === "kab")).toHaveLength(7);
    expect(mixed.filter((target) => target.kind === "prov").map((target) => target.code)).toEqual(["99"]);
  });

  it("prefers an explicit kab list over auto-expansion", () => {
    const targets = targetWilayahTargets({ level1: ["91", "92"], level2: ["9101"] });
    expect(targets.map((target) => target.code)).toEqual(["9101"]);
  });

  it("describes the expansion for UI hints", () => {
    expect(describeRegencyExpansion({ level1: ["91"], level2: [] }).regencies).toHaveLength(7);
    expect(describeRegencyExpansion({ level1: ["91"], level2: [], splitLevel2: false }).regencies).toHaveLength(0);
    expect(describeRegencyExpansion({ level1: ["91"], level2: ["9101"] }).regencies).toHaveLength(0);
    expect(expandProvincesToRegencies(["91", "99"]).unknownProvinces).toEqual(["99"]);
  });

  it("exposes BPS master data with Papua codes differing from Kemendagri", () => {
    expect(provinceName("91")).toBe("PAPUA BARAT");
    expect(provinceName("94")).toBe("PAPUA");
    expect(regenciesOfProvince("93")).toEqual([]);
    expect(regenciesOfProvince("97").map((entry) => entry.code)).toEqual(["9701", "9702", "9703", "9704", "9705", "9706", "9707", "9708"]);
  });

  it("merges regencies into a single run when splitLevel2 is off", () => {
    const targets = targetWilayahTargets({ level1: ["35"], level2: ["3507", "3515"], splitLevel2: false });
    expect(targets).toHaveLength(1);
    expect(targets[0]?.code).toBeNull();
    expect(targets[0]?.kind).toBe("all");
  });

  it("combines provinces into one query for hemat-request runs", () => {
    expect(combinedWilayahConfig({ level1: ["35", "32"], level2: [] }))
      .toEqual({ level1: ["35", "32"], level2: [], splitLevel1: undefined, splitLevel2: undefined });
    expect(combinedWilayahConfig({ level1: [" 35 "], level2: [], splitLevel1: false, splitLevel2: true }))
      .toEqual({ level1: ["35"], level2: [], splitLevel1: false, splitLevel2: true });
    expect(combinedWilayahConfig({ level1: ["35"], level2: ["3507"] }))
      .toEqual({ level1: ["35"], level2: ["3507"], splitLevel1: undefined, splitLevel2: undefined });
    expect(combinedWilayahConfig({ level1: [], level2: [] }))
      .toEqual({ level1: [], level2: [], splitLevel1: undefined, splitLevel2: undefined });
  });
});
