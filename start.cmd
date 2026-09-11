@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem 优先用打包好的免安装 App
if exist "release\ContentRadar\ContentRadar.exe" (
  echo   正在启动桌面 App ...
  start "" "release\ContentRadar\ContentRadar.exe"
  exit /b 0
)

rem 其次用 Electron 开发模式
if exist "node_modules\electron\dist\electron.exe" (
  echo   正在启动 Electron 开发模式 ...
  call npm.cmd run app
  exit /b %errorlevel%
)

rem 最后退回网页模式
echo   ============================================
echo    Content Radar - 内容雷达（网页模式）
echo   ============================================
echo.
echo   正在启动本地服务 http://127.0.0.1:7788
echo   关闭本窗口即停止服务。
echo.

set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE="

start "" cmd /c "timeout /t 2 >nul & if defined EDGE (start \"\" \"%EDGE%\" --app=http://127.0.0.1:7788) else (start \"\" http://127.0.0.1:7788)"

node src/server.js

echo.
echo   服务已停止。
pause
