import { describe, expect, it, vi } from "vitest";
import { ChunkedExport, collectQuery } from "./chunked-export";
import { serializeWorkbook, type QueryResult } from "./excel";
import type { SqlChunkResponse } from "../types";

const result = (rows: unknown[][], filename = "a.sql"): QueryResult => ({ filename, title: filename, columns: ["id"], rows });
const chunk = (rows: unknown[][], hasMore = false): SqlChunkResponse => ({ ok: true, message: "OK", columns: ["id"], rows, hasMore });

function downloads() {
  const saved: { path: string; results: QueryResult[] }[] = [];
  const serialize = vi.fn(async (results: QueryResult[]) => new TextEncoder().encode(JSON.stringify(results)));
  const download = vi.fn(async (path: string, buffer: Uint8Array) => { saved.push({ path, results: JSON.parse(new TextDecoder().decode(buffer)) as QueryResult[] }); });
  return { saved, download, serialize };
}

describe("combined Excel output", () => {
  it("uses compressed XLSX size even when raw data exceeds the old 8 MiB limit", async () => {
    const download = vi.fn<(path: string, buffer: Uint8Array) => Promise<void>>().mockResolvedValue(undefined);
    const serialize = vi.fn(serializeWorkbook);
    const output = new ChunkedExport("folder", download, undefined, serialize);
    await output.append(result(Array.from({ length: 1000 }, () => ["x".repeat(9000)])));
    await output.append(result([[2]], "b.sql"));
    await output.flush(true);
    expect(download).toHaveBeenCalledTimes(1);
    expect(download.mock.calls[0]?.[0]).toBe("folder");
    expect(download.mock.calls[0]?.[1].byteLength).toBeLessThan(20 * 1024 * 1024);
    expect(serialize.mock.calls[0]?.[0]).toHaveLength(2);
  });

  it("does not split at old row or cell limits", async () => {
    const { saved, download, serialize } = downloads();
    const output = new ChunkedExport("folder", download, undefined, serialize);
    const rows = Array.from({ length: 50_001 }, () => [1, 2, 3, 4, 5]);
    await output.append({ ...result(rows), columns: ["a", "b", "c", "d", "e"] });
    await output.flush(true);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.results[0]?.rows).toHaveLength(rows.length);
  });

  it("keeps retrieval chunks and multiple tables in one download", async () => {
    const { saved, download, serialize } = downloads();
    const output = new ChunkedExport("folder", download, undefined, serialize);
    await output.append(result([[1], [2]]));
    await output.append(result([[3]]));
    await output.append(result([[4]], "b.sql"));
    expect(download).not.toHaveBeenCalled();
    await output.flush(true);
    expect(saved).toEqual([{ path: "folder", results: [result([[1], [2], [3]]), result([[4]], "b.sql")] }]);
  });

  it("splits only serialized output above the byte limit without losing or repeating rows", async () => {
    const { saved, download, serialize } = downloads();
    const output = new ChunkedExport("folder", download, 170, serialize);
    const rows = Array.from({ length: 7 }, (_, i) => [String(i).repeat(30)]);
    await output.append(result(rows));
    await output.append(result([["last"]], "b.sql"));
    await output.flush(true);
    expect(saved.length).toBeGreaterThan(1);
    expect(saved.map((part, index) => part.path === `folder_part-${String(index + 1).padStart(3, "0")}`)).not.toContain(false);
    expect(download.mock.calls.every(([, buffer]) => buffer.byteLength <= 170)).toBe(true);
    expect(saved.flatMap((part) => part.results.flatMap((sheet) => sheet.rows))).toEqual([...rows, ["last"]]);
    expect(output.totalRows).toBe(8);
  });

  it("flushes buffered rows incrementally so a ~900k-row run never holds everything in memory", async () => {
    const { saved, download, serialize } = downloads();
    const output = new ChunkedExport("folder", download, 10 ** 9, serialize);
    const rows = Array.from({ length: 60_000 }, (_, i) => [i]);
    await output.append(result(rows));
    expect(output.bufferedRows).toBe(60_000);
    expect(output.needsIntermediateFlush).toBe(true);
    expect(await output.flushIntermediate()).toBe(true);
    expect(output.bufferedRows).toBe(0);
    expect(output.parts).toBe(1);
    await output.append(result([[1]]));
    await output.flush(true);
    // First file already used _part-001, so the remainder keeps the numbered scheme.
    expect(saved.map((part) => part.path)).toEqual(["folder_part-001", "folder_part-002"]);
    expect(output.totalRows).toBe(60_001);
  });

  it("keeps output exactly at the byte limit in one file", async () => {
    const { saved, download, serialize } = downloads();
    const sheet = result([[1]]);
    const bytes = (await serialize([sheet])).byteLength;
    const output = new ChunkedExport("folder", download, bytes, serialize);
    await output.append(sheet);
    await output.flush(true);
    expect(saved.map((part) => part.path)).toEqual(["folder"]);
  });

  it("exports prior tables plus the current partial table together", async () => {
    const { saved, download, serialize } = downloads();
    const output = new ChunkedExport("folder", download, undefined, serialize);
    await output.append(result([[1]]));
    await output.append(result([[2]], "b.sql"));
    await output.flush(true, true);
    expect(saved).toEqual([{ path: "folder_partial", results: [result([[1]]), result([[2]], "b.sql")] }]);
  });

  it("preserves a buffer when download fails and avoids empty files before any result", async () => {
    const { saved, download, serialize } = downloads();
    download.mockRejectedValueOnce(new Error("disk"));
    const output = new ChunkedExport("folder", download, undefined, serialize);
    await output.flush(true, true);
    expect(download).not.toHaveBeenCalled();
    await output.append(result([[1]]));
    await expect(output.flush(true)).rejects.toThrow("disk");
    await output.flush(true, true);
    expect(saved[0]?.results[0]?.rows).toEqual([[1]]);
    expect(output.parts).toBe(1);
  });
});

