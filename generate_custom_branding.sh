#!/bin/bash
# generate_custom_branding.sh - Convert image from URL to video for bot branding
# Usage: ./generate_custom_branding.sh "https://example.com/image.jpg"
set -e

IMAGE_URL=${1:-""}

if [ -z "$IMAGE_URL" ]; then
    echo "❌ Error: Image URL not provided"
    echo "Usage: ./generate_custom_branding.sh 'https://example.com/image.jpg'"
    exit 1
fi

echo "🎬 Downloading and converting image: $IMAGE_URL"

# Download the image directly
curl -L -o temp_image.jpg "$IMAGE_URL"

# Check if download was successful
if [ ! -f "temp_image.jpg" ] || [ ! -s "temp_image.jpg" ]; then
    echo "❌ Error: Failed to download image from $IMAGE_URL"
    exit 1
fi

# Check if we're in WSL2 environment
if [ -n "$WSL_DISTRO_NAME" ] || [ -n "$WSLENV" ]; then
    echo "🔧 WSL2 detected - using image directly for branding"
    # In WSL2, we'll use the image directly instead of converting to video
    cp temp_image.jpg branding_image.jpg
    echo "✅ Branding image saved: branding_image.jpg"
    # Clean up temporary file
    rm temp_image.jpg
else
    # Standard approach for Linux with v4l2loopback
    echo "🎥 Converting to MP4 video (v4l2loopback)..."
    ffmpeg -loop 1 -i temp_image.jpg \
           -c:v libx264 -preset fast -crf 23 \
           -t 5 -pix_fmt yuv420p \
           -vf "scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2:color=black" \
           -y branding.mp4
    
    # Generate Y4M video for Chrome fake video capture
    echo "Converting to Y4M video (Chrome fake video capture)..."
    ffmpeg -loop 1 -i temp_image.jpg \
           -t 5 -pix_fmt yuv420p \
           -vf "scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2:color=black" \
           -y branding.y4m
    
    # Check if files were created
    if [ -f "branding.mp4" ] && [ -f "branding.y4m" ]; then
        echo "✅ Files branding.mp4 and branding.y4m created successfully"
        ls -la branding.mp4 branding.y4m
    else
        echo "❌ Error: Failed to create branding files"
        exit 1
    fi
    
    # Clean up temporary file
    rm temp_image.jpg
    echo "✅ Custom branding generated: branding.mp4 and branding.y4m"
fi
