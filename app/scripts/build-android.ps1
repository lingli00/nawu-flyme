#Requires -Version 5.1
<#
.SYNOPSIS
    归否 App · 一键构建 debug APK（Windows / PowerShell）

.DESCRIPTION
    流程：check-env -> npm ci -> npm run build -> cap sync android
          -> gradlew assembleDebug -> 打印 APK 绝对路径

.PARAMETER SkipEnvCheck
    跳过环境自检（确认 JDK17 / ANDROID_HOME 已就绪时使用）

.PARAMETER UseNpmInstall
    没有 package-lock.json 时用 npm install 代替 npm ci

.PARAMETER NoReveal
    构建完成后不在资源管理器中定位 APK

.EXAMPLE
    .\scripts\build-android.ps1
    .\scripts\build-android.ps1 -SkipEnvCheck -UseNpmInstall
#>
[CmdletBinding()]
param(
    [switch]$SkipEnvCheck,
    [switch]$UseNpmInstall,
    [switch]$NoReveal
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

function Write-Step([string]$text) { Write-Host "`n$text" -ForegroundColor Cyan }
function Write-Ok([string]$text)   { Write-Host "[OK] $text" -ForegroundColor Green }
function Write-Err([string]$text)  { Write-Host "[FAIL] $text" -ForegroundColor Red }

try {
    Push-Location $root

    # ---------------------------------------------------------- 1. 环境自检
    if (-not $SkipEnvCheck) {
        Write-Step '[1/5] 环境自检...'
        node scripts\check-env.mjs
        if ($LASTEXITCODE -ne 0) { throw '环境自检未通过，请按指引安装缺失依赖（详见 docs\BUILD.md）' }
    }
    else {
        Write-Step '[1/5] 环境自检（已跳过）'
    }

    # ---------------------------------------------------------- 2. 依赖安装
    Write-Step '[2/5] 安装依赖...'
    if ($UseNpmInstall) { npm install } else { npm ci }
    if ($LASTEXITCODE -ne 0) { throw '依赖安装失败（若无 package-lock.json，请加 -UseNpmInstall）' }

    # ---------------------------------------------------------- 3. 前端构建
    Write-Step '[3/5] 构建前端产物（dist）...'
    npm run build
    if ($LASTEXITCODE -ne 0) { throw '前端构建失败（tsc 或 vite build 报错）' }

    # ---------------------------------------------------------- 4. 同步原生
    Write-Step '[4/5] 同步到 Android 工程（cap sync android）...'
    npx cap sync android
    if ($LASTEXITCODE -ne 0) { throw 'cap sync android 失败' }

    # ---------------------------------------------------------- 5. Gradle
    Write-Step '[5/5] Gradle 打包 debug APK...'
    Push-Location (Join-Path $root 'android')
    try {
        & .\gradlew.bat assembleDebug
        if ($LASTEXITCODE -ne 0) { throw 'gradlew assembleDebug 失败' }
    }
    finally {
        Pop-Location
    }

    $apk = Join-Path $root 'android\app\build\outputs\apk\debug\app-debug.apk'
    if (-not (Test-Path $apk)) { throw "未找到 APK：$apk" }

    $size = [math]::Round((Get-Item $apk).Length / 1MB, 2)
    Write-Host ''
    Write-Host '============================================================' -ForegroundColor Green
    Write-Ok "APK 已生成：$apk （${size} MB）"
    Write-Host '============================================================' -ForegroundColor Green

    if (-not $NoReveal) { explorer /select,"$apk" }
    exit 0
}
catch {
    Write-Err $_.Exception.Message
    Write-Host "排查表见 docs\BUILD.md" -ForegroundColor Yellow
    exit 1
}
finally {
    Pop-Location
}
