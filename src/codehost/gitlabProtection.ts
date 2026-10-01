import { z } from "zod";

export interface AccessLevel {
  accessLevel: number;
  description: string;
  userId: number | null;
  groupId: number | null;
  deployKeyId: number | null;
}

export interface ProtectedBranch {
  name: string;
  push: AccessLevel[];
  merge: AccessLevel[];
}

const DEVELOPER = 30;
const PROJECT_BOT = /^project_\d+_bot/;

const LevelSchema = z.object({
  access_level: z.number(),
  access_level_description: z.string(),
  user_id: z.number().nullish(),
  group_id: z.number().nullish(),
  deploy_key_id: z.number().nullish(),
});
const BranchesSchema = z.array(z.object({ name: z.string(), push_access_levels: z.array(LevelSchema).default([]), merge_access_levels: z.array(LevelSchema).default([]) }));

const toLevel = (level: z.infer<typeof LevelSchema>): AccessLevel => ({
  accessLevel: level.access_level,
  description: level.access_level_description,
  userId: level.user_id ?? null,
  groupId: level.group_id ?? null,
  deployKeyId: level.deploy_key_id ?? null,
});

export const listProtectedBranches = async (opts: { baseUrl: string; project: string; token: string; fetchImpl: typeof fetch }): Promise<ProtectedBranch[]> => {
  const url = `${opts.baseUrl.replace(/\/$/, "")}/api/v4/projects/${encodeURIComponent(opts.project)}/protected_branches?per_page=100`;
  const response = await opts.fetchImpl(url, { headers: { "PRIVATE-TOKEN": opts.token } });
  if (!response.ok) throw new Error(`protected_branches answered ${response.status}`);
  return BranchesSchema.parse(await response.json()).map((branch) => ({ name: branch.name, push: branch.push_access_levels.map(toLevel), merge: branch.merge_access_levels.map(toLevel) }));
};

const isRoleGrant = (level: AccessLevel): boolean => level.userId === null && level.groupId === null && level.deployKeyId === null;

/** What would let a Developer-role project bot push to or merge into a branch that must stay closed to it. */
export const protectionProblems = (branches: ProtectedBranch[], required: string[]): string[] =>
  required.flatMap((name) => {
    const branch = branches.find((candidate) => candidate.name === name);
    if (branch === undefined) return [`${name} is not protected`];
    const problems: string[] = [];
    for (const [verb, levels] of [["push", branch.push], ["merge", branch.merge]] as const) {
      if (levels.some((level) => isRoleGrant(level) && level.accessLevel === DEVELOPER)) problems.push(`${name} lets Developers ${verb}`);
      for (const level of levels.filter((candidate) => PROJECT_BOT.test(candidate.description))) problems.push(`${name} lets ${level.description} ${verb}`);
    }
    return problems;
  });
