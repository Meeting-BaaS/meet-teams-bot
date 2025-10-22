#!/bin/bash

# Test script to verify port allocation for multiple bot instances
# This script simulates multiple concurrent bot launches

echo "Testing port allocation for multiple bot instances..."
echo "======================================================="

# Source the run_bot.sh to get access to the port functions
source ./run_bot.sh > /dev/null 2>&1

# Test 1: Sequential port allocation
echo "Test 1: Sequential port allocation"
echo "-----------------------------------"

for i in {1..5}; do
    echo "Instance $i:"
    ports=$(get_next_bot_ports)
    if [ $? -eq 0 ]; then
        main_port=$(echo $ports | cut -d' ' -f1)
        vnc_port=$(echo $ports | cut -d' ' -f2)
        echo "  Main port: $main_port, VNC port: $vnc_port"
        
        # Simulate some work time
        sleep 1
        
        # Release the ports
        release_port_lock $main_port
        release_port_lock $vnc_port
    else
        echo "  Failed to allocate ports"
    fi
done

echo ""

# Test 2: Concurrent port allocation (background processes)
echo "Test 2: Concurrent port allocation"
echo "-----------------------------------"

# Function to allocate and hold ports for a short time
allocate_and_hold() {
    local instance_id=$1
    local hold_time=$2
    
    ports=$(get_next_bot_ports)
    if [ $? -eq 0 ]; then
        main_port=$(echo $ports | cut -d' ' -f1)
        vnc_port=$(echo $ports | cut -d' ' -f2)
        echo "Instance $instance_id: Main port: $main_port, VNC port: $vnc_port"
        
        # Hold the ports for specified time
        sleep $hold_time
        
        # Release the ports
        release_port_lock $main_port
        release_port_lock $vnc_port
        echo "Instance $instance_id: Released ports $main_port and $vnc_port"
    else
        echo "Instance $instance_id: Failed to allocate ports"
    fi
}

# Launch multiple instances concurrently
for i in {1..3}; do
    allocate_and_hold $i 3 &
done

# Wait for all background processes to complete
wait

echo ""
echo "Port allocation test completed!"
echo "Check /tmp/baas_port_locks/ for any remaining lock files:"
ls -la /tmp/baas_port_locks/ 2>/dev/null || echo "No lock files remaining (good!)"