import "./style.css";
import { ChunkedExport, collectQuery } from "../services/chunked-export";
import { applyWilayahConfig, extractSqlTitle } from "../services/sql";
import { loadSnapshot, loadWilayah, saveSnapshot, saveWilayah } from "../services/storage";
import { groupSqlFiles, isSqlPath } from "../services/repository-sync/files";
import { addWilayahCode, targetWilayahTargets, validateWilayah } from "../services/wilayah";
import { TARGET, type ExtensionMessage, type RepositorySnapshot, type ScanResult, type SqlFile, type SqlRunProgress, type SqlChunkResponse, type SyncProgress, type WilayahConfig } from "../types";

let snapshot: RepositorySnapshot | null = null;
let wilayah: WilayahConfig = { level1: [], level2: [] };
let progress: SyncProgress = { phase: "idle", message: "Not synced" };
let wilayahError = "";
let folderRunning = false;
const runProgressTargets = new Map<string, (progress: SqlRunProgress) => void>();
const selectedPaths = new Set<string>();
let combineSelected = false;
let selectionRunning = false;
let selectionRunId: string | null = null;
let selectionTabId: number | null = null;
let selectionStopRequested = false;
let selectionController = new AbortController();

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("App container is missing.");

app.innerHTML = `
  <main class="panel">
    <header class="app-header">
      <span class="eyebrow">Chrome Extension</span>
      <h1>QueryFlow</h1>
      <p class="field-note">Integrasi · FASIH SQL Lab</p>
      <p class="field-note">Case 1 · SE2026 — Sensus Ekonomi 2026</p>
    </header>
    <section class="section" aria-labelledby="source-title">
      <div class="section-heading"><span>01</span><h2 id="source-title">Sumber SQL</h2></div>
      <div class="source-card">
        <p id="source-name" class="source-name">Belum ada folder SQL</p>
        <dl class="metadata">
          <div><dt>Branch</dt><dd id="branch">main</dd></div>
          <div><dt>Status</dt><dd id="status" class="status">Belum diimpor</dd></div>
          <div><dt>Commit</dt><dd id="commit">—</dd></div>
          <div><dt>File</dt><dd id="counts">0 SQL · 0 folder</dd></div>
          <div class="wide"><dt>Terakhir diperbarui</dt><dd id="synced-at">—</dd></div>
        </dl>
        <div id="progress" class="progress" aria-live="polite"></div>
        <div class="source-actions">
          <!-- Sync from GitLab sengaja dinonaktifkan. Sumber query aktif berasal dari impor folder lokal. -->
          <button id="import-folder" class="secondary-button" type="button">Import Folder SQL</button>
          <input id="folder-input" type="file" webkitdirectory multiple hidden />
        </div>
      </div>
    </section>
    <section class="section" aria-labelledby="wilayah-title">
      <div class="section-heading"><span>02</span><h2 id="wilayah-title">Filter Wilayah</h2></div>
      <p class="field-note">Case 1 · SE2026. Berlaku pada SQL dengan parameter filter_provinsi dan filter_kabupaten.</p>
      <div class="field">
        <label>Level 1 <span>/ Provinsi · kosong berarti semua</span></label>
        <div id="level1-list" class="code-list"></div>
        <div id="add-level1-row" class="add-row" hidden>
          <input id="new-level1" inputmode="numeric" autocomplete="off" placeholder="kode wilayah (PP)" />
          <button id="confirm-level1" type="button">Tambah</button>
        </div>
        <button id="show-level1-add" class="text-button" type="button">＋ Tambah Provinsi</button>
        <label class="checkbox-row">
          <input id="split-level1" type="checkbox" checked />
          <span>Pisahkan file Excel per provinsi</span>
        </label>
      </div>
      <div class="field">
        <label>Level 2 <span>/ Kabupaten/Kota · kosong berarti semua</span></label>
        <div id="level2-list" class="code-list"></div>
        <div id="add-level2-row" class="add-row" hidden>
          <input id="new-level2" inputmode="numeric" autocomplete="off" placeholder="kode wilayah (PPKK)" />
          <button id="confirm-level2" type="button">Tambah</button>
        </div>
        <button id="show-level2-add" class="text-button" type="button">＋ Tambah Kabupaten/Kota</button>
        <label class="checkbox-row">
          <input id="split-level2" type="checkbox" checked />
          <span>Pisahkan file Excel per Kabupaten/Kota</span>
        </label>
      </div>
      <p id="wilayah-error" class="error" aria-live="polite"></p>
      <p id="wilayah-mode" class="field-note"></p>
      <p id="wilayah-saved" class="saved" aria-live="polite"></p>
    </section>
    <section class="section groups-section" aria-labelledby="groups-title">
      <div class="section-heading"><span>03</span><h2 id="groups-title">Folder SQL</h2></div>
      <details class="run-guide">
        <summary><span class="help-icon">?</span><span>Panduan Run &amp; auto-loop</span></summary>
        <div class="run-guide-content">
          <p>Sekali Run, data diambil bertahap sampai selesai. Hasil besar otomatis diunduh menjadi beberapa file Excel bernomor.</p>
          <ul>
            <li>Tombol <strong>Run</strong> berubah menjadi <strong>Stop</strong> selama query berjalan.</li>
            <li>Editor SQL aktif akan diganti. Side panel harus tetap terbuka; tab SQL Lab boleh tidak terlihat, tapi jangan ditutup atau dipakai menjalankan query lain.</li>
            <li><strong>Stop</strong> atau error tetap mengunduh hasil yang sudah terkumpul sebagai Excel parsial.</li>
          </ul>
        </div>
      </details>
      <div id="empty-groups" class="empty-state">Import folder SQL untuk melihat daftar query dan menjalankannya di FASIH SQL Lab.</div>
      <div id="selection-bar" class="selection-bar" hidden>
        <span id="selection-count" class="selection-count">0 file dipilih</span>
        <label class="checkbox-row selection-combine">
          <input id="combine-selected" type="checkbox" />
          <span>Gabung 1 Excel</span>
        </label>
        <div class="selection-actions">
          <button id="run-selected" class="secondary-button" type="button">▶ Run Terpilih → Excel</button>
          <button id="clear-selected" class="text-button" type="button">Hapus seleksi</button>
        </div>
      </div>
      <p id="selection-status" class="progress" role="status"></p>
      <div id="groups" class="groups"></div>
    </section>
    <footer class="author-credit">initiated by D.Agung Sungkono</footer>
  </main>
  <dialog id="preview-dialog">
    <div class="dialog-header"><div><span id="preview-path"></span><h3 id="preview-name"></h3></div><button id="close-preview" aria-label="Tutup">×</button></div>
    <pre id="preview-content"></pre>
  </dialog>
`;

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
};

