{
  fetchurl,
  lib,
  makeWrapper,
  stdenv,
}:

# oh-my-pi's official release binaries, pinned for the `with-omp` bundle.
# The Linux assets are dynamically linked Bun builds, so they run through the
# platform's dynamic linker explicitly (same packaging the author's dotfiles
# use in production).
let
  version = "17.0.1";
  sources = {
    "x86_64-linux" = {
      asset = "omp-linux-x64";
      hash = "sha256-QnqHQ7C073AcxKDGa/HwuRzsBigOjfYilKEU4H+zghU=";
    };
    "aarch64-linux" = {
      asset = "omp-linux-arm64";
      hash = "sha256-jOcwYeAvbU4H36FND1k9CJSYcFb3A7GMGxUY1WHupQk=";
    };
    "x86_64-darwin" = {
      asset = "omp-darwin-x64";
      hash = "sha256-FjGg7Y4vc0zoZ7tEvNuh/W3Os12KtMIKE3Yp69zWy0Y=";
    };
    "aarch64-darwin" = {
      asset = "omp-darwin-arm64";
      hash = "sha256-73v/zOUjOlogosd77hfgpY7uTYaoysxed9BaPO6VTPg=";
    };
  };
  source =
    sources.${stdenv.hostPlatform.system}
      or (throw "Unsupported omp platform: ${stdenv.hostPlatform.system}");
in
stdenv.mkDerivation {
  pname = "omp";
  inherit version;

  src = fetchurl {
    url = "https://github.com/can1357/oh-my-pi/releases/download/v${version}/${source.asset}";
    inherit (source) hash;
  };

  dontUnpack = true;
  dontPatchELF = true;
  dontStrip = true;

  nativeBuildInputs = lib.optionals stdenv.hostPlatform.isLinux [ makeWrapper ];

  installPhase = ''
    runHook preInstall

    ${
      if stdenv.hostPlatform.isLinux then
        ''
          install -Dm755 "$src" "$out/libexec/omp"
          makeWrapper ${stdenv.cc.bintools.dynamicLinker} "$out/bin/omp" \
            --add-flags "$out/libexec/omp"
        ''
      else
        ''
          install -Dm755 "$src" "$out/bin/omp"
        ''
    }

    runHook postInstall
  '';

  meta = {
    description = "AI coding agent for the terminal";
    homepage = "https://github.com/can1357/oh-my-pi";
    license = lib.licenses.mit;
    mainProgram = "omp";
    platforms = builtins.attrNames sources;
    sourceProvenance = with lib.sourceTypes; [ binaryNativeCode ];
  };
}
