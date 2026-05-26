FROM node:24-bookworm-slim

ARG UID=1000
ARG GID=1000

ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_ENV=production
ENV ORCH_WORKSPACE_ROOT=/workspace
ENV ORCH_DATA_DIR=/data
ENV ORCH_PROMPT_FILE=/app/prompts/main-orchestrator.md
ENV PATH=/home/node/.local/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    passwd \
    python3 \
    python3-pip \
    ripgrep \
    tini \
  && rm -rf /var/lib/apt/lists/*

RUN python3 -m pip install --no-cache-dir --break-system-packages uv

RUN npm install -g \
    @anthropic-ai/claude-code@2.1.150 \
    @openai/codex@0.133.0 \
    @google/gemini-cli@0.43.0

RUN mkdir -p /workspace /data /app \
  && chown -R node:node /workspace /data /app

WORKDIR /app

COPY --chown=node:node pal-mcp-server ./pal-mcp-server
RUN python3 -m pip install --no-cache-dir --break-system-packages -r /app/pal-mcp-server/requirements.txt

COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node test ./test
COPY --chown=node:node public ./public
COPY --chown=node:node prompts ./prompts
COPY --chown=node:node pal-config ./pal-config
COPY --chown=node:node docker-entrypoint.sh /usr/local/bin/orch-entrypoint

RUN chmod +x /usr/local/bin/orch-entrypoint \
  && npm run check \
  && npm test

EXPOSE 8787

ENTRYPOINT ["tini", "--", "orch-entrypoint"]
CMD ["node", "/app/src/server.js"]
