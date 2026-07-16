{
  fetchurl,
  lib,
  stdenvNoCC,
}:

# code's own release binaries (static CGO-free Go builds — no loader fixup on
# any platform). Version + hashes are repointed after each release by
# scripts/bump-flake-pin.sh.
let
  version = "0.2.0";
  sources = {
    "x86_64-linux" = {
      asset = "code-linux-amd64";
      hash = "sha256-G6saSqVz3cJRdfSEWGZA3/+y2sRRZ//tMuGjMrSXXgI=";
    };
    "aarch64-linux" = {
      asset = "code-linux-arm64";
      hash = "sha256-1YSITlk5KuNFOcEDNgSQAGOJp2zKOARzwzGns26p4dA=";
    };
    "x86_64-darwin" = {
      asset = "code-darwin-amd64";
      hash = "sha256-ZTlQngwEf/MibSGVkyQir+N9dTXof8PoNm35N04nO60=";
    };
    "aarch64-darwin" = {
      asset = "code-darwin-arm64";
      hash = "sha256-0i7DHo8RC4LuoYlEyxWDZr6g8DulvxlkSIXNwjQCWUE=";
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
