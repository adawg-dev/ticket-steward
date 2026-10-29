# The run pod's egress sidecar: mitmproxy with the placeholder-swapping addon. Build with ops/egress as the context.
FROM mitmproxy/mitmproxy:12.2.1@sha256:743b6cdc817211d64bc269f5defacca8d14e76e647fc474e5c7244dbcb645141

COPY swap.py entrypoint.sh /opt/egress/
RUN chmod 0755 /opt/egress /opt/egress/entrypoint.sh && chmod 0644 /opt/egress/swap.py

ENV HOME=/home/mitmproxy PYTHONUNBUFFERED=1
USER mitmproxy
ENTRYPOINT ["/opt/egress/entrypoint.sh"]
