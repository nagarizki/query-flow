import type { WilayahConfig } from "../../types";

const PARAMETER_VALUE = (alias: string): RegExp =>
  new RegExp(`'(?:''|[^'])*'\\s+AS\\s+${alias}\\b`, "i");

const TITLE_PREFIX = /^[\t ]*(?:\*+[\t ]*)?(?:Nama[\t ]+Tabel|Judul[\t ]+Tabel|Judul)[\t ]*:[\t ]*(.*)$/i;
const TABLE_PREFIX = /^[\t ]*(?:\*+[\t ]*)?((?:Tabel|Table)\b.*)$/i;
const METADATA_KEY = /^(?:Tujuan|Kategori|Database(?:\/dialek)?|Dialek|Pembuat|Penyusun|Tanggal|Date|Creator|Author|Sumber|Source|Catatan|Notes?|Keterangan|Deskripsi|Description|Parameter|Filter|Versi|Version|Schema|PIC|Penanggung[\t ]+Jawab|Modul|Target|Referensi|Ref|Instansi|Unit|Status|Tipe|Type|User|Nama[\t ]+Tabel|Judul[\t ]+Tabel|Judul)[\t ]*:/i;

function cleanCommentLine(line: string): string {
  return line
    .replace(/^[\t ]*(?:\*+[\t ]*)?/, "")
    .replace(/(?:[\t ]+\*+)+[\t ]*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractSqlTitle(sql: string, fallback: string): string {
  const comment = sql.match(/\/\*([\s\S]*?)\*\//)?.[1]
    ?? sql.match(/^(?:[\t ]*--[^\r\n]*(?:\r?\n|$))+/)?.[0].replace(/^[\t ]*--[\t ]?/gm, "");
  if (comment) {
    const lines = comment.split(/\r?\n/);
    let startIndex = lines.findIndex((line) => TITLE_PREFIX.test(line));
    let initialText = "";

    if (startIndex !== -1) {
      initialText = cleanCommentLine(lines[startIndex]?.match(TITLE_PREFIX)?.[1] ?? "");
    } else {
      startIndex = lines.findIndex((line) => TABLE_PREFIX.test(line));
      if (startIndex !== -1) {
        initialText = cleanCommentLine(lines[startIndex]?.match(TABLE_PREFIX)?.[1] ?? "");
      }
    }

    if (startIndex !== -1) {
      const parts: string[] = [];
      if (initialText) parts.push(initialText);

      // ponytail: stops at next metadata key, empty line, or comment end; add full parser if SQL headers adopt yaml/toml.
      for (let i = startIndex + 1; i < lines.length; i++) {
        const cleaned = cleanCommentLine(lines[i] ?? "");
        if (!cleaned || METADATA_KEY.test(cleaned)) break;
        parts.push(cleaned);
      }

      if (parts.length > 0) return parts.join(" ");
    }
  }

  return fallback.replace(/\.sql$/i, "");
}

export function applyWilayahConfig(sql: string, config: WilayahConfig): string {
  // The repository predicates combine province and regency filters with OR.
  // Therefore a populated province would broaden an explicit regency selection
  // to the entire province. Regency/city selections intentionally take priority.
  const provinceValue = config.level2.length > 0 ? "" : config.level1.join("|");
  const regencyValue = config.level2.join("|");
  const provincePattern = PARAMETER_VALUE("filter_provinsi");
  const regencyPattern = PARAMETER_VALUE("filter_kabupaten");

  if (!provincePattern.test(sql) || !regencyPattern.test(sql)) return sql;

  let prepared = sql
    .replace(provincePattern, `'${provinceValue}' AS filter_provinsi`)
    .replace(regencyPattern, `'${regencyValue}' AS filter_kabupaten`);

  // Existing repository queries compare one province with equality. Convert that
  // comparison to the same pipe-delimited membership check used by kabupaten/kota.
  const provinceEquality = /((?:LEFT\s*\([^)]*\)|CAST\s*\([^)]*\)|(?:[A-Za-z_]\w*\.)?level_1_full_code))\s*=\s*([A-Za-z_]\w*\.filter_provinsi)\b/gi;
  prepared = prepared.replace(
    provinceEquality,
    (_match, regionExpression: string, parameterExpression: string) =>
      `CONCAT('|', ${parameterExpression}, '|') LIKE CONCAT('%|', ${regionExpression}, '|%')`,
  );
  return prepared;
}
