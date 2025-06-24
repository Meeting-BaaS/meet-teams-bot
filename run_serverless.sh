#!/bin/bash
# Script to run the serverless bot with predefined parameters
# Just modify the JSON below to change the meeting parameters

# Generate a random UUID for the bot
BOT_UUID=$(uuidgen)

# Meeting parameters - modify these as needed
STDIN='{
  "meeting_url": "https://meet.google.com/xdk-unmo-gex?authuser=0",
  "user_token": "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzUxMiJ9.eyJpZCI6MX0.hZ2EOeazP82MbLsfQvdvV4nquazqSqlqD3-PVKidPsfaexIo_qiH69-xSISXxUAROikMbenDnkDN4dQG3v38fQ",
  "bots_api_key": "banane",
  "bot_name": "La Vache!",
  "speech_to_text_provider": "Default",
  "bots_webhook_url": "https://webhook-test.com/942a23a5e6cea9a7a2a3be242cede1f7",
  "bot_uuid": "'$BOT_UUID'",
  "recording_mode": "SpeakerView",
  "mp4_s3_path": "187e3f81-3349-4131-a325-10c93922a4fb.mp4",
  "custom_branding_bot_path": "https://i.ibb.co/N9YtnDZ/ducobu.jpg",
  "automatic_leave": {
    "waiting_room_timeout": 60,
    "noone_joined_timeout": 60
  },
  "enter_message": "meuuuuuh....",
  "secret": "story"
}'

# Extract some parameters for display
MEETING_URL=$(echo "$STDIN" | sed -n 's/.*"meeting_url": *"\([^"]*\)".*/\1/p')
BOT_NAME=$(echo "$STDIN" | sed -n 's/.*"bot_name": *"\([^"]*\)".*/\1/p')
BOT_UUID=$(echo "$STDIN" | sed -n 's/.*"bot_uuid": *"\([^"]*\)".*/\1/p')

export STDIN
export SERVERLESS=true

echo "Starting serverless bot with parameters:"
echo "- Meeting URL: $MEETING_URL"
echo "- Bot Name: $BOT_NAME"
echo "- Bot UUID: $BOT_UUID"
echo ""

# Build the server
npm run build

# Run the serverless bot
echo "$STDIN" | SERVERLESS=true npm run start-serverless 