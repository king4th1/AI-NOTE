
import React, { useEffect, useRef } from 'react';

interface WaveformProps {
  isRecording: boolean;
  audioStream: MediaStream | null;
}

const Waveform: React.FC<WaveformProps> = ({ isRecording, audioStream }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!isRecording || !audioStream || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const audioCtx = new AudioContext();
    const source = audioCtx.createMediaStreamSource(audioStream);
    const analyzer = audioCtx.createAnalyser();
    analyzer.fftSize = 256;
    source.connect(analyzer);

    const bufferLength = analyzer.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    let animationId: number;

    const draw = () => {
      animationId = requestAnimationFrame(draw);
      analyzer.getByteFrequencyData(dataArray);

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const barWidth = (canvas.width / bufferLength) * 2.5;
      let barHeight;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        barHeight = dataArray[i] / 2;
        ctx.fillStyle = `rgb(59, 130, 246)`;
        ctx.fillRect(x, canvas.height - barHeight, barWidth, barHeight);
        x += barWidth + 1;
      }
    };

    draw();

    return () => {
      cancelAnimationFrame(animationId);
      audioCtx.close();
    };
  }, [isRecording, audioStream]);

  return (
    <div className="w-full h-12 bg-slate-50 rounded-lg overflow-hidden flex items-center justify-center">
      {!audioStream ? (
        <span className="text-slate-400 text-[10px] font-black uppercase tracking-widest">Ready to Capture</span>
      ) : !isRecording ? (
        <span className="text-amber-500 text-[10px] font-black uppercase tracking-widest flex items-center gap-2">
          <i className="fas fa-pause-circle"></i> Recording Paused
        </span>
      ) : (
        <canvas ref={canvasRef} className="w-full h-full" width={600} height={100} />
      )}
    </div>
  );
};

export default Waveform;
