{
  code,
  lib,
  makeBinaryWrapper,
  omp,
  runCommand,
  symlinkJoin,
}:

# The zero-setup bundle: `code` with a pinned oh-my-pi on its PATH, and `omp`
# itself exposed alongside (users still authenticate providers with
# `omp login` — Nix can bundle the binary, not the credentials).
let
  wrapped =
    runCommand "code-wrapped"
      {
        nativeBuildInputs = [ makeBinaryWrapper ];
      }
      ''
        makeBinaryWrapper ${lib.getExe code} "$out/bin/code" \
          --prefix PATH : ${lib.makeBinPath [ omp ]}
      '';
in
symlinkJoin {
  name = "code-with-omp";
  paths = [
    wrapped
    omp
  ];
  meta = {
    description = "code + a pinned oh-my-pi, ready to run";
    mainProgram = "code";
    inherit (code.meta) homepage license platforms;
  };
}
