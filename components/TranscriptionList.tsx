
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
      className="flex-1 overflow-y-auto p-4 lg:p-10 space-y-8 lg:space-y-12 bg-white rounded-[30px] lg:rounded-[40px] shadow-inner border border-slate-100/50 custom-scrollbar relative select-text"
    >
      {segments.length === 0 && !currentText && (
        <div className="flex flex-col items-center justify-center h-full text-slate-300 space-y-6 animate-fadeIn">
          <div className="w-16 h-16 lg:w-24 lg:h-24 bg-slate-50/50 rounded-2xl lg:rounded-3xl flex items-center justify-center text-3xl lg:text-5xl shadow-inner border border-slate-100">
            <i className="fas fa-microphone-lines text-slate-100"></i>
          </div>
          <p className="text-base lg:text-xl font-black text-slate-300">Awaiting audio input...</p>
        </div>
      )}

      {segments.map((segment) => (
        <div key={segment.id} className="group flex space-x-4 lg:space-x-8 animate-fadeIn relative">
          <div className="w-12 lg:w-16 flex-shrink-0 pt-2 text-[9px] lg:text-[11px] font-black text-slate-200 group-hover:text-blue-400 transition-colors uppercase tracking-widest font-mono">
            {formatTime(segment.startTime)}
          </div>
          <div className="flex-1 pb-6 lg:pb-10 border-b border-slate-50 group-last:border-0 relative min-w-0">
            <div className="flex justify-between items-start gap-4">
              <div className="flex-1 space-y-3 lg:space-y-4 min-w-0">
                <div className="relative">
                  <p className="text-slate-800 leading-relaxed text-base lg:text-xl font-bold tracking-tight break-words">
                    {segment.text}
                  </p>
                  <span className="absolute -top-5 left-0 text-[8px] font-black text-blue-500/40 uppercase tracking-widest">
                    <i className="fas fa-magic mr-1"></i> AI Polished
                  </span>
                </div>

                {isBilingual && segment.translatedText && (
                  <div className="bg-blue-50/30 p-3 lg:p-5 rounded-2xl lg:rounded-3xl border border-blue-100/30 animate-fadeIn shadow-sm">
                    <p className="text-blue-600/90 leading-relaxed text-sm lg:text-lg font-bold italic break-words">
                      {segment.translatedText}
                    </p>
                  </div>
                )}
                
                {isBilingual && !segment.translatedText && (
                  <div className="flex items-center gap-2 lg:gap-3 px-3 lg:px-4 py-1.5 lg:py-2 bg-slate-50 rounded-xl lg:rounded-2xl w-fit">
                    <div className="flex gap-1">
                       <div className="w-1 h-1 bg-blue-300 rounded-full animate-bounce"></div>
                       <div className="w-1 h-1 bg-blue-300 rounded-full animate-bounce [animation-delay:0.2s]"></div>
                    </div>
                    <span className="text-[8px] lg:text-[10px] text-slate-400 font-black uppercase tracking-widest whitespace-nowrap">
                      Translating...
                    </span>
                  </div>
                )}
              </div>
              <button 
                onClick={() => copyToClipboard(segment.id, segment.text, segment.translatedText)}
                className={`w-8 h-8 lg:w-10 lg:h-10 flex-shrink-0 flex items-center justify-center rounded-lg lg:rounded-xl transition-all border-2 ${copiedId === segment.id ? 'bg-green-500 border-green-500 text-white shadow-lg' : 'bg-white text-slate-300 border-slate-100 lg:opacity-0 lg:group-hover:opacity-100 hover:border-blue-200 hover:text-blue-600 shadow-sm'}`}
              >
                <i className={`fas ${copiedId === segment.id ? 'fa-check' : 'fa-copy'} text-xs lg:text-sm`}></i>
              </button>
            </div>
          </div>
        </div>
      ))}

      {currentText && (
        <div className="flex space-x-4 lg:space-x-8 opacity-40 pb-24 animate-pulse">
          <div className="w-12 lg:w-16 flex-shrink-0 pt-2 text-[9px] lg:text-[11px] font-black text-blue-600">LIVE</div>
          <div className="flex-1 min-w-0">
            <p className="text-slate-900 leading-relaxed text-base lg:text-xl font-black italic tracking-tight break-words">{currentText}</p>
            <div className="mt-3 flex gap-2 items-center">
              <div className="w-1 h-1 lg:w-1.5 lg:h-1.5 bg-blue-500 rounded-full animate-bounce"></div>
              <div className="w-1 h-1 lg:w-1.5 lg:h-1.5 bg-blue-500 rounded-full animate-bounce [animation-delay:0.1s]"></div>
              <div className="w-1 h-1 lg:w-1.5 lg:h-1.5 bg-blue-500 rounded-full animate-bounce [animation-delay:0.2s]"></div>
              <span className="text-[8px] lg:text-[9px] font-black text-blue-500/60 uppercase tracking-widest ml-2">Capturing...</span>
            </div>
          </div>
        </div>
      )}
      <div className="h-40 lg:h-56"></div>
    </div>
  );
};

export default TranscriptionList;
