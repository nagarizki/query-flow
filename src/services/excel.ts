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

function excelValue(value: unknown): string | number | boolean | null {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (isBigNumberParts(value)) return bigNumberPartsToDecimal(value);
  return JSON.stringify(value) ?? String(value);
}

export interface QueryResult {
  filename: string;
  title: string;
  columns: string[];
  rows: unknown[][];
}

function bigNumberToString(c: number[], e: number, s: number): string {
  if (!c.length) return "0";
  let coeff = String(c[0]);
  for (let i = 1; i < c.length; i++) coeff += String(c[i]).padStart(14, "0");
  coeff = coeff.replace(/0+$/, "");
  if (!coeff) return "0";
  let result: string;
  if (e < 0) {
    result = `0.${"0".repeat(-e - 1)}${coeff}`;
  } else if (e + 1 >= coeff.length) {
    result = `${coeff}${"0".repeat(e + 1 - coeff.length)}`;
  } else {
    result = `${coeff.slice(0, e + 1)}.${coeff.slice(e + 1)}`;
  }
  return s < 0 && result !== "0" ? `-${result}` : result;
}

function parseNumeric(str: string): number | string {
  const num = Number(str);
  if (!Number.isFinite(num)) return str;
  const digits = str.replace(/^[-+]/, "").replace(/^0+/, "").replace(".", "").replace(/^0+/, "");
  // ponytail: JS double holds max 15 significant digits; string avoids precision loss in Excel.
  return digits.length <= 15 ? num : str;
}

export function normalizeCellValue(value: unknown): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.startsWith('{"') && value.includes('"c"') && value.includes('"e"') && value.includes('"s"')) {
      try {
        const obj = JSON.parse(value);
        if (Array.isArray(obj.c) && typeof obj.e === "number" && typeof obj.s === "number") {
          return parseNumeric(bigNumberToString(obj.c, obj.e, obj.s));
        }
      } catch { /* ignore non-JSON */ }
    }
    return value;
  }
  if (typeof value === "bigint") {
    const num = Number(value);
    return Number.isSafeInteger(num) ? num : value.toString();
  }
  if (typeof value === "object") {
    const obj = value as { s?: number; e?: number; c?: number[]; toString?: () => string };
    if (Array.isArray(obj.c) && typeof obj.e === "number" && typeof obj.s === "number") {
      const str = typeof obj.toString === "function" && obj.toString !== Object.prototype.toString
        ? obj.toString()
        : bigNumberToString(obj.c, obj.e, obj.s);
      return parseNumeric(str);
    }
    if (typeof obj.toString === "function" && obj.toString !== Object.prototype.toString) {
      const str = obj.toString();
      if (str !== "[object Object]") return str;
    }
    return JSON.stringify(value);
  }
  return value;
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
  const folder = path.replace(/^\/+|\/+$/g, "") || "Query";
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
