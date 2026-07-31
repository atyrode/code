{
  fetchurl,
  lib,
  makeWrapper,
  patchelf,
  stdenv,
}:

# atyrode's OMP fork release binaries, pinned for the `with-omp` bundle.
# Linux assets are Bun single-file executables. Patch PT_INTERP in place so
# process.execPath remains the OMP binary when it re-execs subprocess workers.
let
  version = "17.2.1-atyrode.1";
  sources = {
    "x86_64-linux" = {
      asset = "omp-linux-x64";
      hash = "sha256-KqBaxXNTY/ZONsjCfTf+Dc1AWclDPohLFR16ldkrp5s=";
    };
    "aarch64-linux" = {
      asset = "omp-linux-arm64";
      hash = "sha256-E64/ssBc7tsBeVLedEXEUlbiAIUWZz/9YxhNKIKryFE=";
    };
    "x86_64-darwin" = {
      asset = "omp-darwin-x64";
      hash = "sha256-vEvSdtZISOlCkGMvCxA/iYuE5FbdW5QabDkqiVI5cfM=";
    };
    "aarch64-darwin" = {
      asset = "omp-darwin-arm64";
      hash = "sha256-6+zlSbtzBB/sJJlsWqcJIRmO0H0HhGCYrwTPSZFDFEE=";
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
    url = "https://github.com/atyrode/omp/releases/download/v${version}/${source.asset}";
    inherit (source) hash;
  };

  dontUnpack = true;
  dontPatchELF = true;
  dontStrip = true;

  nativeBuildInputs = lib.optionals stdenv.hostPlatform.isLinux [
    makeWrapper
    patchelf
  ];

  installPhase = ''
    runHook preInstall

    ${
      if stdenv.hostPlatform.isLinux then
        ''
          install -Dm755 "$src" "$out/libexec/omp"
          patchelf --set-interpreter ${stdenv.cc.bintools.dynamicLinker} "$out/libexec/omp"
          makeWrapper "$out/libexec/omp" "$out/bin/omp" \
            --suffix LD_LIBRARY_PATH : ${lib.makeLibraryPath [ stdenv.cc.cc.lib ]}
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
    homepage = "https://github.com/atyrode/omp";
    license = lib.licenses.mit;
    mainProgram = "omp";
    platforms = builtins.attrNames sources;
    sourceProvenance = with lib.sourceTypes; [ binaryNativeCode ];
  };
}
