{ flake, inputs }:
{ config, lib, pkgs, ... }:

let
  cfg = config.programs.pi.extensions.pi-agent-extensions;
  system = pkgs.stdenv.hostPlatform.system;
  package = flake.packages.${system}.pi-agent-extensions;
in
{
  options.programs.pi.extensions.pi-agent-extensions = {
    enable = lib.mkEnableOption "pi-agent-extensions";

    pi = lib.mkOption {
      type = lib.types.nullOr lib.types.package;
      default = 
        if inputs ? llm-agents then
          inputs.llm-agents.packages.${system}.pi or pkgs.pi or null
        else
          pkgs.pi or null;
      defaultText = lib.literalExpression "inputs.llm-agents.packages.\${system}.pi or pkgs.pi";
      description = ''
        The pi package to use for automatic installation during home-manager activation.
        
        Defaults to pi from llm-agents.nix input if available, otherwise pkgs.pi.
        You can also specify a custom pi package:
          programs.pi.extensions.pi-agent-extensions.pi = myCustomPi;

        Set to null to skip automatic installation — you'll need to manually run:
          pi install <package-path>
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    # Add the package to home.packages
    home.packages = [ package ];

    # Run 'pi install' if pi binary is available
    home.activation.pi-agent-extensions = lib.mkIf (cfg.pi != null) (
      lib.hm.dag.entryAfter ["writeBoundary"] ''
        echo "════════════════════════════════════════════════════════════"
        echo "Home Manager: Installing pi-agent-extensions"
        echo "────────────────────────────────────────────────────────────"
        
        if [ -x "${cfg.pi}/bin/pi" ]; then
          echo "Pi binary: ${cfg.pi}/bin/pi"
          echo "Package: ${package}"
          echo "────────────────────────────────────────────────────────────"
          
          # Create temp file for error output
          STDERR_LOG=$(mktemp)
          
          if $DRY_RUN_CMD ${cfg.pi}/bin/pi install "${package}" 2>"$STDERR_LOG"; then
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
            echo "  pi install ${package}"
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
      pi-agent-extensions is enabled but no pi binary is available.
      After activation, manually install with: pi install ${package}
    '';
  };
}
