{
  fetchurl,
  lib,
  makeWrapper,
  patchelf,
  stdenv,
}:

# Upstream oh-my-pi release binaries, pinned for `with-omp` and required CI.
#
# This is NOT a build dependency: `code` shells out to whatever `omp` is on PATH
# (or CODE_OMP) at runtime, so a normal install needs nothing from here. The pin
# gives `with-omp` a tested pair and CI the same runtime for the native
# tool-registry canaries; version and hashes have one source.
#
# It used to track the atyrode/omp fork, which is retired — and because the
# dotfiles always tracked upstream, the two disagreed (fork 17.2.1 vs upstream
# 18.x) with nothing to reconcile them. One source, upstream, is the fix.
#
# Linux assets are Bun single-file executables. Patch PT_INTERP in place so
# process.execPath remains the OMP binary when it re-execs subprocess workers.
let
  version = "18.1.12";
  sources = {
    "x86_64-linux" = {
      asset = "omp-linux-x64";
      hash = "sha256-9UMQCPcdLzlxYXIFz86csifB0TVmWTAIgkTHbYay+0I=";
    };
    "aarch64-linux" = {
      asset = "omp-linux-arm64";
      hash = "sha256-Eox5SY5bnTKF1Xt7Q9RhOarVRzpph2cxT/vmDHxd4xQ=";
    };
    "x86_64-darwin" = {
      asset = "omp-darwin-x64";
      hash = "sha256-81tW7DnIlMf0N6LROo7lrFGp/GXvLEozu8TsnGMznLU=";
    };
    "aarch64-darwin" = {
      asset = "omp-darwin-arm64";
      hash = "sha256-fP2Q4LPz/25KlJMUsBBF8ZyyXy8tnYXDxkvORwS+hn0=";
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
    homepage = "https://github.com/can1357/oh-my-pi";
    license = lib.licenses.mit;
    mainProgram = "omp";
    platforms = builtins.attrNames sources;
    sourceProvenance = with lib.sourceTypes; [ binaryNativeCode ];
  };
}
