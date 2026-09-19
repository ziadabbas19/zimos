FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
# sequelize-cli is a prod dependency on purpose: the release step below runs
# migrations inside this image, so it has to survive --omit=dev.
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 4000

# start-period covers the migration step, not just the boot: a deploy with a
# backlog of pending migrations can take a while before the port is listening,
# and failing the healthcheck there would restart the container mid-migration.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "require('http').get('http://localhost:4000/health', r => process.exit(r.statusCode===200?0:1)).on('error', () => process.exit(1))"

# Migrate, then exec the server. See scripts/start.sh.
CMD ["sh", "scripts/start.sh"]
