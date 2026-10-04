# QueryFlow

QueryFlow adalah Chrome Extension untuk mengimpor kumpulan SQL, menerapkan parameter, menjalankan query secara individual maupun per folder pada SQL Lab yang didukung, dan menggabungkan hasil batch ke workbook Excel.

- **Integrasi saat ini:** FASIH Dashboard / FASIH SQL Lab.
- **Case saat ini:** SE2026 — Sensus Ekonomi 2026.
- **Author:** D. Agung Sungkono.

QueryFlow adalah utilitas yang terintegrasi dengan FASIH, bukan produk atau dokumentasi resmi BPS/FASIH.

## Overview

QueryFlow membantu mengimpor koleksi SQL lokal, menyimpan snapshot, mengatur parameter yang didukung, menjalankan satu query atau seluruh file dalam satu folder secara berurutan, mengumpulkan hasil, dan membuat workbook Excel dengan satu sheet per hasil SQL.

**Satu folder SQL = satu execution group; hasil besar dipecah menjadi beberapa workbook Excel.** File yang langsung berada dalam folder menjadi anggota group; subfolder menjadi group tersendiri.

```text
Agregat/Kategori_A/
    Agregat_1a.sql
    Agregat_1b.sql
    Agregat_1c.sql
    Agregat_1d.sql

→ Agregat_Kategori_A.xlsx
    Tabel 1A - Judul tabel A
    Tabel 1B - Judul tabel B
    Tabel 1C - Judul tabel C
    Tabel 1D - Judul tabel D
```

## Workflow

```text
SQL Folder
    ↓
Import Folder
    ↓
Local Snapshot
    ↓
Configure Parameters
    ↓
FASIH SQL Lab
    ↓
Run Query / Run Folder
    ↓
Collect Results
    ↓
Excel Workbook (Run Folder)
    ├── Sheet 1
    ├── Sheet 2
    └── Sheet N
```

Import dan eksekusi adalah operasi terpisah. Snapshot dapat digunakan kembali tanpa import ulang sampai data extension dibersihkan, extension dihapus, atau pengguna mengimpor snapshot baru. Perubahan pada folder asli tidak otomatis mengubah snapshot.

## Requirements

- Google Chrome / Chromium yang mendukung Manifest V3 dan Side Panel.
- Akses ke FASIH Dashboard yang didukung dan akun yang berwenang mengakses SQL Lab.
- Folder lokal berisi file `.sql` dalam subfolder query.
- Node.js 20.19+ atau 22.12+ hanya untuk development/build.

QueryFlow tidak menyimpan username atau password FASIH. Autentikasi dilakukan langsung melalui FASIH Dashboard.

## Build dan Installation

```bash
npm install
npm run build
```

1. Buka `chrome://extensions` dan aktifkan **Developer mode**.
2. Klik **Load unpacked**, lalu pilih folder `dist/`.
3. Pin **QueryFlow** agar Side Panel mudah dibuka.
4. Setelah rebuild, klik **Reload** pada extension, lalu buka kembali panel.

## Import SQL

1. Buka QueryFlow dan klik **Import Folder SQL**.
2. Pilih folder utama kumpulan query/repository, bukan subfolder tabel individual.
3. Tunggu status **Imported** dan periksa jumlah file serta daftar folder SQL.

Hanya file `.sql` dalam subfolder yang diimpor. SQL langsung di root pilihan, seperti `template.sql`, diabaikan. Path folder tetap ditampilkan untuk membedakan group dengan nama sama.

**Import Folder SQL bukan Git clone, Git pull, atau modifikasi source file.** QueryFlow membaca file lokal dan membuat snapshot sendiri di `chrome.storage.local`. File SQL asli tidak ditulis.

Import ulang mengganti seluruh snapshot setelah pembacaan dan penyimpanan berhasil; file yang dihapus dari folder terbaru tidak dipertahankan. Kegagalan import mempertahankan snapshot sukses sebelumnya. Adapter GitLab lama masih tersedia dalam source, tetapi tombol sinkronisasinya dinonaktifkan; alur pengguna memakai folder lokal.

