#!/bin/bash
BASE="http://127.0.0.1:7799"
PW="vault2026"

echo "=== Test /secrets/verify ==="
curl -sf -X POST "$BASE/secrets/verify" \
  -H "Content-Type: application/json" \
  -d "{\"password\":\"$PW\"}" | python3 -m json.tool

echo ""
echo "=== Test /secrets/add ==="
curl -sf -X POST "$BASE/secrets/add" \
  -H "Content-Type: application/json" \
  -d "{\"password\":\"$PW\",\"category\":\"password\",\"label\":\"Gmail Account\",\"fields\":{\"username\":\"rohit@gmail.com\",\"password\":\"testpass123\",\"url\":\"https://gmail.com\"}}" | python3 -m json.tool

echo ""
echo "=== Test /secrets/list ==="
curl -sf "$BASE/secrets/list" | python3 -m json.tool
