{
  description = "Meet Teams Bot Development Environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/release-24.11";
    flake-utils.url = "github:numtide/flake-utils";
    playwright.url = "github:pietdevries94/playwright-web-flake/1.52.0";
  };

  outputs = { self, nixpkgs, flake-utils, playwright }:
    flake-utils.lib.eachDefaultSystem (system:
        let
        overlay = final: prev: {
          inherit (playwright.packages.${system}) playwright-test playwright-driver;
        };
        pkgs = import nixpkgs {
          inherit system;
          overlays = [ overlay ];
        };
        
        # Basic build inputs for the recording server
        buildInputs = with pkgs; [
          nodejs_20
          nodePackages.typescript
          nodePackages.npm
          ffmpeg
          v4l-utils
          pulseaudio
          xorg.xvfb
          xorg.xauth
          vips
          glib
          gtk3
          cairo
          pango
          librsvg
          # Playwright dependencies
          playwright-test
          playwright-driver
        ];
      in
      {
        devShells.default = pkgs.mkShell {
          name = "meet-teams-bot-dev";
          
          buildInputs = buildInputs;
          
          # Set environment variables for TypeScript and Jest
          env = {
            PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
            PLAYWRIGHT_BROWSERS_PATH = "${playwright.packages.${system}.playwright-test}/share/playwright";
            PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "1";
            # Use local node_modules for TypeScript to avoid store conflicts
            NODE_PATH = "./node_modules";
            # Force Node.js 20 to be used
            PATH = "${pkgs.nodejs_20}/bin:$PATH";
          };

          shellHook = ''
            echo "=== Recording Server Development Environment ==="
            echo "Node version: $(node --version)"
            echo "NPM version: $(npm --version)"
            echo "TypeScript version: $(tsc --version)"
            echo ""
            echo "To install dependencies: npm install"
            echo "To run the server: npm start"
            echo ""
          '';
        };
      });
} 
