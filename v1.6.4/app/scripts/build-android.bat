@echo off
rem ============================================================
rem 归否 App · 一键构建 debug APK（Windows / cmd）
rem
rem 流程：check-env -> npm ci -> npm run build -> cap sync android
rem       -> gradlew assembleDebug -> 打印 APK 绝对路径
rem 详细排查见 docs\BUILD.md
rem ============================================================
setlocal enabledelayedexpansion

echo.
echo [1/5] 环境自检...
node scripts\check-env.mjs
if errorlevel 1 goto :fail

echo.
echo [2/5] 安装依赖（npm ci）...
call npm ci
if errorlevel 1 (
  echo 提示：若无 package-lock.json，请改用 npm install
  goto :fail
)

echo.
echo [3/5] 构建前端产物（dist）...
call npm run build
if errorlevel 1 goto :fail

echo.
echo [4/5] 同步到 Android 工程（cap sync）...
call npx cap sync android
if errorlevel 1 goto :fail

echo.
echo [5/5] Gradle 打包 debug APK...
pushd android
call gradlew assembleDebug
set GRADLE_RC=%ERRORLEVEL%
popd
if not "%GRADLE_RC%"=="0" goto :fail

set APK=%CD%\android\app\build\outputs\apk\debug\app-debug.apk
if not exist "%APK%" (
  echo [FAIL] 未找到 APK：%APK%
  goto :fail
)

echo.
echo ============================================================
echo  [OK] APK 已生成：
echo       %APK%
echo ============================================================
echo.
if exist "%APK%" explorer /select,"%APK%"
exit /b 0

:fail
echo.
echo [FAIL] 构建失败。请按上方错误对照 docs\BUILD.md 的「常见错误排查表」处理。
exit /b 1
