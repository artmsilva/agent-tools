FROM docker.io/library/node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d

ARG PI_VERSION=0.82.1
RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates diffutils fd-find git iproute2 ripgrep tmux util-linux \
  && ln -s /usr/bin/fdfind /usr/local/bin/fd \
  && rm -rf /var/lib/apt/lists/*
RUN npm install --global "@earendil-works/pi-coding-agent@${PI_VERSION}"
RUN mkdir -p /workspace /baseline /home/node/.pi/agent \
  && chown -R node:node /workspace /baseline /home/node

ENV HOME=/home/node \
  PI_CODING_AGENT_DIR=/home/node/.pi/agent \
  SHELL=/bin/bash
USER node
WORKDIR /workspace
ENTRYPOINT ["sleep", "infinity"]
