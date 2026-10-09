# Multi-stage build → small self-contained image (Next.js standalone output).
# The same image runs three roles via different commands: web (default),
# worker (dist/worker.cjs), and one-shot migrations (dist/migrate.cjs).
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# NEXT_PHASE lets env.ts skip fail-fast validation at build time (secrets absent).
ENV NEXT_PHASE=phase-production-build
RUN npm run build && npm run build:workers

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
# Run as non-root.
RUN addgroup -g 1001 nodejs && adduser -u 1001 -G nodejs -S nextjs
COPY --from=build /app/public ./public
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
# Bundled worker + migration runner and the committed migrations.
# NOTE: dist/worker.cjs marks @node-rs/argon2 as external, so at runtime it
# resolves that native module from ./node_modules (copied above from
# .next/standalone) — it's only present there because the web app uses
# argon2 for auth and Next's output file tracing pulls it in. If the web app
# ever drops password auth, the worker must declare argon2 as its own
# explicit dependency or it will fail to load.
COPY --from=build --chown=nextjs:nodejs /app/dist ./dist
COPY --from=build --chown=nextjs:nodejs /app/drizzle ./drizzle
USER nextjs
EXPOSE 3000
# Web is the default; worker/migrate services override this command.
CMD ["node", "server.js"]
