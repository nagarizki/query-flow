import { ChunkedExport, MAX_BUFFERED_ROWS } from "./chunked-export";
import { downloadWorkbook, serializeWorkbook, type QueryResult } from "./excel";

type WorkbookSerialize = (results: QueryResult[]) => Promise<Uint8Array>;
type WorkbookDownload = (path: string, buffer: Uint8Array) => Promise<void>;

/** Shared sink for runOneFile/finishPartial: satisfied by ChunkedExport too. */
export interface FolderExportOutput {
  readonly totalRows: number;
  readonly parts: number;
  append(result: QueryResult): Promise<void>;
  readonly needsIntermediateFlush: boolean;
  flushIntermediate(onStatus?: (message: string) => void): Promise<boolean>;
  flush(final: boolean, partial?: boolean): Promise<void>;
}

export interface SplitAfterExportOptions {
  maxWorkbookBytes?: number;
  serialize?: WorkbookSerialize;
  download?: WorkbookDownload;
  keepCombined?: boolean;
}

export function validateSplitColumnInput(column: string): string | null {
  const candidates = column.split(",").map((item) => item.trim()).filter(Boolean);
  if (candidates.length === 0) return "Isi nama kolom untuk memisahkan hasil per kabupaten/kota.";
  return null;
}

export function resolveSplitColumnIndex(columns: string[], requested: string, filename: string): number {
  const candidates = requested
    .split(",")
    .map((item) => item.trim().toLocaleLowerCase())
    .filter(Boolean);
  const normalizedCols = columns.map((column) => column.trim().toLocaleLowerCase());

  for (const candidate of candidates) {
    const matches = normalizedCols.flatMap((column, index) => (column === candidate ? [index] : []));
    if (matches.length > 1) {
      throw new Error(`Kolom pembagi "${candidate}" ambigu pada ${filename}; header hasil mengandung nama duplikat.`);
    }
    if (matches.length === 1) {
      return matches[0]!;
    }
  }

  // ponytail: langsung throw; upgrade ke fallback simpan un-split jika user minta batch lanjut tanpa henti
  const available = columns.length ? columns.join(", ") : "(tidak ada)";
  const requestedLabel = candidates.length > 1 ? `[${candidates.join(", ")}]` : `"${candidates[0] ?? requested.trim()}"`;
  throw new Error(`Kolom pembagi ${requestedLabel} tidak ditemukan pada ${filename}. Header tersedia: ${available}.`);
}

function valueIdentity(value: unknown): unknown[] {
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) return ["blank"];
  if (typeof value === "string") return ["string", value];
  if (typeof value === "number") return ["number", Number.isNaN(value) ? "NaN" : String(value)];
  if (typeof value === "boolean") return ["boolean", value];
  if (typeof value === "bigint") return ["bigint", value.toString()];
  try {
    return ["object", JSON.stringify(value) ?? String(value)];
  } catch {
    return ["object", String(value)];
  }
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) return "(blank)";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function slug(value: string): string {
  const normalized = value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  return normalized.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "blank";
}

function hashKey(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).padStart(7, "0");
}

/**
 * Routes result rows into one ChunkedExport per distinct column value and
 * downloads plain .xlsx files (no ZIP). Each group keeps the 300MB/_part-NNN
 * splitting and fflate streaming of ChunkedExport.
 */
export class SplitAfterExport implements FolderExportOutput {
  private readonly column: string;
  private readonly groups = new Map<string, { output: ChunkedExport; label: string }>();
  private readonly usedPaths = new Set<string>();
  private readonly indexesByFile = new Map<string, { headers: string[]; index: number }>();
  private readonly basePath: string;
  private readonly maxWorkbookBytes?: number;
  private readonly serialize: WorkbookSerialize;
  private readonly download: WorkbookDownload;
  // ponytail: combinedOutput mirrors ChunkedExport; drop if combined file is split client-side by caller.
  private readonly combinedOutput?: ChunkedExport;
  private collectedRows = 0;

