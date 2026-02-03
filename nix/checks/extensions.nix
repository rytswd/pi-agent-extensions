# Check that all extensions are present in the built package
{ pkgs, flake, system, ... }:

let
  package = flake.packages.${system}.pi-agent-extensions;
  
  requiredExtensions = [
    "direnv"
    "questionnaire"
    "slow-mode"
  ];
  
  requiredDeps = [
    "node_modules/@marckrenn/pi-sub-core"
    "node_modules/@marckrenn/pi-sub-bar"
    "node_modules/@marckrenn/pi-sub-shared"
  ];
in
pkgs.runCommand "check-extensions" {
  buildInputs = [ pkgs.coreutils ];
} ''
  set -e
  
  echo "Checking pi-agent-extensions package structure..."
  echo "Package: ${package}"
  echo ""
  
  # Check extensions
  echo "Checking extensions..."
  ${pkgs.lib.concatMapStringsSep "\n" (ext: ''
    if [ -d "${package}/${ext}" ]; then
      echo "  ✓ ${ext}/"
    else
      echo "  ✗ Missing: ${ext}/"
      exit 1
    fi
  '') requiredExtensions}
  
  # Check dependencies
  echo ""
  echo "Checking dependencies..."
  ${pkgs.lib.concatMapStringsSep "\n" (dep: ''
    if [ -d "${package}/${dep}" ]; then
      echo "  ✓ ${dep}"
    else
      echo "  ✗ Missing: ${dep}"
      exit 1
    fi
  '') requiredDeps}
  
  # Check package.json
  echo ""
  echo "Checking package.json..."
  if [ -f "${package}/package.json" ]; then
    echo "  ✓ package.json exists"
  else
    echo "  ✗ Missing: package.json"
    exit 1
  fi
  
  echo ""
  echo "✅ All checks passed!"
  
  # Create success marker
  mkdir -p $out
  echo "success" > $out/result
''
