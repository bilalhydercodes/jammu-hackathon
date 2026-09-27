#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
if [ ! -d frontend/node_modules ]; then
  npm --prefix frontend install
fi
node scripts/start-all.js
