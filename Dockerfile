# Вариант C (SPEC §2.3): FareWatch на домашнем ПК/VPS — Node 24 + SQLite-файл, long polling.
# Сборка:  docker build -t farewatch .
# Запуск:  docker run -d --name farewatch --restart unless-stopped --env-file .dev.vars -v farewatch-data:/data farewatch
FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production \
    DB_PATH=/data/farewatch.db \
    NODE_NO_WARNINGS=1

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY src ./src
COPY migrations ./migrations

RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
USER node

# Node 24 исполняет TypeScript напрямую (type stripping) — отдельная сборка не нужна
CMD ["node", "src/node/main.ts"]
