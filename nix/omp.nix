{
  fetchurl,
  lib,
  makeWrapper,
  patchelf,
  stdenv,
}:

# Upstream oh-my-pi release binaries, pinned for the optional `with-omp` bundle.
#
# This is NOT a build dependency: `code` shells out to whatever `omp` is on PATH
# (or CODE_OMP) at runtime, so a normal install needs nothing from here. The pin
# exists only so `nix run github:atyrode/code#with-omp` can hand a stranger a
# working pair without asking them to install omp first.
#
# It used to track the atyrode/omp fork, which is retired — and because the
# dotfiles always tracked upstream, the two disagreed (fork 17.2.1 vs upstream
# 18.x) with nothing to reconcile them. One source, upstream, is the fix.
#
# Linux assets are Bun single-file executables. Patch PT_INTERP in place so
# process.execPath remains the OMP binary when it re-execs subprocess workers.
let
  version = "18.1.1";
  sources = {
    "x86_64-linux" = {
      asset = "omp-linux-x64";
      hash = "sha256-BHgLQfsztljKboRJNTkRuryMkDMqxETn5lYtBB0+rlI=";
    };
    "aarch64-linux" = {
      asset = "omp-linux-arm64";
      hash = "sha256-qL9NzEfc8yhKD2xD/+uUrcCi8DHc1/irjtktAhXImp0=";
    };
    "x86_64-darwin" = {
      asset = "omp-darwin-x64";
      hash = "sha256-9k0uGgUx2MHogPXkumWrromwxHojOzT+T1fcFAo9n18=";
    };
    "aarch64-darwin" = {
      asset = "omp-darwin-arm64";
      hash = "sha256-kPVbhZcXrFkBF3OhW0GR5Azu1QhFMqTe1w3z9Wb5dGk=";
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
