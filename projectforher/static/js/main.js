// Main Frontend Logic
document.addEventListener('DOMContentLoaded', () => {
    // Basic socket connection
    const socket = io();

    socket.on('connect', () => {
        console.log('Connected to WebSocket server');
    });

    socket.on('disconnect', () => {
        console.log('Disconnected from WebSocket server');
    });
});
