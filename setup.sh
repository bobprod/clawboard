#!/bin/bash
set -e

echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║   ClawBoard — Setup Linux/Mac        ║"
echo "  ╚══════════════════════════════════════╝"
echo ""

# 1. .env
if [ ! -f .env ]; then
  echo "[1/4] Création du fichier .env..."
  cp .env.example .env
  echo "      .env créé."
else
  echo "[1/4] .env déjà présent."
fi

# 2. npm install
echo "[2/4] Installation des dépendances npm..."
npm install

# 3. Docker Compose
echo "[3/4] Démarrage PostgreSQL + backend (Docker)..."
docker compose up -d postgres
sleep 4
docker compose up -d backend

echo "[4/4] Démarrage du frontend..."
echo ""
echo "  Backend  : http://localhost:4000/api/ping"
echo "  Frontend : http://localhost:5173"
echo ""
npm run dev
