{
  fetchurl,
  lib,
  stdenvNoCC,
}:

# code's own release binaries (static CGO-free Go builds — no loader fixup on
# any platform). Version + hashes are repointed after each release by
# scripts/bump-flake-pin.sh.
let
  version = "0.12.0";
  sources = {
    "x86_64-linux" = {
      asset = "code-linux-amd64";
      hash = "sha256-Tay6A68oOjXqlvrdT8EugwRW3iK9aCZKGnJ2yJ65k7I=";
    };
    "aarch64-linux" = {
      asset = "code-linux-arm64";
      hash = "sha256-cMY2uN7YooMmZ6voj38EQA4JBBoiKLAB2yoAmB3dcl0=";
    };
    "x86_64-darwin" = {
      asset = "code-darwin-amd64";
      hash = "sha256-ajpCajw4VXode3gAmXStWdRl2Yax/mfgBhkxY1H2SBs=";
    };
    "aarch64-darwin" = {
      asset = "code-darwin-arm64";
      hash = "sha256-/Mq5dUsNLvoGuO42bLJ9RYsjBX8ByMn4s88Z/0l1uAY=";
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
