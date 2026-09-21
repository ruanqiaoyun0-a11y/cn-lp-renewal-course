#!/usr/bin/env bash
# _run_shots.sh — 起服务+Chrome，批量截图，收尾
set -u
cd "$(dirname "$0")" || exit 1
NODE="C:/Users/PC/.workbuddy/binaries/node/versions/22.22.2-3/node.exe"
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
PROF="C:/Users/PC/AppData/Local/Temp/_chrome_shot_prof"
cleanup(){ [ -n "${SRV_PID:-}" ] && kill "$SRV_PID" 2>/dev/null; taskkill //F //IM chrome.exe //T >/dev/null 2>&1; sleep 1; }
trap cleanup EXIT
"$NODE" _server.js > /tmp/_srv.log 2>&1 & SRV_PID=$!
sleep 2
rm -rf "$PROF"
"$CHROME" --headless=new --remote-debugging-port=9222 --user-data-dir="$PROF" --no-first-run --no-default-browser-check --disable-gpu --window-size=1500,1400 "http://127.0.0.1:8123/index.html" > /tmp/_chrome.log 2>&1 &
for i in $(seq 1 30); do curl -s --noproxy '*' http://127.0.0.1:9222/json/version >/dev/null 2>&1 && break; sleep 1; done
mkdir -p _shots
"$NODE" _shot.js _shots/s1_ch1.png 1500 1500 desktop 0
"$NODE" _shot.js _shots/s3_ch3.png 1500 1500 desktop 2
"$NODE" _shot.js _shots/s6_lib.png 1500 1500 desktop 5 levelLibrary
"$NODE" _shot.js _shots/s6_exam.png 1500 1500 desktop 5 exam-paper
ls -la _shots/
