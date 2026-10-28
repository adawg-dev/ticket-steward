# The slot helper for the Compose stack (docs/ops.md, "Running with Docker Compose"). Build context: ops/.
# The same ops/steward-slot as the host install, served on a unix socket by socat instead of systemd, one helper
# process per connection, so the line protocol is unchanged. Docker here is the dind service's daemon only.
FROM docker:29.2.1-cli
RUN apk add --no-cache bash socat
COPY --chmod=0755 steward-slot /usr/local/sbin/steward-slot
# The helper's fixed COMPOSE_FILE and DOCKER_CONFIG paths, as on the host. The daemon resolves the compose file's
# init bind mount on its own filesystem, so compose.yaml also mounts ops/slots-init into the dind service.
COPY --chmod=0644 slots-compose.yml /etc/ticket-steward/slots/compose.yml
COPY --chmod=0644 slots-init/ /etc/ticket-steward/slots/init/
RUN mkdir -p /etc/ticket-steward/slots/docker && chmod 0755 /etc/ticket-steward/slots /etc/ticket-steward/slots/init /etc/ticket-steward/slots/docker
COPY --chmod=0755 slot-helper/serve.sh /usr/local/bin/serve.sh
ENTRYPOINT ["/usr/local/bin/serve.sh"]
