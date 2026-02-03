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
        if [ -x "${cfg.pi}/bin/pi" ]; then
          echo "Installing pi-agent-extensions via pi install..."
          $DRY_RUN_CMD ${cfg.pi}/bin/pi install "${cfg.package}" || {
            echo "Warning: pi install failed. You can manually install with:"
            echo "  pi install ${cfg.package}"
          }
        fi
      ''
    );

    # Show warning if pi is not available
    warnings = lib.optional (cfg.pi == null) ''
      pi-agent-extensions is enabled but pi binary was not found.
      After activation, manually install with: pi install ${cfg.package}
    '';
  };
}
