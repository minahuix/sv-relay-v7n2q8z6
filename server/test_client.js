const WebSocket = require('ws');

// Get URL from args or default to local
const url = process.argv[2] || 'ws://localhost:8080';
console.log(`Testing connection to: ${url}`);

const ws = new WebSocket(url);

ws.on('open', () => {
    console.log('✅ Connection established!');

    // Simulate joining a session
    const joinMsg = {
        type: 'join',
        sessionId: 'test-room-123',
        senderId: 'TestClient',
        timestamp: new Date().toISOString()
    };

    console.log('Sending JOIN message...');
    ws.send(JSON.stringify(joinMsg));

    // Send a ping after a moment
    setTimeout(() => {
        console.log('Sending PING...');
        ws.ping();
    }, 1000);
});

ws.on('message', (data) => {
    console.log('📩 Received message:', data.toString());
});

ws.on('pong', () => {
    console.log('✅ Received PONG');
    console.log('🎉 Server is functioning correctly!');
    process.exit(0);
});

ws.on('error', (err) => {
    console.error('❌ Connection error:', err.message);
    process.exit(1);
});

ws.on('close', () => {
    console.log('Connection closed');
});
