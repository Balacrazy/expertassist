const socketLocal = io();

socketLocal.on('connect', () => {
    if (typeof SESSION_ID !== 'undefined') {
        socketLocal.emit('join_session', { session_id: SESSION_ID });
    }
    if (typeof USER_ID !== 'undefined') {
        socketLocal.emit('join', { user_id: USER_ID });
    }
});

let localStream;
let peerConnection;
const config = {
    'iceServers': [
        {'urls': 'stun:stun.l.google.com:19302'}
    ]
};

const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const chatInput = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-btn');
const chatMessages = document.getElementById('chat-messages');

let constraints = { video: true, audio: true };

async function initWebRTC(videoParam = true) {
    constraints = { video: videoParam, audio: true };
    
    try {
        localStream = await navigator.mediaDevices.getUserMedia(constraints);
        localVideo.srcObject = localStream;
    } catch (e) {
        console.warn('Could not access requested media. Trying audio only...', e);
        try {
            constraints = { video: false, audio: true };
            localStream = await navigator.mediaDevices.getUserMedia(constraints);
            localVideo.srcObject = localStream;
            alert("No camera found or permitted. Starting with Audio only.");
        } catch(e2) {
            console.error('Audio also failed.', e2);
            alert("Could not access camera or microphone. You can only use text chat.");
            return; // Cannot participate in WebRTC
        }
    }
    
    // Connect WebRTC whenever stream is ready
    socketLocal.emit('ready', { session_id: SESSION_ID, user_id: USER_ID });
}

window.startCall = function(withVideo = true) {
    const mp = document.getElementById('media-panel');
    if(mp) mp.classList.add('active'); // Slide in floating video window
    
    // Set UI buttons based on selection
    if(!withVideo) {
        videoEnabled = false;
        const vBtn = document.getElementById('toggle-video');
        if(vBtn) {
            vBtn.style.color = '#e74c3c';
            vBtn.innerHTML = '<i class="fas fa-video-slash"></i>';
        }
    } else {
        videoEnabled = true;
    }
    
    initWebRTC(withVideo);
};

