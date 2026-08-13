FROM oven/bun:1.3-alpine

# curl é usado pelos healthchecks do compose.
RUN apk add --no-cache curl

WORKDIR /app

# Camada de dependências separada para aproveitar o cache entre builds.
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

ENV NODE_ENV=production

# O comando real vem do compose (main-api.ts ou main-worker.ts).
CMD ["bun", "src/main-api.ts"]