const syncButton = document.querySelector<HTMLButtonElement>("#sync");
const importButton = byId<HTMLButtonElement>("import-folder");
const folderInput = byId<HTMLInputElement>("folder-input");
const newLevel1Input = byId<HTMLInputElement>("new-level1");
const newLevel2Input = byId<HTMLInputElement>("new-level2");

async function initialize(): Promise<void> {
  [snapshot, wilayah] = await Promise.all([loadSnapshot(), loadWilayah()]);
  progress = snapshot
    ? { phase: "success", message: snapshot.repository.namespace === "local-folder" ? "Imported" : "Synced" }
    : { phase: "idle", message: "Belum diimpor" };
  render();
}

function render(): void {
  renderSource();
  renderWilayah();
  renderGroups();
}

function renderSource(): void {
  byId("source-name").textContent = snapshot?.repository.name ?? "Belum ada folder SQL";
  byId("branch").textContent = snapshot?.repository.branch ?? TARGET.defaultBranch;
  const status = byId("status");
  status.textContent = progress.phase === "success" ? `✓ ${progress.message}` : progress.message;
  status.className = `status status-${progress.phase}`;
  byId("commit").textContent = snapshot?.repository.commit?.slice(0, 8) ?? "—";
  byId("counts").textContent = `${snapshot?.repository.sqlCount ?? 0} SQL · ${snapshot?.groups.length ?? 0} folder`;
  byId("synced-at").textContent = snapshot ? formatDate(snapshot.repository.syncedAt) : "—";
  const progressElement = byId("progress");
  const showDetail = !["idle", "success"].includes(progress.phase);
  progressElement.textContent = showDetail
    ? `${progress.message}${progress.phase === "error" && snapshot ? " Last successful snapshot preserved." : ""}`
    : "";
  progressElement.classList.toggle("progress-error", progress.phase === "error");
  const busy = ["connecting", "scanning", "reading", "saving"].includes(progress.phase);
  if (syncButton) syncButton.disabled = busy;
  importButton.disabled = busy;
}

function renderWilayah(): void {
  renderCodeList("level1-list", "Level 1", wilayah.level1, (index, code) => updateCode("level1", index, code), (index) => removeCode("level1", index));
  renderCodeList("level2-list", "Level 2", wilayah.level2, (index, code) => updateCode("level2", index, code), (index) => removeCode("level2", index));
  byId("wilayah-error").textContent = wilayahError;
  byId<HTMLInputElement>("split-level1").checked = wilayah.splitLevel1 !== false;
  byId<HTMLInputElement>("split-level2").checked = wilayah.splitLevel2 !== false;
  byId("wilayah-mode").textContent = wilayah.level2.length > 0
    ? (wilayah.splitLevel2 !== false
        ? "Filter aktif: loop sekuensial per kabupaten/kota (1 file Excel per kabupaten/kota)."
        : "Filter aktif: seluruh kabupaten/kota terpilih digabung dalam 1 file Excel. Daftar provinsi diabaikan selama Level 2 terisi.")
    : wilayah.level1.length > 0
      ? (wilayah.splitLevel1 !== false
          ? "Filter aktif: loop sekuensial per provinsi (1 file Excel per provinsi)."
          : "Filter aktif: seluruh provinsi terpilih digabung dalam 1 file Excel.")
      : "Filter wilayah kosong: semua wilayah akan dijalankan.";
}

