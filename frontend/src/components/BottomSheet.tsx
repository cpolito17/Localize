import { motion, useAnimationControls, useReducedMotion } from "framer-motion";
import { ReactNode, useEffect, useRef, useState } from "react";

interface Props {
  children: ReactNode;
}

type Snap = "peek" | "half" | "full";

/** Mobile results sheet (§7.3): peeks above the map showing the top result,
 * drags up to expand, spring-animated, with a grab handle. */
export default function BottomSheet({ children }: Props) {
  const [snap, setSnap] = useState<Snap>("peek");
  const controls = useAnimationControls();
  const reduced = useReducedMotion();
  const sheetRef = useRef<HTMLDivElement>(null);

  const snapY = (s: Snap): number => {
    const vh = window.innerHeight;
    if (s === "full") return 84;
    if (s === "half") return Math.round(vh * 0.52);
    return Math.max(vh - 232, 84);
  };

  useEffect(() => {
    controls.start({
      y: snapY(snap),
      transition: reduced
        ? { duration: 0 }
        : { type: "spring", stiffness: 320, damping: 32 },
    });
  }, [snap, controls, reduced]);

  useEffect(() => {
    const onResize = () => controls.set({ y: snapY(snap) });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [snap, controls]);

  return (
    <motion.div
      ref={sheetRef}
      className={`sheet sheet-${snap}`}
      initial={{ y: window.innerHeight }}
      animate={controls}
      drag="y"
      dragConstraints={{ top: snapY("full"), bottom: snapY("peek") }}
      dragElastic={0.08}
      dragMomentum={false}
      onDragEnd={(_, info) => {
        const y = snapY(snap) + info.offset.y;
        const candidates: Snap[] = ["full", "half", "peek"];
        let best: Snap = "peek";
        let bestDist = Infinity;
        for (const c of candidates) {
          // Velocity biases toward the direction of the fling.
          const dist = Math.abs(snapY(c) - (y + info.velocity.y * 0.12));
          if (dist < bestDist) {
            bestDist = dist;
            best = c;
          }
        }
        setSnap(best);
        controls.start({
          y: snapY(best),
          transition: reduced
            ? { duration: 0 }
            : { type: "spring", stiffness: 320, damping: 32 },
        });
      }}
    >
      <div
        className="sheet-handle-area"
        onClick={() => setSnap(snap === "peek" ? "half" : snap === "half" ? "full" : "peek")}
      >
        <div className="sheet-handle" />
      </div>
      <div className={`sheet-content${snap === "full" ? " sheet-content-scroll" : ""}`}>
        {children}
      </div>
    </motion.div>
  );
}
