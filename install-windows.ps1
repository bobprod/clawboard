# ClawBoard - Windows Installer
# Installe ClawBoard dans %LOCALAPPDATA%\Programs\ClawBoard
# Cree les raccourcis Bureau + Menu Demarrer
# Cree un desinstalleur
#
# Usage: .\install-windows.ps1
# Usage avec chemin custom: .\install-windows.ps1 -InstallDir "C:\MonDossier\ClawBoard"

param(
  [string]$InstallDir = "$env:LOCALAPPDATA\Programs\ClawBoard"
)

$ErrorActionPreference = 'Stop'
$ProjectDir = $PSScriptRoot

Write-Host ""
Write-Host "  ======================================"  -ForegroundColor Cyan
Write-Host "   ClawBoard - Installateur Windows"      -ForegroundColor Cyan
Write-Host "  ======================================"  -ForegroundColor Cyan
Write-Host ""
Write-Host "  Dossier source  : $ProjectDir"
Write-Host "  Dossier cible   : $InstallDir"
Write-Host ""

# ── 1. Verification Node.js >= 18 ─────────────────────────────────────────────

Write-Host "[1/9] Verification de Node.js..." -ForegroundColor Yellow

try {
  $nodeVersion = node --version 2>$null
  if (-not $nodeVersion) { throw "Node.js introuvable" }
  $major = [int]($nodeVersion -replace 'v(\d+)\..*', '$1')
  if ($major -lt 18) {
    Write-Host "  ERREUR : Node.js $nodeVersion detecte. Version 18+ requise." -ForegroundColor Red
    Write-Host "  Ouverture de nodejs.org..." -ForegroundColor Yellow
    Start-Process "https://nodejs.org/en/download/"
    exit 1
  }
  Write-Host "  OK : Node.js $nodeVersion" -ForegroundColor Green
} catch {
  Write-Host "  ERREUR : Node.js n'est pas installe." -ForegroundColor Red
  Write-Host "  Ouverture de nodejs.org..." -ForegroundColor Yellow
  Start-Process "https://nodejs.org/en/download/"
  exit 1
}

# ── 2. Creation du dossier d'installation ─────────────────────────────────────

Write-Host "[2/9] Creation du dossier d'installation..." -ForegroundColor Yellow

if (-not (Test-Path $InstallDir)) {
  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  Write-Host "  Dossier cree : $InstallDir" -ForegroundColor Green
} else {
  Write-Host "  Dossier existant : $InstallDir" -ForegroundColor Green
}

# ── 3. Copie des fichiers avec robocopy ───────────────────────────────────────

Write-Host "[3/9] Copie des fichiers..." -ForegroundColor Yellow

# Exclusions : .git, node_modules, dist, .env
robocopy $ProjectDir $InstallDir /E /XD ".git" "node_modules" "dist" /XF ".env" /NFL /NDL /NJH /NJS /nc /ns /np | Out-Null

# robocopy retourne des codes >= 8 en cas d'erreur reelle
if ($LASTEXITCODE -ge 8) {
  Write-Host "  ERREUR : La copie des fichiers a echoue (code $LASTEXITCODE)." -ForegroundColor Red
  exit 1
}
Write-Host "  Fichiers copies." -ForegroundColor Green

# ── 4. Installation des dependances (prod seulement) ─────────────────────────

Write-Host "[4/9] Installation des dependances (--omit=dev)..." -ForegroundColor Yellow

Push-Location $InstallDir
try {
  npm install --omit=dev --no-fund --no-audit 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "npm install a echoue" }
  Write-Host "  Dependances installees." -ForegroundColor Green
} finally {
  Pop-Location
}

# ── 5. Build Vite (frontend) ──────────────────────────────────────────────────

Write-Host "[5/9] Build du frontend Vite..." -ForegroundColor Yellow

Push-Location $InstallDir
try {
  npm run build 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "npm run build a echoue" }
  Write-Host "  Build termine." -ForegroundColor Green
} finally {
  Pop-Location
}

# ── 6. Copie / creation du .env ───────────────────────────────────────────────

Write-Host "[6/9] Configuration du fichier .env..." -ForegroundColor Yellow

$sourceEnv = Join-Path $ProjectDir ".env"
$destEnv   = Join-Path $InstallDir ".env"

if (Test-Path $sourceEnv) {
  Copy-Item $sourceEnv $destEnv -Force
  Write-Host "  .env copie depuis le projet source." -ForegroundColor Green
} else {
  $minimalEnv = @"
# ClawBoard - Configuration minimale
# Generez vos cles en lancant le wizard (node launcher.mjs)
PORT=4000
LAUNCHER_USER=admin
LAUNCHER_PASS=admin
CLAWBOARD_SECRET=
CLAWBOARD_KEK=
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/clawboard
ALLOWED_ORIGINS=http://localhost:4000
SETUP_DONE=false
"@
  Set-Content -Path $destEnv -Value $minimalEnv -Encoding UTF8
  Write-Host "  .env minimal cree. Lancez le wizard au premier demarrage." -ForegroundColor Yellow
}

