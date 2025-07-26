#!/bin/bash

echo "🎥 Building and starting virtual camera..."

# Build the virtual camera
cd /app/virtual-camera
cargo build --release

# Create a test image if it doesn't exist
if [ ! -f test_logo.png ]; then
    echo "Creating test image..."
    # Create a simple test image using ImageMagick or similar
    # For now, we'll use a placeholder
    echo "Please ensure test_logo.png exists in the virtual-camera directory"
fi

# Start the virtual camera
echo "Starting virtual camera..."
DISPLAY=:99 ./target/release/rust_virtual_camera test_logo.png &

# Wait a moment for the camera to start
sleep 3

# Check if the camera is running
if pgrep -f rust_virtual_camera > /dev/null; then
    echo "✅ Virtual camera started successfully"
else
    echo "❌ Failed to start virtual camera"
    exit 1
fi

# Keep the script running
wait 