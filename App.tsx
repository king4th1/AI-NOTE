
import React, { useState, useEffect, useRef } from 'react';
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

  const sessionRef = useRef<any>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const timerRef = useRef<number | null>(null);
  const transcriptionBufferRef = useRef<string>('');
  const segmentsRef = useRef<TranscriptionSegment[]>([]);
  const lastSegmentTimeRef = useRef<number>(0);
  
  const statusRef = useRef<RecorderStatus>(RecorderStatus.IDLE);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);
  
  // Advanced Processing Queue (Translation + Polishing)
  const isProcessingRef = useRef(false);
  const processingQueueRef = useRef<{id: string, type: 'polish' | 'translate', retryCount: number}[]>([]);
  const baseCooldownRef = useRef(2500); // Increased base cooldown for better rate limit compliance

  useEffect(() => {
    const saved = localStorage.getItem('classroom_recorder_sessions');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        setSessions(Array.isArray(parsed) ? parsed : []);
      } catch (e) { console.error(e); }
    }
    const savedKB = localStorage.getItem('classroom_recorder_kb');
    if (savedKB) setKnowledgeBase(JSON.parse(savedKB));
  }, []);

  useEffect(() => {
    if (status === RecorderStatus.RECORDING) {
      timerRef.current = window.setInterval(() => setElapsedTime(p => p + 1), 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [status]);

  // Main background processor for Polishing and Translation
  useEffect(() => {
    const processQueue = async () => {
      if (isProcessingRef.current || processingQueueRef.current.length === 0) return;
      
      const item = processingQueueRef.current.shift();
      if (!item) return;

      const activeSegments = viewingSessionId 
        ? sessions.find(s => s.id === viewingSessionId)?.segments 
        : segments;
      
      const segment = activeSegments?.find(s => s.id === item.id);
      if (!segment) {
        processQueue();
        return;
      }

      isProcessingRef.current = true;

      try {
        let success = false;
        if (item.type === 'polish') {
          success = await polishSegment(segment);
        } else if (item.type === 'translate' && isBilingual) {
          success = await translateSegment(segment);
        } else {
          success = true; // Skip if bilingual turned off
        }

        if (success) {
          // Reset cooldown on success
          baseCooldownRef.current = Math.max(2000, baseCooldownRef.current - 500);
          await new Promise(resolve => setTimeout(resolve, baseCooldownRef.current)); 
        } else {
          // Re-queue with incremented retry count
          if (item.retryCount < 5) {
            const backoff = Math.pow(2, item.retryCount) * 2000;
            baseCooldownRef.current = Math.min(15000, baseCooldownRef.current + 2000);
            console.warn(`Retrying ${item.type} for segment ${item.id} in ${backoff}ms...`);
            setTimeout(() => {
              processingQueueRef.current.push({ ...item, retryCount: item.retryCount + 1 });
              processQueue();
            }, backoff);
            // Allow other items to be picked up after some delay
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }
      } catch (err) {
        console.error("Queue process error:", err);
      } finally {
        isProcessingRef.current = false;
        processQueue();
      }
    };

    processQueue();
  }, [isBilingual, segments, viewingSessionId, sessions]);

  const cleanHallucinations = (text: string) => {
    const repeatCharRegex = /(.)\1{5,}/g;
    let cleaned = text.replace(repeatCharRegex, '$1');
    const repeatPhraseRegex = /(.{2,})\1{2,}/g;
    cleaned = cleaned.replace(repeatPhraseRegex, '$1');
    return cleaned;
  };

  const startRecording = async () => {
    try {
      setViewingSessionId(null);
      setAnalysisResult(null);
      setSegments([]);
      segmentsRef.current = [];
      setElapsedTime(0);
      lastSegmentTimeRef.current = 0;
      transcriptionBufferRef.current = '';
      processingQueueRef.current = [];
      
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      setAudioStream(stream);
      setStatus(RecorderStatus.RECORDING);

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const inputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      audioContextRef.current = inputCtx;

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        callbacks: {
          onopen: () => {
            const source = inputCtx.createMediaStreamSource(stream);
            const scriptProcessor = inputCtx.createScriptProcessor(4096, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              if (statusRef.current === RecorderStatus.RECORDING) {
                const inputData = e.inputBuffer.getChannelData(0);
                const pcmBlob = createBlob(inputData);
                sessionPromise.then(s => s.sendRealtimeInput({ media: pcmBlob }));
              }
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputCtx.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            if (message.serverContent?.inputTranscription) {
              let textChunk = message.serverContent.inputTranscription.text;
              textChunk = cleanHallucinations(textChunk);
              transcriptionBufferRef.current += textChunk;
              const cleanedText = cleanHallucinations(transcriptionBufferRef.current);
              setCurrentTranscription(cleanedText);

              if (cleanedText.length > 50 || (cleanedText.length > 8 && /[。！？.!?\n]/.test(cleanedText.slice(-1)))) {
                finalizeCurrentSegment();
              }
            }
            if (message.serverContent?.turnComplete) {
              finalizeCurrentSegment();
            }
          },
          onerror: (e) => setStatus(RecorderStatus.ERROR),
        },
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          systemInstruction: `You are an elite academic real-time transcriber.
          CONTEXT FROM DOCUMENTS: ${knowledgeBase.map(f => f.content).join('\n')}
          
          CORE MISSION:
          1. Speed: Output text as fast as possible.
          2. Accuracy: Use context to fix homophones.
          3. Language: STRICT Simplified Chinese (简体中文).
          4. Format: Natural phrasing. Remove filler words.
          5. NO HALLUCINATION: If silent, output nothing. Do NOT repeat words.
          6. Academic: Match terms to provided CONTEXT.`
        }
      });
      sessionRef.current = await sessionPromise;
    } catch (err) {
      setStatus(RecorderStatus.ERROR);
    }
  };

  const pauseRecording = () => {
    if (status !== RecorderStatus.RECORDING) return;
    setStatus(RecorderStatus.PAUSED);
    finalizeCurrentSegment();
  };

  const resumeRecording = () => {
    if (status !== RecorderStatus.PAUSED) return;
    setStatus(RecorderStatus.RECORDING);
  };

  const finalizeCurrentSegment = () => {
    const text = cleanHallucinations(transcriptionBufferRef.current.trim());
    if (!text || text.length < 1) return;

    const startTime = lastSegmentTimeRef.current;
    const endTime = elapsedTime;
    
    const newSegment: TranscriptionSegment = {
      id: Math.random().toString(36).substr(2, 9),
      startTime,
      endTime: Math.max(endTime, startTime + 1),
      text: text,
      isFinal: true
    };

    segmentsRef.current = [...segmentsRef.current, newSegment];
    setSegments([...segmentsRef.current]);
    
    transcriptionBufferRef.current = '';
    setCurrentTranscription('');
    lastSegmentTimeRef.current = newSegment.endTime;

    // Queue for refinement
    processingQueueRef.current.push({ id: newSegment.id, type: 'polish', retryCount: 0 });
    if (isBilingual) {
      processingQueueRef.current.push({ id: newSegment.id, type: 'translate', retryCount: 0 });
    }
  };

  const polishSegment = async (segment: TranscriptionSegment): Promise<boolean> => {
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const kbContext = knowledgeBase.map(f => f.content).slice(0, 5).join('\n');
      
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: `Act as an editor. Refine this raw classroom transcription segment into polished text. 
        - Correct typos/homophones based on Context: ${kbContext}
        - Maintain original meaning.
        - Simplified Chinese (简体中文).
        - Return ONLY polished text.
        
        Raw Segment: ${segment.text}`,
      });
      
      const polished = response.text?.trim() || segment.text;
      if (polished === segment.text) return true;

      const updateFn = (prev: TranscriptionSegment[]) => prev.map(s => s.id === segment.id ? { ...s, text: polished } : s);
      setSegments(updateFn);
      segmentsRef.current = updateFn(segmentsRef.current);
      
      if (viewingSessionId) {
        setSessions(prev => prev.map(session => session.id === viewingSessionId ? { ...session, segments: updateFn(session.segments) } : session));
      }
      return true;
    } catch (e: any) {
      console.error("Polish Error:", e);
      return false; // Success = false indicates we should retry
    }
  };

  const translateSegment = async (segment: TranscriptionSegment): Promise<boolean> => {
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: `Translate the following classroom segment to the other language (ZH-CN <-> EN). 
        Rules: Simplified Chinese only. Return ONLY translation.
        Segment: ${segment.text}`,
      });
      const translated = response.text?.trim() || "";
      const updateFn = (prev: TranscriptionSegment[]) => prev.map(s => s.id === segment.id ? { ...s, translatedText: translated } : s);
      setSegments(updateFn);
      segmentsRef.current = updateFn(segmentsRef.current);

      if (viewingSessionId) {
        setSessions(prev => prev.map(session => session.id === viewingSessionId ? { ...session, segments: updateFn(session.segments) } : session));
      }
      return true;
    } catch (e: any) {
      console.error("Translation Error:", e);
      return false;
    }
  };

  const stopRecording = () => {
    if (status === RecorderStatus.IDLE) return;
    finalizeCurrentSegment();
    if (audioStream) audioStream.getTracks().forEach(t => t.stop());
    if (audioContextRef.current) audioContextRef.current.close();
    
    const newSession: RecordingSession = {
      id: Math.random().toString(36).substr(2, 9),
      title: `Lesson ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
      date: new Date().toLocaleDateString(),
      segments: [...segmentsRef.current],
      duration: elapsedTime
    };
    
    const updated = [newSession, ...sessions];
    setSessions(updated);
    localStorage.setItem('classroom_recorder_sessions', JSON.stringify(updated));
    
    setStatus(RecorderStatus.IDLE);
    setAudioStream(null);
    setViewingSessionId(newSession.id);
    setSegments([]);
    segmentsRef.current = [];
    processingQueueRef.current = [];
  };

  const copyAllTranscript = () => {
    const activeData = viewingSessionId ? sessions.find(s => s.id === viewingSessionId) : { segments: segments };
    if (!activeData || activeData.segments.length === 0) return;

    const fullText = activeData.segments.map(s => {
      let segmentStr = s.text;
      if (isBilingual && s.translatedText) segmentStr += `\n[Translation]: ${s.translatedText}`;
      return segmentStr;
    }).join('\n\n');

    navigator.clipboard.writeText(fullText);
    setGlobalCopySuccess(true);
    setTimeout(() => setGlobalCopySuccess(false), 2000);
  };

  const performDeepAnalysis = async () => {
    const activeSegments = viewingSessionId ? sessions.find(s => s.id === viewingSessionId)?.segments : segments;
    if (!activeSegments || activeSegments.length === 0) return;
    
    setIsAnalyzing(true);
    setAnalysisResult(null);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const fullText = activeSegments.map(s => s.text).join('\n');
      const response = await ai.models.generateContent({
        model: 'gemini-3-pro-preview',
        contents: `Provide a structured analysis. Use Simplified Chinese.
        Context: ${knowledgeBase.map(f => f.content).join('\n')}
        Transcript: ${fullText}`,
      });
      setAnalysisResult(response.text || "No analysis generated.");
    } catch (e) { setAnalysisResult("Analysis quota exceeded."); } finally { setIsAnalyzing(false); }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const newFile: KnowledgeFile = {
        id: Math.random().toString(36).substr(2, 9),
        name: file.name,
        content: ev.target?.result as string
      };
      const updated = [...knowledgeBase, newFile];
      setKnowledgeBase(updated);
      localStorage.setItem('classroom_recorder_kb', JSON.stringify(updated));
    };
    reader.readAsText(file);
  };

  const currentData = viewingSessionId 
    ? sessions.find(s => s.id === viewingSessionId) 
    : { title: status === RecorderStatus.IDLE ? 'Workspace' : 'Live Recording', segments: segments };

  return (
    <div className="flex h-screen bg-[#F1F5F9] overflow-hidden select-none">
      <aside className="w-80 bg-white border-r border-slate-200 flex flex-col z-20 shadow-sm">
        <div className="p-6 border-b flex items-center justify-between">
          <h1 className="text-xl font-black text-slate-800 flex items-center gap-2">
            <i className="fas fa-brain text-blue-600"></i>
            <span>SMART REC</span>
          </h1>
          <button 
            onClick={() => { setViewingSessionId(null); setAnalysisResult(null); if(status === RecorderStatus.IDLE) setSegments([]); }}
            className="p-2 hover:bg-slate-50 rounded-lg text-slate-400"
          >
            <i className="fas fa-plus-circle"></i>
          </button>
        </div>
        
        <div className="flex-1 overflow-y-auto p-4 space-y-6 custom-scrollbar">
          <div className="bg-blue-50/50 p-4 rounded-2xl border border-blue-100/50">
            <h2 className="text-[10px] font-black text-blue-500 uppercase tracking-widest mb-3 flex items-center justify-between px-1">
              <span>Context Hub</span>
              <label className="cursor-pointer hover:text-blue-700">
                <i className="fas fa-file-upload"></i>
                <input type="file" className="hidden" onChange={handleFileUpload} accept=".txt,.md" />
              </label>
            </h2>
            <div className="space-y-2">
              {knowledgeBase.map(f => (
                <div key={f.id} className="flex items-center justify-between p-2.5 bg-white rounded-xl border border-blue-100/50 text-[11px] group">
                  <span className="truncate flex-1 font-bold text-slate-600"><i className="far fa-file mr-2 text-blue-400"></i>{f.name}</span>
                  <button onClick={() => {
                    setKnowledgeBase(kb => kb.filter(i => i.id !== f.id));
                  }} className="opacity-0 group-hover:opacity-100 text-red-400"><i className="fas fa-trash"></i></button>
                </div>
              ))}
            </div>
          </div>

          <div>
            <h2 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3 px-1">Recordings</h2>
            <div className="space-y-2">
              {sessions.map(s => (
                <button 
                  key={s.id} 
                  onClick={() => { if(status !== RecorderStatus.IDLE) stopRecording(); setViewingSessionId(s.id); setAnalysisResult(null); }} 
                  className={`w-full text-left p-4 rounded-2xl transition-all border-2 ${viewingSessionId === s.id ? 'bg-blue-600 border-blue-600 text-white shadow-md' : 'bg-white hover:bg-slate-50 border-slate-100 text-slate-700'}`}
                >
                  <div className="font-bold text-sm truncate">{s.title}</div>
                  <div className={`text-[10px] mt-2 opacity-70 flex justify-between`}>
                    <span>{s.date}</span>
                    <span className="font-bold">{(s.duration / 60).toFixed(1)}m</span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="p-4 border-t"><button onClick={() => { if(confirm("Clear local storage?")) { localStorage.clear(); window.location.reload(); } }} className="w-full py-2 text-[10px] font-black text-slate-300 hover:text-red-500 uppercase tracking-widest transition-colors">Wipe All</button></div>
      </aside>

      <main className="flex-1 flex flex-col relative bg-white">
        <header className="h-20 border-b flex items-center justify-between px-10 bg-white/70 backdrop-blur-lg sticky top-0 z-10">
          <div className="flex items-center gap-4">
            <div className={`w-12 h-12 rounded-2xl flex items-center justify-center text-white shadow-lg transition-all ${status === RecorderStatus.RECORDING ? 'bg-red-500 animate-pulse' : status === RecorderStatus.PAUSED ? 'bg-amber-500' : 'bg-blue-600'}`}>
               <i className={`fas ${status === RecorderStatus.RECORDING ? 'fa-microphone-alt' : status === RecorderStatus.PAUSED ? 'fa-pause' : 'fa-check-double'}`}></i>
            </div>
            <div>
              <div className="text-[10px] font-black text-blue-600 uppercase tracking-[0.2em]">
                {status === RecorderStatus.IDLE ? 'Ready' : status === RecorderStatus.RECORDING ? 'AI Capturing' : 'Paused'}
              </div>
              <h2 className="text-2xl font-black text-slate-800 tracking-tight">{currentData?.title}</h2>
            </div>
          </div>
          
          <div className="flex items-center gap-3">
            <button onClick={copyAllTranscript} disabled={!currentData?.segments?.length} className={`h-11 px-5 rounded-2xl text-xs font-black transition-all flex items-center gap-2 border-2 ${globalCopySuccess ? 'bg-green-500 border-green-500 text-white' : 'bg-white text-slate-600 border-slate-100 hover:border-slate-300'}`}>
              <i className={`fas ${globalCopySuccess ? 'fa-check' : 'fa-paste'}`}></i>
              {globalCopySuccess ? 'Copied' : 'Copy All'}
            </button>
            <button onClick={() => setIsBilingual(!isBilingual)} className={`h-11 px-5 rounded-2xl text-xs font-black transition-all border-2 ${isBilingual ? 'bg-blue-600 border-blue-600 text-white' : 'bg-white text-slate-600 border-slate-100'}`}>
              Bilingual {isBilingual ? 'ON' : 'OFF'}
            </button>
            <button onClick={performDeepAnalysis} disabled={isAnalyzing || !currentData?.segments?.length} className="h-11 px-6 bg-slate-900 text-white rounded-2xl text-xs font-black flex items-center gap-2 hover:bg-slate-800 transition-all shadow-lg">
              {isAnalyzing ? <i className="fas fa-spinner fa-spin"></i> : <i className="fas fa-sparkles"></i>}
              Insight
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-hidden p-8 flex gap-8">
          <TranscriptionList 
            segments={currentData?.segments || []} 
            currentText={status === RecorderStatus.RECORDING ? currentTranscription : undefined} 
            isBilingual={isBilingual}
          />
          {analysisResult && (
            <div className="w-[450px] bg-slate-50 border-l border-slate-200 flex flex-col animate-slideInRight shadow-3xl rounded-l-[40px] overflow-hidden">
              <div className="p-6 bg-slate-900 text-white flex justify-between items-center">
                <span className="font-black text-[11px] uppercase tracking-widest flex items-center gap-2"><i className="fas fa-brain"></i> AI Summary</span>
                <button onClick={() => setAnalysisResult(null)}><i className="fas fa-times"></i></button>
              </div>
              <div className="flex-1 overflow-y-auto p-8 custom-scrollbar bg-white/50 text-slate-700 leading-relaxed font-medium text-sm whitespace-pre-wrap">
                {analysisResult}
              </div>
            </div>
          )}
        </div>

        <div className="absolute bottom-10 left-1/2 -translate-x-1/2 w-full max-w-lg px-8 z-30">
          <div className="bg-white/95 backdrop-blur-3xl p-6 rounded-[40px] border border-white/50 shadow-2xl flex flex-col gap-5">
            <Waveform isRecording={status === RecorderStatus.RECORDING} audioStream={audioStream} />
            <div className="flex justify-center items-center gap-6">
              {status === RecorderStatus.IDLE ? (
                <button onClick={startRecording} className="w-20 h-20 bg-blue-600 text-white rounded-3xl shadow-xl hover:scale-105 active:scale-95 transition-all flex items-center justify-center">
                  <i className="fas fa-microphone text-2xl"></i>
                </button>
              ) : (
                <div className="flex items-center gap-6">
                  <div className="text-2xl font-black font-mono text-slate-800 bg-slate-100/50 px-6 py-3 rounded-2xl border border-slate-200 min-w-[120px] text-center">
                    {Math.floor(elapsedTime / 60).toString().padStart(2, '0')}:{(elapsedTime % 60).toString().padStart(2, '0')}
                  </div>
                  {status === RecorderStatus.RECORDING ? (
                    <button onClick={pauseRecording} className="w-16 h-16 bg-amber-500 text-white rounded-3xl shadow-xl hover:scale-105 transition-all flex items-center justify-center">
                      <i className="fas fa-pause text-xl"></i>
                    </button>
                  ) : (
                    <button onClick={resumeRecording} className="w-16 h-16 bg-green-500 text-white rounded-3xl shadow-xl hover:scale-105 transition-all flex items-center justify-center">
                      <i className="fas fa-play text-xl ml-1"></i>
                    </button>
                  )}
                  <button onClick={stopRecording} className="w-16 h-16 bg-red-500 text-white rounded-3xl shadow-xl hover:scale-105 transition-all flex items-center justify-center">
                     <div className="w-5 h-5 bg-white rounded-sm"></div>
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
