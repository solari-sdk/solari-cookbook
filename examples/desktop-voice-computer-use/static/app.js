// Solari Voice Agent - War Room Live Observability Client
let ws = null;
let mediaRecorder = null;
let audioChunks = [];
let audioContext = null;
let analyser = null;
let animationFrameId = null;
let isRecording = false;

// DOM Elements
const wsStatusDot = document.getElementById('ws-status-dot');
const wsStatusText = document.getElementById('ws-status-text');
const desktopModeBadge = document.getElementById('desktop-mode-badge');
const resBadge = document.getElementById('res-badge');
const stepBadge = document.getElementById('step-badge');
const btnKillVm = document.getElementById('btn-kill-vm');

const desktopFeed = document.getElementById('desktop-feed');
const screenWrapper = document.getElementById('screen-wrapper');
const actionCrosshair = document.getElementById('action-crosshair');
const viewportOverlay = document.getElementById('viewport-overlay');
const overlayStatusText = document.getElementById('overlay-status-text');
const coordsTracker = document.getElementById('coords-tracker');
const viewportStateBadge = document.getElementById('viewport-state-badge');
const lastActionLabel = document.getElementById('last-action-label');

const btnMic = document.getElementById('btn-mic');
const micHint = document.getElementById('mic-hint');
const micStatusBadge = document.getElementById('mic-status-badge');
const waveformCanvas = document.getElementById('waveform-canvas');
const waveformCtx = waveformCanvas.getContext('2d');

const transcriptBox = document.getElementById('transcript-box');
const textInstructionInput = document.getElementById('text-instruction-input');
const btnSubmitText = document.getElementById('btn-submit-text');
const responseBox = document.getElementById('response-box');
const ttsAudioPlayer = document.getElementById('tts-audio-player');

const planList = document.getElementById('plan-list');
const thoughtBox = document.getElementById('thought-box');
const timelineContainer = document.getElementById('timeline-container');
const presetButtons = document.querySelectorAll('.preset-btn');

