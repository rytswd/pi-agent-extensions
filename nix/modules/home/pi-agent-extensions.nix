# Home-manager module for pi-agent-extensions
# 
# Usage in your home-manager configuration:
#   programs.pi.extensions.pi-agent-extensions.enable = true;
{ config, lib, pkgs, ... }:

let
  cfg = config.programs.pi.extensions.pi-agent-extensions;
  
  # Check if pi is installed in the system
  piPackage = config.home.packages
    ++ (if config.programs ? pi then [ config.programs.pi.package or null ] else [])
    |> lib.filter (p: p != null && (p.pname or "") == "pi")
    |> lib.head or null;
in
{
  options.programs.pi.extensions.pi-agent-extensions = {
    enable = lib.mkEnableOption "pi-agent-extensions";

    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.pi-agent-extensions or (throw "pi-agent-extensions package not found. Add it to your nixpkgs overlays or packages.");
      defaultText = lib.literalExpression "pkgs.pi-agent-extensions";
      description = ''
        The pi-agent-extensions package to use.
        
        This package contains all extensions and their dependencies.
      '';
    };

    pi = lib.mkOption {
      type = lib.types.nullOr lib.types.package;
      default = piPackage;
      defaultText = lib.literalExpression "config.programs.pi.package or detected pi package";
      description = ''
        The pi binary to use for installation.
        
        If null, the package will be installed but you'll need to manually run:
          pi install ${cfg.package}
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    # Add the package to home.packages
    home.packages = [ cfg.package ];

    # Run 'pi install' if pi binary is available
    home.activation.pi-agent-extensions = lib.mkIf (cfg.pi != null) (
      lib.hm.dag.entryAfter ["writeBoundary"] ''
        echo "════════════════════════════════════════════════════════════"
        echo "Home Manager: Installing pi-agent-extensions"
        echo "────────────────────────────────────────────────────────────"
        
        if [ -x "${cfg.pi}/bin/pi" ]; then
          echo "Pi binary: ${cfg.pi}/bin/pi"
          echo "Package: ${cfg.package}"
          echo "────────────────────────────────────────────────────────────"
          
          # Create temp file for error output
          STDERR_LOG=$(mktemp)
          
          if $DRY_RUN_CMD ${cfg.pi}/bin/pi install "${cfg.package}" 2>"$STDERR_LOG"; then
            echo "✓ SUCCESS: Extensions registered with pi"
            rm -f "$STDERR_LOG"
          else
            EXIT_CODE=$?
            echo "✗ FAILED: pi install exited with code $EXIT_CODE"
            echo ""
            echo "Error output:"
            cat "$STDERR_LOG" 2>/dev/null || echo "(no error output)"
            rm -f "$STDERR_LOG"
            echo ""
            echo "Manual installation required:"
            echo "  pi install ${cfg.package}"
            echo ""
            echo "Or check pi configuration:"
            echo "  pi config"
          fi
        else
          echo "✗ ERROR: Pi binary not found or not executable"
          echo "Expected: ${cfg.pi}/bin/pi"
          echo ""
          echo "Please ensure pi is installed and try again."
        fi
        echo "════════════════════════════════════════════════════════════"
      ''
    );

    # Show warning if pi is not available
    warnings = lib.optional (cfg.pi == null) ''
      pi-agent-extensions is enabled but pi binary was not found.
      After activation, manually install with: pi install ${cfg.package}
    '';
  };
}
