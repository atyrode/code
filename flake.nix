{
  description = "Mission control for your coding agents. Yes, it's called code.";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    { self, nixpkgs }:
    let
      lib = nixpkgs.lib;
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems =
        f:
        lib.genAttrs systems (
          system:
          f {
            pkgs = nixpkgs.legacyPackages.${system};
          }
        );
    in
    {
      # The packages wrap the goreleaser RELEASE BINARIES (fetchurl), not a
      # source build: instant `nix run`, no vendorHash churn, and every install
      # channel ships the byte-identical artifact. scripts/bump-flake-pin.sh
      # repoints nix/code.nix after each release.
      packages = forAllSystems (
        { pkgs }:
        rec {
          code = pkgs.callPackage ./nix/code.nix { };
          omp = pkgs.callPackage ./nix/omp.nix { };
          with-omp = pkgs.callPackage ./nix/with-omp.nix { inherit code omp; };
          default = code;
        }
      );

      overlays.default = final: prev: {
        code = final.callPackage ./nix/code.nix { };
      };
    };
}
