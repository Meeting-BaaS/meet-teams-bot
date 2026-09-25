#!/bin/bash
set -euo pipefail

# Input: pipe-separated list of image URLs
# Output: branding_0.mjpeg, branding_1.mjpeg, ... (one per image)
if [[ $# -ne 1 ]]; then
    echo "ERROR: Usage: $0 <image_urls>"
    exit 1
fi

INPUT="$1"
VIDEO_DEVICE="${VIDEO_DEVICE:-/dev/video10}"

echo "Using video device: $VIDEO_DEVICE"
cd ..

# Split pipe-separated URLs into array
IFS='|' read -ra URLS <<< "$INPUT"
echo "Processing ${#URLS[@]} image(s)..."

# Clean old artifacts
echo "Cleaning up old artifacts..."
rm -f branding_*.mjpeg branding_file_*.png resized_branding_file_*.png ffmpeg_*.log

SUCCESS_COUNT=0

for i in "${!URLS[@]}"; do
    URL="${URLS[$i]}"
    IMAGE="branding_file_${SUCCESS_COUNT}.png"
    RESIZE_IMAGE="resized_branding_file_${SUCCESS_COUNT}.png"
    RAW_VIDEO="branding_${SUCCESS_COUNT}.mjpeg"

    echo "--- Processing image $i: $URL ---"

    # Validate URL
    if ! [[ $URL =~ ^https?:// ]]; then
        echo "WARNING: Skipping invalid URL: $URL"
        continue
    fi

    # Download image
    echo "Downloading image from $URL..."
    if ! curl -sSfL --compressed --max-time 60 --max-filesize 10M -o "$IMAGE" "$URL"; then
        echo "WARNING: Failed to download image from $URL, skipping"
        continue
    fi

    if [[ ! -s "$IMAGE" ]]; then
        echo "WARNING: Downloaded file is empty: $IMAGE, skipping"
        continue
    fi

    # Validate image. Dimensions, not just "ffprobe printed something": a
    # format ffmpeg cannot decode (animated WebP) and an HTML error page saved
    # under an image name both probe as 0x0, and used to reach the resize step
    # and fail there with a message that says nothing useful.
    PROBE_OUTPUT=$(ffprobe -v error -select_streams v:0 \
      -show_entries stream=codec_name,width,height,nb_frames \
      -of csv=p=0 "$IMAGE" 2>&1) || true
    # Width on its own: csv=p=0 prints the fields in ffprobe's order, not the
    # order they were asked for, so it cannot be cut out of PROBE_OUTPUT.
    IMAGE_W=$(ffprobe -v error -select_streams v:0 -show_entries stream=width \
      -of csv=p=0 "$IMAGE" 2>/dev/null) || true
    if [[ ! "$IMAGE_W" =~ ^[1-9][0-9]*$ ]]; then
      echo "WARNING: Invalid, corrupted or undecodable image: $IMAGE ($(file -b - < "$IMAGE" 2>/dev/null || echo unknown)), skipping"
      echo "         ffprobe said: ${PROBE_OUTPUT:-<nothing>}"
      continue
    fi
    echo "$PROBE_OUTPUT"

    # Resize image.
    #
    # -frames:v 1 -update 1: take the FIRST FRAME of whatever arrived. Without
    # it any multi-frame input dies in the muxer with "Cannot write more than
    # one file with the same name", because the output is one fixed .png path.
    # That is every GIF (ffmpeg decodes even a single-frame GIF as a stream),
    # every animated PNG, and a multi-size .ico — i.e. a customer sending a
    # perfectly good logo as a GIF got no branding at all and a log line that
    # only said "Failed to resize image".
    #
    # Errors go to a file, not /dev/null: ffmpeg's own last lines are the only
    # thing that says WHY, and throwing them away is what made this
    # undiagnosable from the logs.
    echo "Resizing image to 1280x720..."
    FFMPEG_ERR="ffmpeg_resize_${SUCCESS_COUNT}.log"
    if ! ffmpeg -y -i "$IMAGE" \
      -vf "scale=1280:720:flags=lanczos:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,format=yuv420p,colorspace=bt709:iall=bt709:fast=1" \
      -frames:v 1 -update 1 \
      -color_primaries bt709 -color_trc bt709 -color_range tv \
      "$RESIZE_IMAGE" 2>"$FFMPEG_ERR"; then
      echo "WARNING: Failed to resize image $IMAGE ($PROBE_OUTPUT), skipping"
      echo "         ffmpeg said: $(tail -n 3 "$FFMPEG_ERR" | tr '\n' ' ')"
      continue
    fi

    # Create MJPEG
    echo "Converting to MJPEG..."
    FFMPEG_ERR="ffmpeg_mjpeg_${SUCCESS_COUNT}.log"
    if ! ffmpeg -y -loop 1 -i "$RESIZE_IMAGE" \
      -c:v mjpeg -q:v 5 -r 30 -t 1 \
      -pix_fmt yuvj420p -strict -1 \
      "$RAW_VIDEO" 2>"$FFMPEG_ERR"; then
      echo "WARNING: Failed to create MJPEG from $RESIZE_IMAGE, skipping"
      echo "         ffmpeg said: $(tail -n 3 "$FFMPEG_ERR" | tr '\n' ' ')"
      continue
    fi

    # Validate the generated MJPEG is actually playable
    if ! ffprobe -v error -select_streams v:0 \
      -show_entries stream=codec_name \
      -of csv=p=0 "$RAW_VIDEO" 2>/dev/null | grep -q "mjpeg"; then
      echo "WARNING: Generated MJPEG is corrupt or invalid: $RAW_VIDEO, removing"
      rm -f "$RAW_VIDEO"
      continue
    fi

    echo "Generated: $RAW_VIDEO"
    SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
done

if [[ $SUCCESS_COUNT -eq 0 ]]; then
    echo "ERROR: No images were successfully processed"
    exit 1
fi

echo "Branding generation complete: $SUCCESS_COUNT/${#URLS[@]} images processed. media_context will stream to $VIDEO_DEVICE"
