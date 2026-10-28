#!/bin/sh
# Serves ops/steward-slot on /run/slot/steward-slot.sock, the container form of steward-slot.socket + steward-slot@.service:
# socat forks one `steward-slot --socket` per connection (Accept=yes), the socket belongs to the steward's uid/gid
# with mode 0660 (SocketUser/SocketGroup/SocketMode), and each request is capped at 300 s (RuntimeMaxSec).
# serve brings all 20 slots down at once when it starts; socat's default listen backlog of 5 refuses most of those
# (EAGAIN), so the backlog is raised well past 20.
# The helper's own stderr goes to the container log (StandardError=journal); command output travels in-band.
set -eu
uid="${STEWARD_UID:-1001}"
gid="${STEWARD_GID:-1001}"
case "$uid$gid" in *[!0-9]*) echo "serve.sh: STEWARD_UID and STEWARD_GID must be numeric" >&2; exit 2 ;; esac
exec socat "UNIX-LISTEN:/run/slot/steward-slot.sock,fork,unlink-early,backlog=128,user=$uid,group=$gid,mode=0660" \
  "EXEC:timeout 300 /usr/local/sbin/steward-slot --socket"
