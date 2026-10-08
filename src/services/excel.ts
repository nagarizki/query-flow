import ExcelJS from "exceljs";

export function sheetName(filename: string, used: string[], title = ""): string {
  const fallback = filename.replace(/\.sql$/i, "").trim() || "Hasil";
  const base = (title.trim() || fallback)
    .replace(/[\\/*?:[\]]/g, " ").replace(/\s+/g, " ")
    .slice(0, 31).replace(/'+$/g, "").trimEnd();
  let name = base;
  let index = 2;
  while (used.some((value) => value.toLowerCase() === name.toLowerCase())) {
    const tail = ` (${index++})`;
    name = base.slice(0, 31 - tail.length) + tail;
  }
  return name;
}

type BigNumberParts = { c: number[]; e: number; s: number };

function isBigNumberParts(value: unknown): value is BigNumberParts {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<BigNumberParts>;
  return Array.isArray(candidate.c)
    && candidate.c.length > 0
    && candidate.c.every((part) => Number.isSafeInteger(part) && part >= 0)
    && Number.isInteger(candidate.e)
    && (candidate.s === 1 || candidate.s === -1);
}

/** Converts the serialized internal representation used by bignumber.js to an exact decimal string. */
export function bigNumberPartsToDecimal(value: BigNumberParts): string {
  const digits = value.c
    .map((part, index) => index === 0 ? String(part) : String(part).padStart(14, "0"))
    .join("");
  const decimalPosition = value.e + 1;
  let result: string;

  if (decimalPosition <= 0) {
    result = `0.${"0".repeat(-decimalPosition)}${digits}`.replace(/0+$/, "").replace(/\.$/, "");
  } else if (decimalPosition >= digits.length) {
    result = digits + "0".repeat(decimalPosition - digits.length);
  } else {
    const integer = digits.slice(0, decimalPosition);
    const fraction = digits.slice(decimalPosition).replace(/0+$/, "");
    result = fraction ? `${integer}.${fraction}` : integer;
  }

  return value.s < 0 && !/^0(?:\.0*)?$/.test(result) ? `-${result}` : result;
}

export function parseNumeric(str: string): number | string {
  const num = Number(str);
  if (!Number.isFinite(num)) return str;
  const digits = str.replace(/^[-+]/, "").replace(/^0+/, "").replace(".", "").replace(/^0+/, "");
  // ponytail: JS double holds max 15 significant digits; string avoids precision loss in Excel.
  return digits.length <= 15 ? num : str;
}

export function excelValue(value: unknown): string | number | boolean | null {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.startsWith('{"') && value.includes('"c"') && value.includes('"e"') && value.includes('"s"')) {
      try {
        const obj = JSON.parse(value);
        if (isBigNumberParts(obj)) return parseNumeric(bigNumberPartsToDecimal(obj));
      } catch { /* ignore non-JSON */ }
    }
    return value;
  }
  if (typeof value === "bigint") {
    const num = Number(value);
    return Number.isSafeInteger(num) ? num : value.toString();
  }
  if (isBigNumberParts(value)) return parseNumeric(bigNumberPartsToDecimal(value));
  if (typeof value === "object") {
    const obj = value as { toString?: () => string };
    if (typeof obj.toString === "function" && obj.toString !== Object.prototype.toString) {
      const str = obj.toString();
      if (str !== "[object Object]") return parseNumeric(str);
    }
    return JSON.stringify(value);
  }
  return String(value);
}

export const normalizeCellValue = excelValue;

export interface QueryResult {
  filename: string;
  title: string;
  columns: string[];
  rows: unknown[][];
}

export function buildWorkbook(results: QueryResult[]): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  const used: string[] = [];
  for (const result of results) {
    const name = sheetName(result.filename, used, result.title);
    used.push(name);
    const sheet = workbook.addWorksheet(name);
    sheet.addRow([result.title]);
    if (result.columns.length > 1) sheet.mergeCells(1, 1, 1, result.columns.length);
    sheet.getRow(1).font = { bold: true, size: 14 };
    sheet.addRow(result.columns);
    for (const row of result.rows) sheet.addRow(row.map(excelValue));
    sheet.getRow(2).font = { bold: true };
    sheet.views = [{ state: "frozen", ySplit: 2 }];
    sheet.columns.forEach((column) => { column.width = 24; });
  }
  return workbook;
}

export function workbookFilename(path: string): string {
  const folder = path.replace(/\.sql$/i, "").replace(/^\/+|\/+$/g, "") || "Query";
  return `${folder.replace(/[^a-z0-9_-]/gi, "_")}.xlsx`;
}

export async function serializeWorkbook(results: QueryResult[]): Promise<Uint8Array> {
  const workbook = buildWorkbook(results);
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

export async function exportFolder(path: string, results: QueryResult[]): Promise<void> {
  await downloadWorkbook(path, await serializeWorkbook(results));
}

export async function downloadWorkbook(path: string, buffer: Uint8Array): Promise<void> {
  const url = URL.createObjectURL(new Blob([new Uint8Array(buffer)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  try {
    await chrome.downloads.download({ url, filename: workbookFilename(path), saveAs: false, conflictAction: "uniquify" });
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
