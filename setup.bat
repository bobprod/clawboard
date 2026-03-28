@echo off
echo.
echo  ╔══════════════════════════════════════╗
echo  ║   ClawBoard — Setup Windows          ║
echo  ╚══════════════════════════════════════╝
echo.

REM 1. Crée le .env si absent
if not exist .env (
    echo [1/4] Création du fichier .env...
    copy .env.example .env
    echo       .env créé. Vous pouvez y ajouter vos clés API plus tard.
) else (
    echo [1/4] .env déjà présent.
)

REM 2. Installe les dépendances npm
echo [2/4] Installation des dépendances npm...
call npm install
if %errorlevel% neq 0 (
    echo ERREUR: npm install a échoué.
    pause
    exit /b 1
)

REM 3. Lance PostgreSQL + backend via Docker Compose
echo [3/4] Démarrage de PostgreSQL et du backend (Docker)...
docker compose up -d postgres
timeout /t 5 /nobreak >nul
docker compose up -d backend
if %errorlevel% neq 0 (
    echo ERREUR: Docker Compose a échoué. Assurez-vous que Docker Desktop est lancé.
    pause
    exit /b 1
)

echo [4/4] Démarrage du frontend...
echo.
echo  Backend  : http://localhost:4000/api/ping
echo  Frontend : http://localhost:5173
echo.
start "" http://localhost:5173
call npm run dev
