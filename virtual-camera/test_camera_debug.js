const WebSocket = require('ws');

// Connect to the Chrome DevTools Protocol
const ws = new WebSocket('ws://localhost:9222/devtools/page/5FF7A5FD1DB4FEACE9309E921E789D53');

let messageId = 1;

ws.on('open', function open() {
    console.log('Connected to Chrome DevTools Protocol');
    
    // Enable Runtime domain
    sendMessage('Runtime.enable');
    
    // Enable Page domain
    sendMessage('Page.enable');
    
    // Execute script to test camera access
    setTimeout(() => {
        console.log('Testing camera access...');
        executeScript(`
            (async () => {
                console.log('Starting camera test...');
                
                try {
                    // Check if MediaDevices API is available
                    if (!navigator.mediaDevices) {
                        console.error('MediaDevices API not available');
                        return 'MediaDevices API not available';
                    }
                    
                    console.log('MediaDevices API available');
                    
                    // List all devices
                    const devices = await navigator.mediaDevices.enumerateDevices();
                    const videoDevices = devices.filter(device => device.kind === 'videoinput');
                    
                    console.log('Found video devices:', videoDevices.length);
                    videoDevices.forEach((device, index) => {
                        console.log(\`Device \${index + 1}: \${device.label || 'Unnamed'} (\${device.deviceId})\`);
                    });
                    
                    // Try to get user media
                    console.log('Requesting camera access...');
                    const stream = await navigator.mediaDevices.getUserMedia({ 
                        video: { 
                            width: { ideal: 640 },
                            height: { ideal: 480 }
                        }, 
                        audio: false 
                    });
                    
                    console.log('Camera access successful!');
                    console.log('Stream tracks:', stream.getTracks().length);
                    
                    stream.getTracks().forEach(track => {
                        console.log(\`Track: \${track.kind}, enabled: \${track.enabled}, readyState: \${track.readyState}\`);
                    });
                    
                    // Stop the stream
                    stream.getTracks().forEach(track => track.stop());
                    
                    return 'Camera test completed successfully';
                    
                } catch (error) {
                    console.error('Camera test failed:', error.message);
                    return 'Camera test failed: ' + error.message;
                }
            })()
        `);
    }, 2000);
});

ws.on('message', function message(data) {
    const response = JSON.parse(data);
    
    if (response.method === 'Runtime.consoleAPICalled') {
        const args = response.params.args || [];
        const type = response.params.type;
        const values = args.map(arg => arg.value || arg.description || 'undefined').join(' ');
        
        console.log(`[${type.toUpperCase()}] ${values}`);
    }
    
    if (response.method === 'Runtime.exceptionThrown') {
        console.error('Exception:', response.params.exceptionDetails.text);
    }
    
    if (response.result && response.result.result && response.result.result.value) {
        console.log('Script result:', response.result.result.value);
    }
});

ws.on('error', function error(err) {
    console.error('WebSocket error:', err);
});

function sendMessage(method, params = {}) {
    const message = {
        id: messageId++,
        method: method,
        params: params
    };
    ws.send(JSON.stringify(message));
}

function executeScript(script) {
    sendMessage('Runtime.evaluate', {
        expression: script,
        returnByValue: true
    });
}

// Handle process termination
process.on('SIGINT', () => {
    console.log('Closing connection...');
    ws.close();
    process.exit(0);
}); 