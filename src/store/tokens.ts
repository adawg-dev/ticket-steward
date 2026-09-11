import { randomBytes } from "node:crypto";
import type { Database } from "./db.js";

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  appUserId: string | null;
}

interface TokenRow {
  access_token: string;
  refresh_token: string;
  expires_at: string;
  app_user_id: string | null;
}

const AUTH_BROKEN = "auth_broken";

export class TokenStore {
  private readonly selectPair;
  private readonly upsertPair;
  private readonly deletePair;
  private readonly insertState;
  private readonly deleteState;
  private readonly deleteExpiredStates;
  private readonly upsertFlag;
  private readonly selectFlag;

  constructor(private readonly db: Database) {
    this.selectPair = db.prepare<[], TokenRow>("SELECT * FROM tokens WHERE id = 1");
    this.upsertPair = db.prepare<[string, string, string, string | null]>(
      `INSERT INTO tokens (id, access_token, refresh_token, expires_at, app_user_id) VALUES (1, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET access_token = excluded.access_token, refresh_token = excluded.refresh_token,
         expires_at = excluded.expires_at, app_user_id = excluded.app_user_id`,
    );
    this.deletePair = db.prepare("DELETE FROM tokens WHERE id = 1");
    this.insertState = db.prepare<[string, number]>("INSERT INTO oauth_state (state, expires_at) VALUES (?, ?)");
    this.deleteState = db.prepare<[string, number]>("DELETE FROM oauth_state WHERE state = ? AND expires_at > ?");
    this.deleteExpiredStates = db.prepare<[number]>("DELETE FROM oauth_state WHERE expires_at <= ?");
    this.upsertFlag = db.prepare<[string, string]>(
      "INSERT INTO flags (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    );
    this.selectFlag = db.prepare<[string], { value: string }>("SELECT value FROM flags WHERE key = ?");
  }

  get(): TokenPair | null {
    const row = this.selectPair.get();
    if (row === undefined) return null;
    return {
      accessToken: row.access_token,
      refreshToken: row.refresh_token,
      expiresAt: row.expires_at,
      appUserId: row.app_user_id,
    };
  }

  set(pair: TokenPair): void {
    this.upsertPair.run(pair.accessToken, pair.refreshToken, pair.expiresAt, pair.appUserId);
  }

  clear(): void {
    this.deletePair.run();
  }

  createOauthState(ttlMs: number): string {
    const now = Date.now();
    this.deleteExpiredStates.run(now);
    const state = randomBytes(16).toString("hex");
    this.insertState.run(state, now + ttlMs);
    return state;
  }

  consumeOauthState(state: string): boolean {
    return this.deleteState.run(state, Date.now()).changes === 1;
  }

  setAuthBroken(v: boolean): void {
    this.upsertFlag.run(AUTH_BROKEN, v ? "1" : "0");
  }

  isAuthBroken(): boolean {
    return this.selectFlag.get(AUTH_BROKEN)?.value === "1";
  }

  withImmediateTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }
}
