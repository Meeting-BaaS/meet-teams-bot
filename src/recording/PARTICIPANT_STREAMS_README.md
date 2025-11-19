# Individual Participant Stream Capture

This implementation adds the ability to capture real-time audio and video streams for each participant in your meeting recording system.

## Overview

The system consists of four main components:

1. **ParticipantStreamCapture** - Server-side WebSocket server that receives and processes individual participant streams
2. **ParticipantStreamInjector** - Playwright-based system that injects client-side code directly into meeting pages
3. **ParticipantStreamClient** - Client-side code that captures and sends participant streams
4. **Enhanced Integration** - Integration with your existing ScreenRecorder and SpeakerManager

## Files Added

-   `src/recording/ParticipantStreamCapture.ts` - Main server-side stream capture class
-   `src/recording/ParticipantStreamInjector.ts` - Playwright-based injection system
-   `src/recording/ParticipantStreamClient.ts` - Client-side stream capture example
-   `src/recording/EnhancedSpeakerManager.ts` - Integration example with existing speaker detection

## How It Works

### 1. Server-Side (ParticipantStreamCapture)

The `ParticipantStreamCapture` class:

-   Starts a WebSocket server on port 8080 (configurable)
-   Receives participant join/leave events
-   Captures audio and video chunks from each participant
-   Logs detailed statistics about each participant's stream
-   Processes and stores individual participant data

### 2. Playwright-Based Injection (ParticipantStreamInjector)

The `ParticipantStreamInjector` class:

-   Uses Playwright to inject client-side code directly into meeting pages
-   No browser extension required - works with your existing browser automation
-   Automatically detects and extracts participant information
-   Monitors participant changes and speaking status
-   Handles cleanup when recording ends

### 3. Client-Side (ParticipantStreamClient)

The `ParticipantStreamClient` class:

-   Connects to the WebSocket server
-   Extracts participant information from the meeting page DOM
-   Captures audio using Web Audio API
-   Captures video frames using Canvas API
-   Sends speaking status updates
-   Handles participant join/leave events

### 4. Integration with ScreenRecorder

The `ScreenRecorder` class now:

-   Automatically injects participant stream capture into the page when recording begins
-   Starts participant stream capture when recording begins
-   Stops participant stream capture when recording ends
-   Logs participant statistics at the end of recording
-   Provides access to participant stream data via `getParticipantStreamInjector()`

## Usage

### Basic Usage

```typescript
// The ScreenRecorder automatically handles participant stream capture
const recorder = new ScreenRecorder()
await recorder.startRecording(page)

// During recording, participant streams are automatically captured
// The system injects client-side code into the page and starts WebSocket server
// At the end of recording, statistics are logged

await recorder.stopRecording()
```

### Accessing Participant Data

```typescript
const recorder = new ScreenRecorder()
const streamInjector = recorder.getParticipantStreamInjector()

if (streamInjector) {
    // Get participant statistics
    const streamCapture = streamInjector.getParticipantStreamCapture()
    const stats = streamCapture?.getParticipantStats() || []
    console.log('Participant stats:', stats)

    // Log detailed statistics
    streamInjector.getParticipantStreamCapture()?.logParticipantStats()
}
```

### Manual Control

```typescript
// Start participant stream capture manually
const streamInjector = ParticipantStreamInjector.getInstance({
    enabled: true,
    websocketPort: 8080,
    captureAudio: true,
    captureVideo: true,
    chunkSizeMs: 1000,
})

await streamInjector.startCapture()

// Inject into a specific page
await streamInjector.injectIntoPage(page)

// ... do your recording ...

await streamInjector.stopCapture()
streamInjector.getParticipantStreamCapture()?.logParticipantStats()
```

## Configuration Options

```typescript
interface StreamCaptureConfig {
    enabled: boolean // Enable/disable stream capture
    websocketPort: number // WebSocket server port
    captureAudio: boolean // Capture audio streams
    captureVideo: boolean // Capture video streams
    chunkSizeMs: number // Chunk size in milliseconds
}
```

## Playwright-Based Integration

Since you're already using Playwright to control the browser, the system automatically:

1. **Injects Client Code**: Uses Playwright's `page.evaluate()` to inject the `ParticipantStreamClient` directly into the meeting page
2. **No Browser Extension Required**: Works with your existing browser automation setup
3. **Automatic Detection**: Automatically detects participants and their speaking status
4. **WebRTC Access**: The injected client has access to the user's microphone and camera

### How It Works

```typescript
// The ScreenRecorder automatically handles everything:
const recorder = new ScreenRecorder()
await recorder.startRecording(page)

// Behind the scenes:
// 1. ParticipantStreamInjector starts WebSocket server
// 2. Client-side code is injected into the page
// 3. Participant detection and stream capture begins
// 4. All data is logged and processed automatically

await recorder.stopRecording()
```

## Port Conflict Handling

The system automatically handles port conflicts:

-   **Default Port**: Starts on port 8081 (configurable)
-   **Automatic Fallback**: If port 8081 is in use, automatically tries ports 8082-8090
-   **Dynamic URL**: Updates the WebSocket server URL with the actual port being used
-   **Graceful Degradation**: If no ports are available, logs an error but doesn't crash the main recording

## Logging Output

The system provides detailed logging:

```
🎯 Starting participant stream capture...
🎯 WebSocket server listening on port 8080
🔌 New participant stream connection established
👤 Participant joined: John Doe (participant_123)
🎵 Audio chunk received from John Doe: 16384 bytes
🎬 Video chunk received from John Doe: 24576 bytes
🎤 SPEAKING John Doe (participant_123) at 2024-01-15T10:30:00.000Z
🔇 SILENT John Doe (participant_123) at 2024-01-15T10:30:05.000Z
👋 Participant left: John Doe (participant_123)

📊 PARTICIPANT STREAM STATISTICS:
============================================================
1. John Doe (participant_123)
   Duration: 300.5s
   Audio: 150 chunks (1024.5 KB)
   Video: 9000 chunks (2048.2 KB)
   Status: Left

TOTALS:
   Participants: 1
   Total Audio: 1024.5 KB
   Total Video: 2048.2 KB
============================================================
```

## Next Steps

1. **Browser Extension**: Create a browser extension to inject the client-side code
2. **File Storage**: Implement actual file saving for individual participant streams
3. **Stream Processing**: Add audio/video processing and encoding
4. **Correlation**: Enhance correlation with existing DOM-based speaker detection
5. **Error Handling**: Add robust error handling and reconnection logic

## Dependencies

Make sure to install the required dependencies:

```bash
npm install ws
```

The system uses:

-   `ws` for WebSocket server functionality
-   Your existing `PathManager` for file paths
-   Your existing `SpeakerData` types

## Security Considerations

-   Ensure proper consent for recording individual participants
-   Consider encryption for stream data transmission
-   Implement proper access controls for the WebSocket server
-   Follow privacy regulations (GDPR, CCPA, etc.)

## Performance Considerations

-   Individual stream capture will use more CPU and memory
-   Consider limiting the number of simultaneous participants
-   Monitor WebSocket connection limits
-   Implement proper cleanup and memory management
