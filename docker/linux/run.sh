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
if [ -n "${RETEST_LINUX_RESULTS:-}" ]; then
  case "$RETEST_LINUX_RESULTS" in
    /*) ;;
    *) echo 'RETEST_LINUX_RESULTS must be an absent absolute result directory.' >&2; exit 2 ;;
  esac
  # Create only a new result directory. The container's non-root user may write its metadata here;
  # no repository, cache or pre-existing directory receives different permissions.
  mkdir "$RETEST_LINUX_RESULTS"
  chmod 0777 "$RETEST_LINUX_RESULTS"
  # A re-run of a CI job reads, read-only, which files its earlier attempts passed, and runs only the others. With
  # RETEST_LINUX_EARLIER set and no folder there, no earlier attempt kept its results, and every file runs.
  earlier_results=
  earlier_mount=
  if [ -n "${RETEST_LINUX_EARLIER:-}" ]; then
    earlier_results=/home/node/ci-earlier
    if [ -d "$RETEST_LINUX_EARLIER" ]; then earlier_mount="type=bind,source=$RETEST_LINUX_EARLIER,target=/home/node/ci-earlier,readonly"; fi
  fi
  exec docker run --rm --init --cap-drop ALL --security-opt "seccomp=$root/docker/linux/chromium-seccomp.json" \
    --env "RETEST_CI_EARLIER_RESULTS=$earlier_results" --env "GITHUB_RUN_ATTEMPT=${GITHUB_RUN_ATTEMPT:-1}" \
    ${earlier_mount:+--mount "$earlier_mount"} \
    --mount "type=bind,source=$RETEST_LINUX_RESULTS,target=/home/node/ci-results" "$image" "$@"
fi
exec docker run --rm --init --cap-drop ALL --security-opt "seccomp=$root/docker/linux/chromium-seccomp.json" "$image" "$@"
