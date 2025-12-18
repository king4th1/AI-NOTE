
export interface TranscriptionSegment {
  id: string;
  startTime: number;
  endTime: number;
  text: string;
  translatedText?: string;
  isFinal: boolean;
}

export interface KnowledgeFile {
  id: string;
  name: string;
  content: string;
}

export interface RecordingSession {
  id: string;
  title: string;
  date: string;
  segments: TranscriptionSegment[];
  duration: number;
  analysis?: string;
}

export enum RecorderStatus {
  IDLE = 'IDLE',
  RECORDING = 'RECORDING',
  PAUSED = 'PAUSED',
  ERROR = 'ERROR'
}
