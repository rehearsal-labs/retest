#!/bin/sh
# Builds the Linux image and runs Retest's checks in it, with Chrome's sandbox on. With no arguments it runs every
# gate: build, typecheck, unit, types and integration. Otherwise it runs the command given, for example
#   docker/linux/run.sh npm run test:unit
set -eu

root=$(cd "$(dirname "$0")/../.." && pwd)
image=${RETEST_LINUX_IMAGE:-retest-linux:dev}

docker build --file "$root/docker/linux/Dockerfile" --tag "$image" "$root"

# --init reaps the processes a browser leaves behind as it ends; without it they stay as zombies and Retest reports
# the browser as still there. The seccomp profile is Docker's default plus the calls Chrome's sandbox makes, which
# need no capability, so the container keeps none.
exec docker run --rm --init --cap-drop ALL --security-opt "seccomp=$root/docker/linux/chromium-seccomp.json" "$image" "$@"
