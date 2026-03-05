{ pkgs, ... }:

let
  src = ../../..;
in
pkgs.buildNpmPackage {
  pname = "pi-agent-extensions";
  version = "0.1.0";

  inherit src;

  # Generate with: nix-shell -p prefetch-npm-deps --run 'prefetch-npm-deps package-lock.json'
  npmDepsHash = "sha256-YdgnK7Kp47uTglS4ig4hx7FyoOm7f1AwQQMjM1mOK64=";

  postPatch = ''
    cp ${src}/package-lock.json package-lock.json
  '';

  dontNpmBuild = true;

  installPhase = ''
    runHook preInstall

    mkdir -p $out

    # Copy extension directories (those containing index.ts)
    for dir in */; do
      case "$dir" in
        nix/|air/|node_modules/|.*) continue ;;
      esac
      if [ -f "$dir/index.ts" ]; then
        echo "Copying extension: $dir"
        cp -r "$dir" "$out/"
      fi
    done

    # Copy runtime dependencies
    cp -r node_modules "$out/"

    # Copy metadata
    cp package.json "$out/"
    cp LICENSE "$out/"
    cp README.org "$out/"

    runHook postInstall
  '';

  meta = with pkgs.lib; {
    description = "A collection of pi coding agent extensions";
    homepage = "https://github.com/rytswd/pi-agent-extensions";
    license = licenses.mit;
    platforms = platforms.all;
  };
}
