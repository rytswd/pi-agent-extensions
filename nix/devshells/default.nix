{ pkgs, ... }:

pkgs.mkShell {
  name = "pi-agent-extensions-dev";

  packages = with pkgs; [
    # Node.js ecosystem
    nodejs
    nodePackages.npm
    
    # Development tools
    jq
    
    # Nix tools
    prefetch-npm-deps
    nix-prefetch-git
    
    # Optional: pi if available
    # pi
  ];

  shellHook = ''
    echo "🔧 pi-agent-extensions development environment"
    echo ""
    echo "Available commands:"
    echo "  npm install          - Install dependencies"
    echo "  nix build .#         - Build the package"
    echo "  nix flake check      - Check the flake"
    echo "  prefetch-npm-deps    - Generate npm deps hash"
    echo ""
    echo "Extensions:"
    echo "  - direnv/"
    echo "  - questionnaire/"
    echo "  - slow-mode/"
    echo ""
  '';
}
