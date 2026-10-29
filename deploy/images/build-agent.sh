#!/usr/bin/env bash
# Builds the agent image (deploy/images/agent.Dockerfile) with a pnpm store prefetched from kickoff's lockfile.
#
#   deploy/images/build-agent.sh <kickoff checkout> [base ref]
#
# The lockfile and workspace file come from the base ref of a local kickoff checkout (default dev, the steward's
# workspace.baseBranch; fetch first so it is current), never from its working tree. Rebuild when kickoff's lockfile
# changes or on a schedule. IMAGE names the result (default ticket-steward/agent:latest); extra arguments after the
# base ref go to docker build.
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "usage: $0 <kickoff checkout> [base ref] [docker build args...]" >&2
  exit 2
fi
checkout="$1"
ref="${2:-dev}"
shift $(($# < 2 ? $# : 2))

repo="$(cd "$(dirname "$0")/../.." && pwd)"
image="${IMAGE:-ticket-steward/agent:latest}"
stage="$repo/deploy/images/kickoff"

git -C "$checkout" rev-parse --verify --quiet "$ref^{commit}" >/dev/null || {
  echo "$checkout has no $ref" >&2
  exit 1
}
rm -rf "$stage"
mkdir -p "$stage"
trap 'rm -rf "$stage"' EXIT
git -C "$checkout" show "$ref:pnpm-lock.yaml" >"$stage/pnpm-lock.yaml"
git -C "$checkout" show "$ref:pnpm-workspace.yaml" >"$stage/pnpm-workspace.yaml"
echo "kickoff lockfile from $ref ($(git -C "$checkout" rev-parse --short "$ref"))"

docker build \
  -f "$repo/deploy/images/agent.Dockerfile" \
  --build-arg KICKOFF_LOCKFILE=deploy/images/kickoff/pnpm-lock.yaml \
  --build-arg KICKOFF_WORKSPACE=deploy/images/kickoff/pnpm-workspace.yaml \
  -t "$image" \
  "$@" \
  "$repo"
