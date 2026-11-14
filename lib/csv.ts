import { fail } from "./memberships";
export function parseCsv(source: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '"') {
      if (quoted && source[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (!quoted && cell) fail(400, "Check CSV quotes.");
      else quoted = !quoted;
    } else if (c === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((c === "\n" || c === "\r") && !quoted) {
      if (c === "\r" && source[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (quoted) fail(400, "Close the quoted CSV field.");
  row.push(cell);
  if (row.some(Boolean)) rows.push(row);
  if (rows.length > 201) fail(400, "Import up to 200 members at a time.");
  return rows;
}
export function csv(rows: unknown[][]) {
  return rows
    .map((r) =>
      r
        .map(
          (v) =>
            `"${String(v ?? "")
              .replace(/^[=+@\-\t\r]/, "'$&")
              .replaceAll('"', '""')}"`,
        )
        .join(","),
    )
    .join("\r\n");
}