# ── 7. Creation de l'icone (Base64 ICO minimal) ───────────────────────────────

Write-Host "[7/9] Creation de l'icone..." -ForegroundColor Yellow

$iconPath = Join-Path $InstallDir "launcher.ico"

# ICO 16x16 violet minimal encode en base64
$icoBase64 = "AAABAAEAEBAQAAEABAAoAQAAFgAAACgAAAAQAAAAIAAAAAEABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
             "AAAAAAAAAAAAAAAAAAAAAAAAAAAAiVUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
             "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
             "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="

try {
  $icoBytes = [Convert]::FromBase64String($icoBase64)
  [IO.File]::WriteAllBytes($iconPath, $icoBytes)
  Write-Host "  Icone creee." -ForegroundColor Green
} catch {
  Write-Host "  Icone non creee (optionnel)." -ForegroundColor Gray
  $iconPath = $null
}

# ── 8. Raccourci Bureau ───────────────────────────────────────────────────────

Write-Host "[8/9] Creation des raccourcis..." -ForegroundColor Yellow

$WshShell    = New-Object -ComObject WScript.Shell
$desktopPath = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktopPath "ClawBoard.lnk"

$shortcut = $WshShell.CreateShortcut($shortcutPath)
$shortcut.TargetPath       = "node"
$shortcut.Arguments        = "`"$InstallDir\launcher.mjs`""
$shortcut.WorkingDirectory = $InstallDir
$shortcut.Description      = "ClawBoard - Launcher Nemoclaw"
if ($iconPath -and (Test-Path $iconPath)) {
  $shortcut.IconLocation = "$iconPath,0"
}
$shortcut.Save()
Write-Host "  Raccourci Bureau : $shortcutPath" -ForegroundColor Green

# ── Raccourci Menu Demarrer ───────────────────────────────────────────────────

$startMenuDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\ClawBoard"
if (-not (Test-Path $startMenuDir)) {
  New-Item -ItemType Directory -Path $startMenuDir -Force | Out-Null
}
$startMenuShortcut = Join-Path $startMenuDir "ClawBoard.lnk"

$shortcut2 = $WshShell.CreateShortcut($startMenuShortcut)
$shortcut2.TargetPath       = "node"
$shortcut2.Arguments        = "`"$InstallDir\launcher.mjs`""
$shortcut2.WorkingDirectory = $InstallDir
$shortcut2.Description      = "ClawBoard - Launcher Nemoclaw"
if ($iconPath -and (Test-Path $iconPath)) {
  $shortcut2.IconLocation = "$iconPath,0"
}
$shortcut2.Save()
Write-Host "  Raccourci Menu Demarrer : $startMenuShortcut" -ForegroundColor Green

# ── 9. Creation du desinstalleur ──────────────────────────────────────────────

$uninstallScript = Join-Path $InstallDir "uninstall.ps1"

$uninstallContent = @"
# ClawBoard - Desinstalleur
# Supprime ClawBoard et ses raccourcis

`$ErrorActionPreference = 'Continue'
`$InstallDir = "$InstallDir"
`$desktopShortcut   = "$shortcutPath"
`$startMenuDir      = "$startMenuDir"

Write-Host "Desinstallation de ClawBoard..." -ForegroundColor Yellow

# Suppression des raccourcis
if (Test-Path `$desktopShortcut) { Remove-Item `$desktopShortcut -Force; Write-Host "  Raccourci Bureau supprime." }
if (Test-Path `$startMenuDir)   { Remove-Item `$startMenuDir -Recurse -Force; Write-Host "  Raccourci Menu Demarrer supprime." }

# Suppression du dossier d'installation
if (Test-Path `$InstallDir) {
  Remove-Item `$InstallDir -Recurse -Force
  Write-Host "  Dossier d'installation supprime." -ForegroundColor Green
}

Write-Host "ClawBoard a ete desinstalle." -ForegroundColor Green
"@

Set-Content -Path $uninstallScript -Value $uninstallContent -Encoding UTF8
Write-Host "  Desinstalleur cree : $uninstallScript" -ForegroundColor Green

# ── Resume ────────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "  ======================================"  -ForegroundColor Green
Write-Host "   Installation terminee avec succes !"   -ForegroundColor Green
Write-Host "  ======================================"  -ForegroundColor Green
Write-Host ""
Write-Host "  ClawBoard installe dans : $InstallDir"
Write-Host ""
Write-Host "  Pour demarrer ClawBoard :"
Write-Host "    - Double-cliquez sur le raccourci Bureau 'ClawBoard'"
Write-Host "    - Ou via le Menu Demarrer > ClawBoard"
Write-Host "    - Ou manuellement : node `"$InstallDir\launcher.mjs`""
Write-Host ""
Write-Host "  Puis ouvrez : http://localhost:3999"
Write-Host ""
Write-Host "  Si c'est le premier lancement, un wizard de configuration"
Write-Host "  s'affichera automatiquement pour securiser votre installation."
Write-Host ""
