const COLORS = ['#ecd18a', '#d7b761', '#b8922a', '#4ade80', '#ffffff'];

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export const Confetti = ({ count = 40 }) => {
  if (prefersReducedMotion()) return null;

  const pieces = Array.from({ length: count }, (_, i) => {
    const left = Math.random() * 100;
    const delay = Math.random() * 0.4;
    const duration = 1.2 + Math.random() * 0.9;
    const color = COLORS[i % COLORS.length];
    const rotate = Math.random() * 360;
    return { left, delay, duration, color, rotate, id: i };
  });

  return (
    <div className="confetti-layer" aria-hidden="true">
      {pieces.map((p) => (
        <i
          key={p.id}
          style={{
            left: `${p.left}%`,
            background: p.color,
            transform: `rotateZ(${p.rotate}deg)`,
            animationDelay: `${p.delay}s`,
            animationDuration: `${p.duration}s`,
          }}
        />
      ))}
    </div>
  );
};

export default Confetti;
