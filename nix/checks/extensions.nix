# Verify the built package contains all extensions and dependencies
{ pkgs, flake, system, ... }:

let
  inherit (pkgs) lib;
  package = flake.packages.${system}.pi-agent-extensions;

  extensions = [ "direnv" "fetch" "questionnaire" "slow-mode" ];

  dependencies = [
    "node_modules/@marckrenn/pi-sub-core"
    "node_modules/@marckrenn/pi-sub-bar"
    "node_modules/@marckrenn/pi-sub-shared"
  ];
in
pkgs.runCommand "check-extensions" { } ''
  echo "Checking pi-agent-extensions package…"
  echo "Package: ${package}"
  echo ""

  echo "Extensions:"
  ${lib.concatMapStringsSep "\n" (ext: ''
    if [ -d "${package}/${ext}" ] && [ -f "${package}/${ext}/index.ts" ]; then
      echo "  ✓ ${ext}"
    else
      echo "  ✗ ${ext} — missing or no index.ts"
      exit 1
    fi
  '') extensions}

  echo ""
  echo "Dependencies:"
  ${lib.concatMapStringsSep "\n" (dep: ''
    if [ -d "${package}/${dep}" ]; then
      echo "  ✓ ${dep}"
    else
      echo "  ✗ ${dep} — missing"
      exit 1
    fi
  '') dependencies}

  echo ""
  echo "Metadata:"
  for f in package.json LICENSE; do
    if [ -f "${package}/$f" ]; then
      echo "  ✓ $f"
    else
      echo "  ✗ $f — missing"
      exit 1
    fi
  done

  echo ""
  echo "✅ All checks passed"
  mkdir -p $out
  echo "ok" > $out/result
''
