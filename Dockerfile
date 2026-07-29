FROM node:24.10.0-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:collaboration
RUN npm prune --omit=dev

FROM node:24.10.0-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist-service ./dist-service

USER node
EXPOSE 1234
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:1234/health/ready').then(r=>{if(!r.ok)throw Error(String(r.status))})"]
CMD ["node", "dist-service/main.js"]
