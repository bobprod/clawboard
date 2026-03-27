#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
#  ClawBoard API — Curl Smoke Test Suite
#  Usage : bash tests/curl/smoke.sh [BASE_URL]
#  Default: http://localhost:4000
#  Exit 0 = all pass, Exit N = N failures
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

BASE="${1:-http://localhost:4000}"
PASS=0; FAIL=0

# ── colours ────────────────────────────────────────────────────────────────
G='\033[0;32m'; R='\033[0;31m'; Y='\033[0;33m'; B='\033[0;36m'; NC='\033[0m'

# ── helpers ────────────────────────────────────────────────────────────────
ok()   { echo -e "  ${G}✓${NC}  $1"; ((PASS++)); }
fail() { echo -e "  ${R}✗${NC}  $1"; echo -e "       Expected : ${Y}$2${NC}"; echo -e "       Got      : ${R}$3${NC}"; ((FAIL++)); }

check_body() {
  local name="$1"; local pattern="$2"; local body="$3"
  if echo "$body" | grep -q "$pattern"; then ok "$name"; else fail "$name" "$pattern" "$(echo "$body" | head -c 120)"; fi
}

check_status() {
  local name="$1"; local expected="$2"; local actual="$3"
  if [[ "$actual" == "$expected" ]]; then ok "$name"; else fail "$name" "HTTP $expected" "HTTP $actual"; fi
}

get()    { curl -sf          "$BASE$1" 2>/dev/null || echo "CONN_ERROR"; }
get_s()  { curl -so /dev/null -w "%{http_code}" "$BASE$1" 2>/dev/null || echo "000"; }
post()   { curl -sf -X POST  "$BASE$1" -H "Content-Type: application/json" -d "$2" 2>/dev/null || echo "CONN_ERROR"; }
post_s() { curl -so /dev/null -w "%{http_code}" -X POST "$BASE$1" -H "Content-Type: application/json" -d "$2" 2>/dev/null || echo "000"; }
patch()  { curl -sf -X PATCH "$BASE$1" -H "Content-Type: application/json" -d "$2" 2>/dev/null || echo "CONN_ERROR"; }
del()    { curl -sf -X DELETE "$BASE$1" 2>/dev/null || echo "CONN_ERROR"; }
opts()   { curl -sI -X OPTIONS "$BASE$1" 2>/dev/null || echo "CONN_ERROR"; }

# ─────────────────────────────────────────────────────────────────────────
echo ""
echo -e "${B}═══════════════════════════════════════════════════════${NC}"
echo -e "${B}  ClawBoard API Smoke Tests${NC}"
echo -e "${B}  Target: $BASE${NC}"
echo -e "${B}═══════════════════════════════════════════════════════${NC}"

# ── 1. Health ──────────────────────────────────────────────────────────────
echo -e "\n${B}▶ Health & CORS${NC}"

R=$(get /api/ping)
check_body "GET /api/ping → {ok:true}"              '"ok":true'                    "$R"
check_body "GET /api/ping → has timestamp (ts)"     '"ts"'                         "$R"

H=$(opts /api/ping)
check_body "OPTIONS → Access-Control-Allow-Origin"  "Access-Control-Allow-Origin"  "$H"
check_body "OPTIONS → Access-Control-Allow-Methods" "Access-Control-Allow-Methods" "$H"

S=$(get_s /api/nonexistent-xyz)
check_status "GET /api/nonexistent → 404"           "404"                          "$S"

# ── 2. Tasks — read ───────────────────────────────────────────────────────
echo -e "\n${B}▶ Tasks — read${NC}"

R=$(get /api/tasks)
check_body "GET /api/tasks → array with tasks"      '"id":"tsk_'                   "$R"
check_body "GET /api/tasks → has status field"      '"status"'                     "$R"
check_body "GET /api/tasks → has tokensUsed"        '"tokensUsed"'                 "$R"
check_body "GET /api/tasks → has executions"        '"executions"'                 "$R"

R=$(get /api/tasks/tsk_001)
check_body "GET /api/tasks/tsk_001 → single task"  '"id":"tsk_001"'               "$R"
check_body "GET /api/tasks/tsk_001 → has name"     '"name"'                       "$R"

