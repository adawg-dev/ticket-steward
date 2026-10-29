#!/usr/bin/env bash
# Installs or upgrades the steward's chart with a config dir bundled into the steward-config ConfigMap.
#
#   deploy/helm/install.sh <config dir> <values file> [helm args...]
#
# The namespace is STEWARD_NAMESPACE (default ticket-steward) and must equal runtime.namespace. The config dir is
# steward.config.ts, prompts/ and the overlay template; it must hold no .env, since run pods unpack it too.
set -euo pipefail

if [ $# -lt 2 ]; then
  echo "usage: $0 <config dir> <values file> [helm args...]" >&2
  exit 2
fi
config_dir="$1"
values="$2"
shift 2
namespace="${STEWARD_NAMESPACE:-ticket-steward}"
chart="$(cd "$(dirname "$0")" && pwd)/ticket-steward"

[ -f "$config_dir/steward.config.ts" ] || { echo "$config_dir has no steward.config.ts" >&2; exit 1; }
if find "$config_dir" -name '.env' -o -name '.env.*' | grep -q .; then
  echo "$config_dir holds a .env file; secrets come from Secrets Manager, and run pods unpack this dir" >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
bundle="$work/config.tgz"
# Rooted at ".": the unpack strips that leading "./".
tar -czf "$bundle" -C "$config_dir" .
size=$(stat -c %s "$bundle")
[ "$size" -lt 786432 ] || { echo "the config bundle is $size bytes; base64 must stay under the 1 MiB ConfigMap limit" >&2; exit 1; }
base64 -w0 "$bundle" >"$work/config.b64"

helm upgrade --install ticket-steward "$chart" \
  --namespace "$namespace" --create-namespace \
  -f "$values" \
  --set-file config.bundle="$work/config.b64" \
  "$@"