## Case 1: SE2026

Skema filter berikut khusus untuk case SE2026. QueryFlow tidak terbatas pada koleksi SQL SE2026.

- **Level 1 / Provinsi:** satu atau beberapa kode provinsi.
- **Level 2 / Kabupaten/Kota:** satu atau beberapa kode kabupaten/kota.
- Level 2 berprioritas jika terisi; Level 1 diabaikan saat eksekusi.
- Jika Level 2 kosong, Level 1 digunakan.
- Jika keduanya kosong, QueryFlow tidak memberikan pembatasan wilayah melalui parameter ini. Kondisi lain dalam SQL tetap berlaku.

| Level 1 | Level 2 | Filter |
| --- | --- | --- |
| `35` | kosong | Semua kabupaten/kota yang didukung query dalam provinsi `35` |
| `35` | `3507`, `3515` | Hanya `3507` dan `3515` |
| kosong | `3507`, `3515` | Hanya `3507` dan `3515` |

Kode harus numerik dan tidak duplikat. Konfigurasi tersimpan otomatis secara lokal.

## Supported SQL Parameters

Gunakan format berikut untuk parameter SE2026:

```sql
WITH param_wilayah AS (
    SELECT
        '' AS filter_provinsi,
        '' AS filter_kabupaten
)
```

Penggantian terjadi hanya dalam **salinan eksekusi**; file asli dan source SQL dalam cache tetap utuh. Beberapa kode digabung dengan pemisah `|`. Pola perbandingan provinsi yang didukung diubah menjadi pencocokan keanggotaan untuk beberapa provinsi; kondisi filter dalam SQL harus sesuai dengan skema ini.

SQL tanpa kedua alias yang didukung tetap dapat dijalankan tanpa penggantian parameter SE2026. Transformasi deterministik menggunakan aturan di `src/services/sql/index.ts`, bukan AI/LLM.

## SQL Metadata

Tambahkan metadata pada komentar blok pertama SQL:

```sql
/*
Judul       : Nama tabel hasil
Tujuan      : Keterangan singkat
Kategori    : Agregat
Database/dialek : Fasih Data
Pembuat     : Nama pembuat query
Tanggal     : 2026-09-25
*/
```

`Judul:`, `Nama Tabel:`, dan `Judul Tabel:` didukung tanpa membedakan huruf besar/kecil. Nilai pertama yang tidak kosong dalam komentar blok pertama menjadi judul baris pertama Excel dan bagian judul pada nama sheet. Jika tidak tersedia, judul memakai nama file tanpa `.sql`. Metadata lainnya untuk dokumentasi.

## Menjalankan Query

1. Buka `https://fasih-dashboard.bps.go.id/superset/sqllab/` dan login.
2. Pilih tab query aktif, database, schema, dan LIMIT yang sesuai.
3. Pastikan tidak ada query lain berjalan pada tab tersebut.
4. Buka QueryFlow tanpa berpindah dari tab FASIH SQL Lab dan pilih folder SQL.

### Run

Klik **Run** di samping satu file. Isi editor aktif diganti dengan salinan SQL yang diparameterisasi, kemudian RUN ditekan. Selama query berjalan tombol berubah menjadi **Stop**. Hasil otomatis diunduh ke Excel; Stop mengunduh chunk yang sudah berhasil diterima sebagai hasil parsial.

### Run Folder → Excel

Semua SQL dalam folder dijalankan berurutan. Query berikutnya dimulai setelah query sebelumnya sukses dan hasilnya terbaca. Tombol Run Folder juga berubah menjadi **Stop** selama batch aktif. Tetap buka Side Panel; jangan mengganti tab query atau menjalankan query lain selama batch.

