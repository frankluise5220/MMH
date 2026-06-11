FROM node:20-bookworm AS build

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:20-bookworm-slim AS runtime

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/next.config.ts ./next.config.ts
COPY --from=build /app/public ./public
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/src ./src
COPY --from=build /app/.next ./.next

ENV NODE_ENV=production
ENV PORT=7777

EXPOSE 7777

CMD ["sh", "-c", "PGHOST=\"${PGHOST:-postgres}\"; PGUSER=\"${POSTGRES_USER:-openclaw}\"; PGDATABASE=\"${POSTGRES_DB:-openclaw}\"; until pg_isready -h \"$PGHOST\" -U \"$PGUSER\" -d \"$PGDATABASE\"; do echo \"[wiseme] waiting for postgres...\"; sleep 1; done; npx prisma db push; npm run start"]
