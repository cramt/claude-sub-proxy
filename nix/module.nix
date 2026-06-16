# NixOS module for claude-sub-proxy.
#
# Runs the proxy as a hardened systemd service. The Claude *subscription*
# credentials are delivered via systemd LoadCredential / EnvironmentFile (never
# copied into the world-readable Nix store) and made visible to the Agent SDK at
# $HOME/.claude/.credentials.json. With no ANTHROPIC_API_KEY present, the SDK
# uses the logged-in subscription — which is the whole point.
#
# Imported from the flake as `import ./nix/module.nix self`, where `self`
# supplies the default package for the host's system.
self:
{ config, lib, pkgs, ... }:

let
  cfg = config.services.claude-sub-proxy;
in
{
  options.services.claude-sub-proxy = {
    enable = lib.mkEnableOption "the Claude subscription proxy (OpenAI-compatible, tool-call passthrough)";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.system}.claude-sub-proxy;
      defaultText = lib.literalExpression "claude-sub-proxy.packages.\${system}.claude-sub-proxy";
      description = "The proxy package to run.";
    };

    host = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1";
      description = ''
        Address to bind. Defaults to localhost — the proxy is unauthenticated by
        default and drives a paid Claude subscription, so do not expose it to
        untrusted networks (set {option}`environmentFiles` with `API_KEY=…` first).
      '';
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 8787;
      description = "TCP port the proxy listens on.";
    };

    defaultModel = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = "claude-opus-4-8";
      description = "Model used when a request does not specify one (DEFAULT_MODEL).";
    };

    allowApiKey = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        By default the proxy strips ANTHROPIC_API_KEY from the child env so the
        Agent SDK bills your subscription. Set true to allow a metered
        ANTHROPIC_API_KEY (pay-per-token) through instead.
      '';
    };

    claudeCliPath = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = lib.literalExpression ''"\${pkgs.claude-code}/bin/claude"'';
      description = ''
        Override the `claude` executable the Agent SDK drives. Defaults to the
        version-matched CLI bundled with the SDK (recommended); point at
        `pkgs.claude-code` only if you have a reason to.
      '';
    };

    credentialsFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      example = "/run/secrets/claude-credentials.json";
      description = ''
        Path to a Claude `.credentials.json` (the contents of
        `~/.claude/.credentials.json` from `claude /login` on a Max plan).
        Delivered via systemd LoadCredential and symlinked to
        `$HOME/.claude/.credentials.json`, so it never lands in the Nix store.
        Alternatively, supply `CLAUDE_CODE_OAUTH_TOKEN=…` via {option}`environmentFiles`.
      '';
    };

    environmentFiles = lib.mkOption {
      type = lib.types.listOf lib.types.path;
      default = [ ];
      description = ''
        systemd `EnvironmentFile` paths (KEY=VALUE). Use for secrets such as
        `CLAUDE_CODE_OAUTH_TOKEN=…`, `ANTHROPIC_API_KEY=…` (with
        {option}`allowApiKey`), or `API_KEY=…` to require a client bearer token.
        Pairs naturally with opnix / sops-nix.
      '';
    };

    openFirewall = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Open {option}`port` in the firewall. Leave off unless you have a trusted-network reason.";
    };

    environment = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      description = "Extra environment variables for the service.";
    };
  };

  config = lib.mkIf cfg.enable {
    networking.firewall.allowedTCPPorts = lib.mkIf cfg.openFirewall [ cfg.port ];

    systemd.services.claude-sub-proxy = {
      description = "Claude subscription proxy (OpenAI-compatible)";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];

      environment = {
        HOME = "%S/claude-sub-proxy";
        HOST = cfg.host;
        PORT = toString cfg.port;
        ALLOW_API_KEY = if cfg.allowApiKey then "1" else "0";
      }
      // lib.optionalAttrs (cfg.defaultModel != null) { DEFAULT_MODEL = cfg.defaultModel; }
      // lib.optionalAttrs (cfg.claudeCliPath != null) { CLAUDE_CLI_PATH = cfg.claudeCliPath; }
      // cfg.environment;

      serviceConfig = {
        ExecStartPre = lib.mkIf (cfg.credentialsFile != null) (
          pkgs.writeShellScript "claude-sub-proxy-pre" ''
            set -eu
            mkdir -p "$HOME/.claude"
            ln -sf "$CREDENTIALS_DIRECTORY/claude-credentials.json" "$HOME/.claude/.credentials.json"
          ''
        );
        ExecStart = "${cfg.package}/bin/claude-sub-proxy";

        EnvironmentFile = cfg.environmentFiles;
        LoadCredential = lib.mkIf (cfg.credentialsFile != null)
          [ "claude-credentials.json:${toString cfg.credentialsFile}" ];

        DynamicUser = true;
        StateDirectory = "claude-sub-proxy";
        StateDirectoryMode = "0700";

        Restart = "on-failure";
        RestartSec = 10;

        # Hardening.
        NoNewPrivileges = true;
        PrivateTmp = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        ProtectControlGroups = true;
        ProtectKernelModules = true;
        ProtectKernelTunables = true;
        RestrictAddressFamilies = [ "AF_INET" "AF_INET6" "AF_UNIX" ];
      };
    };
  };
}
