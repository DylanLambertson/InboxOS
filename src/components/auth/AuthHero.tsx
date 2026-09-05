import { useEffect, useState } from "react";
import { CalendarClock, CheckCheck, Inbox, ShieldCheck } from "lucide-react";
import { useBrand } from "@/lib/brand";

const FEATURES = [
  { icon: Inbox, text: "Every team inbox in one place" },
  { icon: CalendarClock, text: "Schedule, undo and track every send" },
  { icon: ShieldCheck, text: "Two-factor security built in" },
];

const ROTATING = ["answered faster.", "never missed.", "beautifully organized.", "always on brand."];

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduced(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
}

/** Envelope with an orbiting ring, echoing the product banner. Pure SVG + CSS, no scripts in the art. */
function OrbitEnvelope({ animate }: { animate: boolean }) {
  const orbit = "M 40 170 A 190 62 -18 1 1 420 170 A 190 62 -18 1 1 40 170";
  return (
    <svg viewBox="0 0 460 340" className="w-full max-w-[440px] overflow-visible" aria-hidden>
      <defs>
        <linearGradient id="env-body" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fafaf9" />
          <stop offset="1" stopColor="#d6d3d1" />
        </linearGradient>
        <linearGradient id="env-flap" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#e7e5e4" />
        </linearGradient>
        <radialGradient id="sphere" cx="35%" cy="30%" r="70%">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.6" stopColor="#d4d4d8" />
          <stop offset="1" stopColor="#71717a" />
        </radialGradient>
        <filter id="env-shadow" x="-30%" y="-30%" width="160%" height="170%">
          <feDropShadow dx="0" dy="22" stdDeviation="18" floodColor="#000" floodOpacity="0.55" />
        </filter>
      </defs>

      {/* back half of the orbit (behind the envelope) */}
      <path d={orbit} fill="none" stroke="white" strokeOpacity="0.22" strokeWidth="1.2" />

      <g className={animate ? "io-bob" : undefined} style={{ transformOrigin: "230px 170px" }}>
        <g transform="rotate(-14 230 170)" filter="url(#env-shadow)">
          <rect x="120" y="95" width="220" height="150" rx="16" fill="url(#env-body)" />
          <path d="M126 104 L230 182 L334 104" fill="none" stroke="#a8a29e" strokeOpacity="0.5" strokeWidth="1.5" strokeLinejoin="round" />
          <path d="M126 238 L205 170 M334 238 L255 170" stroke="#a8a29e" strokeOpacity="0.35" strokeWidth="1.5" />
          <path d="M122 100 Q230 205 338 100 Q336 96 330 96 L130 96 Q124 96 122 100 Z" fill="url(#env-flap)" />
        </g>
      </g>

      {/* orbiting spheres */}
      {[0, 1].map((i) =>
        animate ? (
          <circle key={i} r={i ? 7 : 11} fill="url(#sphere)">
            <animateMotion dur="14s" repeatCount="indefinite" path={orbit} begin={i ? "-7s" : "0s"} />
          </circle>
        ) : (
          <circle key={i} r={i ? 7 : 11} cx={i ? 70 : 400} cy={i ? 232 : 96} fill="url(#sphere)" />
        ),
      )}
    </svg>
  );
}

function NotificationCard({ className, style, icon, title, body }: { className?: string; style?: React.CSSProperties; icon: React.ReactNode; title: string; body: string }) {
  return (
    <div
      className={`io-card absolute flex w-60 items-start gap-3 rounded-2xl border border-white/10 bg-white/[0.07] p-3 text-left shadow-2xl backdrop-blur-md ${className ?? ""}`}
      style={style}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-white/10 text-white">{icon}</span>
      <span className="min-w-0">
        <span className="block truncate text-[13px] font-medium text-white">{title}</span>
        <span className="block truncate text-xs text-white/60">{body}</span>
      </span>
    </div>
  );
}

export function AuthHero() {
  const brand = useBrand();
  const reduced = usePrefersReducedMotion();
  const [word, setWord] = useState(0);

  useEffect(() => {
    if (reduced) return;
    const t = setInterval(() => setWord((w) => (w + 1) % ROTATING.length), 2600);
    return () => clearInterval(t);
  }, [reduced]);

  return (
    <div className="io-hero relative flex h-full flex-col overflow-hidden bg-[#0a0a0b] text-white">
      {/* drifting brand-colored glows */}
      <div className="io-glow io-glow-a" style={{ background: brand.accentColor }} />
      <div className="io-glow io-glow-b" style={{ background: brand.accentColor }} />
      <div className="io-dots absolute inset-0" />

      <div className="relative z-10 flex items-center gap-2.5 p-8 lg:p-10">
        {brand.logoUrl ? (
          <img src={brand.logoUrl} alt="" className="size-8 rounded-lg object-contain" />
        ) : (
          <span className="flex size-8 items-center justify-center rounded-lg bg-white text-xs font-bold text-black">{brand.monogram}</span>
        )}
        <span className="text-sm font-semibold tracking-tight">{brand.companyName}</span>
      </div>

      <div className="relative z-10 flex flex-1 items-center justify-center px-8">
        <div className="relative w-full max-w-[460px]">
          <OrbitEnvelope animate={!reduced} />
          <NotificationCard
            className="-top-2 left-0 max-xl:hidden"
            style={{ animationDelay: "0.3s" }}
            icon={<Inbox className="size-4" />}
            title="Sarah Chen"
            body="Re: Q4 campaign kickoff — Thursday works!"
          />
          <NotificationCard
            className="right-0 bottom-6 max-xl:hidden"
            style={{ animationDelay: "0.9s" }}
            icon={<CheckCheck className="size-4" />}
            title="Delivered"
            body="Proposal sent to 3 recipients"
          />
        </div>
      </div>

      <div className="relative z-10 p-8 lg:p-10">
        <h2 className="text-3xl leading-tight font-semibold tracking-tight lg:text-[40px]">
          Every email,
          <br />
          <span key={word} className="io-word inline-block" style={{ color: `color-mix(in oklab, ${brand.accentColor} 55%, white)` }}>
            {ROTATING[word]}
          </span>
        </h2>
        <ul className="mt-6 space-y-2.5">
          {FEATURES.map((f, i) => (
            <li key={f.text} className="io-rise flex items-center gap-2.5 text-sm text-white/70" style={{ animationDelay: `${0.2 + i * 0.12}s` }}>
              <f.icon className="size-4 text-white/50" />
              {f.text}
            </li>
          ))}
        </ul>
        <p className="mt-8 text-xs text-white/35">{brand.productName} · {brand.footerText}</p>
      </div>
    </div>
  );
}