R=$(get /api/tasks/ghost_task_xyz)
check_body "GET /api/tasks/unknown → null"          "null"                         "$R"

# ── 3. Tasks — write (create → patch → run → delete) ─────────────────────
echo -e "\n${B}▶ Tasks — CRUD write cycle${NC}"

CREATED=$(post /api/tasks '{"name":"[Smoke] Task CRUD","modeleId":"mod_001","agent":"main"}')
check_body "POST /api/tasks → 201 with id"          '"id"'                         "$CREATED"
check_body "POST /api/tasks → status=planned"       '"status":"planned"'           "$CREATED"
check_body "POST /api/tasks → cost=0"               '"cost":0'                     "$CREATED"

TASK_ID=$(echo "$CREATED" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

if [[ -n "$TASK_ID" && "$TASK_ID" != "id" ]]; then
  R=$(patch "/api/tasks/$TASK_ID" '{"status":"running"}')
  check_body "PATCH /api/tasks/:id → status=running"    '"status":"running"'   "$R"
  check_body "PATCH /api/tasks/:id → preserves name"    '"[Smoke] Task CRUD"'  "$R"

  R=$(post "/api/tasks/$TASK_ID/run" '{}')
  check_body "POST /api/tasks/:id/run → {ok:true}"      '"ok":true'            "$R"

  R=$(get "/api/tasks/$TASK_ID")
  check_body "task status=running after /run"            '"status":"running"'   "$R"
  check_body "task has new execution entry"              '"executions"'         "$R"

  R=$(del "/api/tasks/$TASK_ID")
  check_body "DELETE /api/tasks/:id → {ok:true}"        '"ok":true'            "$R"

  R=$(get "/api/tasks/$TASK_ID")
  check_body "GET deleted task → null"                   "null"                 "$R"
fi

# ── 4. Tasks — error paths ────────────────────────────────────────────────
echo -e "\n${B}▶ Tasks — error paths${NC}"

S=$(post_s /api/tasks 'BAD JSON !!!{')
check_status "POST /api/tasks bad JSON → 400"         "400"  "$S"

S=$(post_s /api/tasks/ghost_xyz/run '{}')
check_status "POST run unknown task → 404"            "404"  "$S"

# ── 5. Modèles ────────────────────────────────────────────────────────────
echo -e "\n${B}▶ Modèles${NC}"

R=$(get /api/modeles)
check_body "GET /api/modeles → has id"                '"id":"mod_'               "$R"
check_body "GET /api/modeles → has executionCount"    '"executionCount"'         "$R"
check_body "GET /api/modeles → has disablePreInstr."  '"disablePreInstructions"' "$R"

MOD=$(post /api/modeles '{"name":"[Smoke] Modele","agent":"main","llmModel":"kimi-k2.5","disablePreInstructions":false}')
check_body "POST /api/modeles → created with id"      '"id"'                     "$MOD"
check_body "POST /api/modeles → executionCount=0"     '"executionCount":0'       "$MOD"

MOD_ID=$(echo "$MOD" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
if [[ -n "$MOD_ID" && "$MOD_ID" != "id" ]]; then
  R=$(post "/api/modeles/$MOD_ID/run" '{}')
  check_body "POST /api/modeles/:id/run → taskId"     '"taskId"'                 "$R"
  check_body "POST /api/modeles/:id/run → ok=true"    '"ok":true'                "$R"

  TASK_FROM_MOD=$(echo "$R" | grep -o '"taskId":"[^"]*"' | cut -d'"' -f4)
  if [[ -n "$TASK_FROM_MOD" ]]; then
    TM=$(get "/api/tasks/$TASK_FROM_MOD")
    check_body "task from modele/run → status=running" '"status":"running"'     "$TM"
    del "/api/tasks/$TASK_FROM_MOD" > /dev/null 2>&1
  fi

  S=$(post_s /api/modeles/ghost_mod/run '{}')
  check_status "POST /api/modeles/ghost/run → 404"    "404"                      "$S"

  del "/api/modeles/$MOD_ID" > /dev/null 2>&1
fi

# ── 6. Récurrences ────────────────────────────────────────────────────────
echo -e "\n${B}▶ Récurrences${NC}"

R=$(get /api/recurrences)
check_body "GET /api/recurrences → has cronExpr"    '"cronExpr"'               "$R"
check_body "GET /api/recurrences → has timezone"    '"timezone"'               "$R"
check_body "GET /api/recurrences → has active flag" '"active"'                 "$R"

REC_PAYLOAD='{"name":"[Smoke] Rec","cronExpr":"0 9 * * 1","human":"Lundi 9h","timezone":"Europe/Paris","modeleId":"mod_001","llmModel":"kimi-k2.5","nextRun":"2026-04-06T09:00:00"}'
REC=$(post /api/recurrences "$REC_PAYLOAD")
check_body "POST /api/recurrences → created"        '"id"'                     "$REC"
check_body "POST /api/recurrences → active=true"    '"active":true'            "$REC"

REC_ID=$(echo "$REC" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
if [[ -n "$REC_ID" && "$REC_ID" != "id" ]]; then
  R=$(patch "/api/recurrences/$REC_ID" '{"active":false}')
  check_body "PATCH /api/recurrences/:id → active=false" '"active":false'      "$R"

  R=$(patch "/api/recurrences/$REC_ID" '{"cronExpr":"30 10 * * 1"}')
  check_body "PATCH /api/recurrences/:id → cronExpr"     '"30 10 * * 1"'       "$R"

  R=$(del "/api/recurrences/$REC_ID")
  check_body "DELETE /api/recurrences/:id → ok"          '"ok":true'           "$R"
fi

# ── 7. Pré-instructions ───────────────────────────────────────────────────
echo -e "\n${B}▶ Pré-instructions${NC}"

R=$(get /api/preinstructions)
check_body "GET /api/preinstructions → has content"    '"content"'             "$R"
check_body "GET /api/preinstructions → has savedAt"    '"savedAt"'             "$R"

R=$(curl -sf -X PUT "$BASE/api/preinstructions" -H "Content-Type: application/json" \
  -d '{"content":"[Smoke] Updated instructions"}' 2>/dev/null || echo "CONN_ERROR")
check_body "PUT /api/preinstructions → updated"        '"savedAt"'             "$R"
check_body "PUT /api/preinstructions → correct content" '[Smoke] Updated'      "$R"

S=$(curl -so /dev/null -w "%{http_code}" -X PUT "$BASE/api/preinstructions" \
  -H "Content-Type: application/json" -d '{bad}' 2>/dev/null || echo "000")
check_status "PUT /api/preinstructions bad JSON → 400" "400"                   "$S"

# ── 8. Archives ───────────────────────────────────────────────────────────
echo -e "\n${B}▶ Archives${NC}"

R=$(get /api/archives)
check_body "GET /api/archives → has taskName"        '"taskName"'              "$R"
check_body "GET /api/archives → has duration"        '"duration"'              "$R"
check_body "GET /api/archives → has cost"            '"cost"'                  "$R"
check_body "GET /api/archives → status=ok"           '"status":"ok"'           "$R"
check_body "GET /api/archives → exitCode=0"          '"exitCode":0'            "$R"

# ── 9. SSE content-type ───────────────────────────────────────────────────
echo -e "\n${B}▶ SSE stream headers${NC}"

for ENDPOINT in /api/vitals /api/quota "/api/tasks?stream=1" /api/logs/tsk_001; do
  CT=$(curl -sI --max-time 1 "$BASE$ENDPOINT" 2>/dev/null | grep -i "content-type" || echo "")
  check_body "SSE $ENDPOINT → text/event-stream"     "text/event-stream"       "$CT"
done

# ── Summary ───────────────────────────────────────────────────────────────
TOTAL=$((PASS + FAIL))
echo ""
echo -e "${B}═══════════════════════════════════════════════════════${NC}"
if [[ $FAIL -eq 0 ]]; then
  echo -e "  ${G}All $TOTAL tests passed ✓${NC}"
else
  echo -e "  ${G}$PASS passed${NC}  ${R}$FAIL failed${NC}  /  $TOTAL total"
fi
echo -e "${B}═══════════════════════════════════════════════════════${NC}"
echo ""

exit $FAIL
