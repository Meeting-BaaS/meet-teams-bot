#!/usr/bin/env bash
# install-server-deps.sh: Install server dependencies
# Usage: Run from install-deps.sh

set -euo pipefail

# Note: node_modules and package-lock.json are cleaned by the parent flake
# before calling this script, so we don't need to clean them again here

echo "=== Starting install-server-deps.sh ==="
echo "Current directory: $(pwd)"
echo "Node.js version: $(node --version)"
echo "NPM version: $(npm --version)"

# Verify Node.js version
NODE_VERSION=$(node --version)
if [[ ! "$NODE_VERSION" =~ ^v20.* ]]; then
    echo "Error: Wrong Node.js version. Expected v20, got $NODE_VERSION"
    echo "Please run 'nix develop' to get the correct environment."
    exit 1
fi

echo "✓ Node.js version check passed"

echo "=== Cleaning server dependencies ==="
# echo "Removing node_modules directory..."
# rm -rf node_modules/
# echo "✓ node_modules removed"


echo "=== Cleaning server dependencies ==="

# Check if we're in a Nix build environment
if [ -n "${TYPESCRIPT_TYPES_ROOT:-}" ]; then
    echo "✓ Nix build environment detected - preserving node_modules and package-lock.json"
    echo "TYPESCRIPT_TYPES_ROOT: $TYPESCRIPT_TYPES_ROOT"
    echo "PLAYWRIGHT_TYPES: ${PLAYWRIGHT_TYPES:-'not set'}"
    # In Nix environment, DON'T remove node_modules (buildNpmPackage provides it)
    # Only remove package.json since we recreate it
    rm -f package.json
    echo "✓ package.json removed (will be recreated)"
else
    echo "✓ Dev environment detected - cleaning everything"
    # In dev environment, clean everything
    echo "Removing node_modules directory..."
    rm -rf node_modules/
    echo "✓ node_modules removed"
    rm -f package.json package-lock.json
    echo "✓ package.json and package-lock.json removed"
fi

# Check if we're in a Nix build environment
if [ -n "${TYPESCRIPT_TYPES_ROOT:-}" ]; then
    echo "✓ Nix build environment detected - preserving package-lock.json"
    echo "TYPESCRIPT_TYPES_ROOT: $TYPESCRIPT_TYPES_ROOT"
    echo "PLAYWRIGHT_TYPES: ${PLAYWRIGHT_TYPES:-'not set'}"
    # In Nix environment, we need to keep package-lock.json
    rm -f package.json
    echo "✓ package.json removed (will be recreated)"
else
    echo "✓ Dev environment detected - cleaning everything"
    # In dev environment, clean everything
    rm -f package.json package-lock.json
    echo "✓ package.json and package-lock.json removed"
fi

# Check if we're in a Nix build environment (TYPESCRIPT_TYPES_ROOT is set)
if [ -n "${TYPESCRIPT_TYPES_ROOT:-}" ]; then
    echo "=== Nix Environment Setup ==="
    echo "Detected Nix build environment - setting up TYPESCRIPT_TYPES_ROOT"
    echo "Using Nix-provided TypeScript types from: $TYPESCRIPT_TYPES_ROOT"
    # In Nix environment, we'll use both Nix types and global types
    GLOBAL_NODE_MODULES="${TYPESCRIPT_TYPES_ROOT%%:*}"
    echo "Global node_modules path: $GLOBAL_NODE_MODULES"
    
    # Update TYPESCRIPT_TYPES_ROOT to include both Nix types and global types
    export TYPESCRIPT_TYPES_ROOT="$TYPESCRIPT_TYPES_ROOT:$GLOBAL_NODE_MODULES/@types"
    echo "✓ Updated TYPESCRIPT_TYPES_ROOT to include global types: $TYPESCRIPT_TYPES_ROOT"
    
    # In Nix environment, skip global npm install since types are already available
    echo "✓ Skipping global npm install in Nix environment - types already available"
else
    echo "=== Dev Environment Setup ==="
    # In dev environment, we'll use global types
    echo "Dev environment detected - will use global types"
    
    # Install type definitions globally (only in dev environment)
    echo "Installing type definitions globally..."
    echo "Running: npm install -g --ignore-scripts @types/node@20.19.3"
    npm install -g --ignore-scripts @types/node@20.19.3 || {
        echo "❌ Failed to install type definitions globally!"
        exit 1
    }
    echo "✓ Global type definitions installed successfully"
    
    # Get the global node_modules path
    GLOBAL_NODE_MODULES=$(npm root -g)
    echo "Global node_modules path: $GLOBAL_NODE_MODULES"
    
    # Verify global type definitions
    echo "Verifying global type definitions..."
    if [ ! -d "$GLOBAL_NODE_MODULES/@types/node" ]; then
        echo "❌ Error: @types/node not found in global node_modules"
        echo "Contents of global @types:"
        ls -la "$GLOBAL_NODE_MODULES/@types" || true
        exit 1
    fi
    echo "✓ @types/node found"
    

