# Rust Virtual Camera

A PipeWire virtual camera implementation in Rust that streams a static image as a video source. This project demonstrates how to create a virtual camera device that can be used in video applications, browsers, and other software that supports PipeWire cameras.

## Features

- Streams a static image as a virtual camera
- Supports BGRA format at 640x480 resolution, 30fps
- Integrates with PipeWire audio/video system
- Can be detected by browsers and video applications
- Includes a test client for debugging

## Prerequisites

- Rust and Cargo
- PipeWire development libraries
- Image processing libraries
- C compiler (for test client)

### Ubuntu/Debian Dependencies

```bash
sudo apt update
sudo apt install -y \
    libpipewire-0.3-dev \
    libspa-0.2-dev \
    libimage-dev \
    build-essential \
    pkg-config
```

## Building

### Rust Virtual Camera

```bash
cargo build --release
```

### Test Client

```bash
gcc -o test_client test_client.c $(pkg-config --cflags --libs libpipewire-0.3)
```

## Usage

### Running the Virtual Camera

```bash
# Run with a test image
cargo run -- test_logo.png

# Or run the compiled binary
./target/release/rust_virtual_camera test_logo.png
```

The virtual camera will:
1. Load the specified image
2. Convert it to BGRA format (640x480)
3. Register as a PipeWire node named "rust-image-camera"
4. Start streaming the image as video frames

### Testing with the Test Client

```bash
# Start the virtual camera in one terminal
cargo run -- test_logo.png

# In another terminal, run the test client
sleep 3 && ./test_client
```

The test client will attempt to connect to the virtual camera and display the connection state.

## Debugging

### PipeWire Debugging Commands

#### List Objects and Nodes

```bash
# List all PipeWire objects
pw-cli list-objects

# List only nodes
pw-cli list-objects | grep -E "(Node|node)"

# Get detailed info about a specific node
pw-cli info <node_id>
```

#### Check Ports and Links

```bash
# Find port information for a node
pw-cli list-objects | grep -A 20 "id <node_id>"

# List all links
pw-cli list-objects | grep -A 5 -B 5 "Link"

# Check specific port details
pw-cli list-objects | grep -E "(id [0-9]+|port\.name|port\.direction)"
```

#### Manual Linking

```bash
# Link using node IDs and port names
pw-link <source_node>:<source_port> <dest_node>:<dest_port>

# Link using port IDs directly
pw-link <source_port_id> <dest_port_id>

# Link using just node IDs (auto-finds ports)
pw-link <source_node> <dest_node>
```

#### Monitor PipeWire Logs

```bash
# Monitor PipeWire logs in real-time
journalctl -f | grep -i pipewire

# Monitor specific log patterns
journalctl -f | grep -E "(pw\.link|pw\.context|pw\.buffers)"
```

### Common Debugging Patterns

#### 1. Check Node Status

```bash
# Look for your virtual camera node
pw-cli list-objects | grep -A 10 "rust-image-camera"

# Check node state (should be "running" not "suspended")
pw-cli info <node_id>
```

#### 2. Verify Port Configuration

```bash
# Source node should have output ports
# Destination node should have input ports
pw-cli info <source_node_id>
pw-cli info <dest_node_id>
```

#### 3. Check Existing Links

```bash
# See if links already exist
pw-cli list-objects | grep -A 10 "Link" | grep -E "(output\.port|input\.port)"
```

#### 4. Monitor Format Negotiation

```bash
# Watch for format negotiation errors
journalctl -f | grep -E "(EnumFormat|no more input formats|negotiating -> error)"
```

### Example Debugging Session

```bash
# 1. Start your virtual camera
cargo run -- test_logo.png

# 2. Check what nodes are available
pw-cli list-objects | grep -E "(Node|node)" | grep -E "(rust|test)"

# 3. Get detailed info about your nodes
pw-cli info 93  # rust-image-camera
pw-cli info 92  # test-client

# 4. Check if link already exists
pw-cli list-objects | grep -A 10 "Link" | grep -E "(94|91)"

# 5. Try manual linking if needed
pw-link 94 91

# 6. Monitor logs for errors
journalctl -f | grep -i pipewire
```

### Key Error Messages to Watch For

- `"no more input formats"` - Format negotiation failure
- `"no buffers param"` - Buffer configuration missing
- `"negotiating -> error"` - Link establishment failure
- `"Input & output port do not exist"` - Wrong port names
- `"File exists"` - Link already exists

## Technical Details

### Supported Format

- **Format**: BGRA (Blue-Green-Red-Alpha)
- **Resolution**: 640x480 pixels
- **Frame Rate**: 30 fps
- **Buffer Size**: 1,228,800 bytes per frame (640 × 480 × 4 bytes)

### PipeWire Integration

The virtual camera implements the following PipeWire features:

- **Node Properties**: Media type, category, role, and device information
- **Format Negotiation**: Responds to SPA_PARAM_EnumFormat requests
- **Buffer Management**: Configures buffer parameters for video streaming
- **Stream Processing**: Continuously provides image data to connected clients

### Parameter Handling

The implementation handles these PipeWire parameters:

- **Param 3 (SPA_PARAM_EnumFormat)**: Format enumeration
- **Param 4 (SPA_PARAM_Format)**: Format selection
- **Param 7 (SPA_PARAM_Buffers)**: Buffer configuration
- **Param 15**: Additional format negotiation (context-dependent)

## Troubleshooting

### Common Issues

1. **Camera not detected**: Ensure PipeWire is running and the virtual camera node is active
2. **Format negotiation errors**: Check that the image dimensions match the expected 640x480
3. **Buffer errors**: Verify that the image data is properly converted to BGRA format
4. **Connection failures**: Use `pw-cli` commands to manually inspect node states and links

### Debug Output

The virtual camera provides detailed debug output including:
- Image loading status
- Format pod construction
- Parameter negotiation
- Buffer processing
- Stream state changes

### Log Analysis

Monitor these log patterns for debugging:
- `"Parameter changed"` - Shows parameter negotiation
- `"Built format pod"` - Confirms format response
- `"Processed frame"` - Indicates successful video streaming
- `"Stream state changed"` - Shows connection status

## License

This project is open source. Please check the LICENSE file for details.

## Contributing

Contributions are welcome! Please feel free to submit issues and pull requests. 