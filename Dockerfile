FROM node:24-bookworm-slim

ARG UID=1000
ARG GID=1000

ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_ENV=production
ENV ORCH_WORKSPACE_ROOT=/workspace
ENV ORCH_DATA_DIR=/data
ENV ORCH_PROMPT_FILE=/app/prompts/main-orchestrator.md
ENV CODEX_HOME=/home/node/.codex
ENV PATH=/home/node/.local/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    build-essential \
    ca-certificates \
    chromium \
    curl \
    git \
    jq \
    openssh-client \
    passwd \
    python3 \
    python3-pip \
    ripgrep \
    socat \
    tini \
  && rm -rf /var/lib/apt/lists/*

RUN install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
  && chmod a+r /etc/apt/keyrings/docker.asc \
  && . /etc/os-release \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
    docker-ce-cli \
    docker-compose-plugin \
  && rm -rf /var/lib/apt/lists/*

RUN python3 -m pip install --no-cache-dir --break-system-packages uv

RUN npm install -g \
    @anthropic-ai/claude-code@2.1.150 \
    @openai/codex@0.133.0 \
    @google/gemini-cli@0.43.0

# Shared MCP tool servers, pre-installed + pinned so sessions never cold-start npx/uvx.
# NOTE: verify these versions/bin names against the registry at build time.
ARG CONTEXT7_MCP_VERSION=3.0.0
RUN npm install -g @upstash/context7-mcp@${CONTEXT7_MCP_VERSION}

ARG PLAYWRIGHT_MCP_VERSION=0.0.75
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install -g @playwright/mcp@${PLAYWRIGHT_MCP_VERSION}

ARG GITHUB_MCP_VERSION=2025.4.8
RUN npm install -g @modelcontextprotocol/server-github@${GITHUB_MCP_VERSION}

ARG SERENA_SPEC=serena-agent
RUN runuser -u node -- env HOME=/home/node PATH="$PATH" \
    uv tool install --python 3.12 ${SERENA_SPEC}

RUN mkdir -p /workspace /workspace/orchestrator /data /app \
  && chown -R node:node /workspace /data /app

WORKDIR /app

COPY --chown=node:node pal-mcp-server ./pal-mcp-server
RUN python3 -m pip install --no-cache-dir --break-system-packages -r /app/pal-mcp-server/requirements.txt

COPY --chown=node:node package.json README.md .env.example Dockerfile docker-compose.yml docker-entrypoint.sh ./
COPY --chown=node:node src ./src
COPY --chown=node:node test ./test
COPY --chown=node:node public ./public
COPY --chown=node:node prompts ./prompts
COPY --chown=node:node pal-config ./pal-config
COPY --chown=node:node bin ./bin
COPY --chown=node:node docker-entrypoint.sh /usr/local/bin/orch-entrypoint

RUN chmod +x /usr/local/bin/orch-entrypoint /app/bin/orch-preview \
  && ln -sf /app/bin/orch-preview /usr/local/bin/orch-preview \
  && npm run check \
  && npm test

EXPOSE 8787 3000-3020 5173-5190 8000-8020 8080-8090

ENTRYPOINT ["tini", "--", "orch-entrypoint"]
CMD ["node", "/app/src/server.js"]
