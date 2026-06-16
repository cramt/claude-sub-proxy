{
  description = "claude-sub-proxy — OpenAI-compatible proxy fronting the Claude Agent SDK with tool-call passthrough, billing your Claude subscription";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    pnpm2nix = {
      url = "github:cramt/pnpm2nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, flake-utils, pnpm2nix, ... }:
    (flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};

        # Build the app from the pnpm lockfile (no `pnpm install` at build
        # time). The single root package is a one-app workspace; `pnpm run
        # build` runs `nitro build`, which emits a self-contained .output/
        # (server/index.mjs + server/node_modules).
        ws = pnpm2nix.lib.${system}.mkPnpmWorkspace {
          workspace = ./.;
          nodejs = pkgs.nodejs;
          apps = [{
            name = "claude-sub-proxy";
            path = ".";
            version = "0.1.0";
            script = "build"; # nitro build
            distDir = ".output"; # $out = contents of .output
          }];
        };

        # The Nitro output is self-contained, so the wrapper just runs node
        # against it (and supplies sensible HOST/PORT defaults for `nix run`).
        proxy = pkgs.writeShellApplication {
          name = "claude-sub-proxy";
          runtimeInputs = [ pkgs.nodejs ];
          text = ''
            export PORT="''${PORT:-8787}"
            export HOST="''${HOST:-127.0.0.1}"
            exec node ${ws.apps.claude-sub-proxy}/server/index.mjs "$@"
          '';
        };
      in
      {
        packages = {
          claude-sub-proxy = proxy;
          claude-sub-proxy-unwrapped = ws.apps.claude-sub-proxy;
          default = proxy;
        };

        devShells.default = pkgs.mkShell {
          buildInputs = [ pkgs.nodejs pkgs.pnpm ];
        };
      }
    )) // {
      nixosModules.default = import ./nix/module.nix self;
    };
}
