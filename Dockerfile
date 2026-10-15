# syntax=docker/dockerfile:1

FROM node:22-alpine AS build
WORKDIR /app
RUN npm install -g pnpm@11.5.2
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter web build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
	PORT=3000 \
	DATABASE_PATH=/data/workload.db
WORKDIR /app
COPY --from=build /app/apps/web/package.json ./
COPY --from=build /app/apps/web/build ./build
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 3000
CMD ["node", "build"]