window.closeVideoCall = function() {
    const mp = document.getElementById('media-panel');
    if(mp) mp.classList.remove('active'); // Hide floating video window
    
    // Stop local tracks
    if(localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    if(peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    // We do NOT emit end_session, so the chat remains active!
};

// --- Signaling ---
// Handle when the OTHER peer clicks start or reloads the page
socketLocal.on('ready', () => {
    // Other peer started a call. Let's auto-show the floating panel if we haven't already.
    const mp = document.getElementById('media-panel');
    if(mp && !mp.classList.contains('active')) {
        mp.classList.add('active');
    }

    // If we ALREADY have a local stream, we can immediately offer to the newly ready peer (handles reconnection!)
    if(localStream) {
        createPeerConnection();
        createOffer();
    } else {
        // We aren't ready yet
        alert("The other party is calling! Click 'Video Call' or 'Audio Call' to join them.");
    }
});

socketLocal.on('offer', async (data) => {
    if (data.sender == USER_ID) return;
    createPeerConnection();
    await peerConnection.setRemoteDescription(new RTCSessionDescription(data.description));
    if(localStream) {
        createAnswer();
    }
});

socketLocal.on('answer', async (data) => {
    if (data.sender == USER_ID) return;
    await peerConnection.setRemoteDescription(new RTCSessionDescription(data.description));
});

socketLocal.on('ice-candidate', async (data) => {
    if (data.sender == USER_ID) return;
    try {
        if(peerConnection) {
            await peerConnection.addIceCandidate(data.candidate);
        }
    } catch (e) {
        console.error('Error adding received ice candidate', e);
    }
});

function createPeerConnection() {
    if(peerConnection) return;
    
    peerConnection = new RTCPeerConnection(config);
    
    // Add local tracks
    localStream.getTracks().forEach(track => {
        peerConnection.addTrack(track, localStream);
    });
    
    // Handle ICE candidates
    peerConnection.onicecandidate = event => {
        if (event.candidate) {
            socketLocal.emit('ice-candidate', {
                session_id: SESSION_ID,
                sender: USER_ID,
                candidate: event.candidate
            });
        }
    };
    
    // Handle Remote Stream
    peerConnection.ontrack = event => {
        if (remoteVideo.srcObject !== event.streams[0]) {
            remoteVideo.srcObject = event.streams[0];
        }
    };
}

async function createOffer() {
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socketLocal.emit('offer', {
        session_id: SESSION_ID,
        sender: USER_ID,
        description: peerConnection.localDescription
    });
}

async function createAnswer() {
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    socketLocal.emit('answer', {
        session_id: SESSION_ID,
        sender: USER_ID,
        description: peerConnection.localDescription
    });
}

// --- Chat Logic ---
function appendHtmlMessage(htmlContent, type) {
    const div = document.createElement('div');
    div.className = `msg ${type}`;
    div.innerHTML = htmlContent;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function appendMessage(msg, type) {
    // Escape HTML to prevent basic XSS
    const secureMsg = msg.replace(/</g, "&lt;").replace(/>/g, "&gt;");
    appendHtmlMessage(secureMsg, type);
}

function appendImage(src, type) {
    const div = document.createElement('div');
    div.className = `msg ${type}`;
    div.style.padding = '6px'; // smaller padding for images
    
    const img = document.createElement('img');
    img.src = src;
    img.style.maxWidth = '100%';
    img.style.maxHeight = '250px';
    img.style.borderRadius = '10px';
    img.style.display = 'block';
    img.style.cursor = 'pointer';
    img.onclick = () => window.open(src, '_blank'); // Click to enlarge
    
    div.appendChild(img);
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

sendBtn.addEventListener('click', () => {
    const msg = chatInput.value.trim();
    if(msg) {
        appendMessage(msg, 'self');
        socketLocal.emit('chat_message', {
            session_id: SESSION_ID,
            sender: USER_ID,
            text: msg
        });
        chatInput.value = '';
    }
});

chatInput.addEventListener('keypress', (e) => {
    if(e.key === 'Enter') sendBtn.click();
});

// Image Upload Handling
const imgUpload = document.getElementById('chat-img-upload');
if(imgUpload) {
    imgUpload.addEventListener('change', function(e) {
        const file = e.target.files[0];
        if(!file) return;
        
        // Ensure it's an image
        if(!file.type.startsWith('image/')) {
            alert('Please select an image file.');
            return;
        }

        // Limit size to ~5MB for websocket transmission
        if(file.size > 5 * 1024 * 1024) {
            alert('Image is too large. Max size is 5MB.');
            return;
        }
        
        const reader = new FileReader();
        reader.onload = function(event) {
            const base64Str = event.target.result;
            appendImage(base64Str, 'self');
            
            socketLocal.emit('chat_message', {
                session_id: SESSION_ID,
                sender: USER_ID,
                image: base64Str
            });
        };
        reader.readAsDataURL(file);
        imgUpload.value = ''; // Reset input
    });
}

socketLocal.on('chat_message', (data) => {
    if(data.sender != USER_ID) {
        if(data.image) {
            appendImage(data.image, 'other');
        } else if(data.text) {
            appendMessage(data.text, 'other');
        }
    }
});

// --- Media Toggles ---
let audioEnabled = true;
let videoEnabled = true;

document.getElementById('toggle-audio').onclick = function() {
    audioEnabled = !audioEnabled;
    localStream.getAudioTracks()[0].enabled = audioEnabled;
    this.style.color = audioEnabled ? '#fff' : '#e74c3c';
    this.innerHTML = audioEnabled ? '<i class="fas fa-microphone"></i>' : '<i class="fas fa-microphone-slash"></i>';
};

document.getElementById('toggle-video').onclick = function() {
    videoEnabled = !videoEnabled;
    localStream.getVideoTracks()[0].enabled = videoEnabled;
    this.style.color = videoEnabled ? '#fff' : '#e74c3c';
    this.innerHTML = videoEnabled ? '<i class="fas fa-video"></i>' : '<i class="fas fa-video-slash"></i>';
};

// --- Live Location ---
let locationWatcher = null;
const reqLocDisplay = document.getElementById('partner-coords');
const mapLink = document.getElementById('partner-map-link');

document.getElementById('share-location').onclick = function() {
    if(locationWatcher) {
        // Stop sharing
        navigator.geolocation.clearWatch(locationWatcher);
        locationWatcher = null;
        this.classList.remove('active-tool');
        socketLocal.emit('location_update', {session_id: SESSION_ID, sender: USER_ID, stop: true});
        appendHtmlMessage(`<i class="fas fa-eye-slash"></i> You stopped sharing your live location.`, 'self');
    } else {
        // Start sharing
        if ("geolocation" in navigator) {
            this.classList.add('active-tool');
            appendHtmlMessage(`<i class="fas fa-spinner fa-spin"></i> Fetching your live GPS coordinates...`, 'self');
            
            locationWatcher = navigator.geolocation.watchPosition(pos => {
                const coords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
                socketLocal.emit('location_update', {
                    session_id: SESSION_ID,
                    sender: USER_ID,
                    coords: coords
                });
            }, err => {
                alert('Geolocation error: ' + err.message);
                this.classList.remove('active-tool');
            }, { enableHighAccuracy: true });
        } else {
            alert("Geolocation is not supported by your browser");
        }
    }
};

socketLocal.on('location_update', (data) => {
    if(data.sender != USER_ID) {
        if(data.stop) {
            appendHtmlMessage(`<i class="fas fa-eye-slash"></i> The other user stopped sharing location.`, 'other');
            if(reqLocDisplay) reqLocDisplay.innerText = "Location sharing stopped.";
            if(mapLink) mapLink.style.display = 'none';
        } else {
            const mapUrl = `https://www.google.com/maps/search/?api=1&query=${data.coords.lat},${data.coords.lng}`;
            const html = `
                <div style="font-weight: 600; margin-bottom: 4px; color: var(--primary);"><i class="fas fa-map-marker-alt"></i> Live Location Update</div>
                <div style="font-size: 0.85rem; margin-bottom: 8px;">Coords: ${data.coords.lat.toFixed(4)}, ${data.coords.lng.toFixed(4)}</div>
                <a href="${mapUrl}" target="_blank" style="display: inline-block; padding: 6px 12px; background: #fff; color: var(--primary); text-decoration: none; border-radius: 4px; font-weight: 600; font-size: 0.85rem; border: 1px solid var(--primary);">Open in Google Maps</a>
            `;
            appendHtmlMessage(html, 'other');
            
            if(reqLocDisplay) reqLocDisplay.innerText = `${data.coords.lat.toFixed(4)}, ${data.coords.lng.toFixed(4)}`;
            if(mapLink) {
                mapLink.href = mapUrl;
                mapLink.style.display = 'inline';
            }
        }
    }
});

// --- Timer Logic ---
let secondsRemaining = 60 * 60; // 60 minutes session max by default
const timerDisplay = document.getElementById('timer-display');
const timerWarning = document.getElementById('timer-warning');

const sessionTimer = setInterval(() => {
    secondsRemaining--;
    if(secondsRemaining <= 0) {
        clearInterval(sessionTimer);
        alert('Session time has ended.');
        endCall();
    } else {
        const m = Math.floor(secondsRemaining / 60);
        const s = secondsRemaining % 60;
        timerDisplay.innerText = `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
        
        if(secondsRemaining == 5 * 60) {
            timerWarning.style.display = 'block';
            timerDisplay.style.color = 'var(--danger-color)';
        }
    }
}, 1000);

document.getElementById('btn-extend').onclick = () => {
    // Add 15 mins for now directly (In real app, this might need expert approval)
    secondsRemaining += 15 * 60;
    timerWarning.style.display = 'none';
    timerDisplay.style.color = 'var(--success-color)';
    alert('Session extended by 15 minutes.');
};

document.getElementById('end-call').onclick = endCall;

function endCall() {
    socketLocal.emit('end_session', {session_id: SESSION_ID});
    window.location.href = '/feedback/' + SESSION_ID;
}

socketLocal.on('session_ended', () => {
    alert('The other party ended the session.');
    window.location.href = '/feedback/' + SESSION_ID;
});
