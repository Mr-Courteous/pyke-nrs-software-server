const { PrismaClient } = require('@prisma/client');

/**
 * Shared Prisma client instance.
 *
 * On Vercel, each serverless function invocation can reuse a warm
 * container, so we cache the client on `global` to avoid exhausting
 * Neon's connection limit by creating a new client (and new pool) on
 * every request. This is the standard Prisma-on-serverless pattern.
 *
 * Make sure DATABASE_URL points at Neon's *pooled* connection string
 * (the one with `-pooler` in the hostname) — see .env.example.
 */
const globalForPrisma = global;

const prisma =
  globalForPrisma.__prisma ||
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__prisma = prisma;
}

module.exports = prisma;
