#!/usr/bin/env bash
# Start Agenite and open it in the default browser.
# Usage: ./start.sh [workspace-dir]
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  [Agenite] 没有找到 Node.js。"
  echo "  请先安装 Node 18 或更高版本: https://nodejs.org"
  echo ""
  exit 1
fi

if [ -n "$1" ]; then
  export AGENITE_WORKSPACE="$1"
fi

echo ""
echo "  正在启动 Agenite 本地服务，浏览器会自动打开..."
echo "  按 Ctrl+C 退出。"
echo ""

exec node server.js --open