describe("automatic chunk collection", () => {
  it("downloads all accepted tables on Stop without waiting for the active request", async () => {
    const { saved, download, serialize } = downloads();
    const output = new ChunkedExport("folder", download, undefined, serialize);
    await output.append(result([[1]]));
    const controller = new AbortController();
    let finish: (value: SqlChunkResponse) => void = () => {};
    const pending = new Promise<SqlChunkResponse>((resolve) => { finish = resolve; });
    const request = vi.fn<() => Promise<SqlChunkResponse>>()
      .mockResolvedValueOnce(chunk([[2]], true))
      .mockImplementationOnce(() => { controller.abort(); return pending; });
    await expect(collectQuery(request, (_, rows) => output.append(result(rows, "b.sql")), () => controller.signal.aborted, vi.fn(), controller.signal)).rejects.toThrow("dihentikan");
    await output.flush(true, true);
    expect(saved).toEqual([{ path: "folder_partial", results: [result([[1]]), result([[2]], "b.sql")] }]);
    finish(chunk([[3]]));
    await pending;
    expect(output.totalRows).toBe(2);
  });

  it("shrinks oversized requests at the same offset and advances by actual delivered rows", async () => {
    const request = vi.fn<(...args: number[]) => Promise<SqlChunkResponse>>()
      .mockResolvedValueOnce(chunk([[1], [2]], true))
      .mockResolvedValueOnce({ ok: false, message: "Response exceeded 64 MB" })
      .mockResolvedValueOnce(chunk([[3]], true))
      .mockResolvedValueOnce(chunk([]));
    const accept = vi.fn(async () => {});
    await collectQuery(request, accept, () => false, vi.fn());
    expect(request.mock.calls).toEqual([[0, 9000, 1], [2, 2, 2], [2, 1, 2], [3, 1, 3]]);
    expect(accept).toHaveBeenCalledTimes(2);
  });

  it("exports accepted data after Stop, including a concurrently completed chunk", async () => {
    const { saved, download, serialize } = downloads();
    const output = new ChunkedExport("folder", download, undefined, serialize);
    let stopped = false;
    const request = vi.fn(async () => { stopped = true; return chunk([[1], [2]], true); });
    await expect(collectQuery(request, (columns, rows) => output.append({ ...result(rows), columns }), () => stopped, vi.fn())).rejects.toThrow("dihentikan");
    await output.flush(true, true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(saved[0]?.results[0]?.rows).toEqual([[1], [2]]);
  });

  it("preserves earlier chunks when the next request fails and does not retry ordinary SQL errors", async () => {
    const { saved, download, serialize } = downloads();
    const output = new ChunkedExport("folder", download, undefined, serialize);
    await output.append(result([[0]], "previous.sql"));
    const request = vi.fn<() => Promise<SqlChunkResponse>>()
      .mockResolvedValueOnce(chunk([[1]], true))
      .mockRejectedValueOnce(new Error("Syntax error"));
    await expect(collectQuery(request, (_, rows) => output.append(result(rows)), () => false, vi.fn())).rejects.toThrow("Syntax error");
    await output.flush(true, true);
    expect(saved).toEqual([{ path: "folder_partial", results: [result([[0]], "previous.sql"), result([[1]])] }]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("terminates retries even if a single row cannot be fetched", async () => {
    const request = vi.fn(async () => ({ ok: false as const, message: "Payload too large" }));
    await expect(collectQuery(request, vi.fn(), () => false, vi.fn())).rejects.toThrow("Payload too large");
    expect(request.mock.calls.length).toBeLessThan(16);
  });
});
