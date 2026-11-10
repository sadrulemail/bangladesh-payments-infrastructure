import type { FastifyReply } from "fastify";

const NEEDS_QUOTES = /[",\r\n]/;

const escape = (value: unknown) => {
  const text = value === null || value === undefined ? "" : String(value);
  return NEEDS_QUOTES.exec(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** Renders rows as RFC 4180 CSV with a header line. */
export function toCsv<T extends Record<string, unknown>>(rows: T[], columns: (keyof T & string)[]): string {
  const lines = [columns.join(","), ...rows.map((row) => columns.map((column) => escape(row[column])).join(","))];
  return `${lines.join("\r\n")}\r\n`;
}

/** Sends rows as a CSV download. */
export function sendCsv<T extends Record<string, unknown>>(
  reply: FastifyReply,
  fileName: string,
  rows: T[],
  columns: (keyof T & string)[],
): FastifyReply {
  return reply
    .header("content-type", "text/csv; charset=utf-8")
    .header("content-disposition", `attachment; filename="${fileName}"`)
    .send(toCsv(rows, columns));
}
