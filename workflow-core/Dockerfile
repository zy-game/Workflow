# workflow-core runtime image.
#
# Node 24 is required: Core and the knowledge repository use the built-in
# node:sqlite driver. The process runs as uid/gid 1000 so it can own a data
# volume created by a default Linux user.
#
# Run with host networking and a data volume, for example:
#   docker run -d --name workflow-core --restart unless-stopped \
#     --network host --env-file /etc/workflow-core/core.env \
#     -e WFC_DATA_DIR=/data -v /var/lib/workflow-core:/data \
#     workflow-core:<release>
#
# Host networking is deliberate: Core binds loopback only (WFC_ALLOW_PLAIN_HTTP
# requires a loopback host), and the host's nginx terminates TLS in front of it.
FROM node:24-bookworm-slim

WORKDIR /app

# The monorepo root owns the lockfile, so one workspace install covers Core,
# Worker and Shared.
COPY package.json package-lock.json ./
COPY packages ./packages
COPY ops ./ops
RUN npm ci --omit=dev

ENV NODE_ENV=production
ENV WFC_DATA_DIR=/data
VOLUME ["/data"]

EXPOSE 18710 18711
USER node
CMD ["node", "packages/core/src/index.js"]
