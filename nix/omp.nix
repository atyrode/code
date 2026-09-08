{
  fetchurl,
  lib,
  makeWrapper,
  patchelf,
  stdenv,
}:

# Upstream oh-my-pi release binaries, pinned for `with-omp` and required CI.
#
# A normal install uses `omp` on PATH (or CODE_OMP). Dotfiles owns its managed
# machine runtime and configuration; this optional standalone bundle does not
# override or depend on that deployment. Required CI consumes this same
# derivation, so the bundle's version and hashes have one Code-owned source.
#
# Linux assets are Bun single-file executables. Patch PT_INTERP in place so
# process.execPath remains the OMP binary when it re-execs subprocess workers.
let
  version = "18.1.14";
  sources = {
    "x86_64-linux" = {
      asset = "omp-linux-x64";
      hash = "sha256-J91my2osOf/1Hh/m20Dx83b+5KPQRFfyNu2qXQKQ5NI=";
    };
    "aarch64-linux" = {
      asset = "omp-linux-arm64";
      hash = "sha256-k7oRQ+lcahOOz66l76YFfkWqbkCFPYilW0hYbRGPcyU=";
    };
    "x86_64-darwin" = {
      asset = "omp-darwin-x64";
      hash = "sha256-v1ZT38dLyapu3WlnMjyr8M+3at6A9mmuLlVPJ/otrQ4=";
    };
    "aarch64-darwin" = {
      asset = "omp-darwin-arm64";
      hash = "sha256-ZsCcxf/I4IAzVklXnHzDIhLX4qE9SGoU9F0A8wiOptI=";
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
