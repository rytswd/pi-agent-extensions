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

  # Note: Automatic installation via 'pi install' cannot happen during Nix build
  # because the build runs in a sandbox without access to ~/.pi/agent/settings.json
  # 
  # For automatic installation, use the Home Manager module instead:
  #   programs.pi.extensions.pi-agent-extensions.enable = true;
  # 
  # For manual installation after building:
  #   nix build .#pi-agent-extensions
  #   pi install ./result

  meta = with pkgs.lib; {
    description = "A collection of pi coding agent extensions";
    homepage = "https://github.com/rytswd/pi-agent-extensions";
    license = licenses.mit;
    maintainers = [ ];
    platforms = platforms.all;
  };
}
