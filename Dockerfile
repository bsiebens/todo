# One image: the web app plus the sync server that serves it.
# Build: docker build -t todo .   Run: see deploy/README.md (docker compose with Postgres).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production STATIC_DIR=/app/dist PORT=8080
# The server is bundled into one file, so no node_modules are needed at run time.
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server/server.cjs ./server.cjs
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
CMD ["node", "server.cjs"]