Ukuran awal chunk adalah 9.000 baris dan otomatis mengecil jika batas ukuran tercapai. QueryFlow menjalankan chunk berikutnya dengan `OFFSET` sesuai jumlah baris yang sudah diterima hingga tidak ada hasil lanjutan. Panel menampilkan **Proses ke-n** dan total baris yang telah terkumpul. Gangguan sesaat (perubahan tab, service worker disuspend) dicoba ulang otomatis 3x per chunk sebelum batch dinyatakan gagal.

**SQL dalam folder dijalankan berdasarkan natural filename order.** Contoh: `Tabel1.sql`, `Tabel2.sql`, …, `Tabel10.sql`; suffix `1a`, `1b`, `1c`, `1d` tetap berurutan. Snapshot lama juga diurutkan saat dibuka kembali.

Semua tabel dalam satu folder digabung menjadi satu workbook, misalnya `Agregat/Kategori_A` → `Agregat_Kategori_A.xlsx`. Hanya jika ukuran XLSX akhir melebihi 20 MiB (20 × 1024 × 1024 byte), hasil dipecah menjadi `_part-001.xlsx`, `_part-002.xlsx`, dan seterusnya. Run satu SQL juga mengekspor Excel. Cukup sekali klik Run; chunk berikutnya dijalankan otomatis.

## Excel Output

- Workbook mengikuti path folder tanpa awalan `Hasil_`: `Agregat/Kategori_A` → `Agregat_Kategori_A.xlsx`. Pemisah folder dan karakter khusus diganti underscore sehingga folder Agregat dan Mikro dapat dibedakan.
- Satu hasil SQL menjadi satu sheet, mengikuti urutan eksekusi.
- Nama sheet langsung memakai judul SQL: `Agregat_1a.sql` dengan metadata `Judul: Jumlah usaha` → `Jumlah usaha`. Jika metadata tidak tersedia, nama sheet memakai nama file tanpa `.sql`. Judul lengkap tetap ditulis pada baris 1 meskipun nama sheet dipotong.
- Nama sheet maksimal 31 karakter; karakter terlarang diganti dan nama duplikat diberi suffix angka.
- Baris 1: metadata `Judul:` atau fallback nama file, digabung selebar kolom hasil.
- Baris 2: nama kolom.
- Baris 3+: data query. Dua baris pertama dibekukan.

Data dibaca dari state hasil SQL Lab, bukan hanya baris tabel yang terlihat. Setiap permintaan mengambil maksimal 9.000 baris, dengan respons transfer dibatasi sekitar 2 MiB sebelum dikirim ke extension. Offset maju hanya sebanyak baris yang benar-benar diterima. Jika SQL Lab atau transport melaporkan batas ukuran, jumlah baris per permintaan dibagi dua dan offset yang sama dicoba kembali, hingga minimal satu baris. Error lain menghentikan proses dan mengekspor hasil parsial.

Chunk hanya membatasi pengambilan data. Semua chunk dan tabel dikumpulkan sampai selesai, Stop, atau error, lalu ukuran XLSX sesudah kompresi diperiksa. Workbook hanya dipecah jika melampaui 20 MiB; setiap bagian berukuran maksimal 20 MiB dan mengulang judul/header. Jumlah baris, sel, maupun pergantian tabel tidak memicu file terpisah. Unduhan menggunakan izin Chrome `downloads`; nama yang sudah ada mendapat nama unik otomatis.

QueryFlow menambahkan `ORDER BY 1 ASC` bila query belum memiliki ORDER BY tingkat terluar. Untuk pagination yang konsisten, gunakan ORDER BY dengan kunci unik dan sumber data yang tidak berubah selama proses. Kolom pertama yang tidak unik tidak menjamin urutan antarhalaman.

## Jika Eksekusi Gagal

Query berjalan berurutan dengan batas tunggu empat menit per chunk. Jika satu query gagal atau Stop ditekan, query berikutnya tidak dijalankan. Semua chunk yang sudah diterima tetap diekspor, termasuk query sebelumnya dalam folder dan chunk selesai dari query aktif. Hasil yang terkumpul digabung dan langsung diunduh dengan suffix `_partial.xlsx`, dengan aturan pemecahan 20 MiB yang sama. Jika belum ada hasil, panel menyatakannya tanpa membuat file kosong.

