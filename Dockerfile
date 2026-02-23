# ── Stage 1: Builder ──────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Install dependencies (including devDependencies for build)
COPY package*.json ./
RUN npm ci

# Copy source and build
COPY tsconfig*.json ./
COPY src/ ./src/
RUN npm run build

# ── Stage 2: Production ───────────────────────────────────────────────────────
FROM node:22-alpine AS production

# Add non-root user for security
RUN addgroup -S mnemosyne && adduser -S mnemosyne -G mnemosyne

WORKDIR /app

# Install production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled output from builder
COPY --from=builder /app/dist ./dist

# Set ownership
RUN chown -R mnemosyne:mnemosyne /app
USER mnemosyne

# Environment defaults (override at runtime)
ENV NODE_ENV=production \
    QDRANT_URL=http://qdrant:6333 \
    EMBEDDING_URL=http://ollama:11434 \
    EMBEDDING_MODEL=nomic-embed-text \
    AGENT_ID=mnemosyne-agent \
    COLLECTION_NAME=memories \
    REDIS_URL=redis://redis:6379 \
    FALKORDB_HOST=falkordb \
    FALKORDB_PORT=6380

EXPOSE 3000

CMD ["node", "dist/index.js"]
