# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update \
	&& apt-get install -y --no-install-recommends python3 make g++ \
	&& rm -rf /var/lib/apt/lists/* \
	&& npm install -g pnpm@11.5.2
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/web/package.json apps/web/
COPY packages/client/package.json packages/client/
COPY packages/mcp/package.json packages/mcp/
RUN pnpm install --frozen-lockfile
COPY apps/web/scripts apps/web/scripts
RUN EMBEDDING_MODEL_DIR=/models pnpm --filter web models:fetch
COPY . .
RUN pnpm --filter web build && pnpm --filter web deploy --prod --legacy /deploy
RUN arch="$(node -p process.arch)" \
	&& for ort in /deploy/node_modules/.pnpm/onnxruntime-node@*/node_modules/onnxruntime-node; do \
		bin="$ort/bin/napi-v6" \
		&& rm -rf "$bin/darwin" "$bin/win32" \
		&& find "$bin/linux" -mindepth 1 -maxdepth 1 \! -name "$arch" -exec rm -rf '{}' + \
		&& rm -f "$bin/linux/$arch/libonnxruntime_providers_cuda.so" "$bin/linux/$arch/libonnxruntime_providers_tensorrt.so" \
		&& test -f "$bin/linux/$arch/onnxruntime_binding.node" || exit 1; \
	done \
	&& rm -rf /deploy/node_modules/.pnpm/onnxruntime-web@*/node_modules/onnxruntime-web/dist \
	&& ! find /deploy/node_modules -name 'libonnxruntime_providers_*' | grep -q . \
	&& ! find /deploy/node_modules -path '*onnxruntime-web/dist' | grep -q .

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
	PORT=3000 \
	DATABASE_PATH=/data/sagas.db \
	EMBEDDING_MODEL_DIR=/app/models
WORKDIR /app
COPY --from=build /deploy/package.json ./
COPY --from=build /deploy/node_modules ./node_modules
COPY --from=build /models ./models
COPY --from=build /app/apps/web/build ./build
COPY --from=build /app/apps/web/server ./server
COPY docker-entrypoint.sh /usr/local/bin/
RUN mkdir /data && chown node:node /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
	CMD node -e "fetch('http://127.0.0.1:3000/login',{redirect:'manual'}).then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))"
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server/index.js"]