// --- 1. WebSocket Initialization & Event Routing ---
function initWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/warroom`;
    
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        wsStatusDot.className = 'status-dot online';
        wsStatusText.textContent = 'War Room Live';
    };

    ws.onclose = () => {
        wsStatusDot.className = 'status-dot';
        wsStatusText.textContent = 'Reconnecting...';
        setTimeout(initWebSocket, 2000);
    };

    ws.onerror = (err) => {
        console.error('WebSocket Error:', err);
    };

    ws.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);
            handleIncomingEvent(msg.type, msg.data);
        } catch (e) {
            console.error('Failed to parse WebSocket message:', e);
        }
    };
}

function handleIncomingEvent(type, data) {
    switch (type) {
        case 'init':
            if (data.mode) desktopModeBadge.textContent = data.mode;
            if (data.resolution) resBadge.textContent = data.resolution;
            break;

        case 'status_update':
            viewportStateBadge.textContent = data.status || 'ACTIVE';
            if (data.status === 'PLANNING') {
                showOverlay('🧠 LangGraph Reasoning Task Plan...');
            } else if (data.status === 'PERCEIVING') {
                showOverlay('👁️ Capturing Desktop Viewport...');
            } else if (data.status === 'REASONING') {
                showOverlay('🤔 Multimodal Vision Analysis...');
            } else if (data.status === 'EXECUTING') {
                showOverlay(`⚡ Executing: ${data.action || 'Action'}`);
            } else if (data.status === 'SYNTHESIZING_VOICE') {
                showOverlay('🎙️ Synthesizing Spoken Speech (OpenAI TTS)...');
            }
            break;

        case 'screenshot_update':
            if (data.screenshot_b64) {
                desktopFeed.src = `data:image/jpeg;base64,${data.screenshot_b64}`;
                hideOverlay();
            }
            break;

        case 'plan_generated':
            renderPlan(data.plan || []);
            break;

        case 'reasoning_update':
            if (data.thought) {
                thoughtBox.innerHTML = `<strong>Reasoning:</strong> ${data.thought}`;
            }
            if (data.annotated_screenshot_b64) {
                desktopFeed.src = `data:image/jpeg;base64,${data.annotated_screenshot_b64}`;
            }
            if (data.action && data.action.x !== undefined && data.action.y !== undefined) {
                showCrosshair(data.action.x, data.action.y);
            }
            if (data.step !== undefined) {
                stepBadge.textContent = `${data.step + 1} / 15`;
            }
            hideOverlay();
            break;

        case 'action_executed':
            if (data.action) {
                lastActionLabel.textContent = `${data.action.type.toUpperCase()}`;
            }
            addTimelineItem(data.step_num, data.action, data.observation);
            break;

        case 'task_completed':
            hideOverlay();
            viewportStateBadge.textContent = 'COMPLETED';
            const summaryText = data.summary || 'Task Finished.';
            responseBox.innerHTML = `<strong>Spoken Summary:</strong> ${summaryText}`;
            if (data.audio_uri) {
                ttsAudioPlayer.src = data.audio_uri;
                ttsAudioPlayer.style.display = 'block';
                ttsAudioPlayer.play().catch(e => console.log('Auto-play note:', e));
            } else if (window.speechSynthesis) {
                // Browser native speech synthesis fallback
                try {
                    window.speechSynthesis.cancel();
                    const utterance = new SpeechSynthesisUtterance(summaryText);
                    utterance.rate = 1.0;
                    utterance.pitch = 1.0;
                    window.speechSynthesis.speak(utterance);
                } catch (e) {
                    console.log('Browser TTS note:', e);
                }
            }
            break;

        case 'voice_transcribed':
            if (data.transcript) {
                transcriptBox.innerHTML = `<strong>"${data.transcript}"</strong>`;
            }
            break;

        case 'vm_killed':
            alert('Solari Desktop VM terminated (kill() invoked).');
            viewportStateBadge.textContent = 'VM TERMINATED';
            break;
    }
}

// --- 2. Overlay & Crosshair UI Helpers ---
function showOverlay(text) {
    overlayStatusText.textContent = text;
    viewportOverlay.classList.add('active');
}

function hideOverlay() {
    viewportOverlay.classList.remove('active');
}

function showCrosshair(x, y) {
    const rect = desktopFeed.getBoundingClientRect();
    const scaleX = rect.width / 1024;
    const scaleY = rect.height / 768;
    
    actionCrosshair.style.left = `${x * scaleX}px`;
    actionCrosshair.style.top = `${y * scaleY}px`;
    actionCrosshair.style.display = 'block';
    
    setTimeout(() => {
        actionCrosshair.style.display = 'none';
    }, 2500);
}

// Coordinate tracking on mouse move
screenWrapper.addEventListener('mousemove', (e) => {
    const rect = desktopFeed.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
        const x = Math.round(((e.clientX - rect.left) / rect.width) * 1024);
        const y = Math.round(((e.clientY - rect.top) / rect.height) * 768);
        if (x >= 0 && x <= 1024 && y >= 0 && y <= 768) {
            coordsTracker.textContent = `X: ${x} | Y: ${y}`;
        }
    }
});

// --- 3. Plan & Timeline Rendering ---
function renderPlan(plan) {
    planList.innerHTML = '';
    plan.forEach((item, index) => {
        const li = document.createElement('li');
        li.textContent = item;
        li.id = `plan-step-${index}`;
        planList.appendChild(li);
    });
}

function addTimelineItem(stepNum, action, observation) {
    if (timelineContainer.querySelector('.timeline-empty')) {
        timelineContainer.innerHTML = '';
    }
    const item = document.createElement('div');
    item.className = 'timeline-item';
    item.innerHTML = `
        <div class="timeline-header">
            <span>Step #${stepNum + 1}: ${action.type.toUpperCase()}</span>
            <span>${new Date().toLocaleTimeString()}</span>
        </div>
        <div class="timeline-obs">✓ ${observation || 'Executed'}</div>
    `;
    timelineContainer.prepend(item);
}

// --- 4. Voice Input & Real-Time Speech Recognition ---
let speechRecognizer = null;
let liveSpokenTranscript = '';
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

if (SpeechRecognition) {
    speechRecognizer = new SpeechRecognition();
    speechRecognizer.continuous = false;
    speechRecognizer.interimResults = true;
    speechRecognizer.lang = 'en-US';

    speechRecognizer.onresult = (event) => {
        let interim = '';
        let final = '';
        for (let i = event.resultIndex; i < event.results.length; ++i) {
            if (event.results[i].isFinal) {
                final += event.results[i][0].transcript;
            } else {
                interim += event.results[i][0].transcript;
            }
        }
        const text = final || interim;
        if (text) {
            liveSpokenTranscript = text;
            transcriptBox.innerHTML = `<strong>"${text}"</strong>`;
            textInstructionInput.value = text;
            micHint.textContent = `Heard: "${text}"`;
        }
    };

    speechRecognizer.onerror = (e) => {
        console.warn('Speech recognition error:', e.error);
    };

    speechRecognizer.onend = () => {
        if (isRecording) {
            stopRecording();
            if (liveSpokenTranscript && liveSpokenTranscript.trim()) {
                triggerAgentTask(liveSpokenTranscript.trim());
            }
        }
    };
}

btnMic.addEventListener('click', toggleMicrophoneRecording);

async function toggleMicrophoneRecording() {
    if (isRecording) {
        stopRecording();
        if (liveSpokenTranscript && liveSpokenTranscript.trim()) {
            triggerAgentTask(liveSpokenTranscript.trim());
        }
    } else {
        await startRecording();
    }
}

async function startRecording() {
    liveSpokenTranscript = '';
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        isRecording = true;
        btnMic.classList.add('recording');
        micHint.textContent = 'Listening... Speak your command now!';
        micStatusBadge.textContent = 'Listening to Mic...';

        audioChunks = [];
        mediaRecorder = new MediaRecorder(stream);
        mediaRecorder.ondataavailable = (e) => audioChunks.push(e.data);

        mediaRecorder.onstop = async () => {
            if (!liveSpokenTranscript && audioChunks.length > 0) {
                const audioBlob = new Blob(audioChunks, { type: 'audio/wav' });
                await submitAudioForTranscription(audioBlob);
            }
            stream.getTracks().forEach(track => track.stop());
        };

        mediaRecorder.start();
        initWaveform(stream);

        if (speechRecognizer) {
            try {
                speechRecognizer.start();
            } catch (e) {
                console.log('Speech recognizer start note:', e);
            }
        }

    } catch (err) {
        console.error('Microphone access error:', err);
        micHint.textContent = 'Mic access denied. Please type command instead.';
    }
}

function stopRecording() {
    isRecording = false;
    btnMic.classList.remove('recording');
    micHint.textContent = 'Processing spoken command...';
    micStatusBadge.textContent = 'Whisper / Voice STT';
    
    if (speechRecognizer) {
        try { speechRecognizer.stop(); } catch (e) {}
    }

    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
    }
    
    if (animationFrameId) cancelAnimationFrame(animationFrameId);
    waveformCtx.clearRect(0, 0, waveformCanvas.width, waveformCanvas.height);
}

function initWaveform(stream) {
    try {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const source = audioContext.createMediaStreamSource(stream);
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 64;
        source.connect(analyser);

        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);

        function draw() {
            if (!isRecording) return;
            animationFrameId = requestAnimationFrame(draw);
            analyser.getByteFrequencyData(dataArray);

            waveformCtx.clearRect(0, 0, waveformCanvas.width, waveformCanvas.height);
            const barWidth = (waveformCanvas.width / bufferLength) * 2;
            let x = 0;

            for (let i = 0; i < bufferLength; i++) {
                const barHeight = (dataArray[i] / 255) * waveformCanvas.height;
                waveformCtx.fillStyle = '#00f2fe';
                waveformCtx.fillRect(x, waveformCanvas.height - barHeight, barWidth - 1, barHeight);
                x += barWidth;
            }
        }
        draw();
    } catch (e) {
        console.log('Waveform visualizer init error:', e);
    }
}

async function submitAudioForTranscription(blob) {
    const formData = new FormData();
    formData.append('audio', blob, 'user_voice.wav');

    try {
        const response = await fetch('/api/voice/transcribe', {
            method: 'POST',
            body: formData
        });
        const result = await response.json();
        if (result.success && result.transcript) {
            transcriptBox.innerHTML = `<strong>"${result.transcript}"</strong>`;
            micHint.textContent = 'Executing transcribed command...';
            await triggerAgentTask(result.transcript);
        } else {
            micHint.textContent = 'Could not transcribe speech. Try typing.';
        }
    } catch (err) {
        console.error('Transcription error:', err);
        micHint.textContent = 'Transcription failed.';
    }
}

// --- 5. Task Execution Trigger ---
async function triggerAgentTask(instruction) {
    if (!instruction || instruction.trim() === '') return;

    transcriptBox.innerHTML = `<strong>"${instruction}"</strong>`;
    responseBox.innerHTML = '<em>Agent reasoning in progress...</em>';
    timelineContainer.innerHTML = '';
    planList.innerHTML = '<li class="empty-plan">Planning milestones...</li>';
    thoughtBox.innerHTML = '<em>Analyzing desktop screen...</em>';

    try {
        const response = await fetch('/api/run-task', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ instruction: instruction })
        });
        const data = await response.json();
        console.log('Task Result:', data);
    } catch (err) {
        console.error('Error running task:', err);
    }
}

// Text Submit Button
btnSubmitText.addEventListener('click', () => {
    const text = textInstructionInput.value.trim();
    if (text) {
        textInstructionInput.value = '';
        triggerAgentTask(text);
    }
});

textInstructionInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        btnSubmitText.click();
    }
});

// Demo Preset Buttons
presetButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        const task = btn.getAttribute('data-task');
        triggerAgentTask(task);
    });
});

// Kill VM Button
btnKillVm.addEventListener('click', async () => {
    if (confirm('Are you sure you want to terminate the Solari Desktop VM instance (kill)?')) {
        await fetch('/api/desktop/kill', { method: 'POST' });
    }
});

// Fetch system status on start
async function fetchStatus() {
    try {
        const res = await fetch('/api/status');
        const data = await res.json();
        if (data.mode) desktopModeBadge.textContent = data.mode;
        if (data.resolution) resBadge.textContent = data.resolution;
    } catch (e) {
        console.log('Status fetch error:', e);
    }
}

// Boot up
window.addEventListener('DOMContentLoaded', () => {
    initWebSocket();
    fetchStatus();
});
