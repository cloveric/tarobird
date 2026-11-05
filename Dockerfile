FROM node:24-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.app.json ./
COPY scripts/ scripts/
COPY src/ src/
COPY deepseek-harness-plugin/ deepseek-harness-plugin/
RUN npm run build
COPY client/package.json client/package-lock.json client/
RUN npm ci --prefix client
COPY client/src/ client/src/
COPY client/public/ client/public/
COPY client/scripts/ client/scripts/
COPY client/index.html client/tsconfig.json client/vite.config.ts client/pdf-assets.ts client/service-worker-downloads.js client/
RUN npm run build --prefix client && npm prune --omit=dev

FROM node:24-slim
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules node_modules/
COPY --from=build /app/dist dist/
COPY --from=build /app/client/dist client/dist/
COPY scripts/ scripts/
COPY bin/ bin/
COPY integrations/ integrations/
ENV NODE_ENV=production
USER node
ENTRYPOINT ["node", "bin/tarobot.mjs"]
