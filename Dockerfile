FROM oven/bun:1-slim
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production || bun install --production
COPY src ./src
COPY public ./public
COPY demo ./demo
COPY landing ./landing
ENV PORT=3000
ENV DB_PATH=/data/prism.db
EXPOSE 3000
CMD ["sh", "-c", "bun run src/seed.ts && bun run src/server.ts"]
