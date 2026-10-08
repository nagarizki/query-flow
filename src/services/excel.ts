import ExcelJS from "exceljs";
import { Zip, ZipDeflate, ZipPassThrough, strToU8 } from "fflate";

export function colName(n: number): string {
  let s = "";
  let current = n;
  while (current > 0) {
    const m = (current - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    current = Math.floor((current - m) / 26);
  }
  return s;
}

/* eslint-disable no-control-regex */
export function escapeXml(val: string): string {
  return val
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
/* eslint-enable no-control-regex */

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

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="14"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

const RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

export function workbookFilename(path: string): string {
  const folder = path.replace(/\.sql$/i, "").replace(/^\/+|\/+$/g, "") || "Query";
  return `${folder.replace(/[^a-z0-9_-]/gi, "_")}.xlsx`;
}

export async function serializeWorkbook(results: QueryResult[]): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    const zip = new Zip((err, chunk, final) => {
      if (err) {
        reject(err);
        return;
      }
      if (chunk) chunks.push(chunk);
      if (final) {
        const total = chunks.reduce((acc, c) => acc + c.length, 0);
        const out = new Uint8Array(total);
        let offset = 0;
        for (const c of chunks) {
          out.set(c, offset);
          offset += c.length;
        }
        resolve(out);
      }
    });

    const addStatic = (name: string, content: string): void => {
      const file = new ZipPassThrough(name);
      zip.add(file);
      file.push(strToU8(content), true);
    };

    let contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>`;
    let workbookRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`;
    let workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>`;

    const effectiveResults = results.length ? results : [{ filename: "Hasil.sql", title: "Hasil", columns: ["Hasil"], rows: [] }];
    const usedNames: string[] = [];

    effectiveResults.forEach((result, i) => {
      const sheetId = i + 1;
      const rId = `rId${i + 2}`;
      const partPath = `worksheets/sheet${sheetId}.xml`;
      const name = sheetName(result.filename, usedNames, result.title);
      usedNames.push(name);

      contentTypesXml += `<Override PartName="/xl/${partPath}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`;
      workbookRelsXml += `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${partPath}"/>`;
      workbookXml += `<sheet sheetId="${sheetId}" name="${escapeXml(name)}" state="visible" r:id="${rId}"/>`;
    });

    contentTypesXml += `</Types>`;
    workbookRelsXml += `</Relationships>`;
    workbookXml += `</sheets></workbook>`;

    addStatic("[Content_Types].xml", contentTypesXml);
    addStatic("_rels/.rels", RELS_XML);
    addStatic("xl/_rels/workbook.xml.rels", workbookRelsXml);
    addStatic("xl/workbook.xml", workbookXml);
    addStatic("xl/styles.xml", STYLES_XML);

    for (let i = 0; i < effectiveResults.length; i++) {
      const result = effectiveResults[i]!;
      const sheetId = i + 1;
      const sheetFile = new ZipDeflate(`xl/worksheets/sheet${sheetId}.xml`, { level: 6 });
      zip.add(sheetFile);

      const colCount = Math.max(result.columns.length, 1);
      const lastCol = colName(colCount);

      let header = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="2" topLeftCell="A3" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="${colCount}" width="24" customWidth="1"/></cols><sheetData>`;
      header += `<row r="1" s="1"><c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">${escapeXml(result.title)}</t></is></c></row>`;
      header += `<row r="2" s="2">`;
      for (let c = 0; c < result.columns.length; c++) {
        header += `<c r="${colName(c + 1)}2" s="2" t="inlineStr"><is><t xml:space="preserve">${escapeXml(result.columns[c] ?? "")}</t></is></c>`;
      }
      header += `</row>`;
      sheetFile.push(strToU8(header));

      const BATCH_SIZE = 5000;
      let batchXml = "";
      for (let r = 0; r < result.rows.length; r++) {
        const rowNum = r + 3;
        const row = result.rows[r];
        if (!row) continue;
        batchXml += `<row r="${rowNum}">`;
        for (let c = 0; c < row.length; c++) {
          const val = excelValue(row[c]);
          const ref = `${colName(c + 1)}${rowNum}`;
          if (val === null || val === undefined) {
            continue;
          }
          if (typeof val === "number") {
            batchXml += Number.isFinite(val) ? `<c r="${ref}"><v>${val}</v></c>` : `<c r="${ref}" t="e"><v>#NUM!</v></c>`;
          } else if (typeof val === "boolean") {
            batchXml += `<c r="${ref}" t="b"><v>${val ? 1 : 0}</v></c>`;
          } else {
            batchXml += `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(String(val))}</t></is></c>`;
          }
        }
        batchXml += `</row>`;

        if ((r + 1) % BATCH_SIZE === 0) {
          sheetFile.push(strToU8(batchXml));
          batchXml = "";
        }
      }

      if (batchXml.length > 0) {
        sheetFile.push(strToU8(batchXml));
        batchXml = "";
      }

      let footer = `</sheetData>`;
      if (colCount > 1) {
        footer += `<mergeCells count="1"><mergeCell ref="A1:${lastCol}1"/></mergeCells>`;
      }
      footer += `</worksheet>`;
      sheetFile.push(strToU8(footer), true);
    }

    zip.end();
  });
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
