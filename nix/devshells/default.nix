{ pkgs, ... }:

pkgs.mkShell {
  name = "pi-agent-extensions-dev";

  packages = with pkgs; [
    nodejs
    nodePackages.npm
    jq
    prefetch-npm-deps
    nix-prefetch-git
  ];

  shellHook = ''
    echo "🔧 pi-agent-extensions development environment"
    echo ""
    echo "Commands:"
    echo "  npm install              Install dependencies"
    echo "  nix build                Build the package"
    echo "  nix flake check          Run all checks"
    echo "  prefetch-npm-deps ...    Regenerate npm deps hash"
    echo ""
    echo "Extensions: direnv, fetch, questionnaire, slow-mode"
    echo ""
  '';
}
