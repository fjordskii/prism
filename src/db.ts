// Prism — personalization engine. SQLite schema + db handle.
import { openDatabase } from "./open-db";

export const db = openDatabase(process.env.DB_PATH ?? "prism.db");

export type Variant = {
  id: number;
  site: string;
  name: string;
  selector: string;
  ops: string;      // JSON
  audience: string; // JSON
  weight: number;
  starts_at: number | null;
  ends_at: number | null;
  active: number;
  created_at: number;
};

export type Op =
  | { op: "html"; html: string }
  | { op: "text"; text: string }
  | { op: "insertBefore"; html: string }
  | { op: "insertAfter"; html: string }
  | { op: "remove" }
  | { op: "setAttr"; name: string; value: string }
  | { op: "reorder"; order: string[] }; // child selectors in desired order

export type Rule = { field: string; op: "eq" | "neq" | "gt" | "lt" | "gte" | "lte" | "contains"; value: unknown };

export function matchAudience(rules: Rule[], traits: Record<string, unknown>): boolean {
  return rules.every((r) => {
    const v = traits[r.field];
    switch (r.op) {
      case "eq": return v === r.value;
      case "neq": return v !== r.value;
      case "gt": return typeof v === "number" && v > (r.value as number);
      case "lt": return typeof v === "number" && v < (r.value as number);
      case "gte": return typeof v === "number" && v >= (r.value as number);
      case "lte": return typeof v === "number" && v <= (r.value as number);
      case "contains":
        return Array.isArray(v) ? v.includes(r.value) : typeof v === "string" && v.includes(String(r.value));
      default: return false;
    }
  });
}
