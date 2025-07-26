#!/bin/bash

echo "🔍 Testing Rust Virtual Camera Setup..."

# Check if PipeWire is running
echo "📡 Checking PipeWire status..."
if pgrep -x "pipewire" > /dev/null; then
    echo "✅ PipeWire is running"
else
    echo "❌ PipeWire is not running"
    exit 1
fi

# Check if PulseAudio is running
echo "🔊 Checking PulseAudio status..."
if pgrep -x "pulseaudio" > /dev/null; then
    echo "✅ PulseAudio is running"
else
    echo "❌ PulseAudio is not running"
    exit 1
fi

# Check if virtual camera process is running
echo "📹 Checking virtual camera process..."
if pgrep -f "rust_virtual_camera" > /dev/null; then
    echo "✅ Virtual camera process is running"
else
    echo "❌ Virtual camera process is not running"
    exit 1
fi

# Check if virtual camera node is registered with PipeWire
echo "🔗 Checking PipeWire nodes..."
if pw-cli list-objects 2>/dev/null | grep -q "rust-image-camera"; then
    echo "✅ Virtual camera node found in PipeWire"
else
    echo "❌ Virtual camera node not found in PipeWire"
    echo "Available nodes:"
    pw-cli list-objects 2>/dev/null | grep -E "(Node|node)" || echo "No nodes found"
    exit 1
fi

# Check if virtual audio devices are available
echo "🎵 Checking virtual audio devices..."
if pactl list sources short | grep -q "virtual_speaker.monitor"; then
    echo "✅ Virtual speaker monitor found"
else
    echo "❌ Virtual speaker monitor not found"
    exit 1
fi

echo "🎉 All virtual camera components are working correctly!"
echo ""
echo "📋 Summary:"
echo "  - PipeWire: ✅ Running"
echo "  - PulseAudio: ✅ Running"
echo "  - Virtual Camera Process: ✅ Running"
echo "  - Virtual Camera Node: ✅ Registered"
echo "  - Virtual Audio: ✅ Available"
echo ""
echo "🔍 You can now use the virtual camera in your applications!"
echo "📹 Camera name: 'rust-image-camera'"
echo "🎵 Audio source: 'virtual_speaker.monitor'" 