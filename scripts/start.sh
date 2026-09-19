#!/bin/sh
# Container entrypoint: bring the schema up to date, then start the API.
#
# Split out of the Dockerfile CMD so docker-compose, Railway's start command
# and a local `sh scripts/start.sh` all go through the same two steps.
set -e

node scripts/release-migrate.js

# `exec` so the server replaces this shell as PID 1 and receives SIGTERM
# directly — server.js closes the HTTP server and the DB pool on that signal,
# and none of that runs if the shell stays in front of it and swallows it.
exec node src/server.js
