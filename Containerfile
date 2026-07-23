# Single stage — the app has no build step (Node runs the TypeScript natively).
# node:22-alpine tracks the latest 22.x (>=22.18, which engines requires and
# which node:sqlite needs).
FROM docker.io/library/node:22-alpine

WORKDIR /app

# Prod deps only, from the committed lockfile. corepack ships with the image.
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --prod --frozen-lockfile

# Everything the server reads at runtime (see src/server/app.ts static routes).
COPY src ./src
COPY web ./web
COPY clients ./clients
COPY docs ./docs

ENV DB_PATH=/data/mediation.db
EXPOSE 4100

# ponytail: runs as root; USER node needs /data chown handling — add if image is ever exposed beyond the tunnel

# Same command as `pnpm start`.
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server/index.ts"]
