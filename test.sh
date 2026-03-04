#!/bin/bash
set -e

BASE="http://127.0.0.1:7799"

echo "===== 1. HEALTH CHECK ====="
curl -sf "$BASE/health" | python3 -m json.tool

echo ""
echo "===== 2. ADD DIARY ENTRY ====="
DIARY_RESP=$(curl -sf -X POST "$BASE/add" \
  -H "Content-Type: application/json" \
  -d '{"type":"diary","source":"manual","title":"Live Test 2026-03-05","content":"Vault is running! All systems green. This is a live test entry from Antigravity.","tags":"test,vault,live"}')
echo "$DIARY_RESP" | python3 -m json.tool

echo ""
echo "===== 3. ADD CONVERSATION LOG ====="
CONV_RESP=$(curl -sf -X POST "$BASE/add" \
  -H "Content-Type: application/json" \
  -d '{"type":"conversation","source":"antigravity","title":"Vault Run+Test Session","content":"User asked to run and test the vault. Server started on port 7799. All endpoints tested.","tags":"conversation,antigravity,test"}')
echo "$CONV_RESP" | python3 -m json.tool

echo ""
echo "===== 4. SEARCH: query='vault' ====="
curl -sf "$BASE/search?q=vault" | python3 -m json.tool

echo ""
echo "===== 5. SEARCH: query='test' type=diary ====="
curl -sf "$BASE/search?q=test&type=diary" | python3 -m json.tool

echo ""
echo "===== ALL TESTS PASSED ====="
