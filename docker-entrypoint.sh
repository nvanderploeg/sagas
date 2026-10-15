#!/bin/sh
set -eu

# Never run the app as root. A fresh bind mount arrives root-owned, so hand /data to node first.
if [ "$(id -u)" = 0 ]; then
	find /data \! -user node -exec chown node:node '{}' +
	exec su-exec node "$@"
fi
exec "$@"
