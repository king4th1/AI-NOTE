
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { RecorderStatus, TranscriptionSegment, RecordingSession, KnowledgeFile } from './types';
import { createBlob } from './services/audioUtils';
import TranscriptionList from './components/TranscriptionList';
import Waveform from './components/Waveform';

const App: React.FC = () => {
  const [status, setStatus] = useState<RecorderStatus>(RecorderStatus.IDLE);
  const [segments, setSegments] = useState<TranscriptionSegment[]>([]);
  const [currentTranscription, setCurrentTranscription] = useState<string>('');
  const [elapsedTime, setElapsedTime] = useState(0);
  const [sessions, setSessions] = useState<RecordingSession[]>([]);
  const [knowledgeBase, setKnowledgeBase] = useState<KnowledgeFile[]>([]);
  const [viewingSessionId, setViewingSessionId] = useState<string | null>(null);
  const [isBilingual, setIsBilingual] = useState(false);
  const [analysisResult, setAnalysisResult] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [audioStream, setAudioStream] = useState<MediaStream | null>(null);
  const [globalCopySuccess, setGlobalCopySuccess] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [tempSessionTitle, setTempSessionTitle] = useState("");
  const [searchQuery, setSearchQuery] = useState("");

  const sessionRef = useRef<any>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const timerRef = useRef<number | null>(null);
  const transcriptionBufferRef = useRef<string>('');
  const segmentsRef = useRef<TranscriptionSegment[]>([]);
  const lastSegmentTimeRef = useRef<number>(0);
  const connectionRetryCount = useRef(0);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  
  const statusRef = useRef<RecorderStatus>(RecorderStatus.IDLE);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);
  
  const isProcessingRef = useRef(false);
  const processingQueueRef = useRef<{id: string, type: 'polish' | 'translate', retryCount: number}[]>([]);
  const baseCooldownRef = useRef(3500); 

  // Initialize data from local storage
  useEffect(() => {
    const saved = localStorage.getItem('classroom_recorder_sessions');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        setSessions(Array.isArray(parsed) ? parsed : []);
      } catch (e) { console.error("Failed to parse sessions", e); }
    }
    const savedKB = localStorage.getItem('classroom_recorder_kb');
    if (savedKB) {
      try {
        setKnowledgeBase(JSON.parse(savedKB));
      } catch (e) { console.error("Failed to parse KB", e); }
    }
  }, []);

  // Recording Timer
  useEffect(() => {
    if (status === RecorderStatus.RECORDING) {
      timerRef.current = window.setInterval(() => setElapsedTime(p => p + 1), 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [status]);

  const cleanText = (text: string) => {
    if (!text) return "";
    // Remove character/phrase spam (hallucinations/jitter)
    let cleaned = text.replace(/(.)\1{6,}/g, '$1'); 
    cleaned = cleaned.replace(/(.{4,})\1{2,}/g, '$1'); 
    return cleaned.trim();
  };

  // Background processor for Polishing and Translating
  useEffect(() => {
    const processQueue = async () => {
      if (isProcessingRef.current || processingQueueRef.current.length === 0) return;
      const item = processingQueueRef.current.shift();
      if (!item) return;

      const currentActiveSegments = viewingSessionId 
        ? sessions.find(s => s.id === viewingSessionId)?.segments 
        : segments;
      
      const segment = currentActiveSegments?.find(s => s.id === item.id);
      if (!segment) {
        processQueue();
        return;
      }

      isProcessingRef.current = true;
      try {
        let success = false;
        if (item.type === 'polish') {
          const segmentIndex = currentActiveSegments?.indexOf(segment) ?? -1;
          const contextSegments = segmentIndex > 0 ? currentActiveSegments?.slice(Math.max(0, segmentIndex - 3), segmentIndex) : [];
          success = await polishSegment(segment, contextSegments || []);
        } else if (item.type === 'translate' && isBilingual) {
          success = await translateSegment(segment);
        } else {
          success = true;
        }

        if (success) {
          await new Promise(resolve => setTimeout(resolve, baseCooldownRef.current)); 
        } else if (item.retryCount < 5) {
          const backoffDelay = Math.pow(2, item.retryCount) * 2000;
          setTimeout(() => {
            processingQueueRef.current.push({ ...item, retryCount: item.retryCount + 1 });
          }, backoffDelay);
        }
      } catch (err) {
        console.error("Processing queue error:", err);
      } finally {
        isProcessingRef.current = false;
        setTimeout(processQueue, 1000);
      }
    };
    processQueue();
  }, [isBilingual, segments, viewingSessionId, sessions]);

  const cleanupSession = () => {
    if (sessionRef.current) {
      try { sessionRef.current.close(); } catch (e) {}
      sessionRef.current = null;
    }
    if (scriptProcessorRef.current) {
      scriptProcessorRef.current.disconnect();
      scriptProcessorRef.current = null;
    }
    if (audioContextRef.current) {
      try { audioContextRef.current.close(); } catch (e) {}
      audioContextRef.current = null;
    }
  };

  const connectToLive = async () => {
    if (statusRef.current !== RecorderStatus.RECORDING && statusRef.current !== RecorderStatus.PAUSED) return;

    cleanupSession();
    
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const AudioContextClass = (window as any).AudioContext || (window as any).webkitAudioContext;
      const inputCtx = new AudioContextClass({ sampleRate: 16000 });
      audioContextRef.current = inputCtx;

      if (inputCtx.state === 'suspended') {
        await inputCtx.resume();
      }

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        callbacks: {
          onopen: () => {
            console.log("Live API: Connected");
            connectionRetryCount.current = 0;
            if (!audioStream) return;
            
            const source = inputCtx.createMediaStreamSource(audioStream);
            const scriptProcessor = inputCtx.createScriptProcessor(4096, 1, 1);
            scriptProcessorRef.current = scriptProcessor;
            
            scriptProcessor.onaudioprocess = (e) => {
              if (statusRef.current === RecorderStatus.RECORDING) {
                const inputData = e.inputBuffer.getChannelData(0);
                const pcmBlob = createBlob(inputData);
                sessionPromise.then(s => {
                  if (s) s.sendRealtimeInput({ media: pcmBlob });
                }).catch(() => {});
              }
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputCtx.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            if (message.serverContent?.inputTranscription) {
              const textChunk = message.serverContent.inputTranscription.text;
              transcriptionBufferRef.current += textChunk;
              const liveText = cleanText(transcriptionBufferRef.current);
              setCurrentTranscription(liveText);
              
              // Trigger finalization on punctuation or length
              if (liveText.length > 120 || (liveText.length > 25 && /[。！？.!?\n]/.test(liveText.slice(-1)))) {
                finalizeCurrentSegment();
              }
            }
            if (message.serverContent?.turnComplete) {
              finalizeCurrentSegment();
            }
          },
          onerror: (e) => {
            console.error("Live API Session Error:", e);
            if (connectionRetryCount.current < 5 && statusRef.current !== RecorderStatus.IDLE) {
              connectionRetryCount.current++;
              const backoff = Math.min(15000, Math.pow(2, connectionRetryCount.current) * 1000);
              setTimeout(connectToLive, backoff);
            } else if (connectionRetryCount.current >= 5) {
              setStatus(RecorderStatus.ERROR);
            }
          },
          onclose: () => {
            console.log("Live API: Closed");
          }
        },
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          systemInstruction: `Academic Verbatim Transcriber. 
Output exactly what is said. 
Languages: Simplified Chinese and English. 
Context Files: ${knowledgeBase.map(k => k.name).join(', ')}. 
Do not hallucinate or add commentary.`
        }
      });

      sessionRef.current = await sessionPromise;
    } catch (err) {
      console.error("Live API Connection Failed:", err);
      setStatus(RecorderStatus.ERROR);
    }
  };

  const startRecording = async () => {
    try {
      cleanupSession();
      setViewingSessionId(null);
      setAnalysisResult(null);
      setSegments([]);
      segmentsRef.current = [];
      setElapsedTime(0);
      lastSegmentTimeRef.current = 0;
      transcriptionBufferRef.current = '';
      processingQueueRef.current = [];
      connectionRetryCount.current = 0;
      
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      setAudioStream(stream);
      setStatus(RecorderStatus.RECORDING);
      
      // Delay initialization slightly for stability
      setTimeout(connectToLive, 300);
    } catch (err) {
      console.error("Microphone access failed", err);
      setStatus(RecorderStatus.ERROR);
    }
  };

  const finalizeCurrentSegment = () => {
    const text = cleanText(transcriptionBufferRef.current);
    if (!text || text.length < 2) return;

    const newSegment: TranscriptionSegment = {
      id: Math.random().toString(36).substr(2, 9),
      startTime: lastSegmentTimeRef.current,
      endTime: elapsedTime,
      text: text,
      isFinal: true
    };

    segmentsRef.current = [...segmentsRef.current, newSegment];
    setSegments([...segmentsRef.current]);
    transcriptionBufferRef.current = '';
    setCurrentTranscription('');
    lastSegmentTimeRef.current = elapsedTime;

    processingQueueRef.current.push({ id: newSegment.id, type: 'polish', retryCount: 0 });
    if (isBilingual) {
      processingQueueRef.current.push({ id: newSegment.id, type: 'translate', retryCount: 0 });
    }
  };

  const polishSegment = async (segment: TranscriptionSegment, context: TranscriptionSegment[]): Promise<boolean> => {
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const contextText = context.map(s => s.text).join(' ');
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: `Proofread and polish this classroom transcript segment for academic flow and homophone correction.
Context: ${contextText || "Start of lecture"}.
Current segment: ${segment.text}.
Language: Simplified Chinese.
Knowledge Base Context: ${knowledgeBase.map(k => k.content).slice(0, 1).join('\n')}.
Return ONLY the polished text.`,
      });
      const polished = response.text?.trim() || segment.text;
      const updateFn = (prev: TranscriptionSegment[]) => prev.map(s => s.id === segment.id ? { ...s, text: polished } : s);
      setSegments(updateFn);
      if (viewingSessionId) setSessions(prev => {
        const updated = prev.map(session => session.id === viewingSessionId ? { ...session, segments: updateFn(session.segments) } : session);
        localStorage.setItem('classroom_recorder_sessions', JSON.stringify(updated));
        return updated;
      });
      return true;
    } catch (e) { return false; }
  };

  const translateSegment = async (segment: TranscriptionSegment): Promise<boolean> => {
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: `Translate to the other language (English <-> Chinese). Text: ${segment.text}. Professional tone. Return ONLY translation.`,
      });
      const translated = response.text?.trim() || "";
      const updateFn = (prev: TranscriptionSegment[]) => prev.map(s => s.id === segment.id ? { ...s, translatedText: translated } : s);
      setSegments(updateFn);
      if (viewingSessionId) setSessions(prev => {
        const updated = prev.map(session => session.id === viewingSessionId ? { ...session, segments: updateFn(session.segments) } : session);
        localStorage.setItem('classroom_recorder_sessions', JSON.stringify(updated));
        return updated;
      });
      return true;
    } catch (e) { return false; }
  };

  const pauseRecording = () => setStatus(RecorderStatus.PAUSED);
  const resumeRecording = () => {
    setStatus(RecorderStatus.RECORDING);
    if (audioContextRef.current?.state === 'suspended') audioContextRef.current.resume();
  };

  const stopRecording = async () => {
    if (status === RecorderStatus.IDLE) return;
    finalizeCurrentSegment();
    
    if (audioStream) {
      audioStream.getTracks().forEach(t => t.stop());
      setAudioStream(null);
    }
    cleanupSession();
    
    const timestamp = new Date().toLocaleString();
    const finalSegments = [...segmentsRef.current];
    const duration = elapsedTime;

    const newSession: RecordingSession = {
      id: Math.random().toString(36).substr(2, 9),
      title: "Synthesizing Title...",
      date: timestamp,
      segments: finalSegments,
      duration: duration
    };
    
    const updated = [newSession, ...sessions];
    setSessions(updated);
    localStorage.setItem('classroom_recorder_sessions', JSON.stringify(updated));
    setStatus(RecorderStatus.IDLE);
    setViewingSessionId(newSession.id);
    setSegments([]);
    segmentsRef.current = [];

    // Title generation: Academic summary without timestamps
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const fullContent = finalSegments.map(s => s.text).join(' ');
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: `Based on the following transcript, generate a concise academic title (3-5 words) in Simplified Chinese. IMPORTANT: Do not include any dates, times, or timestamps.
Content: ${fullContent.slice(0, 800)}`,
      });
      const smartTitle = response.text?.trim() || "Academic Lecture";
      setSessions(prev => {
        const updatedList = prev.map(s => s.id === newSession.id ? { ...s, title: smartTitle } : s);
        localStorage.setItem('classroom_recorder_sessions', JSON.stringify(updatedList));
        return updatedList;
      });
    } catch (e) {
      setSessions(prev => prev.map(s => s.id === newSession.id ? { ...s, title: "Lecture Recording" } : s));
    }
  };

  const renameSession = (id: string, newTitle: string) => {
    const updated = sessions.map(s => s.id === id ? { ...s, title: newTitle } : s);
    setSessions(updated);
    localStorage.setItem('classroom_recorder_sessions', JSON.stringify(updated));
    setEditingSessionId(null);
  };

  const deleteSession = (id: string) => {
    if (!confirm("Confirm removal from archive?")) return;
    const updated = sessions.filter(s => s.id !== id);
    setSessions(updated);
    localStorage.setItem('classroom_recorder_sessions', JSON.stringify(updated));
    if (viewingSessionId === id) {
      setViewingSessionId(null);
      setAnalysisResult(null);
    }
  };

  const exportSession = (session: RecordingSession) => {
    const header = `TRANSCRIPT: ${session.title}\nRecorded: ${session.date}\nLength: ${(session.duration / 60).toFixed(1)}m\n${"-".repeat(40)}\n\n`;
    const body = session.segments.map(s => {
      const time = `[${Math.floor(s.startTime / 60).toString().padStart(2, '0')}:${(s.startTime % 60).toString().padStart(2, '0')}]`;
      let line = `${time} ${s.text}`;
      if (isBilingual && s.translatedText) line += `\n   TRANSLATION: ${s.translatedText}`;
      return line;
    }).join('\n\n');
    const analysis = session.analysis ? `\n\n--- AI ANALYSIS ---\n\n${session.analysis}` : "";
    const blob = new Blob([header + body + analysis], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    // Filename sanitized for OS compatibility
    link.download = `${session.title.replace(/[/\\?%*:|"<>]/g, '_')}.txt`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const performDeepAnalysis = async () => {
    const activeSegments = viewingSessionId ? sessions.find(s => s.id === viewingSessionId)?.segments : segments;
    if (!activeSegments || activeSegments.length === 0) return;
    setIsAnalyzing(true);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const fullText = activeSegments.map(s => s.text).join('\n');
      const response = await ai.models.generateContent({
        model: 'gemini-3-pro-preview',
        contents: `Act as a senior academic researcher. Provide an executive summary, key technical concepts, and a logical structure for the following transcript.
Language: Simplified Chinese.
Context: ${knowledgeBase.map(k => k.content).join('\n')}.
Transcript: ${fullText}`,
      });
      const resultText = response.text || "Analysis complete but empty.";
      setAnalysisResult(resultText);
      if (viewingSessionId) {
        setSessions(prev => {
          const updated = prev.map(s => s.id === viewingSessionId ? { ...s, analysis: resultText } : s);
          localStorage.setItem('classroom_recorder_sessions', JSON.stringify(updated));
          return updated;
        });
      }
    } catch (e) { 
      setAnalysisResult("Analysis request failed. Please check connection."); 
    } finally { 
      setIsAnalyzing(false); 
    }
  };

  const filteredSessions = useMemo(() => {
    if (!searchQuery.trim()) return sessions;
    const lowerQuery = searchQuery.toLowerCase();
    return sessions.filter(s => s.title.toLowerCase().includes(lowerQuery) || s.date.toLowerCase().includes(lowerQuery));
  }, [sessions, searchQuery]);

  const currentData = viewingSessionId ? sessions.find(s => s.id === viewingSessionId) : { title: status === RecorderStatus.IDLE ? 'New Session' : 'Recording Live', segments: segments };

  return (
    <div className="flex h-screen bg-[#F1F5F9] overflow-hidden select-none relative font-sans text-slate-900">
      {isSidebarOpen && <div className="fixed inset-0 bg-black/40 z-[45] lg:hidden backdrop-blur-sm" onClick={() => setIsSidebarOpen(false)} />}

      {/* Sidebar Navigation */}
      <aside className={`fixed lg:relative w-[280px] sm:w-80 h-full bg-white border-r border-slate-200 flex flex-col z-50 transition-transform duration-300 shadow-2xl lg:shadow-none ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}`}>
        <div className="p-5 border-b flex items-center justify-between bg-white sticky top-0 z-10">
          <h1 className="text-xl font-black text-slate-800 flex items-center gap-2">
            <i className="fas fa-brain text-blue-600"></i>
            <span>SMART REC</span>
          </h1>
          <button onClick={() => setIsSidebarOpen(false)} className="lg:hidden p-2 text-slate-400"><i className="fas fa-times"></i></button>
        </div>
        
        <div className="flex-1 overflow-y-auto p-4 space-y-6 custom-scrollbar">
          {/* Context / Knowledge Base */}
          <div className="bg-blue-50/50 p-4 rounded-2xl border border-blue-100/50">
            <div className="flex items-center justify-between mb-3 px-1">
              <h2 className="text-[10px] font-black text-blue-500 uppercase tracking-widest">Knowledge Context</h2>
              <label className="cursor-pointer text-blue-500 p-1 hover:bg-blue-100 rounded-lg transition-colors">
                <i className="fas fa-plus"></i>
                <input type="file" className="hidden" onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const reader = new FileReader();
                  reader.onload = (ev) => {
                    const newFile: KnowledgeFile = { id: Math.random().toString(36).substr(2, 9), name: file.name, content: ev.target?.result as string };
                    const updated = [...knowledgeBase, newFile];
                    setKnowledgeBase(updated);
                    localStorage.setItem('classroom_recorder_kb', JSON.stringify(updated));
                  };
                  reader.readAsText(file);
                }} accept=".txt,.md" />
              </label>
            </div>
            <div className="space-y-1.5">
              {knowledgeBase.map(f => (
                <div key={f.id} className="flex items-center justify-between p-2 bg-white rounded-lg border border-blue-50 text-[11px] group hover:border-blue-200 transition-colors">
                  <span className="truncate font-medium text-slate-600"><i className="far fa-file-alt mr-2 text-blue-300"></i>{f.name}</span>
                  <button onClick={() => setKnowledgeBase(kb => kb.filter(i => i.id !== f.id))} className="text-red-400 opacity-0 group-hover:opacity-100 p-1"><i className="fas fa-trash-alt"></i></button>
                </div>
              ))}
              {knowledgeBase.length === 0 && <div className="text-[9px] text-slate-400 text-center py-2 italic">No context files loaded</div>}
            </div>
          </div>

          {/* Library / Search */}
          <div className="space-y-3">
            <div className="flex items-center justify-between px-1">
              <h2 className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Library</h2>
              <div className="relative">
                <input type="text" placeholder="Search..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="bg-slate-100 border-none rounded-lg py-1 px-3 text-[10px] w-24 focus:w-32 transition-all focus:ring-1 focus:ring-blue-400 outline-none" />
              </div>
            </div>
            <div className="space-y-2">
              {filteredSessions.map(s => (
                <div key={s.id} className="group relative">
                  {editingSessionId === s.id ? (
                    <div className="p-3 bg-white rounded-xl border-2 border-blue-500 shadow-lg">
                      <input autoFocus type="text" value={tempSessionTitle} onChange={(e) => setTempSessionTitle(e.target.value)} onBlur={() => renameSession(s.id, tempSessionTitle)} onKeyDown={(e) => e.key === 'Enter' && renameSession(s.id, tempSessionTitle)} className="w-full text-xs font-bold bg-transparent outline-none text-slate-700" />
                    </div>
                  ) : (
                    <div className="flex items-center gap-1">
                      <button onClick={() => { if(status !== RecorderStatus.IDLE) stopRecording(); setViewingSessionId(s.id); setAnalysisResult(s.analysis || null); setIsSidebarOpen(false); }} className={`flex-1 text-left p-4 rounded-xl transition-all border-2 ${viewingSessionId === s.id ? 'bg-blue-600 border-blue-600 text-white shadow-md' : 'bg-white hover:bg-slate-50 border-slate-100 text-slate-700'}`}>
                        <div className="font-bold text-[11px] truncate pr-14 leading-tight">{s.title}</div>
                        <div className="text-[9px] mt-2 opacity-60 flex justify-between font-medium"><span>{s.date.split(',')[0]}</span><span>{(s.duration / 60).toFixed(1)}m</span></div>
                      </button>
                      <div className="absolute right-2 top-1/2 -translate-y-1/2 flex flex-col gap-1 opacity-0 group-hover:opacity-100 transition-opacity z-10">
                        <button onClick={(e) => { e.stopPropagation(); exportSession(s); }} className={`p-1.5 rounded-lg text-[10px] ${viewingSessionId === s.id ? 'bg-white/20 text-white hover:bg-white/30' : 'bg-slate-100 text-slate-400 hover:text-green-500'}`}><i className="fas fa-file-export"></i></button>
                        <button onClick={(e) => { e.stopPropagation(); setEditingSessionId(s.id); setTempSessionTitle(s.title); }} className={`p-1.5 rounded-lg text-[10px] ${viewingSessionId === s.id ? 'bg-white/20 text-white hover:bg-white/30' : 'bg-slate-100 text-slate-400 hover:text-blue-500'}`}><i className="fas fa-edit"></i></button>
                        <button onClick={(e) => { e.stopPropagation(); deleteSession(s.id); }} className={`p-1.5 rounded-lg text-[10px] ${viewingSessionId === s.id ? 'bg-white/20 text-white hover:bg-red-400' : 'bg-slate-100 text-slate-400 hover:text-red-500'}`}><i className="fas fa-trash-alt"></i></button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
              {filteredSessions.length === 0 && <div className="text-center py-8 text-slate-300 text-[10px] italic">No recordings found</div>}
            </div>
          </div>
        </div>
      </aside>

      {/* Header & Main Workspace */}
      <main className="flex-1 flex flex-col min-w-0 bg-white relative">
        <header className="h-16 lg:h-20 border-b flex items-center justify-between px-4 lg:px-8 bg-white/80 backdrop-blur-md sticky top-0 z-[40]">
          <div className="flex items-center gap-2 sm:gap-4 overflow-hidden">
            <button onClick={() => setIsSidebarOpen(true)} className="lg:hidden p-2 text-slate-500"><i className="fas fa-bars"></i></button>
            <div className={`w-8 h-8 sm:w-10 sm:h-10 rounded-lg sm:rounded-xl flex items-center justify-center text-white shrink-0 ${status === RecorderStatus.RECORDING ? 'bg-red-500 animate-pulse shadow-lg' : status === RecorderStatus.PAUSED ? 'bg-amber-500' : status === RecorderStatus.ERROR ? 'bg-red-700' : 'bg-blue-600'}`}>
               <i className={`fas ${status === RecorderStatus.RECORDING ? 'fa-microphone-lines' : status === RecorderStatus.ERROR ? 'fa-circle-exclamation' : status === RecorderStatus.PAUSED ? 'fa-pause' : 'fa-check'} text-xs sm:text-sm`}></i>
            </div>
            <div className="min-w-0">
              <h2 className="text-sm sm:text-lg font-black text-slate-800 truncate leading-tight pr-4">{currentData?.title}</h2>
              <div className="text-[9px] text-blue-500 font-bold uppercase tracking-widest mt-0.5">
                {status === RecorderStatus.RECORDING ? 'Live AI Transcription' : status === RecorderStatus.ERROR ? 'API Connection Error' : 'Workspace Ready'}
              </div>
            </div>
          </div>
          
          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            <button onClick={() => {
                const activeData = viewingSessionId ? sessions.find(s => s.id === viewingSessionId) : { segments: segments };
                if (!activeData || activeData.segments.length === 0) return;
                const fullText = activeData.segments.map(s => s.text + (isBilingual && s.translatedText ? `\n[TL]: ${s.translatedText}` : '')).join('\n\n');
                navigator.clipboard.writeText(fullText);
                setGlobalCopySuccess(true);
                setTimeout(() => setGlobalCopySuccess(false), 2000);
              }} disabled={!currentData?.segments?.length} className={`h-9 lg:h-11 px-2.5 lg:px-4 rounded-xl text-[10px] lg:text-xs font-black transition-all border-2 flex items-center gap-1.5 ${globalCopySuccess ? 'bg-green-500 border-green-500 text-white' : 'bg-white text-slate-600 border-slate-100 hover:border-slate-300'}`}>
              <i className={`fas ${globalCopySuccess ? 'fa-check' : 'fa-copy'}`}></i>
              <span className="hidden sm:inline">Copy</span>
            </button>
            <button onClick={() => setIsBilingual(!isBilingual)} className={`h-9 lg:h-11 px-2.5 lg:px-4 rounded-xl text-[10px] lg:text-xs font-black transition-all border-2 flex items-center gap-1.5 ${isBilingual ? 'bg-blue-600 border-blue-600 text-white shadow-sm' : 'bg-white text-slate-600 border-slate-100 hover:border-slate-300'}`}>
              <i className="fas fa-language"></i>
              <span className="hidden md:inline">Bilingual</span>
            </button>
            <button onClick={performDeepAnalysis} disabled={isAnalyzing || !currentData?.segments?.length} className="h-9 lg:h-11 px-3 lg:px-5 bg-slate-900 text-white rounded-xl text-[10px] lg:text-xs font-black flex items-center gap-2 hover:bg-slate-800 transition-all shadow-lg active:scale-95 disabled:opacity-50">
              {isAnalyzing ? <i className="fas fa-spinner fa-spin"></i> : <i className="fas fa-sparkles"></i>}
              <span className="hidden sm:inline">AI Analysis</span>
            </button>
          </div>
        </header>

        {/* Content Body */}
        <div className="flex-1 overflow-hidden p-3 lg:p-6 flex flex-col lg:flex-row gap-4 lg:gap-6 relative">
          <TranscriptionList segments={currentData?.segments || []} currentText={status === RecorderStatus.RECORDING ? currentTranscription : undefined} isBilingual={isBilingual} />
          
          {analysisResult && (
            <div className="fixed lg:relative inset-x-0 bottom-0 lg:inset-auto h-[45%] lg:h-full w-full lg:w-[320px] bg-slate-50 border-t lg:border-t-0 lg:border-l border-slate-200 flex flex-col z-[45] animate-slideInRight lg:rounded-l-[24px] shadow-2xl overflow-hidden">
              <div className="p-4 bg-slate-900 text-white flex justify-between items-center shrink-0">
                <span className="text-[10px] font-black uppercase tracking-widest flex items-center gap-2"><i className="fas fa-brain text-blue-400"></i> AI Synthesis</span>
                <button onClick={() => setAnalysisResult(null)} className="p-1 hover:text-red-400 transition-colors"><i className="fas fa-times"></i></button>
              </div>
              <div className="flex-1 overflow-y-auto p-5 text-slate-700 leading-relaxed text-xs sm:text-sm whitespace-pre-wrap font-medium custom-scrollbar">
                {analysisResult}
              </div>
            </div>
          )}
        </div>

        {/* Floating Controls */}
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 w-full max-w-[95%] sm:max-w-md px-2 z-[40]">
          <div className="bg-white/95 backdrop-blur-2xl p-4 lg:p-5 rounded-[24px] border border-white/50 shadow-2xl flex flex-col gap-3 transition-all duration-300">
            {status === RecorderStatus.ERROR && (
              <div className="text-[10px] text-red-500 font-bold bg-red-50 p-2 rounded-lg border border-red-100 flex items-center gap-2 animate-pulse mb-1">
                <i className="fas fa-triangle-exclamation"></i>
                Connection loss. Please check your internet or API key.
              </div>
            )}
            <Waveform isRecording={status === RecorderStatus.RECORDING} audioStream={audioStream} />
            <div className="flex justify-center items-center gap-6 sm:gap-8">
              {status === RecorderStatus.IDLE || status === RecorderStatus.ERROR ? (
                <button onClick={startRecording} className="w-14 h-14 sm:w-16 sm:h-16 bg-blue-600 text-white rounded-2xl shadow-xl hover:scale-110 active:scale-95 transition-all flex items-center justify-center">
                  <i className="fas fa-microphone text-xl"></i>
                </button>
              ) : (
                <div className="flex items-center gap-4 sm:gap-6">
                  <div className="text-sm sm:text-lg font-black font-mono text-slate-800 bg-slate-100/50 px-4 sm:px-6 py-2 rounded-xl border border-slate-200 min-w-[70px] sm:min-w-[100px] text-center shadow-inner">
                    {Math.floor(elapsedTime / 60).toString().padStart(2, '0')}:{(elapsedTime % 60).toString().padStart(2, '0')}
                  </div>
                  {status === RecorderStatus.RECORDING ? (
                    <button onClick={pauseRecording} className="w-11 h-11 sm:w-13 sm:h-13 bg-amber-500 text-white rounded-xl shadow-lg hover:scale-105 transition-all flex items-center justify-center">
                      <i className="fas fa-pause text-sm"></i>
                    </button>
                  ) : (
                    <button onClick={resumeRecording} className="w-11 h-11 sm:w-13 sm:h-13 bg-green-500 text-white rounded-xl shadow-lg hover:scale-105 transition-all flex items-center justify-center">
                      <i className="fas fa-play text-sm ml-0.5"></i>
                    </button>
                  )}
                  <button onClick={stopRecording} className="w-11 h-11 sm:w-13 sm:h-13 bg-red-500 text-white rounded-xl shadow-lg hover:scale-105 transition-all flex items-center justify-center">
                     <div className="w-3.5 h-3.5 bg-white rounded-sm shadow-sm"></div>
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};

export default App;
