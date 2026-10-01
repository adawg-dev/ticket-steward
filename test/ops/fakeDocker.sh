#!/usr/bin/env bash
# Stands in for docker in the steward-slot tests: logs each call with the slot ports it saw, answers what the helper reads.
printf '%s|%s|%s|%s\n' "$*" "${STEWARD_SLOT_POSTGRES_PORT:-}" "${STEWARD_SLOT_REDIS_PORT:-}" "${STEWARD_SLOT_RABBITMQ_PORT:-}" >> "$FAKE_DOCKER_LOG"
case "$*" in
  *" config --images") printf '%s\n' timescale/timescaledb-ha:pg17-ts2.27-all redis:7-alpine rabbitmq:4.2.0-management ;;
  "image inspect "*) [[ "$3" != "${FAKE_DOCKER_MISSING:-}" ]] ;;
esac
