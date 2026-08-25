$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot

Push-Location (Join-Path $repositoryRoot "cloud")
try {
    corepack pnpm install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw "Cloud dependency installation failed." }
    corepack pnpm check
    if ($LASTEXITCODE -ne 0) { throw "Cloud static checks failed." }
    corepack pnpm test
    if ($LASTEXITCODE -ne 0) { throw "Cloud tests failed." }
}
finally {
    Pop-Location
}

Push-Location (Join-Path $repositoryRoot "android")
try {
    & .\scripts\build.ps1
    if ($LASTEXITCODE -ne 0) { throw "Android verification failed." }
}
finally {
    Pop-Location
}

Write-Host "Repository verification passed."
