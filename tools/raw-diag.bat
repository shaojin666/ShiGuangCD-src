@echo off
chcp 65001 >nul
cd /d %~dp0\..
where node >nul 2>nul
if errorlevel 1 (
  echo 没有找到 node。请先安装 Node.js LTS ^(https://nodejs.org^)，再重新运行本工具。
  echo.
  pause
  exit /b 1
)
echo ============================================================
echo   ShiGuangCD RAW 读取诊断
echo   请把下面出现的全部内容复制后发给开发者
echo ============================================================
echo.
node "%~dp0raw-diag.js"
echo.
pause
