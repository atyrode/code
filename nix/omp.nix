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
  version = "17.0.6-atyrode.1";
  sources = {
    "x86_64-linux" = {
      asset = "omp-linux-x64";
      hash = "sha256-NASJMAsKhGsRvljHMuRicURE5S5tg8KX/h8sIzXnAAw=";
    };
    "aarch64-linux" = {
      asset = "omp-linux-arm64";
      hash = "sha256-xKj46OTI9zAxU4AKb4HnLkuuhqqCVCJQFjN/pJ6eEwg=";
    };
    "x86_64-darwin" = {
      asset = "omp-darwin-x64";
      hash = "sha256-lNXlnkFDbOUCahBsjoSpO/8TWNLHGvOodkFOkXlnN3M=";
    };
    "aarch64-darwin" = {
      asset = "omp-darwin-arm64";
      hash = "sha256-SeEzTxt/jVR63+Ep6ICqj0TfuvK3ix1W0rlHfwZzRYE=";
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
