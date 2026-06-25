import { motion, useReducedMotion } from "framer-motion";
import { scoreColor } from "../score";

interface Props {
  score: number;
  size?: number;
}

/** The signature circular score dial (§8): ring fills to the score, colored
 * by the shared score scale. */
export default function ScoreBadge({ score, size = 52 }: Props) {
  const reduced = useReducedMotion();
  const color = scoreColor(score);
  const stroke = size >= 48 ? 4.5 : 3.5;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const filled = c * (score / 100);

  return (
    <div
      className="score-badge"
      style={{ width: size, height: size }}
      role="img"
      aria-label={`Localize score ${score} out of 100`}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="#fff"
          stroke="rgba(28,27,26,0.08)"
          strokeWidth={stroke}
        />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          initial={{ strokeDashoffset: reduced ? c - filled : c }}
          animate={{ strokeDashoffset: c - filled }}
          transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1], delay: 0.15 }}
        />
      </svg>
      <span className="score-badge-number" style={{ color, fontSize: size * 0.34 }}>
        {score}
      </span>
    </div>
  );
}
