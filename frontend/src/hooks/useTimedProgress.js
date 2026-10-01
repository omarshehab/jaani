import { useEffect, useMemo, useRef, useState } from 'react';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const toEtaText = (seconds) => {
  if (seconds <= 0) return 'Almost done';
  if (seconds < 60) return `${Math.ceil(seconds)}s left`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.ceil(seconds % 60);
  return `${mins}m ${secs}s left`;
};

const useTimedProgress = (active, expectedSeconds = 20) => {
  const startedAtRef = useRef(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!active) {
      startedAtRef.current = null;
      setTick(0);
      return undefined;
    }

    if (!startedAtRef.current) startedAtRef.current = Date.now();

    const interval = setInterval(() => {
      setTick((prev) => prev + 1);
    }, 250);

    return () => clearInterval(interval);
  }, [active]);

  return useMemo(() => {
    if (!active || !startedAtRef.current) {
      return {
        progress: 0,
        elapsedSeconds: 0,
        remainingSeconds: expectedSeconds,
        etaText: toEtaText(expectedSeconds),
      };
    }

    const elapsedMs = Date.now() - startedAtRef.current;
    const elapsedSeconds = elapsedMs / 1000;
    const rawProgress = (elapsedSeconds / expectedSeconds) * 100;
    const progress = clamp(rawProgress, 2, 97);
    const remainingSeconds = Math.max(0, expectedSeconds - elapsedSeconds);

    return {
      progress,
      elapsedSeconds,
      remainingSeconds,
      etaText: toEtaText(remainingSeconds),
      _tick: tick,
    };
  }, [active, expectedSeconds, tick]);
};

export default useTimedProgress;
