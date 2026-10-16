FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: better-sqlite3 ships a prebuilt binary; no node-gyp/Python in the slim image.
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src/ ./src/
RUN npm run build

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM node:22-slim
ARG GIT_SHA=dev
ENV NODE_ENV=production \
    GIT_SHA=${GIT_SHA} \
    HOST=0.0.0.0 \
    PORT=8080 \
    PUBLIC_PORT=8081 \
    DATA_DIR=/data
RUN useradd --no-create-home --uid 10001 app && mkdir -p /data && chown 10001:10001 /data
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY migrations/ ./migrations/
COPY prompts/ ./prompts/
# The two public policy pages (WP-PLAT-06), served under PUBLIC_BASE.
COPY public/ ./public/
USER 10001:10001
# 8080: director API, /health, /ready. 8081: the public listener (four routes, WP-PLAT-07).
EXPOSE 8080 8081
CMD ["node", "dist/index.js"]
