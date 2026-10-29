# The run pod's agent container (docs/ops.md, "Running on Kubernetes"): `steward run-pod` with Claude Code, workspace setup,
# Playwright's Chromium, the app and the checks. It holds no credential; everything it needs is baked in, and a pnpm
# store prefetched from kickoff's base-branch lockfile, so a run's `pnpm install` fetches only what changed. Nothing a
# run writes reaches another run: each pod writes to its own copy. Build with deploy/images/build-agent.sh, which
# copies the lockfile and workspace file in and passes them as KICKOFF_LOCKFILE and KICKOFF_WORKSPACE.
#
# Node: one runtime, 24, for both the steward and kickoff (its .nvmrc asks for 24, packageManager pnpm@11.13.0).
ARG NODE_IMAGE=node:24.13.1-bookworm-slim

FROM ${NODE_IMAGE} AS build
# better-sqlite3 falls back to a source build when no prebuilt binary matches.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@11.13.0
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM ${NODE_IMAGE}
# git for the worktree, tini as PID 1, psql for kickoff's reset-dbs.sh, the rest for agent shell work.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates tini postgresql-client curl jq ripgrep procps \
  && rm -rf /var/lib/apt/lists/*
# pnpm for kickoff's workspace setup, at kickoff's packageManager version; npm checks the registry integrity hash.
RUN npm install -g pnpm@11.13.0
WORKDIR /opt/ticket-steward
COPY --from=build /src/package.json ./
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
COPY bin ./bin
COPY prompts ./prompts
RUN ln -s /opt/ticket-steward/bin/steward.js /usr/local/bin/steward
# The Claude Code CLI comes with the Agent SDK (its platform package in node_modules), at the version it expects.
# Chromium for the Playwright MCP server, at the Playwright version @playwright/mcp resolves to in the lockfile.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN node -e 'const { createRequire } = require("module"); const r = createRequire(require.resolve("@playwright/mcp/package.json")); console.log(require("path").dirname(r.resolve("playwright/package.json")) + "/cli.js")' > /tmp/playwright-cli \
  && node "$(cat /tmp/playwright-cli)" install --with-deps chromium \
  && rm -rf /tmp/playwright-cli /var/lib/apt/lists/* \
  && chmod -R a+rX /opt/ms-playwright

# Native glab and the Orbit CLI for the agent, pinned and checksum-checked as in Dockerfile, never auto-updated.
ARG TARGETARCH=amd64
ARG GLAB_VERSION=1.125.0
ARG GLAB_SHA256_AMD64=c7325f14e408be26fcc1ba5f7a7f71f02c1a20aa3ac6018a57fb04901ea5549a
ARG GLAB_SHA256_ARM64=1b0ed76664cff16a3d183413931f75601d3054869c24dee6d528f930fec8c9b3
ARG ORBIT_VERSION=0.161.0
ARG ORBIT_SHA256_AMD64=9cf4a6fd3c902250343de6797c93931690cb1328da2924138a6619f164588992
ARG ORBIT_SHA256_ARM64=595da171fc6b94bc0ea35736502ed9a7c30ce3266ff53f7410cd8ddd38eb0eff
RUN set -eu; \
  case "${TARGETARCH}" in \
    amd64) glab_arch=amd64; orbit_arch=x86_64; glab_sha="${GLAB_SHA256_AMD64}"; orbit_sha="${ORBIT_SHA256_AMD64}" ;; \
    arm64) glab_arch=arm64; orbit_arch=aarch64; glab_sha="${GLAB_SHA256_ARM64}"; orbit_sha="${ORBIT_SHA256_ARM64}" ;; \
    *) echo "unsupported TARGETARCH ${TARGETARCH}" >&2; exit 1 ;; \
  esac; \
  tmp="$(mktemp -d)"; \
  curl -fsSL -o "${tmp}/glab.tar.gz" "https://gitlab.com/gitlab-org/cli/-/releases/v${GLAB_VERSION}/downloads/glab_${GLAB_VERSION}_linux_${glab_arch}.tar.gz"; \
  echo "${glab_sha}  ${tmp}/glab.tar.gz" | sha256sum -c -; \
  tar -xzf "${tmp}/glab.tar.gz" -C "${tmp}" bin/glab; \
  install -m 0755 "${tmp}/bin/glab" /usr/local/bin/glab; \
  curl -fsSL -o "${tmp}/orbit.tar.gz" "https://gitlab.com/api/v4/projects/77960826/packages/generic/orbit-cli/${ORBIT_VERSION}/orbit-cli-linux-musl-${orbit_arch}.tar.gz"; \
  echo "${orbit_sha}  ${tmp}/orbit.tar.gz" | sha256sum -c -; \
  tar -xzf "${tmp}/orbit.tar.gz" -C "${tmp}" orbit; \
  install -m 0755 "${tmp}/orbit" /usr/local/bin/orbit; \
  rm -rf "${tmp}"; \
  glab --version; \
  test "$(orbit version)" = "${ORBIT_VERSION}"
# glab finds the Orbit CLI here instead of downloading its own.
ENV GLAB_ORBIT_CLI_BINARY_PATH=/usr/local/bin/orbit

# uid 1001, as the steward image; its home is the data dir, where the run pod mounts work/, sessions/ and jobs/.
RUN groupadd --gid 1001 steward && useradd --uid 1001 --gid 1001 --home-dir /var/lib/ticket-steward --no-create-home --shell /bin/bash steward \
  && install -d -o 1001 -g 1001 -m 0700 /var/lib/ticket-steward
ENV HOME=/var/lib/ticket-steward \
  NODE_ENV=production
USER 1001

# The warm store, last so a lockfile change rebuilds only this layer. pnpm puts it where a run's pnpm looks: the
# default store under $HOME, which the run pod does not mount over. `pnpm fetch` reads only the lockfile and the
# workspace settings; no package is built or run here.
ARG KICKOFF_LOCKFILE=deploy/images/kickoff/pnpm-lock.yaml
ARG KICKOFF_WORKSPACE=deploy/images/kickoff/pnpm-workspace.yaml
WORKDIR /tmp/kickoff-lock
COPY --chown=1001:1001 ${KICKOFF_LOCKFILE} ./pnpm-lock.yaml
COPY --chown=1001:1001 ${KICKOFF_WORKSPACE} ./pnpm-workspace.yaml
RUN pnpm fetch --ignore-scripts \
  && pnpm store path \
  && cd / && rm -rf /tmp/kickoff-lock
WORKDIR /var/lib/ticket-steward
ENTRYPOINT ["tini", "--", "steward"]
CMD ["run-pod"]
