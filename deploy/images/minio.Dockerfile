# MinIO for the steward's sessions (deploy/k8s/base/minio.yaml), built from source. MinIO's open-source server and mc
# are archived: their images and binaries are no longer published, so both are built here from their last release
# tags, pinned by commit. Build from the repo root:
#   docker build -f deploy/images/minio.Dockerfile -t <registry>/ticket-steward/minio:RELEASE.2025-10-15T17-29-55Z .
ARG GO_IMAGE=golang:1.24.8-bookworm

FROM ${GO_IMAGE} AS build
ARG MINIO_RELEASE=RELEASE.2025-10-15T17-29-55Z
ARG MINIO_COMMIT=9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a
ARG MC_RELEASE=RELEASE.2025-08-13T08-35-41Z
ARG MC_COMMIT=7394ce0dd2a80935aded936b09fa12cbb3cb8096
ENV CGO_ENABLED=0 GOFLAGS=-trimpath
RUN set -eu; \
  for spec in "minio ${MINIO_RELEASE} ${MINIO_COMMIT}" "mc ${MC_RELEASE} ${MC_COMMIT}"; do \
    set -- ${spec}; \
    git clone --quiet --depth 1 --branch "$2" "https://github.com/minio/$1.git" "/src/$1"; \
    test "$(git -C "/src/$1" rev-parse HEAD)" = "$3"; \
  done
# The release ldflags, so `minio --version` and the server's own version checks report the release.
RUN cd /src/minio && go build -o /out/minio \
  -ldflags "-s -w -X github.com/minio/minio/cmd.ReleaseTag=${MINIO_RELEASE} -X github.com/minio/minio/cmd.CommitID=${MINIO_COMMIT} -X github.com/minio/minio/cmd.ShortCommitID=$(echo ${MINIO_COMMIT} | cut -c1-12) -X github.com/minio/minio/cmd.CopyrightYear=2025 -X github.com/minio/minio/cmd.Version=$(echo ${MINIO_RELEASE} | sed 's/RELEASE\.//; s/T\(..\)-\(..\)-\(..\)Z/T\1:\2:\3Z/')"
RUN cd /src/mc && go build -o /out/mc -ldflags "-s -w -X github.com/minio/mc/cmd.ReleaseTag=${MC_RELEASE} -X github.com/minio/mc/cmd.CommitID=${MC_COMMIT}"

FROM debian:bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/minio /out/mc /usr/local/bin/
COPY deploy/images/minio-start.sh /usr/local/bin/minio-start
RUN chmod 0755 /usr/local/bin/minio-start \
  && groupadd --gid 1000 minio && useradd --uid 1000 --gid 1000 --no-create-home --shell /usr/sbin/nologin minio \
  && install -d -o 1000 -g 1000 /data \
  && minio --version && mc --version
ENV MINIO_UPDATE=off
USER 1000
EXPOSE 9000
ENTRYPOINT ["tini", "--", "/usr/local/bin/minio-start"]
