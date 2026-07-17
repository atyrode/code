{
  fetchurl,
  lib,
  stdenvNoCC,
}:

# code's own release binaries (static CGO-free Go builds — no loader fixup on
# any platform). Version + hashes are repointed after each release by
# scripts/bump-flake-pin.sh.
let
  version = "0.2.1";
  sources = {
    "x86_64-linux" = {
      asset = "code-linux-amd64";
      hash = "sha256-qIZRmAw7kJ8eEgMLaqFF4tdR2x664tVVHrmn7aG0jJY=";
    };
    "aarch64-linux" = {
      asset = "code-linux-arm64";
      hash = "sha256-eF+SOKPPgvCHOi66oHl8V8HEy3BZY7WCScU0kY6WJ5U=";
    };
    "x86_64-darwin" = {
      asset = "code-darwin-amd64";
      hash = "sha256-NfmXbPU2+VX+A9omjEuZIUl+NXAnFMmRxi/co2KNASM=";
    };
    "aarch64-darwin" = {
      asset = "code-darwin-arm64";
      hash = "sha256-JBrfbhnXUAyIrixgSn3DbF1tISYVRklbLQ31LuG+BNA=";
    };
  };
  source =
    sources.${stdenvNoCC.hostPlatform.system}
      or (throw "Unsupported code platform: ${stdenvNoCC.hostPlatform.system}");
in
stdenvNoCC.mkDerivation {
  pname = "code";
  inherit version;

  src = fetchurl {
    url = "https://github.com/atyrode/code/releases/download/v${version}/${source.asset}.tar.gz";
    inherit (source) hash;
  };

  sourceRoot = ".";

  installPhase = ''
    runHook preInstall
    install -Dm755 code "$out/bin/code"
    runHook postInstall
  '';

  meta = {
    description = "Mission control for your coding agents";
    homepage = "https://github.com/atyrode/code";
    license = lib.licenses.mit;
    mainProgram = "code";
    platforms = builtins.attrNames sources;
    sourceProvenance = with lib.sourceTypes; [ binaryNativeCode ];
  };
}
