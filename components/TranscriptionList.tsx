
import React, { useEffect, useRef, useState } from 'react';
import { TranscriptionSegment } from '../types';

interface TranscriptionListProps {
  segments: TranscriptionSegment[];
  currentText?: string;
  isBilingual?: boolean;
}

const TranscriptionList: React.FC<TranscriptionListProps> = ({ segments, currentText, isBilingual }) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const lastSegmentCount = useRef(0);

  useEffect(() => {
    if (scrollRef.current) {
      // Smoother scroll to bottom when new segments arrive
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: 'smooth'
      });
    }
    lastSegmentCount.current = segments.length;
  }, [segments, currentText]);

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const copyToClipboard = (id: string, text: string, translated?: string) => {
    const content = (isBilingual && translated) ? `${text}\n${translated}` : text;
    navigator.clipboard.writeText(content);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  return (
    <div 
      ref={scrollRef}
      className="flex-1 overflow-y-auto p-10 space-y-12 bg-white rounded-[40px] shadow-inner border border-slate-100/50 custom-scrollbar relative select-text"
    >
      {segments.length === 0 && !currentText && (
        <div className="flex flex-col items-center justify-center h-full text-slate-300 space-y-6 animate-fadeIn">
          <div className="w-24 h-24 bg-slate-50/50 rounded-3xl flex items-center justify-center text-5xl shadow-inner border border-slate-100">
            <i className="fas fa-microphone-lines text-slate-100"></i>
          </div>
          <p className="text-xl font-black text-slate-300">Awaiting audio input...</p>
        </div>
      )}

      {segments.map((segment) => (
        <div key={segment.id} className="group flex space-x-8 animate-fadeIn relative">
          <div className="w-16 flex-shrink-0 pt-2 text-[11px] font-black text-slate-200 group-hover:text-blue-400 transition-colors uppercase tracking-widest font-mono">
            {formatTime(segment.startTime)}
          </div>
          <div className="flex-1 pb-10 border-b border-slate-50 group-last:border-0 relative">
            <div className="flex justify-between items-start gap-4">
              <div className="flex-1 space-y-4">
                <div className="relative">
                  <p className="text-slate-800 leading-relaxed text-xl font-bold tracking-tight transition-all duration-500">
                    {segment.text}
                  </p>
                  {/* Subtle indicator for Polished AI text */}
                  <span className="absolute -top-6 left-0 text-[9px] font-black text-blue-500/40 uppercase tracking-widest">
                    <i className="fas fa-magic mr-1"></i> AI Polished
                  </span>
                </div>

                {isBilingual && segment.translatedText && (
                  <div className="bg-blue-50/30 p-5 rounded-3xl border border-blue-100/30 animate-fadeIn shadow-sm">
                    <p className="text-blue-600/90 leading-relaxed text-lg font-bold italic">
                      {segment.translatedText}
                    </p>
                  </div>
                )}
                
                {isBilingual && !segment.translatedText && (
                  <div className="flex items-center gap-3 px-4 py-2 bg-slate-50 rounded-2xl w-fit">
                    <div className="flex gap-1.5">
                       <div className="w-1.5 h-1.5 bg-blue-300 rounded-full animate-bounce"></div>
                       <div className="w-1.5 h-1.5 bg-blue-300 rounded-full animate-bounce [animation-delay:0.2s]"></div>
                    </div>
                    <span className="text-[10px] text-slate-400 font-black uppercase tracking-widest">
                      AI Translating...
                    </span>
                  </div>
                )}
              </div>
              <button 
                onClick={() => copyToClipboard(segment.id, segment.text, segment.translatedText)}
                className={`w-10 h-10 flex-shrink-0 flex items-center justify-center rounded-xl transition-all border-2 ${copiedId === segment.id ? 'bg-green-500 border-green-500 text-white shadow-lg' : 'bg-white text-slate-300 border-slate-100 opacity-0 group-hover:opacity-100 hover:border-blue-200 hover:text-blue-600 shadow-sm'}`}
              >
                <i className={`fas ${copiedId === segment.id ? 'fa-check' : 'fa-copy'}`}></i>
              </button>
            </div>
          </div>
        </div>
      ))}

      {currentText && (
        <div className="flex space-x-8 opacity-40 pb-20 animate-pulse">
          <div className="w-16 flex-shrink-0 pt-2 text-[11px] font-black text-blue-600">LIVE</div>
          <div className="flex-1">
            <p className="text-slate-900 leading-relaxed text-xl font-black italic tracking-tight">{currentText}</p>
            <div className="mt-4 flex gap-2 items-center">
              <div className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-bounce"></div>
              <div className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-bounce [animation-delay:0.1s]"></div>
              <div className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-bounce [animation-delay:0.2s]"></div>
              <span className="text-[9px] font-black text-blue-500/60 uppercase tracking-widest ml-2">Capturing Stream</span>
            </div>
          </div>
        </div>
      )}
      <div className="h-56"></div>
    </div>
  );
};

export default TranscriptionList;
