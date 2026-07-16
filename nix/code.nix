{
  fetchurl,
  lib,
  stdenvNoCC,
}:

# code's own release binaries (static CGO-free Go builds — no loader fixup on
# any platform). Version + hashes are repointed after each release by
# scripts/bump-flake-pin.sh.
let
  version = "0.1.0";
  sources = {
    "x86_64-linux" = {
      asset = "code-linux-amd64";
      hash = "sha256-FmHrQAu9fs6aqfRtRuyDDKfIoTXsCVVOL5Q9W737gcY=";
    };
    "aarch64-linux" = {
      asset = "code-linux-arm64";
      hash = "sha256-F39GL95WLxGDokHRa3mZR2zYBGjfaSim9wFrnx/z7kk=";
    };
    "x86_64-darwin" = {
      asset = "code-darwin-amd64";
      hash = "sha256-J0KorW2g17WNsUbFXRGzqkB2MvO+53IFGHJVLqVbrs4=";
    };
    "aarch64-darwin" = {
      asset = "code-darwin-arm64";
      hash = "sha256-HhFiSs4nm2TTCbwenw22fgjCwyTU5HrGPdkd4DbI3pE=";
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
