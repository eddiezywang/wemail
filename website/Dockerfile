FROM node:22-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
ARG NPM_REGISTRY=https://registry.npmjs.org
RUN npm ci --registry=${NPM_REGISTRY} --no-audit --no-fund

COPY . .
RUN npm run build

FROM node:22-slim AS runtime

ENV NODE_ENV=production
ENV PORT=4321
WORKDIR /app

COPY --from=build /app/dist ./dist
COPY --from=build /app/server.mjs ./server.mjs
RUN mkdir -p /app/dist/downloads \
  && chown -R node:node /app/dist/downloads

USER node
EXPOSE 4321

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/healthz').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"

CMD ["node", "server.mjs"]
