#!/bin/bash
# 双击这个文件就能启动「小树英语」
cd "$(dirname "$0")" || exit 1
PORT=8787

if curl -s --max-time 1 "http://127.0.0.1:$PORT/api/health" > /dev/null 2>&1; then
  echo "小树英语已经在运行了，直接打开页面。"
else
  echo "正在启动小树英语…"
  nohup node server.js > /tmp/xy_english_app.log 2>&1 &
  sleep 1.5
fi

open "http://127.0.0.1:$PORT/"
echo "页面已打开：http://127.0.0.1:$PORT/"
echo "这个窗口可以关掉，服务在后台跑。"