function renderCodeList(
  elementId: string,
  label: string,
  codes: string[],
  update: (index: number, code: string) => void,
  removeCodeAt: (index: number) => void,
): void {
  const list = byId(elementId);
  list.replaceChildren();
  codes.forEach((code, index) => {
    const row = document.createElement("div");
    row.className = "code-row";
    const input = document.createElement("input");
    input.inputMode = "numeric";
    input.value = code;
    input.placeholder = label === "Level 1" ? "kode wilayah (PP)" : "kode wilayah (PPKK)";
    input.setAttribute("aria-label", `Kode ${label} ${index + 1}`);
    input.addEventListener("change", () => update(index, input.value));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Hapus ${code}`);
    remove.addEventListener("click", () => removeCodeAt(index));
    row.append(input, remove);
    list.append(row);
  });
}

function allSnapshotFiles(): SqlFile[] {
  return (snapshot?.groups ?? []).flatMap((group) => group.files);
}

function pruneSelection(): void {
  const existing = new Set(allSnapshotFiles().map((file) => file.path));
  for (const path of [...selectedPaths]) {
    if (!existing.has(path)) selectedPaths.delete(path);
  }
}

function selectedFilesOrdered(): SqlFile[] {
  const wanted = new Set(selectedPaths);
  return allSnapshotFiles().filter((file) => wanted.has(file.path));
}

function selectionExportBase(files: SqlFile[]): string {
  const first = files[0]?.path.replace(/\.sql$/i, "") ?? "seleksi";
  const folder = first.includes("/") ? first.slice(0, first.lastIndexOf("/")) : "seleksi";
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
  return `${folder}/seleksi_${files.length}file_${stamp}`;
}

function updateSelectionBar(): void {
  const bar = byId("selection-bar");
  const count = byId("selection-count");
  const runButton = byId<HTMLButtonElement>("run-selected");
  bar.hidden = selectedPaths.size === 0;
  count.textContent = `${selectedPaths.size} file dipilih`;
  // Keep Stop clickable while the selection run itself is active.
  runButton.disabled = (folderRunning && !selectionRunning) || selectedPaths.size === 0;
  byId<HTMLInputElement>("combine-selected").checked = combineSelected;
}

interface QueueFileHooks {
  report: (message: string) => void;
  isStopped: () => boolean;
  signal: AbortSignal;
  tabId: number;
  trackRun: (runId: string) => void;
  untrackRun: (runId: string) => void;
}

async function runOneFile(
  file: SqlFile,
  activeConfig: WilayahConfig,
  output: ChunkedExport,
  hooks: QueueFileHooks,
): Promise<void> {
  const runId = createRunId();
  hooks.trackRun(runId);
  let pending: Promise<SqlChunkResponse> | undefined;
  try {
    await collectQuery(
      (offset, limit, iteration) => pending = chrome.runtime.sendMessage({
        type: "RUN_SQL_FILE",
        path: file.path,
        tabId: hooks.tabId,
        runId,
        offset,
        limit,
        iteration,
        wilayah: activeConfig,
      } satisfies ExtensionMessage) as Promise<SqlChunkResponse>,
      async (columns, rows) => {
        await output.append({ filename: file.path, title: extractSqlTitle(file.content, file.name), columns, rows });
        if (output.needsIntermediateFlush) {
          await output.flushIntermediate((message) => { hooks.report(message); });
        }
      },
      hooks.isStopped,
      (message) => { hooks.report(message); },
      hooks.signal,
    );
  } finally {
    hooks.untrackRun(runId);
    // Keep cancellation active until the outstanding request settles.
    void (pending ?? Promise.resolve()).then(() => clearRun(runId, hooks.tabId), () => clearRun(runId, hooks.tabId));
  }
}

function renderGroups(): void {
  const groupsElement = byId("groups");
  // Preserve open <details> across re-renders triggered by selection toggles.
  const openPaths = new Set(
    [...groupsElement.querySelectorAll("details.open")].map((item) => (item as HTMLElement).dataset.path ?? ""),
  );
  groupsElement.replaceChildren();
  pruneSelection();
  byId("empty-groups").hidden = Boolean(snapshot?.groups.length);
  for (const group of snapshot?.groups ?? []) {
    const details = document.createElement("details");
    details.className = "group";
    details.dataset.path = group.path;
    if (openPaths.has(group.path)) details.open = true;
    const summary = document.createElement("summary");
    const groupCheckbox = document.createElement("input");
    groupCheckbox.type = "checkbox";
    groupCheckbox.className = "select-box";
    groupCheckbox.setAttribute("aria-label", `Pilih semua file di ${group.path}`);
    const groupPaths = group.files.map((file) => file.path);
    const selectedInGroup = groupPaths.filter((path) => selectedPaths.has(path)).length;
    groupCheckbox.checked = group.files.length > 0 && selectedInGroup === group.files.length;
    groupCheckbox.indeterminate = selectedInGroup > 0 && selectedInGroup < group.files.length;
    groupCheckbox.addEventListener("click", (event) => event.stopPropagation());
    groupCheckbox.addEventListener("change", () => {
      if (folderRunning) {
        groupCheckbox.checked = !groupCheckbox.checked;
        byId("selection-status").textContent = "Tunggu run selesai untuk mengubah seleksi.";
        return;
      }
      if (groupCheckbox.checked) {
        for (const path of groupPaths) selectedPaths.add(path);
      } else {
        for (const path of groupPaths) selectedPaths.delete(path);
      }
      renderGroups();
    });
    const heading = document.createElement("span");
    heading.className = "group-name";
    const repeatedName = (snapshot?.groups ?? []).filter((candidate) => candidate.name === group.name).length > 1;
    heading.textContent = repeatedName ? group.path.replaceAll("/", " / ") : group.name;
    const meta = document.createElement("span");
    meta.className = "group-count";
    meta.textContent = `${group.path} · ${group.files.length} SQL file${group.files.length === 1 ? "" : "s"}`;
    summary.append(groupCheckbox, heading, meta);
    const files = document.createElement("div");
    files.className = "file-list";
    const batch = document.createElement("button");
    batch.textContent = "▶ Run Folder → Excel";
    batch.className = "secondary-button";
    const batchStatus = document.createElement("p");
    batchStatus.className = "progress";
    batchStatus.setAttribute("role", "status");
    let batchRunId: string | null = null;
    let batchTabId: number | null = null;
    let batchStopRequested = false;
    let batchController = new AbortController();
    batch.addEventListener("click", async () => {
      if (folderRunning) {
        if (!batchRunId || batchTabId === null) {
          batchStatus.textContent = "Run Folder lain masih berjalan.";
          return;
        }
        batchStopRequested = true;
        batchController.abort();
        batch.disabled = true;
        batch.textContent = "■ Stopping…";
        void stopRun(batchRunId, batchTabId);
        return;
      }
      folderRunning = true;
      batchStopRequested = false;
      batchController = new AbortController();
      batch.textContent = "■ Stop";
      batch.classList.add("stop-button");
      const targets = targetWilayahTargets(wilayah);
      let currentOutput: ChunkedExport | null = null;
      let currentPrefix = "";
      try {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (tab?.id === undefined) throw new Error("Aktifkan tab FASIH SQL Lab.");
        batchTabId = tab.id;
        for (const [targetIndex, wilayahTarget] of targets.entries()) {
          if (batchStopRequested) throw new Error("Run Folder dihentikan oleh pengguna.");
          const activeConfig: WilayahConfig = wilayahTarget.config;
          const exportPath = wilayahTarget.code ? `${group.path}_${wilayahTarget.code}` : group.path;
          const output = new ChunkedExport(exportPath);
          currentOutput = output;
          const provPrefix = wilayahTarget.code ? `${wilayahTarget.label} [${targetIndex + 1}/${targets.length}] - ` : "";
          currentPrefix = provPrefix;
          for (const [index, file] of group.files.entries()) {
            if (batchStopRequested) throw new Error("Run Folder dihentikan oleh pengguna.");
            batchStatus.textContent = `${provPrefix}File ${index + 1}/${group.files.length}: ${file.name} — menunggu hasil. Tetap buka panel dan tab query ini.`;
            await runOneFile(file, activeConfig, output, {
              tabId: tab.id!,
              signal: batchController.signal,
              isStopped: () => batchStopRequested,
              report: (message) => { batchStatus.textContent = `${provPrefix}File ${index + 1}/${group.files.length}: ${file.name} — ${message}`; },
              trackRun: (runId) => {
                batchRunId = runId;
                runProgressTargets.set(runId, (runProgress) => {
                  batchStatus.textContent = `${provPrefix}File ${index + 1}/${group.files.length}: ${file.name} — ${formatRunProgress(runProgress)}`;
                });
              },
              untrackRun: (runId) => {
                runProgressTargets.delete(runId);
                // Keep the Stop action available between files and while exporting.
              },
            });
          }
          batchStatus.textContent = `${provPrefix}Menulis Excel akhir: ${output.totalRows.toLocaleString("id-ID")} baris terkumpul, ${output.parts} bagian sudah tersimpan…`;
          await output.flush(true);
        }
        batchStatus.textContent = targets.length > 1
          ? `Selesai: ${targets.length} ${targets[0]?.kind === "kab" ? "kabupaten/kota" : "provinsi"} berhasil diproses.`
          : `Selesai: ${currentOutput?.totalRows.toLocaleString("id-ID") ?? 0} baris · ${currentOutput?.parts ?? 0} file Excel diunduh.`;
      } catch (error) {
        batchStatus.textContent = currentOutput
          ? `${currentPrefix}${await finishPartial(currentOutput, error)}`
          : (error instanceof Error ? error.message : "Run Folder gagal.");
      } finally {
        folderRunning = false;
        batchRunId = null;
        batchTabId = null;
        batchStopRequested = false;
        batch.disabled = false;
        batch.textContent = "▶ Run Folder → Excel";
        batch.classList.remove("stop-button");
      }
    });
    files.append(batch, batchStatus);
    for (const file of group.files) {
      const select = document.createElement("input");
      select.type = "checkbox";
      select.className = "select-box";
      select.checked = selectedPaths.has(file.path);
      select.setAttribute("aria-label", `Pilih ${file.path}`);
      select.addEventListener("change", () => {
        if (folderRunning) {
          select.checked = !select.checked;
          byId("selection-status").textContent = "Tunggu run selesai untuk mengubah seleksi.";
          return;
        }
        if (select.checked) selectedPaths.add(file.path);
        else selectedPaths.delete(file.path);
        updateSelectionBar();
        // Refresh group header indeterminate state while keeping open <details>.
        renderGroups();
      });
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = file.name;
      button.addEventListener("click", () => showPreview(file.name, file.path, file.content));
      const row = document.createElement("div");
      row.style.display = "grid";
      row.className = "file-row";
      const actions = document.createElement("div");
      actions.className = "file-actions";
      const copy = document.createElement("button");
      copy.type = "button";
      copy.textContent = "⧉ Copy";
      copy.title = "Salin SQL dengan filter wilayah aktif";
      const run = document.createElement("button");
      run.type = "button";
      run.textContent = "▶ Run";
      run.title = "Jalankan SQL dan unduh Excel otomatis; Stop mengunduh hasil parsial";
      const status = document.createElement("p");
      status.className = "progress";
      status.setAttribute("role", "status");
      let activeRun: { runId: string; tabId: number } | null = null;
      let stopRequested = false;
      let controller = new AbortController();
      copy.addEventListener("click", async () => {
        try {
          await copyText(applyWilayahConfig(file.content, wilayah));
          status.textContent = "SQL tersalin ke clipboard.";
        } catch (error) {
          status.textContent = error instanceof Error ? error.message : "SQL gagal disalin.";
        }
      });
      run.addEventListener("click", async () => {
        if (activeRun) {
          stopRequested = true;
          controller.abort();
          run.disabled = true;
          run.textContent = "■ Stopping…";
          void stopRun(activeRun.runId, activeRun.tabId);
          return;
        }
        if (folderRunning) { status.textContent = "Tunggu Run Folder selesai."; return; }
        folderRunning = true;
        stopRequested = false;
        controller = new AbortController();
        const targets = targetWilayahTargets(wilayah);
        const basePath = file.path.replace(/\.sql$/i, "");
        let currentOutput: ChunkedExport | null = null;
        let currentPrefix = "";
        try {
          const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          if (tab?.id === undefined) throw new Error("Aktifkan tab FASIH SQL Lab.");
          run.textContent = "■ Stop";
          run.classList.add("stop-button");
          for (const [targetIndex, wilayahTarget] of targets.entries()) {
            if (stopRequested) throw new Error("Run dihentikan oleh pengguna.");
            const activeConfig: WilayahConfig = wilayahTarget.config;
            const exportPath = wilayahTarget.code ? `${basePath}_${wilayahTarget.code}` : basePath;
            const output = new ChunkedExport(exportPath);
            currentOutput = output;
            const provPrefix = wilayahTarget.code ? `${wilayahTarget.label} [${targetIndex + 1}/${targets.length}] - ` : "";
            currentPrefix = provPrefix;
            status.textContent = `${provPrefix}Mengirim SQL ke editor aktif...`;
            await runOneFile(file, activeConfig, output, {
              tabId: tab.id!,
              signal: controller.signal,
              isStopped: () => stopRequested,
              report: (message) => { status.textContent = `${provPrefix}${message}`; },
              trackRun: (runId) => {
                activeRun = { runId, tabId: tab.id! };
                runProgressTargets.set(runId, (runProgress) => {
                  status.textContent = `${provPrefix}${formatRunProgress(runProgress)}`;
                });
              },
              untrackRun: (runId) => {
                runProgressTargets.delete(runId);
              },
            });
            status.textContent = `${provPrefix}Menulis Excel akhir: ${output.totalRows.toLocaleString("id-ID")} baris terkumpul, ${output.parts} bagian sudah tersimpan…`;
            await output.flush(true);
          }
          status.textContent = targets.length > 1
            ? `Selesai: ${targets.length} ${targets[0]?.kind === "kab" ? "kabupaten/kota" : "provinsi"} berhasil diproses.`
            : `Selesai: ${currentOutput?.totalRows.toLocaleString("id-ID") ?? 0} baris · ${currentOutput?.parts ?? 0} file Excel diunduh.`;
        } catch (error) {
          status.textContent = currentOutput
            ? `${currentPrefix}${await finishPartial(currentOutput, error)}`
            : (error instanceof Error ? error.message : "Run gagal.");
        } finally {
          folderRunning = false;
          activeRun = null;
          stopRequested = false;
          run.disabled = false;
          run.textContent = "▶ Run";
          run.classList.remove("stop-button");
        }
      });
      actions.append(copy, run);
      row.append(select, button, actions);
      files.append(row, status);
    }
    details.append(summary, files);
    groupsElement.append(details);
  }
  updateSelectionBar();
}

async function runSelected(): Promise<void> {
  const statusEl = byId("selection-status");
  const runButton = byId<HTMLButtonElement>("run-selected");
  if (folderRunning) {
    if (!selectionRunId || selectionTabId === null) {
      statusEl.textContent = "Run lain masih berjalan.";
      return;
    }
    selectionStopRequested = true;
    selectionController.abort();
    runButton.disabled = true;
    runButton.textContent = "■ Stopping…";
    void stopRun(selectionRunId, selectionTabId);
    return;
  }
  const files = selectedFilesOrdered();
  if (files.length === 0) {
    statusEl.textContent = "Pilih minimal 1 file lintas folder untuk dijalankan.";
    return;
  }
  folderRunning = true;
  selectionRunning = true;
  updateSelectionBar();
  selectionStopRequested = false;
  selectionController = new AbortController();
  runButton.textContent = "■ Stop";
  const targets = targetWilayahTargets(wilayah);
  const combine = combineSelected;
  let currentOutput: ChunkedExport | null = null;
  let currentPrefix = "";
  let doneFiles = 0;
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id === undefined) throw new Error("Aktifkan tab FASIH SQL Lab.");
    selectionTabId = tab.id;
    for (const [targetIndex, wilayahTarget] of targets.entries()) {
      if (selectionStopRequested) throw new Error("Run Terpilih dihentikan oleh pengguna.");
      const targetPrefix = wilayahTarget.code ? `${wilayahTarget.label} [${targetIndex + 1}/${targets.length}] - ` : "";
      if (combine) {
        const exportPath = wilayahTarget.code
          ? `${selectionExportBase(files)}_${wilayahTarget.code}`
          : selectionExportBase(files);
        const output = new ChunkedExport(exportPath);
        currentOutput = output;
        currentPrefix = targetPrefix;
        for (const [index, file] of files.entries()) {
          if (selectionStopRequested) throw new Error("Run Terpilih dihentikan oleh pengguna.");
          statusEl.textContent = `${targetPrefix}File ${index + 1}/${files.length}: ${file.path} — menunggu hasil. Tetap buka panel dan tab query ini.`;
          await runOneFile(file, wilayahTarget.config, output, {
            tabId: tab.id!,
            signal: selectionController.signal,
            isStopped: () => selectionStopRequested,
            report: (message) => { statusEl.textContent = `${targetPrefix}File ${index + 1}/${files.length}: ${file.name} — ${message}`; },
            trackRun: (runId) => {
              selectionRunId = runId;
              runProgressTargets.set(runId, (runProgress) => {
                statusEl.textContent = `${targetPrefix}File ${index + 1}/${files.length}: ${file.name} — ${formatRunProgress(runProgress)}`;
              });
            },
            untrackRun: (runId) => { runProgressTargets.delete(runId); },
          });
          doneFiles++;
        }
        statusEl.textContent = `${targetPrefix}Menulis Excel akhir: ${output.totalRows.toLocaleString("id-ID")} baris terkumpul, ${output.parts} bagian sudah tersimpan…`;
        await output.flush(true);
      } else {
        for (const [index, file] of files.entries()) {
          if (selectionStopRequested) throw new Error("Run Terpilih dihentikan oleh pengguna.");
          const basePath = file.path.replace(/\.sql$/i, "");
          const exportPath = wilayahTarget.code ? `${basePath}_${wilayahTarget.code}` : basePath;
          const output = new ChunkedExport(exportPath);
          currentOutput = output;
          currentPrefix = targetPrefix;
          await runOneFile(file, wilayahTarget.config, output, {
            tabId: tab.id!,
            signal: selectionController.signal,
            isStopped: () => selectionStopRequested,
            report: (message) => { statusEl.textContent = `${targetPrefix}File ${index + 1}/${files.length}: ${file.name} — ${message}`; },
            trackRun: (runId) => {
              selectionRunId = runId;
              runProgressTargets.set(runId, (runProgress) => {
                statusEl.textContent = `${targetPrefix}File ${index + 1}/${files.length}: ${file.name} — ${formatRunProgress(runProgress)}`;
              });
            },
            untrackRun: (runId) => { runProgressTargets.delete(runId); },
          });
          doneFiles++;
          statusEl.textContent = `${targetPrefix}Menulis Excel akhir (${file.name}): ${output.totalRows.toLocaleString("id-ID")} baris terkumpul…`;
          await output.flush(true);
        }
      }
    }
    const unit = targets.length > 1 ? (targets[0]?.kind === "kab" ? "kabupaten/kota" : "provinsi") : "";
    statusEl.textContent = targets.length > 1
      ? `Selesai: ${doneFiles} file × ${targets.length} ${unit} berhasil diproses.`
      : `Selesai: ${doneFiles} file berhasil diproses · ${currentOutput?.totalRows.toLocaleString("id-ID") ?? 0} baris · ${currentOutput?.parts ?? 0} file Excel diunduh.`;
  } catch (error) {
    statusEl.textContent = currentOutput
      ? `${currentPrefix}${await finishPartial(currentOutput, error)}`
      : (error instanceof Error ? error.message : "Run Terpilih gagal.");
  } finally {
    folderRunning = false;
    selectionRunning = false;
    selectionRunId = null;
    selectionTabId = null;
    selectionStopRequested = false;
    runButton.disabled = false;
    runButton.textContent = "▶ Run Terpilih → Excel";
    updateSelectionBar();
  }
}

async function persistWilayah(next: WilayahConfig): Promise<boolean> {
  const validation = validateWilayah(next);
  if (!validation.valid) {
    wilayahError = validation.errors[0] ?? "Konfigurasi wilayah tidak valid.";
    byId("wilayah-error").textContent = wilayahError;
    return false;
  }
  wilayah = next;
  wilayahError = "";
  await saveWilayah(wilayah);
  byId("wilayah-error").textContent = "";
  const saved = byId("wilayah-saved");
  saved.textContent = "Tersimpan";
  window.setTimeout(() => (saved.textContent = ""), 1200);
  return true;
}

async function updateCode(level: "level1" | "level2", index: number, code: string): Promise<void> {
  const next = [...wilayah[level]];
  next[index] = code.trim();
  await persistWilayah({ ...wilayah, [level]: next });
  renderWilayah();
}

async function removeCode(level: "level1" | "level2", index: number): Promise<void> {
  await persistWilayah({ ...wilayah, [level]: wilayah[level].filter((_, candidate) => candidate !== index) });
  renderWilayah();
}

async function confirmAdd(level: "level1" | "level2", input: HTMLInputElement, rowId: string): Promise<void> {
  const code = input.value.trim();
  const next = addWilayahCode(wilayah, level, code);
  if (next === wilayah) {
    const label = level === "level1" ? "Level 1" : "Level 2";
    wilayahError = wilayah[level].includes(code) ? `Kode ${label} tidak boleh duplikat.` : `Kode ${label} harus berisi angka.`;
    renderWilayah();
    return;
  }
  await persistWilayah(next);
  input.value = "";
  byId(rowId).hidden = true;
  renderWilayah();
}

function showPreview(name: string, path: string, content: string): void {
  byId("preview-name").textContent = name;
  byId("preview-path").textContent = path;
  byId("preview-content").textContent = content;
  byId<HTMLDialogElement>("preview-dialog").showModal();
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function createRunId(): string {
  return crypto.randomUUID();
}

function formatRunProgress(progress: SqlRunProgress): string {
  const rows = new Intl.NumberFormat("id-ID").format(progress.rowsCollected);
  return progress.state === "running"
    ? `Proses ke-${progress.iteration} sedang berjalan · ${rows} baris terkumpul`
    : `Proses ke-${progress.iteration} selesai · ${rows} baris terkumpul`;
}

async function finishPartial(output: ChunkedExport, error: unknown): Promise<string> {
  const reason = error instanceof Error ? error.message : "Run gagal.";
  try {
    await output.flush(true, true);
    return `${reason} ${output.parts ? `Hasil parsial: ${output.totalRows.toLocaleString("id-ID")} baris · ${output.parts} file Excel diunduh.` : "Belum ada hasil yang dapat diunduh."}`;
  } catch (exportError) {
    return `${reason} Ekspor sisa hasil gagal: ${exportError instanceof Error ? exportError.message : "Error Excel"}. ${output.parts} bagian sebelumnya sudah diunduh.`;
  }
}

async function clearRun(runId: string, tabId: number): Promise<void> {
  await chrome.runtime.sendMessage({ type: "CLEAR_SQL_RUN", runId, tabId } satisfies ExtensionMessage).catch(() => undefined);
}

async function stopRun(runId: string, tabId: number): Promise<{ ok: boolean; message: string }> {
  try {
    return await chrome.runtime.sendMessage({ type: "STOP_SQL_RUN", runId, tabId } satisfies ExtensionMessage) as { ok: boolean; message: string };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Query gagal dihentikan." };
  }
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textArea = document.createElement("textarea");
  textArea.value = value;
  textArea.style.position = "fixed";
  textArea.style.opacity = "0";
  document.body.append(textArea);
  textArea.select();
  const copied = document.execCommand("copy");
  textArea.remove();
  if (!copied) throw new Error("SQL gagal disalin ke clipboard.");
}

// Handler dipertahankan agar fitur GitLab dapat diaktifkan kembali cukup dengan
// mengembalikan tombol #sync pada template di atas.
syncButton?.addEventListener("click", async () => {
  progress = { phase: "connecting", message: "Connecting to GitLab..." };
  renderSource();
  try {
    const result = (await chrome.runtime.sendMessage({ type: "SYNC_REPOSITORY" } satisfies ExtensionMessage)) as ScanResult;
    if (!result.ok) throw new Error(result.error);
    snapshot = result.snapshot;
    progress = { phase: "success", message: "Synced" };
    render();
  } catch (error) {
    progress = { phase: "error", message: error instanceof Error ? error.message : "Sync failed" };
    renderSource();
  }
});

importButton.addEventListener("click", () => folderInput.click());
folderInput.addEventListener("change", () => void importRepositoryFolder(folderInput.files));

async function importRepositoryFolder(fileList: FileList | null): Promise<void> {
  if (!fileList?.length) return;
  const selected = [...fileList];
  const sqlFiles = selected.filter((file) => isSqlPath(file.name) && file.webkitRelativePath.split("/").length > 2);
  if (sqlFiles.length === 0) {
    progress = { phase: "error", message: "Tidak ada SQL dalam subfolder. SQL di root diabaikan; pilih folder repository yang membungkus query groups." };
    renderSource();
    folderInput.value = "";
    return;
  }

  const firstPath = selected[0]?.webkitRelativePath || selected[0]?.name || "repository";
  const rootFolder = firstPath.split("/")[0] || "repository";
  try {
    const importedFiles: SqlFile[] = [];
    for (const [index, file] of sqlFiles.entries()) {
      progress = {
        phase: "reading",
        message: `Reading ${index + 1} / ${sqlFiles.length} SQL files...`,
        current: index + 1,
        total: sqlFiles.length,
      };
      renderSource();
      const fullPath = file.webkitRelativePath || file.name;
      const relativePath = fullPath.startsWith(`${rootFolder}/`) ? fullPath.slice(rootFolder.length + 1) : fullPath;
      importedFiles.push({ name: file.name, path: relativePath, content: await file.text() });
    }

    const nextSnapshot: RepositorySnapshot = {
      version: 1,
      repository: {
        name: rootFolder,
        namespace: "local-folder",
        branch: "local import",
        syncedAt: new Date().toISOString(),
        sqlCount: importedFiles.length,
      },
      groups: groupSqlFiles(importedFiles),
    };
    progress = { phase: "saving", message: "Mengganti seluruh cache SQL dengan folder impor terbaru..." };
    renderSource();
    await saveSnapshot(nextSnapshot);
    snapshot = nextSnapshot;
    progress = { phase: "success", message: "Imported — cache lama diganti" };
    render();
  } catch (error) {
    progress = { phase: "error", message: error instanceof Error ? error.message : "Import folder gagal." };
    renderSource();
  } finally {
    folderInput.value = "";
  }
}

chrome.runtime.onMessage.addListener((message: ExtensionMessage) => {
  if (message.type === "SQL_RUN_PROGRESS") {
    runProgressTargets.get(message.progress.runId)?.(message.progress);
    return;
  }
  if (message.type !== "SYNC_PROGRESS") return;
  progress = message.progress;
  renderSource();
});

byId("show-level1-add").addEventListener("click", () => {
  byId("add-level1-row").hidden = false;
  newLevel1Input.focus();
});
byId("confirm-level1").addEventListener("click", () => void confirmAdd("level1", newLevel1Input, "add-level1-row"));
newLevel1Input.addEventListener("keydown", (event) => {
  if (event.key === "Enter") void confirmAdd("level1", newLevel1Input, "add-level1-row");
});
byId("show-level2-add").addEventListener("click", () => {
  byId("add-level2-row").hidden = false;
  newLevel2Input.focus();
});
byId("confirm-level2").addEventListener("click", () => void confirmAdd("level2", newLevel2Input, "add-level2-row"));
newLevel2Input.addEventListener("keydown", (event) => {
  if (event.key === "Enter") void confirmAdd("level2", newLevel2Input, "add-level2-row");
});
byId<HTMLInputElement>("split-level1").addEventListener("change", async (event) => {
  const target = event.target as HTMLInputElement;
  await persistWilayah({ ...wilayah, splitLevel1: target.checked });
  renderWilayah();
});
byId<HTMLInputElement>("split-level2").addEventListener("change", async (event) => {
  const target = event.target as HTMLInputElement;
  await persistWilayah({ ...wilayah, splitLevel2: target.checked });
  renderWilayah();
});
byId("close-preview").addEventListener("click", () => byId<HTMLDialogElement>("preview-dialog").close());
byId<HTMLButtonElement>("run-selected").addEventListener("click", () => void runSelected());
byId("clear-selected").addEventListener("click", () => {
  selectedPaths.clear();
  byId("selection-status").textContent = "";
  renderGroups();
});
byId<HTMLInputElement>("combine-selected").addEventListener("change", (event) => {
  combineSelected = (event.target as HTMLInputElement).checked;
});

void initialize();
