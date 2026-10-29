#!/bin/sh
# The run pod's egress sidecar. It makes a CA for this run in its private confdir (an emptyDir only this container
# mounts), publishes only the CA certificate for the agent to trust, and runs mitmdump on 127.0.0.1:4182 with the
# placeholder-swapping addon. Flows are not printed (flow_detail=0): a swapped URL carries a real value.
set -eu

confdir="${EGRESS_CONFDIR:-/run/egress-confdir}"
ca_out="${EGRESS_CA_OUT:-/run/egress-ca/ca.pem}"
rules="${EGRESS_RULES:-/run/egress-rules/rules.json}"

umask 077
if [ ! -r "$rules" ]; then
  echo "egress: no rules file at $rules" >&2
  exit 1
fi

# Reused when the container restarts in the same pod, so the agent's trusted CA stays valid.
python3 -I -c 'import sys; from mitmproxy.certs import CertStore; CertStore.from_store(sys.argv[1], "mitmproxy", 2048)' "$confdir"

# Written then renamed, so the agent, which waits for the file, never reads it half-written.
tmp="$ca_out.tmp.$$"
cp "$confdir/mitmproxy-ca-cert.pem" "$tmp"
chmod 0644 "$tmp"
mv -f "$tmp" "$ca_out"

exec mitmdump \
  --listen-host 127.0.0.1 \
  --listen-port 4182 \
  --set confdir="$confdir" \
  --set flow_detail=0 \
  --set anticomp=true \
  --scripts /opt/egress/swap.py \
  --set steward_rules="$rules"
