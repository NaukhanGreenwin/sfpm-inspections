#!/usr/bin/env bash
# Build the static export and publish it to the gh-pages branch of NaukhanGreenwin/sfpm-inspections.
# Served at https://inspections.stressfreepm.ca (public/CNAME ships with every build).
set -euo pipefail
cd "$(dirname "$0")"
REMOTE="$(git remote get-url origin)"
npx next build
touch out/.nojekyll
# Commit on top of the existing gh-pages branch (no force push) so GitHub's own CNAME commits are kept.
TMP="$(mktemp -d)"
git clone -q --branch gh-pages --single-branch "$REMOTE" "$TMP" 2>/dev/null || { git -C "$TMP" init -q -b gh-pages; }
find "$TMP" -mindepth 1 -maxdepth 1 ! -name .git ! -name CNAME -exec rm -rf {} +
cp -R out/. "$TMP/"
cd "$TMP"
git add -A
git -c user.name="Hermes" -c user.email="hermes@itrapidsupport.com" commit -q -m "Deploy $(date -u +%Y-%m-%dT%H:%MZ)" || echo "nothing to commit"
git push -q origin gh-pages
echo "Deployed to gh-pages"
