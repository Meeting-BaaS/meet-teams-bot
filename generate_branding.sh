#!/bin/bash
# generate_branding.sh - Generate default branding video with bot name
# Usage: ./generate_branding.sh "Bot Name"
set -e

BOT_NAME=${1:-"Recording Bot"}
echo "🎬 Generating default branding for: $BOT_NAME"

# Create simple video with bot name text
# Create simple MP4 video with bot name text (v4l2loopback)
echo "🎥 Generating MP4 video (v4l2loopback)..."
ffmpeg -f lavfi -i "color=black:size=640x360:duration=5:rate=30" \
       -vf "drawtext=text='$BOT_NAME':fontsize=48:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2" \
       -c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p \
       -y branding.mp4

echo "✅ Default branding generated: branding.mp4"
# Create Y4M video for Chrome fake video capture
echo "Generating Y4M video (Chrome fake video capture)..."
ffmpeg -f lavfi -i "color=black:size=640x360:duration=5:rate=30" \
       -vf "drawtext=text='$BOT_NAME':fontsize=48:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2" \
       -pix_fmt yuv420p \
       -y branding.y4m
echo "Branding generated: branding.mp4 and branding.y4m"