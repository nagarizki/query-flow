import type { SqlChunkResponse } from "../types";

/** Executes one bounded page in MAIN world. All runtime helpers must remain inside this function. */
export async function runInSqlLabChunk(baseSql: string, runId: string, path: string, offset: number, limit: number, iteration: number): Promise<SqlChunkResponse> {
  const runtimeWindow = window as typeof window & { __queryFlowCancelledRuns?: Record<string, boolean> };
  runtimeWindow.__queryFlowCancelledRuns ??= {};

  function throwIfCancelled(): void {
    if (runtimeWindow.__queryFlowCancelledRuns?.[runId]) {
      throw new Error("Run dihentikan oleh pengguna.");
    }
  }
  
  // Helper to check if ORDER BY exists strictly at the top level (depth 0, outside subqueries/CTEs)
  function hasTopLevelOrderBy(sql: string): boolean {
    let depth = 0;
    const upper = sql.toUpperCase();
    for (let i = 0; i < upper.length; i++) {
      const char = upper[i];
      if (char === '(') depth++;
      else if (char === ')') depth--;
      else if (depth === 0) {
        if (upper.substring(i, i + 8) === 'ORDER BY') {
          return true;
        }
      }
    }
    return false;
  }

  // Keep an explicit outer ORDER BY. Otherwise use the first output column by
  // position: guessing an identifier from a CTE/SELECT expression can reference
  // a column that is not exposed by the outer query.
  function ensureOrderBy(sql: string): string {
    if (hasTopLevelOrderBy(sql)) {
      return sql; // Outer/main query already has a top-level ORDER BY
    }

    const modified = sql.trim().replace(/;$/, "");
    return `${modified} ORDER BY 1 ASC`;
  }

  // Preserve high-precision SQL values before executeScript's structured clone
  // strips the BigNumber/Decimal prototype and leaves only fields such as c/e/s.
  function normalizeResultValue(value: unknown): unknown {
    if (typeof value === "bigint") {
      const num = Number(value);
      return Number.isSafeInteger(num) ? num : value.toString();
    }
    if (!value || typeof value !== "object") return value;

    const candidate = value as { c?: unknown; e?: unknown; s?: unknown; toString?: () => string };
    const isHighPrecisionNumber = Array.isArray(candidate.c)
      && typeof candidate.e === "number"
      && (candidate.s === 1 || candidate.s === -1);
    if (!isHighPrecisionNumber || typeof candidate.toString !== "function") return value;

    const rendered = candidate.toString();
    if (rendered === "[object Object]") return value;
    const num = Number(rendered);
    const digits = rendered.replace(/^[-+]/, "").replace(/^0+/, "").replace(".", "").replace(/^0+/, "");
    return Number.isFinite(num) && digits.length <= 15 ? num : rendered;
  }

  // Apply the intelligent top-level ORDER BY check before starting pagination loops
  const preparedSql = ensureOrderBy(baseSql);
  const cleanSql = preparedSql.trim().replace(/;$/, "");

  function reportProgress(state: "running" | "completed", iteration: number, rowsCollected: number, batchRows?: number): void {
    window.postMessage({
      source: "queryflow-sql-run-progress",
      progress: { runId, path, iteration, state, rowsCollected, batchRows },
    }, window.location.origin);
  }

  type Query = { id?: string; sql?: string; state?: string; errorMessage?: string; results?: { columns?: { name: string }[]; data?: Record<string, unknown>[] }; rows?: number };
  type Store = { getState(): { sqlLab?: { queries?: Record<string, Query> } } };

  {
    const paginatedSql = `${cleanSql} LIMIT ${limit} OFFSET ${offset};`;
    reportProgress("running", iteration, offset);

    try {
      throwIfCancelled();
      let store: Store | undefined;
      for (const node of document.querySelectorAll("#app, #root, #app *")) {
        const key = Object.keys(node).find((key) => key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$"));
        if (!key) continue;
        let fiber = (node as unknown as Record<string, unknown>)[key] as { return?: unknown; memoizedProps?: { store?: Store; value?: { store?: Store } } } | undefined;
        for (let depth = 0; fiber && depth < 100; depth++) {
          const candidate = fiber.memoizedProps?.store ?? fiber.memoizedProps?.value?.store;
          if (candidate?.getState()?.sqlLab?.queries) { store = candidate; break; }
          fiber = fiber.return as typeof fiber;
        }
        if (store) break;
      }
      if (!store) throw new Error("State hasil SQL Lab belum dikenali. Run dibatalkan.");

      const before = { ...store.getState().sqlLab?.queries };
      const visible = (element: HTMLElement): boolean => element.getClientRects().length > 0;
      const editors = [...document.querySelectorAll<HTMLElement>(".ace_editor")].filter(visible);
      if (editors.length !== 1) throw new Error("Pilih satu tab query SQL Lab dengan editor yang terlihat.");

      const element = editors[0] as HTMLElement & {
        env?: { editor?: {
          setValue(value: string, cursor: number): void;
          getValue(): string;
          clearSelection(): void;
        } };
      };

      const editor = element.env?.editor;
      if (!editor) throw new Error("Editor SQL Lab belum dapat diakses.");

      const buttons = [...document.querySelectorAll<HTMLButtonElement>("button")].filter(visible);
      if (buttons.some((button) => /^stop(?: query)?$/i.test(button.textContent?.trim() ?? ""))) {
        throw new Error("Query masih berjalan. Tunggu selesai.");
      }

      editor.setValue(paginatedSql, -1);
      editor.clearSelection();
      
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

      const run = [...document.querySelectorAll<HTMLButtonElement>("button")]
        .filter(visible).filter((button) => /^run(?: query)?$/i.test(button.textContent?.trim() ?? ""));
      if (run.length !== 1 || !run[0] || run[0].disabled) throw new Error("RUN belum siap.");
      
      throwIfCancelled();
      run[0].click();

      const deadline = Date.now() + 240_000;
      let queryId: string | undefined;
      let batchColumns: string[] = [];
      const batchRows: unknown[][] = [];
      let complete = false;
      let hasMore = false;

      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        const queries = store.getState().sqlLab?.queries ?? {};
        if (!queryId) {
          const candidates = Object.entries(queries).filter(([id, query]) => !before[id] && query.sql?.trim() === paginatedSql.trim());
          queryId = candidates[0]?.[0];
        }

        const query = queryId ? queries[queryId] : undefined;
        if (!query || query.state !== "success") throwIfCancelled();
        if (!query) continue;
        if (["failed", "stopped", "timed_out"].includes(query.state ?? "")) throw new Error(query.errorMessage ?? `Query ${query.state}`);
        if (query.state !== "success") continue;

        const cols = query.results?.columns?.map((column) => column.name);
        const data = query.results?.data;
        if (!cols || !Array.isArray(data)) {
          throwIfCancelled();
          continue;
        }

        batchColumns = cols;
        // Bound the response before executeScript/Chrome messaging serializes it.
        // A wide result may yield fewer rows than the SQL LIMIT; resume at the
        // number actually delivered, never at the requested LIMIT.
        const encoder = new TextEncoder();
        const maxBytes = 2 * 1024 * 1024;
        let bytes = encoder.encode(JSON.stringify(cols)).byteLength + 4096;
        if (bytes >= maxBytes) throw new Error("Header hasil melebihi batas transfer 2 MiB.");
        for (const row of data) {
          const values = cols.map((name) => normalizeResultValue(row[name] ?? null));
          const rowBytes = encoder.encode(JSON.stringify(values)).byteLength + 1;
          if (bytes + rowBytes > maxBytes) {
            if (batchRows.length === 0) throw new Error("Satu baris melebihi batas transfer 2 MiB.");
            break;
          }
          batchRows.push(values);
          bytes += rowBytes;
        }
        hasMore = batchRows.length < data.length || data.length >= limit;
        complete = true;
        break;
      }

      if (!complete) {
        const stopButton = [...document.querySelectorAll<HTMLButtonElement>("button")]
          .find((button) => button.getClientRects().length > 0 && /^stop(?: query)?$/i.test(button.textContent?.trim() ?? ""));
        stopButton?.click();
        throw new Error("Batas tunggu 4 menit tercapai; hasil chunk belum tersedia.");
      }
      reportProgress("completed", iteration, offset + batchRows.length, batchRows.length);
      return { ok: true, message: "Chunk diterima.", columns: batchColumns, rows: batchRows, hasMore };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : "Run gagal." };
    }
  }
}

/** Release cancellation state after the panel has finished exporting a run. */
export function clearSqlLabRun(runId: string): void {
  const runtimeWindow = window as typeof window & { __queryFlowCancelledRuns?: Record<string, boolean> };
  delete runtimeWindow.__queryFlowCancelledRuns?.[runId];
}

/** Marks a QueryFlow run as cancelled and presses SQL Lab's visible Stop button when available. */
export function stopSqlLabRun(runId: string): { ok: true; message: string } {
  const runtimeWindow = window as typeof window & { __queryFlowCancelledRuns?: Record<string, boolean> };
  runtimeWindow.__queryFlowCancelledRuns ??= {};
  runtimeWindow.__queryFlowCancelledRuns[runId] = true;

  const visible = (element: HTMLElement): boolean => element.getClientRects().length > 0;
  const stopButton = [...document.querySelectorAll<HTMLButtonElement>("button")]
    .filter(visible)
    .find((button) => /^stop(?: query)?$/i.test(button.textContent?.trim() ?? ""));
  stopButton?.click();

  return {
    ok: true,
    message: stopButton ? "Menghentikan query aktif…" : "Permintaan stop dikirim…",
  };
}
