{
  fetchurl,
  lib,
  stdenvNoCC,
}:

# code's own release binaries (static CGO-free Go builds — no loader fixup on
# any platform). Version + hashes are repointed after each release by
# scripts/bump-flake-pin.sh.
let
  version = "0.4.6";
  sources = {
    "x86_64-linux" = {
      asset = "code-linux-amd64";
      hash = "sha256-7lzTzX1wG80AYNzexgHRD/oVRGCndypojq4So+BHCe8=";
    };
    "aarch64-linux" = {
      asset = "code-linux-arm64";
      hash = "sha256-pCuLtCVia1p75jBh95TmlJMSXzBHBWdc4N6+J4bofDk=";
    };
    "x86_64-darwin" = {
      asset = "code-darwin-amd64";
      hash = "sha256-fcubFmXiSRtcrTOP70IU9GXcBn5BUo/CJznGHcln0A8=";
    };
    "aarch64-darwin" = {
      asset = "code-darwin-arm64";
      hash = "sha256-cJr+SiRahmmMmFczr4jW5WGxeBSmFXAP252nmtVdbRs=";
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
