import type { ChangeRef } from "./types.js";

export const mergeChangeRefs = (refs: ChangeRef[]): ChangeRef[] => {
  const byId = new Map<string, ChangeRef>();
  for (const ref of refs) {
    const existing = byId.get(`${ref.kind}:${ref.id}`);
    if (!existing) {
      byId.set(`${ref.kind}:${ref.id}`, { ...ref, shas: [...ref.shas] });
      continue;
    }
    for (const sha of ref.shas) if (!existing.shas.includes(sha)) existing.shas.push(sha);
  }
  return [...byId.values()];
};
