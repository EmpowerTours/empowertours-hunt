import { PrismaClient } from "@prisma/client";

// Next dev server hot-reloads modules; without the global cache each reload
// opens a fresh pool and Postgres runs out of connections.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
