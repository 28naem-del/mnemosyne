FROM node:24-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY tsconfig*.json ./
COPY src/ ./src/
RUN npm run build

FROM node:24-alpine AS production

WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=builder /app/dist ./dist

# SQLite, its WAL, and its shared-memory file need the same writable directory.
RUN mkdir /data && chown node:node /data && chmod 700 /data
VOLUME ["/data"]
USER node

# MCP uses stdin/stdout; there is no HTTP listener or exposed port.
ENTRYPOINT ["node", "/app/dist/cli/index.js"]
CMD ["mcp", "--db", "/data/memory.sqlite", "--workspace", "default", "--agent", "docker-agent"]
