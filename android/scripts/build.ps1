$ErrorActionPreference = "Stop"

if (-not $env:JAVA_HOME) {
    $bundledJava = Get-ChildItem -LiteralPath "E:\Android\jdk" -Recurse -Filter java.exe -ErrorAction SilentlyContinue |
        Where-Object FullName -Like "*\bin\java.exe" |
        Select-Object -First 1
    if (-not $bundledJava) {
        throw "Set JAVA_HOME to JDK 17 or install the project toolchain under E:\Android\jdk."
    }
    $env:JAVA_HOME = $bundledJava.Directory.Parent.FullName
}

$sdkRoot = $env:ANDROID_SDK_ROOT
if (-not $sdkRoot) { $sdkRoot = $env:ANDROID_HOME }
if (-not $sdkRoot -and (Test-Path -LiteralPath "E:\Android\Sdk")) { $sdkRoot = "E:\Android\Sdk" }
if (-not $sdkRoot -and (Test-Path -LiteralPath "$env:LOCALAPPDATA\Android\Sdk")) { $sdkRoot = "$env:LOCALAPPDATA\Android\Sdk" }
if (-not $sdkRoot -or -not (Test-Path -LiteralPath $sdkRoot)) {
    throw "Set ANDROID_SDK_ROOT (or ANDROID_HOME) to an installed Android SDK."
}

$env:ANDROID_HOME = $sdkRoot
$env:ANDROID_SDK_ROOT = $sdkRoot
if (-not $env:GRADLE_USER_HOME -and (Test-Path -LiteralPath "E:\Android")) {
    $env:GRADLE_USER_HOME = "E:\Android\gradle-cache"
}

& "$PSScriptRoot\..\gradlew.bat" testDebugUnitTest lintDebug assembleDebug assembleDebugAndroidTest
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
