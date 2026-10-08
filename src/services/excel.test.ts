import { afterEach, expect, it, vi } from "vitest";
import ExcelJS from "exceljs";
import { bigNumberPartsToDecimal, buildWorkbook, sheetName, exportFolder, normalizeCellValue, serializeWorkbook } from "./excel";

it("uses the SQL title directly as the sheet name", () => {
  expect(sheetName("Agregat_1a.sql", [], "Jumlah Usaha")).toBe("Jumlah Usaha");
  expect(sheetName("rantabF_tabel1.sql", [], "Jumlah Tenaga Kerja")).toBe("Jumlah Tenaga Kerja");
  expect(sheetName("Agregat_1a.sql", ["Jumlah Usaha"], "Jumlah Usaha")).toBe("Jumlah Usaha (2)");
  expect(sheetName("x.sql", [], "a".repeat(40))).toHaveLength(31);
  expect(sheetName("Agregat_1a.sql", [])).toBe("Agregat_1a");
});

it("writes the SQL title on row 1 and column headers on row 2", async () => {
  const workbook = buildWorkbook([{ filename: "tabel1.sql", title: "Judul Tabel 1", columns: ["wilayah", "total"], rows: [["3507", 10]] }]);
  const sheet = workbook.worksheets[0];
  expect(sheet?.name).toBe("Judul Tabel 1");
  expect(sheet?.getCell("A1").value).toBe("Judul Tabel 1");
  expect(sheet?.getCell("A2").value).toBe("wilayah");
  expect(sheet?.getCell("B2").value).toBe("total");
});

it("includes titles and keeps truncated worksheet names valid and unique", async () => {
  expect(sheetName("Agregat_1a.sql", [], "Judul Tabel 1a")).toBe("Judul Tabel 1a");
  const title = "Jumlah penduduk menurut wilayah dan kategori";
  const first = sheetName("x_1.sql", [], title);
  const second = sheetName("x_1.sql", [first], title);
  expect(first.length).toBeLessThanOrEqual(31);
  expect(second.length).toBeLessThanOrEqual(31);
  expect(second).not.toBe(first);
  expect(sheetName("x_1.sql", [], "A/B: C? [D]")).not.toMatch(/[\\/*?:[\]]/);
  const workbook = buildWorkbook([{ filename: "x_1.sql", title, columns: ["n"], rows: [[1]] }]);
  await expect(workbook.xlsx.writeBuffer()).resolves.toBeDefined();
  expect(workbook.worksheets[0]?.getCell("A1").value).toBe(title);
});

it("converts serialized high-precision numbers instead of writing JSON", () => {
  expect(bigNumberPartsToDecimal({ c: [1592650473717], e: 13, s: 1 })).toBe("15926504737170");
  expect(bigNumberPartsToDecimal({ c: [123, 45600000000000], e: 2, s: 1 })).toBe("123.456");
  expect(bigNumberPartsToDecimal({ c: [12], e: -3, s: -1 })).toBe("-0.0012");

  expect(normalizeCellValue({ c: [9921520318842], e: 12, s: 1 })).toBe(9921520318842);
  expect(normalizeCellValue('{"c":[9921520318842],"e":12,"s":1}')).toBe(9921520318842);
  expect(normalizeCellValue({ c: [123, 45600000000000], e: 2, s: 1 })).toBe(123.456);
  expect(normalizeCellValue({ c: [123456, 78901234567890], e: 19, s: 1 })).toBe("12345678901234567890");

  const workbook = buildWorkbook([{
    filename: "omzet.sql",
    title: "Total Omzet",
    columns: ["metrik_total_omzet"],
    rows: [
      [{ c: [1592650473717], e: 13, s: 1 }],
      ['{"c":[9921520318842],"e":12,"s":1}'],
    ],
  }]);
  expect(workbook.worksheets[0]?.getCell("A3").value).toBe(15926504737170);
  expect(workbook.worksheets[0]?.getCell("A4").value).toBe(9921520318842);
});


afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("uses Chrome downloads for automatic parts and reports download rejection", async () => {
  const download = vi.fn().mockResolvedValueOnce(123).mockRejectedValueOnce(new Error("Download rejected"));
  vi.stubGlobal("chrome", { downloads: { download } });
  vi.stubGlobal("window", { setTimeout: vi.fn() });
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
  const results = [{ filename: "a.sql", title: "A", columns: ["id"], rows: [[1]] }];
  await exportFolder("folder_part-001", results);
  expect(download).toHaveBeenCalledWith({ url: "blob:test", filename: "folder_part-001.xlsx", saveAs: false, conflictAction: "uniquify" });
  await expect(exportFolder("folder_partial", results)).rejects.toThrow("Download rejected");
});

it("streams valid OpenXML XLSX with correct types, formatting, and frozen panes", async () => {
  const results = [
    {
      filename: "test1.sql",
      title: "Laporan & Statistik",
      columns: ["id", "nama", "omzet", "aktif"],
      rows: [
        [1, "Toko \"A & B\" <Utama>", 1500000.5, true],
        [2, "Toko C", "12345678901234567890", false],
        [3, null, null, null],
      ],
    },
    {
      filename: "test2.sql",
      title: "Ringkasan",
      columns: ["kode"],
      rows: [["3507"]],
    },
  ];

  const buffer = await serializeWorkbook(results);
  expect(buffer.byteLength).toBeGreaterThan(0);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as Parameters<typeof wb.xlsx.load>[0]);
  expect(wb.worksheets).toHaveLength(2);

  const ws1 = wb.worksheets[0]!;
  expect(ws1.name).toBe("Laporan & Statistik");
  expect(ws1.getCell("A1").value).toBe("Laporan & Statistik");
  expect(ws1.getCell("A2").value).toBe("id");
  expect(ws1.getCell("B2").value).toBe("nama");
  expect(ws1.getCell("A3").value).toBe(1);
  expect(ws1.getCell("B3").value).toBe("Toko \"A & B\" <Utama>");
  expect(ws1.getCell("C3").value).toBe(1500000.5);
  expect(ws1.getCell("D3").value).toBe(true);
  expect(ws1.getCell("C4").value).toBe("12345678901234567890");
  expect(ws1.getCell("B5").value).toBeNull();
  expect((ws1.views[0] as { ySplit?: number } | undefined)?.ySplit).toBe(2);

  const ws2 = wb.worksheets[1]!;
  expect(ws2.name).toBe("Ringkasan");
  expect(ws2.getCell("A3").value).toBe("3507");
});
