import type { Command } from "commander";
import {
  MINIO_TOKEN_FILE,
  minioCredentials,
  pullSession,
  s3ObjectStore,
  SESSIONS_BUCKET,
  SESSIONS_CONFIG_DIR,
  sessionFolder,
  sessionPolicy,
  SessionPusher,
  syncSession,
  SYNC_INTERVAL_SECONDS,
  type ObjectStore,
  type PushResult,
} from "../sessions/store.js";
import { errorMessage, exitWith, fail, println, type CliContext } from "./context.js";

interface SessionOptions {
  identifier: string;
  worktree: string;
  bucket: string;
  configDir: string;
  endpoint: string;
  tokenFile: string;
  roleArn?: string;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

const withSessionOptions = (command: Command): Command =>
  command
    .requiredOption("--identifier <KEY>", "the ticket whose sessions these are")
    .requiredOption("--worktree <path>", "the ticket's worktree path in the run pod; it names the session folder")
    .option("--bucket <name>", "the MinIO bucket", SESSIONS_BUCKET)
    .option("--config-dir <dir>", "Claude Code's CLAUDE_CONFIG_DIR", SESSIONS_CONFIG_DIR)
    .requiredOption("--endpoint <url>", "MinIO's URL, for both STS and S3")
    .option("--token-file <path>", "the projected service-account token (audience minio)", MINIO_TOKEN_FILE)
    .option("--role-arn <arn>", "the role to assume, when MinIO's OpenID provider is configured with a role policy");

/** The bucket through MinIO STS with the pod's token, its credentials limited to this ticket's prefix, or the test's fake. */
const objectStore = (ctx: CliContext, opts: SessionOptions): ObjectStore =>
  ctx.factories?.objectStore ??
  s3ObjectStore({
    endpoint: opts.endpoint,
    bucket: opts.bucket,
    credentials: () => minioCredentials({ endpoint: opts.endpoint, tokenFile: opts.tokenFile, durationSeconds: 3600, policy: sessionPolicy(opts.bucket, opts.identifier), ...(opts.roleArn === undefined ? {} : { roleArn: opts.roleArn }) }),
  });

const pusherFor = (ctx: CliContext, opts: SessionOptions): SessionPusher =>
  new SessionPusher({ store: objectStore(ctx, opts), identifier: opts.identifier, configDir: opts.configDir, worktree: opts.worktree });

const describePush = (opts: SessionOptions, pusher: SessionPusher, result: PushResult): string =>
  `pushed ${plural(result.pushed, "file")} to s3://${opts.bucket}/${pusher.prefix}, ${result.unchanged} unchanged`;

const parseInterval = (value: string): number => {
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < 1) throw new Error(`--interval must be a whole number of seconds, got ${JSON.stringify(value)}`);
  return seconds;
};

export const registerSessions = (program: Command, ctx: CliContext): void => {
  const sessions = program.command("sessions").description("run pod session containers: one ticket's Claude Code transcripts, kept in MinIO");

  withSessionOptions(sessions.command("pull").description("init container: downloads the ticket's session folder; with nothing stored it creates an empty one")).action(
    async (opts: SessionOptions) => {
      const folder = sessionFolder(opts.configDir, opts.worktree);
      let count: number;
      try {
        count = await pullSession({ store: objectStore(ctx, opts), identifier: opts.identifier, folder });
      } catch (err) {
        return fail(ctx, `sessions pull: ${errorMessage(err)}`);
      }
      println(ctx, `pulled ${plural(count, "file")} into ${folder}`);
    },
  );

  withSessionOptions(sessions.command("push").description("uploads the files in the ticket's session folder that differ from what is stored")).action(async (opts: SessionOptions) => {
    try {
      const pusher = pusherFor(ctx, opts);
      println(ctx, describePush(opts, pusher, await pusher.push()));
    } catch (err) {
      return fail(ctx, `sessions push: ${errorMessage(err)}`);
    }
  });

  withSessionOptions(sessions.command("sync").description("sidecar: pushes changed session files on an interval, and once more on SIGTERM before exiting"))
    .option("--interval <seconds>", "seconds between pushes", String(SYNC_INTERVAL_SECONDS))
    .action(async (opts: SessionOptions & { interval: string }) => {
      let pusher: SessionPusher;
      let seconds: number;
      try {
        seconds = parseInterval(opts.interval);
        pusher = pusherFor(ctx, opts);
      } catch (err) {
        return fail(ctx, `sessions sync: ${errorMessage(err)}`);
      }
      const controller = new AbortController();
      const stop = (): void => controller.abort();
      // `on`, not `once`: the OpenAI Agents SDK's own SIGTERM handler exits 0 when it finds no other listener, which
      // would cut the final push short; this one stays registered until that push is done.
      process.on("SIGTERM", stop);
      process.on("SIGINT", stop);
      const folder = sessionFolder(opts.configDir, opts.worktree);
      println(ctx, `syncing ${folder} to s3://${opts.bucket}/${pusher.prefix} every ${seconds}s`);
      let final: PushResult;
      try {
        final = await syncSession({
          pusher,
          intervalMs: seconds * 1000,
          signal: controller.signal,
          onPush: (result) => {
            if (result.pushed > 0) println(ctx, describePush(opts, pusher, result));
          },
          onError: (err) => void ctx.stderr.write(`sessions sync: ${err.message}; trying again in ${seconds}s\n`),
        });
      } catch (err) {
        return fail(ctx, `sessions sync: final push failed: ${errorMessage(err)}`);
      } finally {
        process.off("SIGTERM", stop);
        process.off("SIGINT", stop);
      }
      println(ctx, `final push: ${describePush(opts, pusher, final)}`);
      exitWith(ctx, 0);
    });
};
