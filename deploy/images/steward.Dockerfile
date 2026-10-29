# The steward image on Kubernetes (docs/ops.md, "Running on Kubernetes"): the dispatcher, and in each run pod the init containers
# (git-init, render-overlay, sessions pull) and the keyproxy, tools and sessions-sync sidecars. It is the Compose
# image (Dockerfile) without what only the agent uses: no Chromium, pnpm or psql. glab and Orbit stay, for the tools
# sidecar's Orbit server and doctor. Build from the repo root:
#   docker build -f deploy/images/steward.Dockerfile -t <registry>/ticket-steward/steward:<tag> .
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

# Native glab and the Orbit CLI, pinned and checksum-checked as in Dockerfile; curl stays in this stage.
FROM ${NODE_IMAGE} AS tools
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
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
  test "$(orbit version)" = "${ORBIT_VERSION}"

FROM ${NODE_IMAGE}
# git for the mirror, git-init and the push tool; tini as PID 1.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*
COPY --from=tools /usr/local/bin/glab /usr/local/bin/orbit /usr/local/bin/
# glab finds the Orbit CLI here instead of downloading its own.
ENV GLAB_ORBIT_CLI_BINARY_PATH=/usr/local/bin/orbit
WORKDIR /opt/ticket-steward
COPY --from=build /src/package.json ./
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
COPY bin ./bin
COPY prompts ./prompts
RUN ln -s /opt/ticket-steward/bin/steward.js /usr/local/bin/steward \
  && glab --version
# uid 1001, as on the Compose host, so the data the cut-over copies keeps its owner.
RUN groupadd --gid 1001 steward && useradd --uid 1001 --gid 1001 --home-dir /var/lib/ticket-steward --no-create-home --shell /bin/bash steward
ENV HOME=/var/lib/ticket-steward \
  NODE_ENV=production \
  STEWARD_LISTEN_HOST=0.0.0.0
USER 1001
WORKDIR /etc/ticket-steward
ENTRYPOINT ["tini", "--", "steward"]
CMD ["serve"]
