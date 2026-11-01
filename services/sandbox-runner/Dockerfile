# The image checks run in. It holds Node and the package managers, and nothing else:
# no git credentials, no build tools beyond what Node ships, no secrets.
# Pin by digest when deploying; the tag is kept here so local builds stay simple.
FROM node:22-bookworm-slim

# corepack provides pnpm and yarn shims. The versions a project pins are downloaded
# into /cache/corepack during the install step, the only step with network access.
RUN corepack enable \
 && mkdir -p /workspace /cache \
 && chown node:node /workspace /cache

ENV CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NO_COLOR=1

USER node
WORKDIR /workspace
