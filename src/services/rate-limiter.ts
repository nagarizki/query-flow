/**
 * Limiter global untuk rate limit DB engine ("30 query per 1 menit").
 *
 * Semua request ke DB — chunk, retry, file, wilayah, batch — melewati satu
 * instance yang sama, sehingga kuota dihitung pada satu jendela waktu global,
 * bukan per file atau per wilayah. Jeda antar file/wilayah di side panel
 * tetap ada sebagai jeda minimum tambahan, tetapi penentu laju yang
 * sesungguhnya adalah limiter ini.
 *
 * Tiga sifat yang dijamin:
 *
 * 1. Jendela bergulung (sliding window). Timestamp mulai setiap request
 *    dicatat; tidak boleh ada lebih dari `capacity` request dalam jendela
 *    `windowMs` mana pun. Karena jendela ikut bergeser, limit server yang
 *    menghitung per menit pun tidak akan terlampaui — termasuk saat dua
 *    menit berdekatan, yang bisa dilampaui bila jeda dihitung per menit tetap.
 * 2. Spasi dihitung dari waktu *mulai* request sebelumnya, bukan dari waktu
 *    selesai. Request yang lambat (mis. 4 dtk) karena itu tidak menambah
 *    jeda ekstra, sehingga laju tetap maksimal selama kuota jendela cukup.
 * 3. Adaptif. Setiap 429 menurunkan kuota sementara dan tiap request
 *    sukses memulihkannya sedikit demi sedikit, sehingga limiter menyesuaikan
 *    dengan batas yang sebenarnya di server.
 */

/** Batas keras server, dipakai untuk computes margin aman. */
export const SERVER_LIMIT_PER_MINUTE = 30;
/** Kuota default per jendela rolling, dengan margin 3 request. */
export const DEFAULT_CAPACITY = 27;
/** Panjang jendela rolling. */
export const DEFAULT_WINDOW_MS = 60_000;

export interface RateLimiterOptions {
  /** Maks request per jendela rolling. Default 27. */
  capacity?: number;
  /** Panjang jendela rolling dalam ms. Default 60.000. */
  windowMs?: number;
  /** Penalti minimum saat 429 (fraksi dari kuota nominal). Default 0,5. */
  minPenalty?: number;
  /** Sumber waktu; default `Date.now`. Dipakai untuk tes. */
  now?: () => number;
  /** Fungsi sleep; default `sleepAbortable`. Dipakai untuk tes. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export class RateLimiter {
  private readonly capacity: number;
  private readonly windowMs: number;
  private readonly minPenalty: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Timestamp mulai request, urut naik. */
  private readonly starts: number[] = [];
  /** 1 = kuota penuh; < 1 = sedang diturunkan karena 429. */
  private penalty = 1;
  /** Jeda minimum untuk request berikutnya, dihitung dari request terakhir. */
  private pendingSpacing = 0;
  /** Serialisasi acquire supaya dua request tidak lolos bersamaan. */
  private tail: Promise<void> = Promise.resolve();

  constructor(options: RateLimiterOptions = {}) {
    this.capacity = options.capacity ?? DEFAULT_CAPACITY;
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.minPenalty = options.minPenalty ?? 0.5;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? sleepAbortable;
  }

  /** Kuota efektif setelah penalti 429. */
  get effectiveCapacity(): number {
    return Math.max(1, Math.floor(this.capacity * this.penalty));
  }

  /**
   * Jeda minimum antar waktu-mulai request.
   *
   * `floor(window / capacity) + 1` dipakai, bukan pembulatan ke atas, supaya
   * jendela tertutup (yang bisa memuat satu request lebih) tetap tidak
   * pernah melewati kuota.
   */
  get spacingMs(): number {
    return Math.floor(this.windowMs / this.effectiveCapacity) + 1;
  }

  /** Berapa request yang terpakai dalam jendela berjalan. */
  get usedInWindow(): number {
    this.prune(this.now());
    return this.starts.length;
  }

  /** Mulai request terakhir yang tercatat, kalau ada. */
  get lastStartMs(): number | undefined {
    return this.starts[this.starts.length - 1];
  }

  /** Panggil saat server membalas 429: turunkan kuota sementara. */
  noteRateLimited(): void {
    this.penalty = Math.max(this.minPenalty, this.penalty * 0.75);
  }

  /** Panggil setelah request sukses: pulihkan kuota sedikit demi sedikit. */
  noteSuccess(): void {
    if (this.penalty < 1) {
      this.penalty = Math.min(1, this.penalty + (1 - this.penalty) * 0.15);
      if (1 - this.penalty < 0.01) this.penalty = 1;
    }
  }

  /** Bersihkan riwayat (mis. setelah run selesai). */
  reset(): void {
    this.starts.length = 0;
    this.penalty = 1;
    this.pendingSpacing = 0;
  }

  /**
   * Daftarkan jeda minimum untuk request berikutnya. Nilainya dihitung dari
   * waktu *mulai* request terakhir, sehingga jeda ini tidak menambah waktu
   * total di atas apa yang limiter glass butuh.
   */
  requestSpacing(ms: number): void {
    this.pendingSpacing = Math.max(this.pendingSpacing, ms);
  }

  /**
   * Sisa jeda (ms) sebelum request berikutnya boleh dikirim. 0 berarti boleh
   * langsung jalan.
   */
  waitMs(now = this.now()): number {
    this.prune(now);
    const spacing = Math.max(this.spacingMs, this.pendingSpacing);
    const last = this.starts[this.starts.length - 1];
    let wait = 0;
    if (last !== undefined) wait = last + spacing - now;
    // Jendela penuh: request tertua yang menyebabkan kuota penuh harus keluar lebih dulu.
    if (this.starts.length >= this.effectiveCapacity) {
      const overflowIndex = this.starts.length - this.effectiveCapacity;
      wait = Math.max(wait, this.starts[overflowIndex]! + this.windowMs - now);
    }
    return Math.max(0, wait);
  }

  /**
   * Tunggu sampai aman mengirim request, lalu catat waktu mulainya.
   * `onWait` dipakai untuk memberi tahu panel selama menunggu.
   */
  acquire(signal?: AbortSignal, onWait?: (waitMs: number) => void): Promise<void> {
    const run = this.tail.then(() => this.acquireInner(signal, onWait));
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async acquireInner(signal?: AbortSignal, onWait?: (waitMs: number) => void): Promise<void> {
    if (signal?.aborted) throw new Error("Run dihentikan oleh pengguna.");
    while (true) {
      const wait = this.waitMs();
      if (wait <= 0) break;
      onWait?.(wait);
      await this.sleep(wait, signal);
    }
    const now = this.now();
    this.prune(now);
    this.starts.push(now);
    this.pendingSpacing = 0;
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.starts.length && this.starts[0]! <= cutoff) this.starts.shift();
  }
}

/** Limiter yang dipakai seluruh extension. */
export const dbRateLimiter = new RateLimiter();

/** Sleep yang bisa dibatalkan; menolak dengan pesan berbahasa Indonesia. */
export function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("Run dihentikan oleh pengguna."));
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    const onAbort = (): void => { cleanup(); reject(new Error("Run dihentikan oleh pengguna.")); };
    const cleanup = (): void => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); };
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
