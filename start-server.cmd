@echo off
setlocal
cd /d "%~dp0"

if not exist "apps\server\dist\index.js" (
  echo [ChatAgent] 未找到服务端构建产物，正在安装依赖并构建...
  call pnpm install || goto :error
  call pnpm build || goto :error
)

if "%PORT%"=="" set PORT=8787
if "%HOST%"=="" set HOST=0.0.0.0

echo [ChatAgent] 启动服务端： http://localhost:%PORT%
echo [ChatAgent] 按 Ctrl+C 停止。
node apps\server\dist\index.js
goto :eof

:error
echo.
echo [ChatAgent] 构建失败，请检查上方输出。
pause
