# The agent server image. Build from the repo root, because npm workspaces
# install from the root lockfile:
#   docker build -f packages/agent/Dockerfile .
# Pinned to the Node version the code is tested on.
FROM node:26.7.0-slim

WORKDIR /app
COPY . .
# .dockerignore keeps secrets out. This fails the build if one slips through.
RUN test ! -e .env

# tsx runs the TypeScript at start-up, and it is a dev dependency.
RUN npm ci --include=dev

# The Qloo harness writes its home here, so the unprivileged user must own it.
RUN mkdir -p packages/agent/data/qloo-home && chown -R node:node packages/agent/data

# Set after npm ci, so the install above still includes dev dependencies.
ENV NODE_ENV=production

USER node
WORKDIR /app/packages/agent
CMD ["node", "--import", "tsx", "src/server/main.ts"]