  constructor(basePath: string, column: string, options: SplitAfterExportOptions = {}) {
    const error = validateSplitColumnInput(column);
    if (error) throw new Error(error);
    this.basePath = basePath;
    this.column = column.trim();
    this.maxWorkbookBytes = options.maxWorkbookBytes;
    this.serialize = options.serialize ?? serializeWorkbook;
    this.download = options.download ?? downloadWorkbook;
    if (options.keepCombined) {
      this.combinedOutput = new ChunkedExport(basePath, this.download, this.maxWorkbookBytes, this.serialize);
    }
  }

  get totalRows(): number {
    return this.collectedRows;
  }

  get groupCount(): number {
    return this.groups.size;
  }

  get parts(): number {
    let total = this.combinedOutput ? this.combinedOutput.parts : 0;
    for (const group of this.groups.values()) total += group.output.parts;
    return total;
  }

  /** Rows held in memory across all groups, not yet downloaded. */
  get bufferedRows(): number {
    let total = this.combinedOutput ? this.combinedOutput.bufferedRows : 0;
    for (const group of this.groups.values()) total += group.output.bufferedRows;
    return total;
  }

  get needsIntermediateFlush(): boolean {
    return this.bufferedRows >= MAX_BUFFERED_ROWS;
  }

  /**
   * Download the largest buffered group as _part-NNN files and free its
   * memory, mirroring ChunkedExport.flushIntermediate for long runs.
   */
  async flushIntermediate(onStatus?: (message: string) => void): Promise<boolean> {
    let largest: { output: ChunkedExport; label: string } | null = null;
    if (this.combinedOutput && this.combinedOutput.bufferedRows > 0) {
      largest = { output: this.combinedOutput, label: "gabungan" };
    }
    for (const group of this.groups.values()) {
      if (!largest || group.output.bufferedRows > largest.output.bufferedRows) largest = group;
    }
    if (!largest || largest.output.bufferedRows === 0) return false;
    onStatus?.(`Menulis Excel sementara grup ${largest.label} agar panel tidak crash…`);
    const done = await largest.output.flushIntermediate(onStatus);
    return done;
  }

  validateHeaders(filename: string, columns: string[]): void {
    const normalizedHeaders = columns.map((column) => column.trim().toLocaleLowerCase());
    const previous = this.indexesByFile.get(filename);
    if (previous) {
      if (JSON.stringify(previous.headers) !== JSON.stringify(normalizedHeaders)) {
        throw new Error(`Header hasil berubah selama pagination pada ${filename}.`);
      }
      return;
    }
    const index = resolveSplitColumnIndex(columns, this.column, filename);
    this.indexesByFile.set(filename, { headers: normalizedHeaders, index });
  }

  async append(result: QueryResult): Promise<void> {
    this.validateHeaders(result.filename, result.columns);
    const entry = this.indexesByFile.get(result.filename);
    if (!entry) throw new Error(`Header hasil tidak tervalidasi pada ${result.filename}.`);
    if (result.rows.length === 0) return;

    if (this.combinedOutput) {
      await this.combinedOutput.append(result);
    }

    const grouped = new Map<string, { value: unknown; rows: unknown[][] }>();
    for (const row of result.rows) {
      const value = row[entry.index] ?? null;
      const key = JSON.stringify(valueIdentity(value));
      const group = grouped.get(key) ?? { value, rows: [] };
      group.rows.push(row);
      grouped.set(key, group);
    }

    for (const [key, group] of grouped) {
      let existing = this.groups.get(key);
      if (!existing) {
        const label = slug(displayValue(group.value)).slice(0, 40) || "blank";
        const stem = `${this.basePath}_${label}_${hashKey(key)}`;
        let path = stem;
        let collision = 2;
        while (this.usedPaths.has(path)) path = `${stem}_${collision++}`;
        this.usedPaths.add(path);
        const output = new ChunkedExport(path, this.download, this.maxWorkbookBytes, this.serialize);
        existing = { output, label };
        this.groups.set(key, existing);
      }
      await existing.output.append({ ...result, rows: group.rows });
    }
    this.collectedRows += result.rows.length;
  }

  async flush(final: boolean, partial = false): Promise<void> {
    if (this.combinedOutput) {
      await this.combinedOutput.flush(final, partial);
    }
    for (const group of this.groups.values()) {
      await group.output.flush(final, partial);
    }
  }
}
