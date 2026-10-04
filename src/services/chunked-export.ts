import { serializeWorkbook, downloadWorkbook, type QueryResult } from "./excel";
import type { SqlChunkResponse } from "../types";

export const MAX_EXPORT_BYTES = 20 * 1024 * 1024;
/** Flush buffered rows to disk before they can OOM the side panel (~900k x 25 crash). */
export const MAX_BUFFERED_ROWS = 200_000;

/** Retrieval pages are accumulated into one workbook, independent of table boundaries. */
export class ChunkedExport {
  private results: QueryResult[] = [];
  parts = 0;
  totalRows = 0;

  constructor(
    private readonly path: string,
    private readonly download = downloadWorkbook,
    private readonly maxBytes = MAX_EXPORT_BYTES,
    private readonly serialize = serializeWorkbook,
  ) {}

  /** Rows held in memory and not yet downloaded. */
  get bufferedRows(): number {
    return this.results.reduce((sum, sheet) => sum + sheet.rows.length, 0);
  }

  get needsIntermediateFlush(): boolean {
    return this.bufferedRows >= MAX_BUFFERED_ROWS;
  }

  async append(result: QueryResult): Promise<void> {
    const existing = this.results.find((entry) => entry.filename === result.filename);
    if (existing) {
      for (const row of result.rows) existing.rows.push(row);
    } else {
      this.results.push({ ...result, rows: [...result.rows] });
    }
    this.totalRows += result.rows.length;
  }

  async flush(_final: boolean, partial = false): Promise<void> {
    await this.drain(partial, false);
  }

  /**
   * Download everything currently buffered as `_part-NNN` files and free memory.
   * Call this during collection (e.g. every chunk) so a ~900k-row run never
   * holds the whole result set + a full XLSX serialization in memory at once.
   * Returns true when at least one file was downloaded.
   */
  async flushIntermediate(onStatus?: (message: string) => void): Promise<boolean> {
    if (!this.results.length) return false;
    onStatus?.(`Menulis Excel sementara (bagian ke-${this.parts + 1}, ${this.bufferedRows.toLocaleString("id-ID")} baris di memori) agar panel tidak crash…`);
    await this.drain(false, true);
    onStatus?.(`Bagian ke-${this.parts} tersimpan. Lanjut mengambil data…`);
    return true;
  }

  private async drain(partial: boolean, forceSplit: boolean): Promise<void> {
    while (this.results.length) {
      let selected = this.results;
      let buffer = await this.serialize(selected);
      let remainder: QueryResult[] = [];
      const split = forceSplit || buffer.byteLength > this.maxBytes || this.parts > 0;
      // Measure real XLSX bytes, including ZIP compression and workbook overhead.
      // Halve oversized prefixes until each downloadable workbook fits.
      while (buffer.byteLength > this.maxBytes) {
        const units = selected.reduce((sum, sheet) => sum + Math.max(1, sheet.rows.length), 0);
        if (units <= 1) throw new Error("Satu baris/header Excel melebihi batas 20 MB dan tidak dapat dipecah lagi.");
        let remaining = Math.floor(units / 2);
        const prefix: QueryResult[] = [];
        const suffix: QueryResult[] = [];
        for (const sheet of selected) {
          const count = Math.max(1, sheet.rows.length);
          if (remaining >= count) {
            prefix.push(sheet);
            remaining -= count;
          } else if (remaining > 0) {
            prefix.push({ ...sheet, rows: sheet.rows.slice(0, remaining) });
            suffix.push({ ...sheet, rows: sheet.rows.slice(remaining) });
            remaining = 0;
          } else {
            suffix.push(sheet);
          }
        }
        selected = prefix;
        remainder = [...suffix, ...remainder];
        buffer = await this.serialize(selected);
      }
      const suffix = split ? `_part-${String(this.parts + 1).padStart(3, "0")}` : "";
      await this.download(`${this.path}${suffix}${partial ? "_partial" : ""}`, buffer);
      this.parts++;
      // Retain everything not successfully downloaded if serialization/download fails.
      this.results = remainder;
    }
  }
}

/** Errors worth retrying at the same offset instead of aborting the batch. */
export const TRANSIENT_RUN_ERROR = /message channel closed|receiving end does not exist|could not establish connection|message port closed|disconnected|service worker|worker.*terminat|koneksi sql lab terputus|query masih berjalan/i;

export interface CollectQueryOptions {
  /** Max retries per offset for transient errors. Defaults to 3. */
  transientRetries?: number;
  /** Base delay between transient retries (multiplied by attempt). Defaults to 2000 ms. */
  retryDelayMs?: number;
}

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    const onAbort = (): void => { cleanup(); reject(new Error("Run dihentikan oleh pengguna.")); };
    const cleanup = (): void => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); };
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Retry size failures at the same offset; advance only after a chunk is accepted. */
export async function collectQuery(
  request: (offset: number, limit: number, iteration: number) => Promise<SqlChunkResponse>,
  accept: (columns: string[], rows: unknown[][]) => Promise<void>,
  stopped: () => boolean,
  report: (message: string) => void,
  signal?: AbortSignal,
  options: CollectQueryOptions = {},
): Promise<void> {
  const maxTransient = options.transientRetries ?? 3;
  const baseDelay = options.retryDelayMs ?? 2000;
  let offset = 0;
  let limit = 9000;
  let iteration = 1;
  let transientAttempts = 0;
  while (!stopped()) {
    let response: SqlChunkResponse;
    try {
      const pending = request(offset, limit, iteration);
      if (signal) {
        let cancel: () => void = () => {};
        const cancelled = new Promise<never>((_, reject) => {
          cancel = () => reject(new Error("Run dihentikan oleh pengguna."));
          signal.addEventListener("abort", cancel, { once: true });
          if (signal.aborted) cancel();
        });
        try {
          response = await Promise.race([pending, cancelled]);
        } finally {
          signal.removeEventListener("abort", cancel);
        }
      } else {
        response = await pending;
      }
    } catch (error) {
      response = { ok: false, message: error instanceof Error ? error.message : "Koneksi SQL Lab terputus." };
    }
    if (!response.ok) {
      if (stopped()) break;
      if (TRANSIENT_RUN_ERROR.test(response.message) && transientAttempts < maxTransient) {
        transientAttempts++;
        report(`Koneksi ke SQL Lab terputus sesaat. Mencoba ulang ${transientAttempts}/${maxTransient} dari baris ${offset + 1}…`);
        await sleepAbortable(baseDelay * transientAttempts, signal);
        continue;
      }
      if (limit > 1 && /exceed|too (?:large|big)|size.{0,30}limit|limit.{0,30}(?:size|bytes|mb)|payload|out of memory/i.test(response.message)) {
        limit = Math.max(1, Math.floor(limit / 2));
        report(`Batas ukuran tercapai. Mengulang dari baris ${offset + 1} dengan chunk ${limit} baris…`);
        continue;
      }
      throw new Error(response.message);
    }
    // A chunk that finished concurrently with Stop is still valid and exported.
    if (response.rows.length || offset === 0) await accept(response.columns, response.rows);
    offset += response.rows.length;
    transientAttempts = 0;
    if (stopped()) break;
    if (!response.hasMore) return;
    if (!response.rows.length) throw new Error("Chunk kosong tetapi hasil belum selesai; proses dihentikan agar tidak mengulang tanpa akhir.");
    // Match subsequent SQL pages to the transfer budget for wide rows.
    limit = Math.min(limit, response.rows.length);
    iteration++;
  }
  throw new Error("Run dihentikan oleh pengguna.");
}
