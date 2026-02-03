{ pkgs }:

let
  # Get the root of the project (three levels up from nix/packages/pi-agent-extensions/)
  src = ../../..;
in
pkgs.buildNpmPackage rec {
  pname = "pi-agent-extensions";
  version = "0.1.0";

  inherit src;

  # Generate package-lock.json hash with: nix-shell -p prefetch-npm-deps --run 'prefetch-npm-deps package-lock.json'
  npmDepsHash = "sha256-HcjZnwtT53sZKWSDVcqoRLzFnIb6tVGQM4DvHwNNvDY=";

  # Ensure package-lock.json is available
  postPatch = ''
    cp ${src}/package-lock.json package-lock.json
  '';

  # Don't run npm build, just install dependencies
  dontNpmBuild = true;

  # Copy all extension files and node_modules to output
  installPhase = ''
    runHook preInstall

    mkdir -p $out
    
    # Copy all extension directories (directories with index.ts)
    for dir in */; do
      # Skip nix/, air/, examples/, node_modules/, and hidden directories
      if [[ "$dir" != "nix/" && "$dir" != "air/" && "$dir" != "examples/" && "$dir" != "node_modules/" && "$dir" != .* ]]; then
        if [ -f "$dir/index.ts" ]; then
          echo "Copying extension: $dir"
          cp -r "$dir" $out/
        fi
      fi
    done
    
    # Copy node_modules (contains @marckrenn packages)
    cp -r node_modules $out/
    
    # Copy metadata files
    cp package.json $out/
    cp LICENSE $out/
    cp README.org $out/

    # Create a simple setup script
    cat > $out/setup.sh << 'EOF'
#!/usr/bin/env bash
# pi-agent-extensions setup script
# This script adds this package to pi's configuration

set -e

PI_CONFIG="$HOME/.pi/agent/settings.json"
PACKAGE_PATH="$(cd "$(dirname "$0")" && pwd)"

# Create config directory if it doesn't exist
mkdir -p "$(dirname "$PI_CONFIG")"

# Initialize settings.json if it doesn't exist
if [ ! -f "$PI_CONFIG" ]; then
  echo '{"packages": []}' > "$PI_CONFIG"
fi

# Check if package is already configured
if grep -q "\"$PACKAGE_PATH\"" "$PI_CONFIG" 2>/dev/null; then
  echo "✓ pi-agent-extensions already configured at: $PACKAGE_PATH"
  exit 0
fi

# Add package to settings.json
if command -v jq >/dev/null 2>&1; then
  # Use jq if available for proper JSON manipulation
  TMP=$(mktemp)
  jq --arg path "$PACKAGE_PATH" '.packages += [$path]' "$PI_CONFIG" > "$TMP"
  mv "$TMP" "$PI_CONFIG"
else
  # Fallback: simple append (assumes packages array exists)
  echo "Warning: jq not found, using simple append method"
  sed -i.bak "s|\"packages\": \[|\"packages\": [\n    \"$PACKAGE_PATH\",|" "$PI_CONFIG"
  rm -f "$PI_CONFIG.bak"
fi

echo "✓ Added pi-agent-extensions to $PI_CONFIG"
echo ""
echo "Package path: $PACKAGE_PATH"
echo ""
echo "Extensions are now available. Start pi to use them:"
echo "  pi"
echo ""
echo "To configure individual extensions:"
echo "  pi config"
EOF
    chmod +x $out/setup.sh

    runHook postInstall
  '';

  meta = with pkgs.lib; {
    description = "A collection of pi coding agent extensions";
    homepage = "https://github.com/rytswd/pi-agent-extensions";
    license = licenses.mit;
    maintainers = [ ];
    platforms = platforms.all;
  };
}
