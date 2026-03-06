# Home-manager module for pi-agent-extensions
#
# Usage:
#   programs.pi.extensions.pi-agent-extensions = {
#     enable = true;
#     extensions.fetch.enable = false;  # disable individual extensions
#     extensions.pi-sub.enable = false; # disable pi-sub-core + pi-sub-bar
#   };
#
# Blueprint injects { flake, inputs } as publisherArgs.
{ inputs, flake, ... }:
{ config, lib, pkgs, ... }:

let
  cfg = config.programs.pi.extensions.pi-agent-extensions;
  system = pkgs.stdenv.hostPlatform.system;
  defaultPi = inputs.llm-agents.packages.${system}.pi or null;

  # All available extensions and their metadata.
  # This is the single source of truth — add new extensions here.
  # Each entry maps to one or more paths in package.json's pi.extensions array.
  extensionDefs = {
    direnv = {
      description = "Loads direnv environment variables on session start and after bash commands";
      paths = [ "direnv" ];
    };
    fetch = {
      description = "HTTP request tool — fetches URLs, downloads files, shows curl equivalent";
      paths = [ "fetch" ];
    };
    questionnaire = {
      description = "Multi-question tool for LLM-driven user input";
      paths = [ "questionnaire" ];
    };
    slow-mode = {
      description = "Review gate for write/edit tool calls — toggle with /slowmode";
      paths = [ "slow-mode" ];
    };
    pi-sub = {
      description = "Status bar and subscription tracking (pi-sub-core + pi-sub-bar)";
      paths = [
        "node_modules/@marckrenn/pi-sub-core"
        "node_modules/@marckrenn/pi-sub-bar"
      ];
    };
  };

  # Collect paths from all enabled extensions
  enabledExtensions = lib.filterAttrs (_: ext: ext.enable) cfg.extensions;
  enabledPaths = lib.concatMap
    (ext: extensionDefs.${ext.name}.paths)
    (lib.attrValues enabledExtensions);

  # Build a derived package with a filtered package.json
  filteredPackage = pkgs.runCommand "pi-agent-extensions-filtered" { } ''
    cp -r --no-preserve=mode ${cfg.package} $out

    # Generate package.json with only the enabled extensions
    ${pkgs.jq}/bin/jq --argjson exts ${
      lib.escapeShellArg (builtins.toJSON enabledPaths)
    } '.pi.extensions = $exts' ${cfg.package}/package.json > $out/package.json
  '';

  # Stable symlink path that survives Nix store path changes.
  stablePath = ".pi/agent/packages/pi-agent-extensions";
in
{
  options.programs.pi.extensions.pi-agent-extensions = {
    enable = lib.mkEnableOption "pi-agent-extensions";

    package = lib.mkOption {
      type = lib.types.package;
      default = flake.packages.${system}.pi-agent-extensions;
      defaultText = lib.literalExpression "flake.packages.\${system}.pi-agent-extensions";
      description = "The pi-agent-extensions package to use.";
    };

    pi = lib.mkOption {
      type = lib.types.nullOr lib.types.package;
      default = defaultPi;
      defaultText = lib.literalExpression "inputs.llm-agents.packages.\${system}.pi";
      description = ''
        The pi binary used for install/remove during activation.
        Set to null to skip automatic registration.
      '';
    };

    extensions = lib.mkOption {
      description = "Individual extension toggles.";
      type = lib.types.submodule {
        options = lib.mapAttrs (name: def:
          lib.mkOption {
            type = lib.types.submodule {
              options = {
                enable = lib.mkEnableOption "${name} — ${def.description}" // {
                  default = true;
                };
                name = lib.mkOption {
                  type = lib.types.str;
                  default = name;
                  internal = true;
                };
              };
            };
            default = { };
            description = def.description;
          }
        ) extensionDefs;
      };
      default = { };
    };
  };

  config = lib.mkIf cfg.enable {
    # Symlink the filtered package to a stable path
    home.file.${stablePath}.source = filteredPackage;

    home.activation.pi-agent-extensions = lib.mkIf (cfg.pi != null) (
      lib.hm.dag.entryAfter [ "writeBoundary" ] ''
        PI="${cfg.pi}/bin/pi"
        INSTALL_PATH="$HOME/${stablePath}"

        echo "┌──────────────────────────────────────────────────────────┐"
        echo "│ Home Manager: pi-agent-extensions                       │"
        echo "└──────────────────────────────────────────────────────────┘"

        if ! [ -x "$PI" ]; then
          echo "✗ pi binary not found: $PI"
          echo "  Run manually: pi install $INSTALL_PATH"
          exit 0
        fi

        # Show what's enabled / disabled
        echo ""
        echo "Extensions:"
        ${lib.concatStringsSep "\n" (lib.mapAttrsToList (name: def:
          let ext = cfg.extensions.${name}; in
          if ext.enable then
            ''echo "  ✓ ${name}"''
          else
            ''echo "  ✗ ${name} (disabled)"''
        ) extensionDefs)}
        echo ""

        # Install the package (registers only enabled extensions)
        if $DRY_RUN_CMD "$PI" install "$INSTALL_PATH" 2>/dev/null; then
          echo "✓ Extensions registered with pi"
        else
          echo "✗ pi install failed (exit $?)"
          echo "  Try manually: pi install $INSTALL_PATH"
        fi
      ''
    );

    warnings = lib.optional (cfg.pi == null) ''
      pi-agent-extensions: no pi binary available.
      After activation, run: pi install ~/${stablePath}
    '' ++ lib.optional (enabledExtensions == { }) ''
      pi-agent-extensions: all extensions are disabled.
      Enable at least one via programs.pi.extensions.pi-agent-extensions.extensions.<name>.enable.
    '';
  };
}
