{
  description = "WebSocket test server for streaming transcription with ngrok";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
          inherit system;
          config.allowUnfree = true;
        };
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            nodejs_22
            ngrok
          ];

          shellHook = ''
            echo ""
            echo "🎙️  Streaming Transcription Test Environment"
            echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
            echo ""
            echo "Available commands:"
            echo "  npm install     - Install dependencies (first time only)"
            echo "  npm start       - Start WebSocket server on port 8765"
            echo "  npm run tunnel  - Start ngrok tunnel (run in separate terminal)"
            echo "  npm run dev     - Start both server and ngrok together"
            echo ""
            echo "Quick start:"
            echo "  1. Run: npm install && npm run dev"
            echo "  2. Copy the ngrok wss:// URL"
            echo "  3. Use it in your streaming_transcription_config.output_url"
            echo ""
          '';
        };
      }
    );
}
