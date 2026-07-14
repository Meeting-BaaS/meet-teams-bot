{
  description = "meet-teams-bot — pinned dev/build toolchain (Node, pnpm, ffmpeg, Playwright deps)";

  inputs = {
    # Pin nixpkgs by revision so the toolchain is byte-reproducible across the
    # linux box, the Mac mini, and CI. Bump deliberately, never floating.
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.05";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };

        # package.json declares engines.node ">= 18.0.0 <=24.0.0" and the repo's
        # .npmrc sets engine-strict=true, so an out-of-range Node makes
        # `pnpm install` hard-fail with ERR_PNPM_UNSUPPORTED_ENGINE. Node 20 is
        # what the Dockerfile ships, so pin the same major here — this is the
        # whole reason the flake exists: the host's Node (22 on the linux box,
        # 24 on the mini) is out of range and silently breaks installs.
        nodejs = pkgs.nodejs_20;
        pnpm = pkgs.pnpm.override { inherit nodejs; };
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = [
            nodejs
            pnpm
            # Recording pipeline: the bot shells out to ffmpeg (x11grab + PulseAudio).
            pkgs.ffmpeg
            # Local join spikes run the bot in Docker, but a bare-metal run needs these.
            pkgs.xvfb-run
            pkgs.pulseaudio
            pkgs.x11vnc
            pkgs.git
          ];

          shellHook = ''
            echo "meet-teams-bot devshell"
            echo "  node   $(node --version)   (engines: >=18 <=24)"
            echo "  pnpm   $(pnpm --version)"
            echo "  ffmpeg $(ffmpeg -version | head -1 | cut -d' ' -f3)"
            echo ""
            echo "  pnpm install && pnpm test"
            echo "  bash run_bot.sh build && bash run_bot.sh debug zoom.config.json"
          '';
        };
      });
}
