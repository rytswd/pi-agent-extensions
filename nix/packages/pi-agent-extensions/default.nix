{ pkgs, pi ? null }:

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

    runHook postInstall
  '';

  # Post-installation hook: run 'pi install' if pi binary is available
  postInstall = pkgs.lib.optionalString (pi != null) ''
    echo "════════════════════════════════════════════════════════════"
    echo "Attempting automatic installation via 'pi install'..."
    echo "────────────────────────────────────────────────────────────"
    echo "Pi binary: ${pi}/bin/pi"
    echo "Package path: $out"
    echo "────────────────────────────────────────────────────────────"
    
    # Create a temporary file to capture stderr
    STDERR_LOG=$(mktemp)
    
    if ${pi}/bin/pi install "$out" 2>"$STDERR_LOG"; then
      echo "✓ SUCCESS: pi-agent-extensions installed automatically"
      echo ""
      echo "Extensions are now available in pi. To verify, run:"
      echo "  pi config"
      rm -f "$STDERR_LOG"
    else
      EXIT_CODE=$?
      echo "✗ FAILED: pi install exited with code $EXIT_CODE"
      echo ""
      echo "Error output:"
      cat "$STDERR_LOG" || echo "(no error output captured)"
      rm -f "$STDERR_LOG"
      echo ""
      echo "Possible causes:"
      echo "  1. Pi not configured yet (no ~/.pi/agent/settings.json)"
      echo "  2. Pi config directory doesn't exist"
      echo "  3. Permission issues with ~/.pi/agent/"
      echo "  4. Pi binary not compatible with this system"
      echo ""
      echo "Manual installation steps:"
      echo "  1. Ensure pi is installed and working:"
      echo "       pi --version"
      echo "  2. Run pi install manually:"
      echo "       pi install $out"
      echo "  3. Or add to settings.json manually:"
      echo "       echo '{\"packages\":[\"$out\"]}' > ~/.pi/agent/settings.json"
      echo ""
      echo "The package is still installed at: $out"
      echo "Extensions will work once registered with pi."
    fi
    echo "════════════════════════════════════════════════════════════"
  '';

  meta = with pkgs.lib; {
    description = "A collection of pi coding agent extensions";
    homepage = "https://github.com/rytswd/pi-agent-extensions";
    license = licenses.mit;
    maintainers = [ ];
    platforms = platforms.all;
  };
}
