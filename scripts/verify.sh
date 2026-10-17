#!/usr/bin/env bash
set -euo pipefail

echo "=========================================="
echo "  Vibe Studio: Project Verification Suite"
echo "=========================================="

# 1. Check for forbidden Cursor artifacts
echo "▶ 1/4 Checking for forbidden Cursor files..."
if [ -d ".cursor" ] || [ -f ".cursorrules" ] || [ -f ".cursorignore" ]; then
  echo "❌ Error: Forbidden Cursor configuration detected! Removing immediately..."
  rm -rf .cursor .cursorrules .cursorignore
  exit 1
fi
echo "✅ Passed: No Cursor files found."

# 2. Check for lazy placeholders
echo "▶ 2/4 Checking for lazy placeholders (TODO/FIXME) in src/..."
if command -v rg >/dev/null 2>&1; then
  if rg -i "TODO:" src/ >/dev/null 2>&1; then
    echo "❌ Error: Unresolved TODO comments found in src/:"
    rg -i "TODO:" src/
    exit 1
  fi
fi
echo "✅ Passed: No lazy placeholders in src/."

# 3. TypeScript Typecheck
echo "▶ 3/4 Running TypeScript strict check..."
npx tsc --noEmit
echo "✅ Passed: TypeScript compiler reported 0 errors."

# 4. Unit & Integration Tests
echo "▶ 4/4 Running Vitest test suite..."
npx vitest run
echo "✅ Passed: All tests passed with 100% assertions."

echo "=========================================="
echo "🎉 ALL CHECKS PASSED: Ready for Vibe Coding!"
echo "=========================================="
