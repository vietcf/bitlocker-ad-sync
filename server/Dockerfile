FROM node:24.9-alpine

WORKDIR /app
ENV NODE_ENV=production

# pg_dump for the database backup (Quan tri > Sao luu); same major version as the server (17).
RUN apk add --no-cache postgresql17-client

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public
COPY db/migrations ./db/migrations
COPY openapi ./openapi
COPY templates ./templates

# Backup files (BACKUP_DIR, default /app/backups): usually a mounted volume.
RUN mkdir -p /app/backups && chown node:node /app/backups && chmod 700 /app/backups

# Never run as root.
USER node
EXPOSE 3000 8443
CMD ["node", "src/index.js"]
