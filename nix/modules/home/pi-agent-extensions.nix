# Home-manager module for pi-agent-extensions
# 
# Usage in your home-manager configuration:
#   programs.pi.extensions.pi-agent-extensions.enable = true;
#
# Blueprint injects { flake, inputs } as publisherArgs, giving us
# access to the flake's llm-agents input for the pi binary.
{ inputs, flake, ... }:
{ config, lib, pkgs, ... }:

let
  cfg = config.programs.pi.extensions.pi-agent-extensions;
  system = pkgs.stdenv.hostPlatform.system;
  defaultPi = inputs.llm-agents.packages.${system}.pi or null;

  # Stable symlink path that survives Nix store path changes across rebuilds.
  # home.file manages the symlink target, so pi always references this fixed path.
  stablePath = ".pi/agent/packages/pi-agent-extensions";
in
{
  options.programs.pi.extensions.pi-agent-extensions = {
    enable = lib.mkEnableOption "pi-agent-extensions";

    package = lib.mkOption {
      type = lib.types.package;
      default = flake.packages.${system}.pi-agent-extensions;
      defaultText = lib.literalExpression "flake.packages.\${system}.pi-agent-extensions";
      description = ''
        The pi-agent-extensions package to use.
        
        This package contains all extensions and their dependencies.
        Defaults to the package built by this flake.
      '';
    };

    pi = lib.mkOption {
      type = lib.types.nullOr lib.types.package;
      default = defaultPi;
      defaultText = lib.literalExpression "inputs.llm-agents.packages.\${system}.pi";
      description = ''
        The pi package to use for automatic installation during home-manager activation.
        
        Defaults to the pi package from the llm-agents flake input, which is
        automatically resolved for the current system.

        Set to null to skip automatic installation — you'll need to manually run:
          pi install ~/${stablePath}
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    # Create a stable symlink at ~/.pi/agent/packages/pi-agent-extensions
    # that points to the current Nix store path. This survives rebuilds —
    # home-manager updates the symlink target, but the path registered
    # with pi remains constant.
    home.file.${stablePath}.source = cfg.package;

    # Run 'pi install' using the stable symlink path
    home.activation.pi-agent-extensions = lib.mkIf (cfg.pi != null) (
      lib.hm.dag.entryAfter ["writeBoundary"] ''
        INSTALL_PATH="$HOME/${stablePath}"

        echo "════════════════════════════════════════════════════════════"
        echo "Home Manager: Installing pi-agent-extensions"
        echo "────────────────────────────────────────────────────────────"
        
        if [ -x "${cfg.pi}/bin/pi" ]; then
          echo "Pi binary: ${cfg.pi}/bin/pi"
          echo "Package:   $INSTALL_PATH"
          echo "────────────────────────────────────────────────────────────"
          
          # Create temp file for error output
          STDERR_LOG=$(mktemp)
          
          if $DRY_RUN_CMD ${cfg.pi}/bin/pi install "$INSTALL_PATH" 2>"$STDERR_LOG"; then
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
            echo "  pi install $INSTALL_PATH"
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
      After activation, manually install with: pi install ~/${stablePath}
    '';
  };
}
