$ErrorActionPreference = "Stop"
$sdkRoot = $env:ANDROID_SDK_ROOT
if (-not $sdkRoot) { $sdkRoot = $env:ANDROID_HOME }
if (-not $sdkRoot -and (Test-Path -LiteralPath "E:\Android\Sdk")) { $sdkRoot = "E:\Android\Sdk" }
if (-not $sdkRoot) { throw "Set ANDROID_SDK_ROOT (or ANDROID_HOME) to an installed Android SDK." }

$adb = Join-Path $sdkRoot "platform-tools\adb.exe"
$apk = Join-Path $PSScriptRoot "..\app\build\outputs\apk\debug\app-debug.apk"
if (-not (Test-Path -LiteralPath $adb)) { throw "ADB was not found at $adb" }
if (-not (Test-Path -LiteralPath $apk)) { throw "Build the debug APK first" }

& $adb devices
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& $adb install -r $apk
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
