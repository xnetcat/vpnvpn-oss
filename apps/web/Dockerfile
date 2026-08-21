FROM oven/bun:1.1.38 AS builder
WORKDIR /app

COPY package.json bun.lock* turbo.json ./
COPY apps ./apps
COPY services ./services
COPY packages ./packages

RUN bun install --frozen-lockfile

WORKDIR /app

# Generate Prisma client for the shared DB package so that @prisma/client is available
ENV DATABASE_URL="postgresql://localhost:5432/placeholder"
RUN cd packages/db && bun run build

WORKDIR /app/apps/web

# Next.js collects completely anonymous telemetry data about general usage.
# Learn more here: https://nextjs.org/telemetry
ENV NEXT_TELEMETRY_DISABLED=1

RUN bun run build

FROM node:20-slim AS runner

# We run the Next.js app from within the web workspace
WORKDIR /app/apps/web

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Install OpenSSL for Prisma
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Copy monorepo node_modules so Next and Prisma are available at runtime
COPY --from=builder /app/node_modules /app/node_modules

# Copy the built app artifacts
COPY --from=builder /app/apps/web/package.json ./package.json
COPY --from=builder /app/apps/web/next.config.mjs ./next.config.mjs
COPY --from=builder /app/apps/web/public ./public
COPY --from=builder /app/apps/web/.next ./.next

# Fail fast at build time if Prisma client/engine cannot be loaded
WORKDIR /app
RUN DATABASE_URL="postgresql://placeholder:5432/vpnvpn" node -e "require('@prisma/client'); console.log('Prisma client OK in web-app image')"

# Switch back to the web app workspace
WORKDIR /app/apps/web

# Run as an unprivileged user
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# Use Next.js CLI from the shared node_modules (located at /app/node_modules)
CMD ["node", "../../node_modules/next/dist/bin/next", "start", "-H", "0.0.0.0", "-p", "3000"]


