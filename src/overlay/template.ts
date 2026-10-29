import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readSecretValue, type SecretFetcher } from "../config/secretSource.js";
import { listFiles } from "../workspace/files.js";

/** The egress sidecar puts `value` in place of `placeholder` on requests to `hosts` (fnmatch patterns) only. */
export interface EgressRule {
  placeholder: string;
  value: string;
  hosts: string[];
}

export interface RenderedOverlay {
  /** The agent's env files, relative to the template dir, with placeholders in place of every fetched value. */
  files: Array<{ path: string; content: string }>;
  rules: EgressRule[];
  /** Every real value and every placeholder, which the tools sidecar's secret guard refuses in a commit. */
  guardValues: string[];
}

/**
 * `{{secret:<id>@<host>,<host>}}` an outbound secret, `{{signed:<id>}}` a key requests are signed with (refused),
 * `{{local}}` a throwaway value per run. Any other `{{…}}` is a literal.
 */
const TOKEN = /\{\{(?:(secret|signed):([^}]*)|local)\}\}/g;
const ENV_KEY_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;
const SECRET_ID = /^[A-Za-z0-9_/+=.-]+$/;
const HOST = /^(?:\*\.)?[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*$/;

type Entry =
  | { kind: "secret"; id: string; hosts: string[] }
  | { kind: "local" }
  | { kind: "issue"; message: string };

const parseEntry = (kind: string | undefined, body: string | undefined, token: string): Entry => {
  if (kind === undefined) return { kind: "local" };
  const [id = "", hostList] = (body ?? "").split(/@(.*)/s, 2);
  if (!SECRET_ID.test(id)) return { kind: "issue", message: `${token} names no valid secret id` };
  if (kind === "signed") return { kind: "issue", message: `${id} is used to sign requests; the egress proxy cannot stand in for it` };
  if (hostList === undefined || hostList.trim() === "") return { kind: "issue", message: `${token} names no hosts` };
  const hosts = hostList.split(",").map((host) => host.trim());
  const bad = hosts.find((host) => !HOST.test(host));
  if (bad !== undefined) return { kind: "issue", message: `${token} names an invalid host "${bad}"` };
  return { kind: "secret", id, hosts };
};

interface TemplateLine {
  text: string;
  /** The `KEY` of a `KEY=value` line. */
  key: string | undefined;
  tokens: Array<{ start: number; end: number; entry: Entry }>;
}

type Template = Array<{ path: string; lines: TemplateLine[] }>;

/** Each template file's lines with their key and tokens, in file order. */
const readTemplate = async (templateDir: string): Promise<Template> => {
  const files: Template = [];
  for (const path of await listFiles(templateDir)) {
    const content = await readFile(join(templateDir, path), "utf8");
    const lines = content.split("\n").map((text) => ({
      text,
      key: ENV_KEY_LINE.exec(text)?.[1],
      tokens: [...text.matchAll(TOKEN)].map((match) => ({ start: match.index, end: match.index + match[0].length, entry: parseEntry(match[1], match[2], match[0]) })),
    }));
    files.push({ path, lines });
  }
  return files;
};

const issuesOf = (template: Template): string[] =>
  template.flatMap(({ path, lines }) =>
    lines.flatMap(({ tokens }, index) => tokens.flatMap(({ entry }) => (entry.kind === "issue" ? [`${path}:${index + 1}: ${entry.message}`] : []))),
  );

/** What makes the template unrenderable, as `<file>:<line>: <reason>`; no secret is read. */
export const overlayTemplateIssues = async (templateDir: string): Promise<string[]> => issuesOf(await readTemplate(templateDir));

/** The template's file count, the secret ids its outbound entries name (sorted, once each) and its issues; no secret is read. */
export const overlayTemplateSummary = async (templateDir: string): Promise<{ files: number; secretIds: string[]; issues: string[] }> => {
  const template = await readTemplate(templateDir);
  const ids = template.flatMap(({ lines }) => lines.flatMap(({ tokens }) => tokens.flatMap(({ entry }) => (entry.kind === "secret" ? [entry.id] : []))));
  return { files: template.length, secretIds: [...new Set(ids)].sort(), issues: issuesOf(template) };
};

const randomHex = (bytes: number): string => randomBytes(bytes).toString("hex");

/** `STEWARD_PH_<NAME>_<16 hex>`, NAME being the line's key or, off a `KEY=` line, the secret id without `DEV_`. */
const placeholderFor = (key: string | undefined, id: string): string => {
  const name = key ?? id.replace(/^DEV_/, "").replace(/[^A-Za-z0-9_]/g, "_");
  return `STEWARD_PH_${name}_${randomHex(8)}`;
};

/**
 * Renders the overlay template for one run: outbound secrets become placeholders with egress rules, `{{local}}` a fresh
 * value (`random`, 32 random bytes as hex by default). One key gets the same placeholder or local value in every file,
 * so apps that share it agree. Refuses the whole template on any issue, and refuses a file that still carries a fetched
 * value (a literal equal to a secret), naming the secret id only.
 */
export const renderOverlay = async (p: { templateDir: string; fetcher: SecretFetcher; random?: () => string }): Promise<RenderedOverlay> => {
  const random = p.random ?? (() => randomHex(32));
  const template = await readTemplate(p.templateDir);
  const issues = issuesOf(template);
  if (issues.length > 0) throw new Error(issues.join("\n"));

  const values = new Map<string, string>();
  const placeholders = new Map<string, EgressRule>();
  const locals = new Map<string, string>();
  const files: RenderedOverlay["files"] = [];
  for (const { path, lines } of template) {
    const rendered: string[] = [];
    for (const { text, key, tokens } of lines) {
      const out: string[] = [];
      let last = 0;
      for (const { start, end, entry } of tokens) {
        out.push(text.slice(last, start));
        last = end;
        if (entry.kind === "secret") {
          const ruleKey = JSON.stringify([key ?? null, entry.id, entry.hosts]);
          let known = placeholders.get(ruleKey);
          if (known === undefined) {
            let value = values.get(entry.id);
            if (value === undefined) {
              value = await readSecretValue(p.fetcher, entry.id);
              values.set(entry.id, value);
            }
            known = { placeholder: placeholderFor(key, entry.id), value, hosts: entry.hosts };
            placeholders.set(ruleKey, known);
          }
          out.push(known.placeholder);
        } else if (key === undefined) {
          out.push(random());
        } else {
          let local = locals.get(key);
          if (local === undefined) {
            local = random();
            locals.set(key, local);
          }
          out.push(local);
        }
      }
      out.push(text.slice(last));
      rendered.push(out.join(""));
    }
    files.push({ path, content: rendered.join("\n") });
  }

  for (const { path, content } of files) {
    for (const [id, value] of values) {
      if (content.includes(value)) throw new Error(`${path} carries the value of ${id}; the agent's files hold placeholders only`);
    }
  }
  const rules = [...placeholders.values()];
  return { files, rules, guardValues: [...new Set([...values.values(), ...rules.map((rule) => rule.placeholder)])] };
};

const writePrivate = async (target: string, content: string): Promise<void> => {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, content, { mode: 0o600 });
  await chmod(target, 0o600);
};

/**
 * The agent's files under `agentOut` (they hold no real value), the rules and guard values as JSON, mode 0600, for the
 * volumes only the egress and tools sidecars mount.
 */
export const writeRenderedOverlay = async (rendered: RenderedOverlay, out: { agentOut: string; rulesOut: string; guardOut: string }): Promise<void> => {
  await writePrivate(out.rulesOut, `${JSON.stringify(rendered.rules)}\n`);
  await writePrivate(out.guardOut, `${JSON.stringify(rendered.guardValues)}\n`);
  for (const { path, content } of rendered.files) {
    const target = join(out.agentOut, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
};
