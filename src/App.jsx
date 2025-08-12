import { useEffect, useMemo, useRef, useState } from 'react';
import { getProjects, getKB, pushKB, getRealtimePayload } from './api';
import { Mic, MicOff, MessageSquare, Settings, Volume2, VolumeX, Send, X, PhoneOff } from 'lucide-react';

export default function App() {
  const [projects, setProjects] = useState([]);
  const [project, setProject] = useState('');
  const [kb, setKb] = useState(null);
  const [kbErr, setKbErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [convaiResp, setConvaiResp] = useState(null);

  const [isAdmin, setIsAdmin] = useState(false);
  const [chatMode, setChatMode] = useState('voice');
  const [isPushToTalk, setIsPushToTalk] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [currentAgentMessage, setCurrentAgentMessage] = useState('');
  const [showSettings, setShowSettings] = useState(false);

  const [wsStatus, setWsStatus] = useState('disconnected');
  const [messages, setMessages] = useState([]);
  const [agentSpeaking, setAgentSpeaking] = useState(false);
  const wsRef = useRef(null);
  const inputRef = useRef(null);
  const videoRef = useRef(null);

  const audioCtxRef = useRef(null);
  const audioQueueRef = useRef([]);
  const audioPlayingRef = useRef(false);
  const mediaRecorderRef = useRef(null);
  const audioStreamRef = useRef(null);

  const [isProcessingAudio, setIsProcessingAudio] = useState(false);
  const audioProcessingRef = useRef(false);
  const [isUpdatingKB, setIsUpdatingKB] = useState(false);
  const [kbUpdateStatus, setKbUpdateStatus] = useState('');

  const API_BASE = import.meta.env.VITE_API_BASE || 'https://11labs-webhook-voiceagent.vercel.app';

  useEffect(() => {
    getProjects().then((p) => {
      setProjects(p || []);
      if (p?.[0]?.key) setProject(p[0].key);
    });
  }, []);

  useEffect(() => {
    if (!project) return;
    setKb(null);
    setKbErr('');
    setKbUpdateStatus('');
    getKB(project)
      .then((d) => setKb(d))
      .catch((e) => setKbErr(e.message || 'Failed to load KB'));
  }, [project]);

  // Auto-update KB when project changes
  const updateAgentKB = async (projectKey) => {
    if (!projectKey) return;
    
    setIsUpdatingKB(true);
    setKbUpdateStatus('Updating agent knowledge base...');
    
    try {
      const result = await pushKB({ project: projectKey, mode: 'convai' });
      if (result.error) {
        throw new Error(result.error);
      }
      setKbUpdateStatus('Knowledge base updated successfully!');
      setTimeout(() => setKbUpdateStatus(''), 3000);
    } catch (error) {
      console.error('KB update failed:', error);
      setKbUpdateStatus(`Failed to update KB: ${error.message}`);
      setTimeout(() => setKbUpdateStatus(''), 5000);
    } finally {
      setIsUpdatingKB(false);
    }
  };

  const canChat = useMemo(() => wsStatus === 'connected', [wsStatus]);

  const handlePush = async (mode) => {
    setLoading(true);
    setConvaiResp(null);
    const out = await pushKB({ project, mode });
    setLoading(false);
    if (out.error) return alert(out.error);
    if (mode === 'convai') setConvaiResp(out.response || out);
  };

  const ensureAudioCtx = () => {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
    }
    return audioCtxRef.current;
  };

  // Play PCM audio from ElevenLabs ConvAI
  const playNext = async () => {
    if (audioPlayingRef.current || isMuted) return;
    const item = audioQueueRef.current.shift();
    if (!item) return;

    audioPlayingRef.current = true;
    try {
      const ctx = ensureAudioCtx();
      let cleanB64 = item.b64 || '';
      if (cleanB64.includes(',')) cleanB64 = cleanB64.split(',')[1];
      cleanB64 = cleanB64.replace(/\s/g, '');
      
      if (!cleanB64) { 
        audioPlayingRef.current = false; 
        return playNext(); 
      }

      // Convert base64 to bytes
      const byteStr = atob(cleanB64);
      const bytes = new Uint8Array(byteStr.length);
      for (let i = 0; i < byteStr.length; i++) {
        bytes[i] = byteStr.charCodeAt(i);
      }

      // ElevenLabs ConvAI sends 16-bit PCM at 16kHz, mono
      const sampleRate = 16000;
      const channels = 1;
      const bytesPerSample = 2; // 16-bit
      const numSamples = Math.floor(bytes.length / bytesPerSample);

      if (numSamples < 10) { // Skip very short audio chunks
        audioPlayingRef.current = false;
        return playNext();
      }

      // Create audio buffer
      const buffer = ctx.createBuffer(channels, numSamples, sampleRate);
      const channelData = buffer.getChannelData(0);
      
      // Convert 16-bit PCM to float32 for Web Audio API
      const dataView = new DataView(bytes.buffer);
      for (let i = 0; i < numSamples; i++) {
        // Read 16-bit signed integer (little-endian)
        const sample = dataView.getInt16(i * 2, true);
        // Convert to float32 range [-1, 1]
        channelData[i] = sample / 32768.0;
      }

      // Create and play audio source
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      
      source.onended = () => {
        audioPlayingRef.current = false;
        setCurrentAgentMessage('');
        setAgentSpeaking(false);
        playNext();
      };
      
      source.start(0);
      
    } catch (error) {
      console.error('PCM audio playback error:', error);
      audioPlayingRef.current = false;
      setCurrentAgentMessage('');
      setAgentSpeaking(false);
      playNext();
    }
  };

  const enqueueAudio = (b64, mime = 'audio/mpeg') => {
    if (!isMuted && b64 && b64.length > 100) {
      audioQueueRef.current.push({ b64, mime });
      if (!audioPlayingRef.current) {
        setAgentSpeaking(true);
        playNext();
      }
    }
  };

  // Improved audio recording with better quality settings
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { 
          sampleRate: 16000, // Standard rate for speech recognition
          channelCount: 1, 
          echoCancellation: true, 
          noiseSuppression: true,
          autoGainControl: false // Disable auto gain to preserve natural voice
        }
      });
      audioStreamRef.current = stream;

      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported('audio/wav') ? 'audio/wav' : 'audio/webm'
      });

      const audioChunks = [];
      mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };

      mediaRecorder.onstop = async () => {
  if (audioChunks.length === 0 || audioProcessingRef.current || agentSpeaking) {
    stream.getTracks().forEach(t => t.stop());
    setIsRecording(false);
    return;
  }
  audioProcessingRef.current = true;
  setIsProcessingAudio(true);
  try {
    const audioBlob = new Blob(audioChunks, { type: 'audio/wav' });
    
    // Option 1: Send audio directly to Worker as base64 (if Worker supports it)
    // const arrayBuffer = await audioBlob.arrayBuffer();
    // const uint8Array = new Uint8Array(arrayBuffer);
    // const base64Audio = btoa(String.fromCharCode.apply(null, uint8Array));
    // 
    // if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
    //   wsRef.current.send(JSON.stringify({
    //     user_audio_chunk: base64Audio
    //   }));
    // }
    
    // Option 2: Use STT API then send text (recommended for now)
    const formData = new FormData();
    formData.append('audio', audioBlob, 'recording.wav');
    formData.append('model_id', 'scribe_v1');

    const sttResponse = await fetch(`${API_BASE}/api/stt`, { method: 'POST', body: formData });
    if (!sttResponse.ok) throw new Error(`STT failed: ${sttResponse.status}`);
    const sttResult = await sttResponse.json();
    const transcribedText = sttResult.text?.trim();

    if (transcribedText) {
      setMessages((m) => [...m, { role: 'user', text: transcribedText, timestamp: new Date() }]);
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        console.log('📤 Sending transcribed text to Worker:', transcribedText);
        wsRef.current.send(JSON.stringify({ type: 'user_message', text: transcribedText }));
      }
    }
  } catch (error) {
    console.error('❌ Voice processing failed:', error);
    setMessages((m) => [...m, { 
      role: 'system', 
      text: `❌ Voice processing failed: ${error.message}`, 
      type: 'error', 
      timestamp: new Date() 
    }]);
  } finally {
    setTimeout(() => { 
      audioProcessingRef.current = false; 
      setIsProcessingAudio(false); 
    }, 1500);
    stream.getTracks().forEach(t => t.stop());
  }
};
      

      mediaRecorderRef.current = mediaRecorder;
      mediaRecorder.start(1000);
      setIsRecording(true);
    } catch {
      alert('Mic permission needed.');
      setIsRecording(false);
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    if (audioStreamRef.current) {
      audioStreamRef.current.getTracks().forEach(t => t.stop());
      audioStreamRef.current = null;
    }
    setIsRecording(false);
  };


  // Add function to disconnect conversation
  const disconnectConversation = () => {
    if (wsRef.current) {
      wsRef.current.close();
    }
    setWsStatus('disconnected');
    setMessages([]);
    setCurrentAgentMessage('');
    setAgentSpeaking(false);
    setIsRecording(false);
    setIsProcessingAudio(false);
    
    // Clear any audio queues
    audioQueueRef.current = [];
    audioPlayingRef.current = false;
    audioProcessingRef.current = false;
    
    // Stop any ongoing recording
    stopRecording();
  };

  const handleMouseDown = () => {
    if (isPushToTalk && canChat && !audioProcessingRef.current && !agentSpeaking) startRecording();
  };
  const handleMouseUp = () => { if (isPushToTalk && isRecording) stopRecording(); };

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.code === 'Space' && isPushToTalk && canChat && !e.repeat) {
        e.preventDefault();
        if (!isRecording) startRecording();
      }
    };
    const handleKeyUp = (e) => {
      if (e.code === 'Space' && isPushToTalk && isRecording) {
        e.preventDefault();
        stopRecording();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [isPushToTalk, canChat, isRecording]);

  const startRealtime = async () => {
    if (!project) {
      alert('Please select a project first');
      return;
    }
  
    // First update the agent's knowledge base with selected project
    setKbUpdateStatus('Updating agent knowledge base...');
    setIsUpdatingKB(true);
    
    try {
      const kbResult = await pushKB({ project, mode: 'convai' });
      if (kbResult.error) {
        throw new Error(kbResult.error);
      }
      setKbUpdateStatus('Knowledge base updated! Starting conversation...');
    } catch (error) {
      console.error('Failed to update KB before starting conversation:', error);
      setKbUpdateStatus('');
      setIsUpdatingKB(false);
      alert(`Failed to update knowledge base: ${error.message}`);
      return;
    }
  
    // Close existing connection
    if (wsRef.current && wsRef.current.readyState === 1) wsRef.current.close();
    setWsStatus('connecting');
    
    try {
      // Get WebSocket URL (now points to Worker)
      const { ws_url } = await getRealtimePayload(project);
      console.log('Connecting to Worker:', ws_url);
      
      const ws = new WebSocket(ws_url);
      ws.binaryType = 'arraybuffer';
      
      ws.onopen = () => { 
        console.log('✅ Connected to Worker');
        setWsStatus('connected'); 
        setMessages([]); 
        setIsUpdatingKB(false);
        setKbUpdateStatus('');
        try { ensureAudioCtx(); } catch {} 
      };
      
      ws.onclose = (evt) => { 
        console.log('🔌 Worker connection closed:', evt.code, evt.reason);
        setWsStatus('disconnected'); 
        setCurrentAgentMessage(''); 
        setAgentSpeaking(false); 
      };
      
      ws.onerror = (evt) => {
        console.error('❌ Worker connection error:', evt);
        setWsStatus('error');
        setIsUpdatingKB(false);
        setKbUpdateStatus('');
      };
      
      ws.onmessage = async (evt) => {
        const raw = await normalizeWsData(evt.data);
        try {
          const j = JSON.parse(raw);
          
          // Handle Worker-specific message formats
          if (j.type === 'info') {
            console.log('ℹ️ Worker info:', j.text);
            setMessages((m) => [...m, { 
              role: 'system', 
              text: j.text, 
              type: 'info', 
              timestamp: new Date() 
            }]);
            return;
          }
          
          if (j.type === 'error') {
            console.error('❌ Worker error:', j.text);
            setMessages((m) => [...m, { 
              role: 'system', 
              text: j.text, 
              type: 'error', 
              timestamp: new Date() 
            }]);
            return;
          }
          
          // Handle audio from Worker (normalized format)
          if (j.type === 'audio' && j.audio_base_64) {
            console.log('🔊 Received audio from Worker');
            enqueueAudio(j.audio_base_64, j.mime);
            return;
          }
          
          // Handle direct audio_base_64 field (backward compatibility)
          const b64 = j?.audio_base_64;
          if (b64) { 
            console.log('🔊 Received direct audio');
            enqueueAudio(b64, j.mime); 
            return; 
          }
          
          // Handle conversation metadata
          if (j.conversation_initiation_metadata_event) {
            console.log('🎤 Conversation initialized:', j.conversation_initiation_metadata_event.conversation_id);
            setMessages((m) => [...m, { 
              role: 'system', 
              text: 'Conversation started successfully', 
              type: 'info', 
              timestamp: new Date() 
            }]);
            return;
          }
          
          // Handle text messages from agent
          const extractedText = extractText(j);
          if (extractedText && extractedText.trim() && 
              !extractedText.includes('conversation_initiation') && 
              !extractedText.includes('metadata') && 
              !extractedText.includes('ping') && 
              !extractedText.includes('pong') && 
              !extractedText.includes('interruption') && 
              extractedText.length > 2) {
            
            console.log('💬 Agent text:', extractedText);
            setCurrentAgentMessage(extractedText.trim());
            setMessages((m) => [...m, { 
              role: 'assistant', 
              text: String(extractedText).trim(), 
              timestamp: new Date() 
            }]);
          }
          
        } catch (parseError) {
          console.log('⚠️ Failed to parse Worker message:', parseError);
          // Handle non-JSON messages if needed
        }
      };
      
      wsRef.current = ws;
      
    } catch (error) {
      console.error('❌ Failed to start Worker connection:', error);
      setWsStatus('error');
      setIsUpdatingKB(false);
      setKbUpdateStatus('');
      alert(`Failed to connect: ${error.message}`);
    }
  };

  const decodeAB = (ab) => {
    try { return new TextDecoder().decode(ab instanceof Uint8Array ? ab : new Uint8Array(ab)); }
    catch { return ''; }
  };

  const normalizeWsData = async (d) => {
    if (typeof d === 'string') return d;
    if (d instanceof Blob) return await d.text();
    if (d instanceof ArrayBuffer || ArrayBuffer.isView(d)) return decodeAB(d);
    try { return JSON.stringify(d); } catch { return String(d); }
  };

  const extractText = (obj) => {
    if (obj?.conversation_initiation_metadata) return null;
    if (typeof obj?.text === 'string') return obj.text;
    if (typeof obj?.message === 'string') return obj.message;
    if (typeof obj?.content === 'string') return obj.content;
    if (typeof obj?.text_event?.text === 'string') return obj.text_event.text;
    if (typeof obj?.agent_response?.output_text === 'string') return obj.agent_response.output_text;
    if (typeof obj?.data?.text === 'string') return obj.data.text;
    let found = null;
    (function scan(o){
      if (found) return;
      if (typeof o === 'string' && o.length && o.length < 2000) { found = o; return; }
      if (o && typeof o === 'object') for (const k of Object.keys(o)) scan(o[k]);
    })(obj);
    return found;
  };

const sendTextMessage = () => {
    const v = inputRef.current?.value?.trim();
    if (!v || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    
    // Send in format expected by Worker
    const message = { type: 'user_message', text: v };
    console.log('📤 Sending text to Worker:', message);
    
    wsRef.current.send(JSON.stringify(message));
    setMessages((m) => [...m, { role: 'user', text: v, timestamp: new Date() }]);
    inputRef.current.value = '';
  };
  const getStatusText = () => {
    if (isRecording) return 'Recording...';
    if (isProcessingAudio) return 'Processing...';
    if (agentSpeaking) return 'Speaking...';
    if (wsStatus === 'connected') return 'Listening';
    if (wsStatus === 'connecting') return 'Connecting...';
    return 'Click to Talk';
  };

  return (
    <div className="min-h-screen text-white flex flex-col relative overflow-hidden"
         style={{
           background: `
             radial-gradient(circle at 20% 50%, rgba(120, 119, 198, 0.3) 0%, transparent 50%),
             radial-gradient(circle at 80% 20%, rgba(255, 119, 198, 0.3) 0%, transparent 50%),
             radial-gradient(circle at 40% 80%, rgba(120, 200, 255, 0.3) 0%, transparent 50%),
             linear-gradient(135deg, #0c0c0c 0%, #1a1a2e 50%, #16213e 100%)
           `
         }}>
      
      {/* Animated background elements */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 left-1/4 w-64 h-64 bg-blue-500/10 rounded-full blur-3xl animate-pulse"></div>
        <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-purple-500/10 rounded-full blur-3xl animate-pulse" style={{animationDelay: '2s'}}></div>
        <div className="absolute top-1/2 right-1/3 w-48 h-48 bg-cyan-500/10 rounded-full blur-3xl animate-pulse" style={{animationDelay: '4s'}}></div>
      </div>

      {/* Top Bar */}
      <div className="relative z-10 flex items-center justify-between p-6 border-b border-gray-800/50 backdrop-blur-sm">
        <div className="flex items-center gap-4">
          <h1 className="text-2xl font-bold text-white">Qriocity</h1>
          <div className="flex items-center gap-2">
            <select
              className="bg-gray-800/80 backdrop-blur-sm border border-gray-700/50 rounded-lg px-3 py-2 text-sm text-white focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              value={project}
              onChange={(e) => setProject(e.target.value)}
              disabled={isUpdatingKB || wsStatus === 'connected'}
            >
              <option value="">Select Project...</option>
              {Array.isArray(projects) ? projects.map(p => (
                <option key={p.key} value={p.key}>{p.title}</option>
              )) : null}
            </select>
            
            {/* Project selection status indicator */}
            {project && !isUpdatingKB && wsStatus === 'disconnected' && (
              <div className="flex items-center gap-2 ml-2">
                <div className="w-2 h-2 bg-green-500 rounded-full"></div>
                <span className="text-xs text-green-400">Ready</span>
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* Add disconnect button when connected */}
          {wsStatus === 'connected' && (
            <button
              onClick={disconnectConversation}
              className="p-3 rounded-lg bg-red-600/80 backdrop-blur-sm hover:bg-red-500/80 text-white transition-all"
              title="Disconnect"
            >
              <PhoneOff className="w-5 h-5" />
            </button>
          )}
          <button
            onClick={() => setShowSettings(!showSettings)}
            className="p-3 rounded-lg bg-gray-800/80 backdrop-blur-sm hover:bg-gray-700/80 text-gray-300 hover:text-white transition-all"
          >
            <Settings className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Main */}
      <div className="relative z-10 flex-1 flex flex-col items-center justify-center">
        <div className="flex flex-col items-center space-y-12">

          {/* Voice Circle with Video */}
          <div className="relative">
            <div
              className={`relative w-96 h-96 rounded-full overflow-hidden transition-all duration-500
                ${isRecording
                  ? 'ring-8 ring-red-500/40'
                  : agentSpeaking
                  ? 'ring-8 ring-blue-500/40'
                  : isProcessingAudio
                  ? 'ring-8 ring-yellow-500/40'
                  : wsStatus === 'connected'
                  ? 'ring-8 ring-cyan-500/30'
                  : 'ring-8 ring-gray-600/30'
                }`}
            >
              {/* full-size orb video */}
              <video
                ref={videoRef}
                className="absolute inset-0 w-full h-full object-cover scale-250"
                autoPlay
                loop
                muted
                playsInline
                src="orb1.mp4"
              />

              {/* mic button centered */}
              <button
                onMouseDown={handleMouseDown}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseUp}
                onClick={!isPushToTalk ? (isRecording ? stopRecording : startRecording) : undefined}
                disabled={!canChat || isProcessingAudio}
                className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2
                           w-28 h-28 rounded-full bg-white/10 backdrop-blur-sm border border-white/20
                           flex items-center justify-center hover:scale-105 hover:bg-white/20
                           transition-all duration-200 z-10 disabled:opacity-50"
              >
                {isRecording ? (
                  <MicOff className="w-14 h-14 text-white" />
                ) : isProcessingAudio ? (
                  <Volume2 className="w-14 h-14 text-white animate-pulse" />
                ) : agentSpeaking ? (
                  <Volume2 className="w-14 h-14 text-white animate-bounce" />
                ) : (
                  <Mic className="w-14 h-14 text-white" />
                )}
              </button>
            </div>
          </div>

          {/* Status + Controls */}
          <div className="flex flex-col items-center space-y-6">
            <div className="text-center">
              <div className={`text-2xl font-semibold mb-2 ${
                isRecording ? 'text-red-300' :
                agentSpeaking ? 'text-blue-300' :
                isProcessingAudio ? 'text-yellow-300' :
                wsStatus === 'connected' ? 'text-green-300' :
                'text-gray-400'
              }`}>
                {getStatusText()}
              </div>
              <div className="text-gray-400 text-sm">
                {isPushToTalk ? 'Hold Space or click & hold' : 'Click to talk'}
              </div>
            </div>

            <div className="flex items-center gap-6 flex-wrap justify-center">
              <button
                onClick={() => setIsMuted(!isMuted)}
                className={`p-4 rounded-full transition-all duration-200 ${
                  isMuted
                    ? 'bg-red-600/80 hover:bg-red-600 text-white shadow-lg shadow-red-500/30'
                    : 'bg-gray-800/80 hover:bg-gray-700/80 text-gray-300 hover:text-white backdrop-blur-sm'
                }`}
                title={isMuted ? 'Unmute' : 'Mute'}
              >
                {isMuted ? <VolumeX className="w-6 h-6" /> : <Volume2 className="w-6 h-6" />}
              </button>

              <button
                onClick={() => setIsPushToTalk(!isPushToTalk)}
                className={`px-6 py-3 rounded-full text-sm font-medium transition-all duration-200 backdrop-blur-sm ${
                  isPushToTalk
                    ? 'bg-green-600/80 hover:bg-green-600 text-white shadow-lg shadow-green-500/30'
                    : 'bg-gray-800/80 hover:bg-gray-700/80 text-gray-300 hover:text-white'
                }`}
              >
                {isPushToTalk ? 'Push to Talk: ON' : 'Push to Talk: OFF'}
              </button>

              <button
                onClick={() => setChatMode(chatMode === 'voice' ? 'text' : 'voice')}
                className="p-4 rounded-full bg-gray-800/80 hover:bg-gray-700/80 text-gray-300 hover:text-white transition-all duration-200 backdrop-blur-sm"
                title={`Switch to ${chatMode === 'voice' ? 'Text' : 'Voice'} Mode`}
              >
                {chatMode === 'voice' ? <MessageSquare className="w-6 h-6" /> : <Mic className="w-6 h-6" />}
              </button>
            </div>
          </div>
        </div>

        {wsStatus !== 'connected' && (
          <div className="mt-12 text-center">
            {/* KB Update Status */}
            {kbUpdateStatus && (
              <div className="mb-4 p-3 rounded-lg bg-blue-900/20 border border-blue-500/30 max-w-md mx-auto">
                <div className="flex items-center gap-2 justify-center">
                  {isUpdatingKB && (
                    <div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin"></div>
                  )}
                  <span className="text-sm text-blue-300">{kbUpdateStatus}</span>
                </div>
              </div>
            )}
            
            <button
              onClick={startRealtime}
              disabled={!project || isUpdatingKB}
              className="px-10 py-4 rounded-full bg-blue-600/80 hover:bg-blue-600 text-white font-semibold text-lg transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed backdrop-blur-sm shadow-lg shadow-blue-500/30"
            >
              {isUpdatingKB 
                ? 'Updating Knowledge Base...' 
                : wsStatus === 'connecting' 
                ? 'Connecting...' 
                : 'Start Conversation'
              }
            </button>
            
            {!project && (
              <p className="mt-3 text-sm text-gray-400">
                Please select a project to continue
              </p>
            )}
          </div>
        )}
      </div>

      {/* Fixed Text Input - positioned above controls, only show when in text mode and connected */}
      {chatMode === 'text' && canChat && (
        <div className="fixed bottom-32 left-1/2 transform -translate-x-1/2 w-full max-w-lg px-4 z-50">
          <div className="flex gap-3 bg-gray-900/95 backdrop-blur-md rounded-full p-4 border border-gray-700/50 shadow-2xl">
            <input
              ref={inputRef}
              placeholder="Ask anything"
              className="flex-1 bg-transparent px-4 py-3 text-white placeholder-gray-400 focus:outline-none text-base"
              onKeyDown={(e) => e.key === 'Enter' && sendTextMessage()}
            />
            <button
              onClick={sendTextMessage}
              className="p-3 rounded-full bg-blue-600/90 hover:bg-blue-600 text-white transition-all duration-200 shadow-lg"
            >
              <Send className="w-5 h-5" />
            </button>
          </div>
        </div>
      )}



      {messages.length > 0 && (
        <div className="absolute top-20 left-4 w-80 max-h-96 overflow-y-auto bg-gray-900/95 backdrop-blur-md border border-gray-700/50 rounded-xl p-4 space-y-3 z-40">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-300">Conversation</h3>
            <button onClick={() => setMessages([])} className="text-xs text-gray-500 hover:text-gray-300">Clear</button>
          </div>

          {messages.slice(-10).map((msg, i) => (
            <div key={i} className={`text-sm ${
              msg.role === 'user' ? 'text-blue-300' :
              msg.role === 'system' ? 'text-yellow-300' : 'text-gray-300'
            }`}>
              <div className="font-medium mb-1">
                {msg.role === 'user' ? '🎤 You' : msg.role === 'system' ? '⚠️ System' : '🤖 Assistant'}
              </div>
              <div className="text-xs text-gray-400 leading-relaxed">{msg.text}</div>
            </div>
          ))}
        </div>
      )}

      {currentAgentMessage && audioPlayingRef.current && (
        <div className="absolute bottom-32 left-1/2 transform -translate-x-1/2 max-w-md z-30">
          <div className="bg-gray-900/95 backdrop-blur-md border border-blue-500/30 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2">
              <Volume2 className="w-4 h-4 text-blue-400 animate-pulse" />
              <span className="text-sm text-blue-400">Speaking now...</span>
            </div>
            <p className="text-sm text-gray-300 leading-relaxed">{currentAgentMessage}</p>
          </div>
        </div>
      )}

      <div className="absolute bottom-4 left-1/2 transform -translate-x-1/2 z-10">
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <span>Powered by</span>
          <span className="text-blue-400">ElevenLabs Conversational AI</span>
        </div>
      </div>
    </div>
  );
}
