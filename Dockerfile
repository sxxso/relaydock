FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN npm run build
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000 RELAYDOCK_DATA_DIR=/app/data
RUN mkdir /app/data && chown node:node /app/data
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/LICENSE ./LICENSE
COPY --from=build --chown=node:node /app/THIRD-PARTY-NOTICES.md ./THIRD-PARTY-NOTICES.md
COPY --from=build --chown=node:node /app/scripts/doctor.mjs /app/scripts/doctor-lib.mjs ./scripts/
COPY --from=build --chown=node:node /app/node_modules/@next/env ./node_modules/@next/env
USER node
EXPOSE 3000
VOLUME ["/app/data"]
CMD ["node", "server.js"]

