# Prometheus for Railway: the entrypoint renders the config from environment
# variables at startup (Prometheus itself can't expand env vars in its config).
FROM prom/prometheus:v2.54.1

COPY docker-entrypoint.sh /bin/docker-entrypoint.sh

USER root
RUN chmod +x /bin/docker-entrypoint.sh
USER nobody

ENTRYPOINT ["/bin/docker-entrypoint.sh"]
