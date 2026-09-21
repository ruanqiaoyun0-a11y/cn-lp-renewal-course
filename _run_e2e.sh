#!/usr/bin/env bash
# _run_e2e.sh — 一体化跑 E2E：起静态服务 → 起 headless Chrome → 跑 CDP 测试 → 收尾
# 用法：bash _run_e2e.sh
set -u
cd "$(dirname "$0")" || exit 1

NODE="C:/Users/PC/.workbuddy/binaries/node/versions/22.22.2-3/node.exe"
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
PROF="C:/Users/PC/AppData/Local/Temp/_chrome_renewal_prof"
PORT=8123

cleanup() {
  [ -n "${SRV_PID:-}" ] && kill "$SRV_PID" 2>/dev/null
  [ -n "${CHROME_PID:-}" ] && kill "$CHROME_PID" 2>/dev/null
  taskkill //F //IM chrome.exe //T >/dev/null 2>&1
  sleep 1
}
trap cleanup EXIT

# 1) 静态服务
"$NODE" _server.js > /tmp/_srv.log 2>&1 &
SRV_PID=$!
sleep 2
CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/index.html")
echo "[server] http://127.0.0.1:$PORT/index.html -> $CODE"
[ "$CODE" = "200" ] || { echo "静态服务启动失败"; exit 1; }

# 2) headless Chrome
rm -rf "$PROF"
"$CHROME" --headless=new --remote-debugging-port=9222 \
  --user-data-dir="$PROF" --no-first-run --no-default-browser-check \
  --disable-gpu --window-size=1280,900 \
  "http://127.0.0.1:$PORT/index.html" > /tmp/_chrome.log 2>&1 &
CHROME_PID=$!

# 等待 CDP 就绪
READY=0
for i in $(seq 1 30); do
  if curl -s --noproxy '*' "http://127.0.0.1:9222/json/version" >/dev/null 2>&1; then READY=1; break; fi
  sleep 1
done
if [ "$READY" != "1" ]; then
  echo "[chrome] CDP 未就绪，日志："; tail -20 /tmp/_chrome.log; exit 1
fi
echo "[chrome] CDP 已就绪"

# 3) 跑测试
"$NODE" _cdp_test.js
RC=$?
echo "[exit] $RC"
exit $RC
