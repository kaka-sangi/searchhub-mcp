FROM oven/bun:1.3.14-alpine AS base
WORKDIR /app

FROM base AS install
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install

FROM base AS run
COPY --from=install /app/node_modules ./node_modules
COPY . .
RUN mkdir -p /app/data
ENV PORT=3000 \
    NODE_ENV=production \
    DATA_DIR=/app/data
EXPOSE 3000
USER bun
CMD ["bun", "run", "src/server.ts"]