Tombol Stop mengirim pembatalan ke proses QueryFlow dan menekan Stop pada SQL Lab jika tombolnya tersedia. Baris dari chunk yang masih berjalan dan belum menghasilkan respons sukses belum dapat diunduh. Panel menampilkan jumlah baris dan file yang berhasil dikirim ke unduhan Chrome. Jika ekspor Excel sendiri gagal, panel melaporkan kegagalan tersebut.

1. Identifikasi SQL yang gagal dari pesan panel.
2. Periksa pilihan database/schema.
3. Periksa sesi FASIH masih aktif.
4. Periksa SQL dan error SQL Lab.
5. Perbaiki penyebabnya; import ulang jika source SQL lokal berubah.
6. Jalankan folder kembali setelah query sebelumnya selesai atau dihentikan di FASIH.

Versi ini **tidak mendukung resume**. Query yang sudah sukses pada batch gagal akan dijalankan lagi saat folder dicoba ulang.

## Data & Privacy

- Snapshot SQL tersimpan di `chrome.storage.local`, key `repositorySnapshot`; wilayah di `wilayahConfig`.
- File asli dan source SQL dalam cache tidak diubah saat eksekusi.
- QueryFlow tidak menyimpan username/password FASIH atau membaca token/cookie secara manual.
- SQL dieksekusi melalui sesi FASIH SQL Lab yang sudah login; SQL dikirim ke FASIH.
- Tidak ada AI/LLM, telemetry, atau pengiriman SQL/hasil yang disengaja ke layanan pihak ketiga oleh QueryFlow.
- Hasil ditampung per bagian dalam memori panel untuk membuat Excel lokal, bukan disimpan sebagai cache hasil permanen. Menutup panel sebelum buffer diekspor dapat menghilangkan bagian yang belum diunduh.
- Menghapus storage/extension menghilangkan state lokal QueryFlow. Excel yang sudah diunduh tetap di lokasi unduhan.
- Izin host meliputi FASIH dan GitLab BPS; GitLab dipertahankan untuk adapter lama. Tidak ada izin semua situs.

Jangan masukkan kredensial, snapshot pengguna, atau hasil query ke repository. `.gitignore` mengecualikan `.env`, SQL lokal, CSV/XLSX, folder snapshot/hasil, dependencies, dan build. Contoh konfigurasi tidak membutuhkan kredensial.

## Limitations

- Integrasi aktif saat ini FASIH SQL Lab; SE2026 adalah case parameterisasi yang didokumentasikan.
- Belum ada pemilih atau konfigurasi multi-case.
- Integrasi bergantung pada editor Ace, tombol RUN, dan state React/Redux FASIH/Superset; perubahan dapat memerlukan penyesuaian `src/background/sql-lab.ts`.
- Tidak ada resume setelah gagal; Side Panel harus tetap terbuka selama batch.
- Satu baris/header yang melebihi batas transfer tidak dapat diambil; hasil sebelumnya tetap diekspor. SQL Lab sendiri masih menyimpan riwayat/state query dan tetap dibatasi kapasitas browser/server; snapshot mengikuti kuota `chrome.storage.local`.
- Natural order mengurutkan nama file, bukan menganalisis dependensi antar-query.

## Development

```bash
npm install
npm run test
npm run typecheck
npm run lint
npm run build
```

Lokasi utama: `src/sidepanel/` (UI), `src/background/sql-lab.ts` (FASIH), `src/services/storage/` (snapshot), `src/services/sql/` (parameter/metadata), `src/services/excel.ts` (Excel). Adapter GitLab lama berada di `src/content/gitlab/`.

Setelah build, reload extension di `chrome://extensions`. Tes lokal memverifikasi logika; kompatibilitas live FASIH tetap perlu diuji pada browser yang sudah login.
