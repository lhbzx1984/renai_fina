@echo off
chcp 65001 > nul
title 天津仁爱学院报销管理系统
cd /d "%~dp0server"

echo.
echo   ============================================
echo     天津仁爱学院 · 报销管理系统
echo   ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   [错误] 未检测到 Node.js
  echo.
  echo   请先安装 Node.js 22 及以上版本：
  echo     https://nodejs.org/
  echo.
  echo   本项目使用 Node 内置的 node:sqlite，无需安装任何依赖包。
  echo.
  pause
  exit /b 1
)

for /f "tokens=*" %%v in ('node -v') do set NODEVER=%%v
echo   Node 版本: %NODEVER%

node -e "const n=process.versions.node.split('.')[0]; if(n<22){console.log('  [错误] 需要 Node 22 及以上，当前 '+process.versions.node); process.exit(1);}"
if errorlevel 1 (
  echo.
  pause
  exit /b 1
)

echo.
echo   正在启动服务...
echo   浏览器将自动打开 http://127.0.0.1:5180
echo.
echo   [请勿双击打开 server\public\index.html]
echo   双击 HTML 文件会用 file:// 协议打开，连不上后台数据库。
echo.

start "" cmd /c "timeout /t 3 >nul & start http://127.0.0.1:5180"

node --experimental-sqlite index.js

echo.
echo   服务已停止。
pause