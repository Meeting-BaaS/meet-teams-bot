#!/bin/bash
# Script to run the serverless bot with configurable parameters
# Usage: ./run_serverless.sh [config_file]
# Default config file: bot.config.json

# Get config file from parameter or use default
CONFIG_FILE="${1:-bot.config.json}"

# Check if config file exists
if [ ! -f "$CONFIG_FILE" ]; then
    echo "❌ Config file '$CONFIG_FILE' not found!"
    echo ""
    echo "Creating default config file: $CONFIG_FILE"
    
    # Generate a random UUID for the bot
    BOT_UUID=$(uuidgen)
    
    # Create default config file
    cat > "$CONFIG_FILE" << EOF
{
    "id": "meeting-bot-session",
    "use_my_vocabulary": false,
    "meeting_url": "https://meet.google.com/bfe-bdys-ads?authuser=0",
    "user_token": "dummy-token-for-production",
    "bot_name": "Recording Bot",
    "user_id": 123,
    "session_id": "production-session",
    "email": "bot@example.com",
    "vocabulary": [],
    "force_lang": false,
    "speech_to_text_provider": "Default",
    "speech_to_text_api_key": "",
    "streaming_input": "",
    "streaming_output": "",
    "streaming_audio_frequency": 24000,
    "bots_api_key": "your-api-key-here",
    "bots_webhook_url": "",
    "bot_uuid": "$BOT_UUID",
    "enter_message": "Recording bot has joined the meeting",
    "recording_mode": "speaker_view",
    "local_recording_server_location": "docker",
    "automatic_leave": {
        "waiting_room_timeout": 600,
        "noone_joined_timeout": 600
    },
    "mp4_s3_path": "recordings/output.mp4",
    "custom_branding_bot_path": "https://your-domain.com/path/to/branding-image.jpg",
    "environ": "local",
    "aws_s3_temporary_audio_bucket": "local-audio-bucket",
    "remote": null,
    "secret": "your-secret-key"
}
EOF
    
    echo "✅ Default config created. Edit '$CONFIG_FILE' and run again."
    exit 0
fi

echo "📋 Using config file: $CONFIG_FILE"

# Read config from file
STDIN=$(cat "$CONFIG_FILE")

# Extract some parameters for display
MEETING_URL=$(echo "$STDIN" | jq -r '.meeting_url // "N/A"')
BOT_NAME=$(echo "$STDIN" | jq -r '.bot_name // "N/A"')
BOT_UUID=$(echo "$STDIN" | jq -r '.bot_uuid // "N/A"')
RECORDING_MODE=$(echo "$STDIN" | jq -r '.recording_mode // "N/A"')

export STDIN
export SERVERLESS=true

echo ""
echo "🚀 Starting REVOLUTIONARY bot with parameters:"
echo "- Config file: $CONFIG_FILE"
echo "- Meeting URL: $MEETING_URL"
echo "- Bot Name: $BOT_NAME"
echo "- Bot UUID: $BOT_UUID"
echo "- Recording Mode: $RECORDING_MODE"
echo ""

# Build the server
echo "📦 Building server..."
npm run build

# Run the serverless bot
echo ""
echo "🎬 Launching revolutionary live recording bot..."
echo "$STDIN" | SERVERLESS=true npm run start-serverless 