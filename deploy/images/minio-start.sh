#!/bin/sh
# MinIO for the steward's sessions (deploy/helm/ticket-steward/templates/minio.yaml). The root password is new on every start and lives
# only in this container's memory: it creates the bucket and the steward-sessions policy, idempotently, then is
# dropped from this shell. Pods sign in through MinIO's STS with their projected token and get that policy. MinIO
# signs STS credentials with the root key, so a restart voids them; the sessions store signs in again on the
# InvalidAccessKeyId that follows (src/sessions/store.ts, s3ObjectStore).
set -eu

bucket="${STEWARD_BUCKET:-steward-sessions}"
policy_file="${STEWARD_POLICY_FILE:-/etc/minio-steward/policy.json}"
policy="${MINIO_IDENTITY_OPENID_ROLE_POLICY:-steward-sessions}"

MINIO_ROOT_USER=steward-root
MINIO_ROOT_PASSWORD="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
export MINIO_ROOT_USER MINIO_ROOT_PASSWORD

minio server /data --address :9000 --console-address 127.0.0.1:9001 &
pid=$!
trap 'kill -TERM "$pid" 2>/dev/null' TERM INT

# mc takes the root credential from its env, never from a config file.
export MC_CONFIG_DIR="${MC_CONFIG_DIR:-/tmp/mc}"
MC_HOST_local="http://${MINIO_ROOT_USER}:${MINIO_ROOT_PASSWORD}@127.0.0.1:9000"
export MC_HOST_local
tries=0
until mc ready local >/dev/null 2>&1; do
  tries=$((tries + 1))
  if [ "$tries" -ge 120 ] || ! kill -0 "$pid" 2>/dev/null; then
    echo "minio-start: MinIO did not become ready" >&2
    kill -TERM "$pid" 2>/dev/null || true
    exit 1
  fi
  sleep 1
done
mc mb --ignore-existing "local/$bucket"
mc admin policy create local "$policy" "$policy_file"
unset MC_HOST_local MINIO_ROOT_PASSWORD
echo "minio-start: bucket $bucket and policy $policy ready"

# Wait twice: the first wait returns early when the TERM trap runs, the second for MinIO to finish shutting down.
wait "$pid" || true
wait "$pid" 2>/dev/null || true
