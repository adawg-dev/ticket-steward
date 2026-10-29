import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listenHost, reapChats } from "../../src/cli/serve.js";
import type { KubernetesChat } from "../../src/k8s/chat.js";
import { LEASE_STALE_MS, openStores } from "../../src/store/index.js";

describe("listenHost", () => {
  it("binds localhost unless the environment names an address", () => {
    expect(listenHost({})).toBe("localhost");
    expect(listenHost({ STEWARD_LISTEN_HOST: "0.0.0.0" })).toBe("0.0.0.0");
  });
});

describe("reapChats", () => {
  it("reaps the chat runs whose lease is stale or gone, at once and then on a timer, and prunes the stale lease", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "steward-serve-"));
    const stores = openStores(dataDir);
    try {
      const live = stores.leases.create({ issueId: "issue-1", worktreeName: "ticket-API-1", slot: null, pid: 1 });
      const stale = stores.leases.create({ issueId: "issue-2", worktreeName: "ticket-API-2", slot: null, pid: 2 });
      stores.db.prepare("UPDATE chat_leases SET heartbeat_at = ? WHERE id = ?").run(new Date(Date.now() - LEASE_STALE_MS - 1_000).toISOString(), stale);
      const asked: Array<Record<string, boolean>> = [];
      const chat: KubernetesChat = {
        start: () => Promise.reject(new Error("unused")),
        end: () => Promise.reject(new Error("unused")),
        reap: (held) => {
          asked.push(Object.fromEntries([`chat-${live}`, `chat-${stale}`, "chat-99"].map((runId) => [runId, held(runId)])));
          return Promise.resolve([]);
        },
      };
      const stop = await reapChats(chat, stores, 10);
      expect(asked).toEqual([{ [`chat-${live}`]: true, [`chat-${stale}`]: false, "chat-99": false }]);
      expect(stores.leases.active().map((lease) => lease.id)).toEqual([live]);
      await new Promise((resolve) => setTimeout(resolve, 35));
      stop();
      const reaps = asked.length;
      expect(reaps).toBeGreaterThan(1);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(asked.length).toBe(reaps);
    } finally {
      stores.db.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
