#!/bin/bash
set -e

echo "========================================="
echo "  Running Server Tests (Rust + Linux)"
echo "========================================="
cd /app/server
cargo test -- --nocapture

echo ""
echo "========================================="
echo "  Running Client Rust Tests (Linux, lib only)"
echo "========================================="
cd /app/client/src-tauri
cargo test --lib -- --nocapture

echo ""
echo "========================================="
echo "  Running Client Frontend Tests (Vitest)"
echo "========================================="
cd /app/client
npx vitest run

echo ""
echo "========================================="
echo "  All Tests Passed!"
echo "========================================="
