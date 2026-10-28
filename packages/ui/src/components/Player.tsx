import { useEffect, useState } from "react";

export const SPEEDS = [0.5, 1, 2, 4];

/** Auto-advances a stepper: calls next() once per beat while playing; next() returns false at the end. */
export function usePlayer(position: number | null, next: () => boolean) {
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  useEffect(() => {
    if (!playing) return;
    const t = setTimeout(() => {
      if (!next()) setPlaying(false);
    }, 1400 / speed);
    return () => clearTimeout(t);
  }, [playing, position, speed, next]);
  /** Seconds a packet takes to travel one edge: most of a beat, so it lands before the next step. */
  const dur = Math.min(1.1, 1.1 / speed);
  return { playing, setPlaying, speed, setSpeed, dur };
}

export function PlayerBar({ playing, speed, setSpeed, onToggle, label = "Play data flow" }: {
  playing: boolean;
  speed: number;
  setSpeed: (s: number) => void;
  onToggle: () => void;
  label?: string;
}) {
  return (
    <div className="fl-player">
      <button className={playing ? "is-on" : undefined} onClick={onToggle} title="Play / pause (Space)">
        {playing ? "⏸ Pause" : `▶ ${label}`}
      </button>
      <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} title="Playback speed">
        {SPEEDS.map((s) => <option key={s} value={s}>{s}×</option>)}
      </select>
    </div>
  );
}
