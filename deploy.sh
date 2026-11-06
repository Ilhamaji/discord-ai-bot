#!/usr/bin/env bash
# Helper untuk mengelola AI Discord Bot di server (via PM2)
# Usage:
#   ./deploy.sh start     -> start bot
#   ./deploy.sh stop      -> stop bot
#   ./deploy.sh restart   -> restart bot
#   ./deploy.sh status    -> lihat status
#   ./deploy.sh logs      -> lihat log realtime
#   ./deploy.sh update    -> pull/upload kode baru + restart
set -euo pipefail

export PATH="/opt/npm/bin:$PATH"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"

case "${1:-}" in
  start)
    mkdir -p logs
    pm2 start ecosystem.config.js
    pm2 save
    ;;
  stop)
    pm2 stop ai-bot
    ;;
  restart)
    pm2 restart ai-bot
    ;;
  status)
    pm2 status
    ;;
  logs)
    pm2 logs ai-bot
    ;;
  update)
    npm install --no-audit --no-fund
    pm2 restart ai-bot
    pm2 save
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status|logs|update}"
    exit 1
    ;;
esac
