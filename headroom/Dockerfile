FROM python:3.13-slim-trixie

# to rebuild
# docker compose up -d --build

ENV RUNTIME_HOME=/home/nonroot

ENV HEADROOM_CODE_AWARE_ENABLED=1
ENV HEADROOM_MEMORY_INJECTION_MODE=live_zone_tail
ENV HEADROOM_CCR_TTL_SECONDS=86400
ENV HEADROOM_SMART_CRUSHER_COMPACTION=1
ENV HEADROOM_OUTPUT_HOLDOUT=0.1
ENV HEADROOM_OUTPUT_SHAPER=1
ENV TZ=Europe/Paris

RUN mkdir -p ${RUNTIME_HOME} /data && \
    groupadd --gid 1000 nonroot && \
    useradd --uid 1000 --gid nonroot --create-home nonroot && \
    mkdir -p ${RUNTIME_HOME}/.headroom && \
    chown -R nonroot:nonroot /data ${RUNTIME_HOME}

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

USER nonroot
WORKDIR ${RUNTIME_HOME}

ENV PYTHONUNBUFFERED=1 \
    PATH="${RUNTIME_HOME}/.local/bin:${PATH}"

VOLUME ${RUNTIME_HOME}/.headroom
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["python3", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8787/readyz', timeout=5)"]

RUN pip install --no-cache-dir --upgrade "headroom-ai[proxy,code]"

ENTRYPOINT ["headroom"]
CMD ["--host", "0.0.0.0", "--port", "8787"]
