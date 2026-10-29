## Working in kickoff

- The repo's rules are in `CLAUDE.md` files, at the root and in directories. They apply to you: read the root one and the one nearest every file you change before editing.
- pnpm workspaces and Turborepo. Workspaces import each other from `dist/`: after changing a package under `packages/`, `service/` or `api/`, run `pnpm build` in that package (and in any workspace between it and the one you are testing) before testing a consumer. Type-check can stay green while the runtime breaks.
- Never hand-edit `pnpm-lock.yaml`; use `pnpm add <pkg>@<version> --filter <name>` and commit what pnpm writes.
- The local services (Postgres with TimescaleDB, Redis, RabbitMQ) are this run's own and were reset for you. Their hosts and ports are in the workspace's `.env` files; never assume the defaults.
- To check a user-app change in the browser, follow the `steward-user-app-verify` skill: it starts the app on your port and logs in as a seeded persona through the dev-auth route.
