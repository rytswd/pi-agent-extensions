# Home-manager module for pi-agent-extensions
# 
# Usage in your home-manager configuration:
#   programs.pi.extensions.pi-agent-extensions.enable = true;
{ config, lib, pkgs, ... }:

let
  cfg = config.programs.pi.extensions.pi-agent-extensions;
in
{
  options.programs.pi.extensions.pi-agent-extensions = {
    enable = lib.mkEnableOption "pi-agent-extensions";

    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.pi-agent-extensions;
      defaultText = lib.literalExpression "pkgs.pi-agent-extensions";
      description = ''
        The pi-agent-extensions package to use.
        
        This package contains all extensions and their dependencies.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    # Install extensions using 'pi install' command with local path
    home.activation.pi-agent-extensions = lib.hm.dag.entryAfter ["writeBoundary"] ''
      # Use pi install command to add the package
      if command -v pi &> /dev/null; then
        $DRY_RUN_CMD pi install "${cfg.package}" || true
      fi
    '';
  };
}
