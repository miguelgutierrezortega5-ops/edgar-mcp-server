import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CHARACTER_LIMIT, ResponseFormat } from "../constants.js";
import { formatError } from "./http.js";

export const responseFormatField = z
  .nativeEnum(ResponseFormat)
  .default(ResponseFormat.MARKDOWN)
  .describe("Output format: 'markdown' (readable, default) or 'json' (structured).");

export const dateField = (what: string) =>
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
    .optional()
    .describe(`${what} (YYYY-MM-DD).`);

export function truncate(text: string, hint = "Narrow the request to see more."): string {
  if (text.length <= CHARACTER_LIMIT) return text;
  return `${text.slice(0, CHARACTER_LIMIT)}\n\n[Truncated at ${CHARACTER_LIMIT} characters. ${hint}]`;
}

export function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text: truncate(text) }] };
}

export function errorResult(error: unknown): CallToolResult {
  return { content: [{ type: "text", text: formatError(error) }], isError: true };
}

export function render<T>(format: ResponseFormat, data: T, toMarkdown: (d: T) => string): CallToolResult {
  return textResult(format === ResponseFormat.JSON ? JSON.stringify(data, null, 2) : toMarkdown(data));
}

export function fmtNum(v: unknown, unit?: string): string {
  if (v === null || v === undefined || v === "") return "–";
  if (typeof v !== "number" || !Number.isFinite(v)) return String(v);
  if (unit === "%") return `${(v * 100).toFixed(1)}%`;
  if (unit === "x") return `${v.toFixed(2)}x`;
  if (unit === "USD/shares" || unit === "per_share") return v.toFixed(2);
  const abs = Math.abs(v);
  if (abs >= 1e12) return `${(v / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e4) return `${(v / 1e3).toFixed(1)}K`;
  if (Number.isInteger(v)) return String(v);
  return abs >= 1 ? v.toFixed(2) : v.toPrecision(3);
}

const cell = (s: unknown) => String(s ?? "–").replace(/\|/g, "\\|").replace(/\n+/g, " ");

export function mdTable(headers: string[], rows: unknown[][]): string {
  if (!rows.length) return "_No rows._";
  return [
    `| ${headers.map(cell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`),
  ].join("\n");
}