fi

# Now create the full package.json with all dependencies
echo "=== Creating package.json ==="
echo "Creating full package.json..."
cat > package.json <<EOF
{
  "name": "meet-teams-bot",
  "version": "1.0.0",
  "description": "Automated meeting recording bot for Google Meet, Microsoft Teams, and Zoom",
      "keywords": [
      "meeting",
      "recording",
      "bot",
      "automation",
      "google-meet",
      "teams",
      "zoom"
    ],
  "engines": {
    "node": ">= 18.0.0 <=20"
  },
  "dependencies": {
    "@types/sharp": "^0.31.1",
    "amqplib": "^0.10.3",
    "async": "^3.2.6",
    "axios": "0.21.1",
    "express": "4.17.1",
    "jsdom": "24.0.0",
    "node-fetch": "^2.7.0",
    "ramda": "0.29.1",
    "redis": "4.6.7",
    "retry-axios": "^2.5.0",
    "sharp": "^0.34.1",
    "tesseract.js": "^6.0.0",
    "tslib": "^2.8.1",
    "wav-encoder": "1.3.0",
    "winston": "^3.17.0",
    "ws": "8.18.0"
  },
  "devDependencies": {
    "@types/amqplib": "^0.10.1",
    "@types/async": "^3.2.24",
    "@types/body-parser": "^1.19.0",
    "@types/express": "^4.17.11",

    "@types/jsdom": "^21.1.6",
    "@types/node": "~14.14.45",
    "@types/ramda": "0.29.1",
    "@types/redis": "^4.0.10",
    "@types/wav-encoder": "1.3.3",
    "@types/ws": "8.5.12",
    "depcheck": "^1.4.7",

    "prettier": "3.3.3",
    "rimraf": "~3.0.2",

    "ts-node": "^10.9.2",
    "ts-node-dev": "^2.0.0",
    "ts-unused-exports": "^11.0.1",
    "typescript": "^5.4",
    "unimported": "^1.31.0"
  },
  "scripts": {
    "start": "node build/src/main.js",
    "start-serverless": "SERVERLESS=true node build/src/main.js",
    "clean": "rimraf coverage build tmp",
    "build": "echo '{\"buildDate\": \"'$(date -u +'%Y-%m-%dT%H:%M:%SZ')'\"}' > src/buildInfo.json && ./node_modules/typescript/bin/tsc --skipLibCheck -p tsconfig.release.json",
    "watch": "./node_modules/typescript/bin/tsc --skipLibCheck -w -p tsconfig.release.json",
    "watch-dev": "PROFILE=DEV ts-node-dev --respawn --transpile-only src/main.ts -p tsconfig.release.json",
    "format": "prettier --log-level warn --write \"src/**/*.{jsx,js,ts}\"",

    "check:unused-exports": "ts-unused-exports tsconfig.json",
    "check:unused-imports": "unimported",
    "check:unused-deps": "depcheck",
    "check:dead-code": "npm run check:unused-exports && npm run check:unused-imports && npm run check:unused-deps"
  },
  "author": "Meet Teams Bot Contributors",
  "license": "Apache-2.0",
  "repository": {
    "type": "git",
    "url": "https://github.com/yourusername/meet-teams-bot.git"
  },
  "bugs": {
    "url": "https://github.com/yourusername/meet-teams-bot/issues"
  },
  "homepage": "https://github.com/yourusername/meet-teams-bot#readme",
  "volta": {
    "node": "20.18.0"
  }
}
EOF
echo "✓ package.json created"

# Create .npmrc to set Node.js options globally
echo "=== Creating .npmrc ==="
cat > .npmrc <<EOF
node-options=--experimental-modules
EOF
echo "✓ .npmrc created"

# Install dependencies based on environment
echo "=== Installing Dependencies ==="
echo "Installing dependencies with npm install..."
echo "Running: npm install --legacy-peer-deps"
npm install --legacy-peer-deps || {
    echo "❌ Failed to install dependencies!"
    exit 1
}
echo "✓ Dependencies installed with npm install"

echo "=== Setting up TypeScript Configuration ==="

# Get the TypeScript lib directory from the environment
TYPESCRIPT_LIB_DIR="${TYPESCRIPT_TYPES_ROOT%%:*}"
PLAYWRIGHT_TYPES="${PLAYWRIGHT_TYPES%/types}"

echo "TypeScript lib directory: $TYPESCRIPT_LIB_DIR"
echo "Playwright types: $PLAYWRIGHT_TYPES"



