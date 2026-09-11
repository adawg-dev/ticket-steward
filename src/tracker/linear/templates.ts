import type { TicketBundle } from "../types.js";

type TemplateSummary = TicketBundle["templates"][number];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const fieldLabel = (field: Record<string, unknown>): string | null => {
  const { label, name } = field;
  if (typeof label === "string") return label;
  if (typeof name === "string") return name;
  return null;
};

const requiredFormFields = (node: unknown): string[] => {
  if (Array.isArray(node)) return node.flatMap(requiredFormFields);
  if (!isRecord(node)) return [];
  const label = fieldLabel(node);
  if (node.required === true && label !== null) return [label];
  return Object.values(node).flatMap(requiredFormFields);
};

const boldHeadings = (body: string): string[] =>
  body
    .split("\n")
    .map((line) => /^\*\*([^*]+)\*\*\s*$/.exec(line.trim()))
    .flatMap((match) => (match?.[1] === undefined ? [] : [match[1].trim()]));

export const toTemplateSummary = (t: {
  name: string;
  description?: string | null;
  content?: string | null;
  templateData: unknown;
}): TemplateSummary => {
  const body = t.content ?? "";
  const fromForm = requiredFormFields(t.templateData);
  return {
    name: t.name,
    description: t.description ?? "",
    body,
    requiredFields: fromForm.length > 0 ? fromForm : boldHeadings(body),
  };
};
