# Production Dockerfile for control-plane
# Uses Node.js directly (Railway deployment)
FROM node:20-slim AS builder
WORKDIR /app

# Copy monorepo files needed for install/build
COPY package.json turbo.json bun.lock* ./
COPY apps ./apps
COPY services ./services
COPY packages ./packages

RUN npm install -g bun
RUN bun install

# Ensure Prisma client is generated for the shared DB package
ENV DATABASE_URL="postgresql://localhost:5432/placeholder"
RUN cd packages/db && bun run build

WORKDIR /app/services/control-plane
RUN bun run build

FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

# Install OpenSSL for Prisma query engine
RUN apt-get update && apt-get install -y openssl ca-certificates && rm -rf /var/lib/apt/lists/*

# Copy built app and dependencies
COPY --from=builder /app/services/control-plane/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/packages/db/prisma ./prisma

# Regenerate Prisma client for the target platform
RUN npx prisma generate --schema=./prisma/schema.prisma

# Verify Prisma client can be loaded
RUN DATABASE_URL="postgresql://placeholder:5432/vpnvpn" node -e "require('@prisma/client'); console.log('Prisma client OK')"

EXPOSE 4000

CMD ["node", "dist/index.mjs"]