# Create tsconfig.json with npm types and custom Playwright types (no Jest)
echo "Creating tsconfig.json..."
cat > tsconfig.json <<EOF
{
  "compilerOptions": {
    "target": "esnext",
    "module": "commonjs",
    "moduleResolution": "node",
    "allowSyntheticDefaultImports": true,
    "allowJs": true,
    "importHelpers": true,
    "jsx": "react",
    "strict": true,
    "sourceMap": true,
    "forceConsistentCasingInFileNames": true,
    "noFallthroughCasesInSwitch": true,
    "noImplicitReturns": true,
    "noImplicitAny": false,
    "noImplicitThis": false,
    "resolveJsonModule": true,
    "strictNullChecks": false,
    "esModuleInterop": true,
    "types": ["node"],
    "outDir": "./build",
    "skipLibCheck": true,
    "typeRoots": [
      "./node_modules/@types"
    ],
    "paths": {
      "@playwright/test": ["${PLAYWRIGHT_TYPES}"]
    },
    "baseUrl": "."
  },
  "include": [
    "src/**/*"
  ],
  "exclude": [
    "node_modules",
    "**/*.test.ts",
    "**/*.test.js",
    "**/__tests__/**"
  ]
}
EOF
echo "✓ tsconfig.json created"

# Create tsconfig.release.json
echo "Creating tsconfig.release.json..."
cat > tsconfig.release.json <<EOF
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "rootDir": ".",
    "outDir": "build",
    "removeComments": true,
    "resolveJsonModule": true,
    "typeRoots": [
      "./node_modules/@types"
    ],
    "paths": {
      "@playwright/test": ["${PLAYWRIGHT_TYPES}"]
    },
    "baseUrl": "."
  },
  "include": [
    "src/**/*"
  ],
  "exclude": [
    "**/*.test.ts",
    "**/*.test.js",
    "**/__tests__/**"
  ]
}
EOF
echo "✓ tsconfig.release.json created"

echo "✓ TypeScript configuration created with:"
echo "  - Standard types from: ./node_modules/@types"
echo "  - Playwright types from: ${PLAYWRIGHT_TYPES}"



# Verify Playwright types
echo "=== Verifying Playwright Types ==="
if [ -z "$PLAYWRIGHT_TYPES" ]; then
    echo "❌ Warning: PLAYWRIGHT_TYPES environment variable not set"
    echo "Make sure you're running in the nix environment with 'nix develop'"
    exit 1
fi

if [ ! -f "$PLAYWRIGHT_TYPES/index.d.ts" ]; then
    echo "❌ Error: Playwright types not found at $PLAYWRIGHT_TYPES/index.d.ts"
    echo "Make sure you're running in the nix environment with 'nix develop'"
    exit 1
fi
echo "✓ Playwright types verified at: $PLAYWRIGHT_TYPES"

echo "=== Building Server ==="
echo "Creating build info..."
echo "{\"buildDate\": \"$(date -u +'%Y-%m-%dT%H:%M:%SZ')\"}" > src/buildInfo.json
echo "✓ Build info created"

echo "Running TypeScript compilation..."
echo "Running: tsc --skipLibCheck -p tsconfig.release.json"
tsc --skipLibCheck -p tsconfig.release.json || {
    echo "❌ Server build failed!"
    echo "TypeScript configuration:"
    cat tsconfig.release.json
    echo "TypeScript types root: $TYPESCRIPT_TYPES_ROOT"
    echo "Current directory: $PWD"
    echo "Package-lock.json exists: $([ -f "package-lock.json" ] && echo "Yes" || echo "No")"
    echo "Node modules exists: $([ -d "node_modules" ] && echo "Yes" || echo "No")"
    if [ -d "node_modules/@types" ]; then
        echo "Available @types:"
        ls -la node_modules/@types/ || true
    fi
    exit 1
}
echo "✓ TypeScript compilation successful"

# Verify the build actually worked
echo "=== Verifying Build ==="
if [ ! -f "build/src/main.js" ]; then
    echo "❌ Error: Build failed - main.js not found at build/src/main.js"
    echo "Build directory contents:"
    find build -type f 2>/dev/null || echo "No build directory found"
    exit 1
fi
echo "✓ Build verification successful - main.js found"

# Create a wrapper script to run the server with experimental modules
echo "=== Creating Server Wrapper ==="
cat > run-server.sh <<EOF
#!/bin/bash
NODE_OPTIONS="--experimental-modules" node build/src/main.js "\$@"
EOF
chmod +x run-server.sh
echo "✓ Server wrapper script created"

echo "=== Build Summary ==="
echo "✓ Node.js version check passed"
echo "✓ Dependencies cleaned"
echo "✓ Environment detected and configured"
echo "✓ Type definitions set up"
echo "✓ package.json created"
echo "✓ Dependencies installed"
echo "✓ TypeScript configuration created"
echo "✓ Playwright types verified"
echo "✓ Server built successfully"
echo "✓ Build verification passed"
echo "✓ Server wrapper script created"

echo "=== Server dependencies installed and built successfully ===" 
