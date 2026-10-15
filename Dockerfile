# syntax=docker/dockerfile:1

FROM node:22-alpine AS build
WORKDIR /app
RUN apk add --no-cache python3 make g++ && npm install -g pnpm@11.5.2
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter web build && pnpm --filter web deploy --prod --legacy /deploy

FROM node:22-alpine AS runtime
RUN apk add --no-cache su-exec
ENV NODE_ENV=production \
	PORT=3000 \
	DATABASE_PATH=/data/workload.db
WORKDIR /app
COPY --from=build /deploy/package.json ./
COPY --from=build /deploy/node_modules ./node_modules
COPY --from=build /app/apps/web/build ./build
COPY --from=build /app/apps/web/server ./server
COPY docker-entrypoint.sh /usr/local/bin/
RUN mkdir /data && chown node:node /data
EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server/index.js"]
