const MESSAGE = "QUHÁ — NEW SEASON — SHOP THE DROP — ";

export default function Marquee() {
  const strip = MESSAGE.repeat(6);

  return (
    <div className="relative flex h-11 items-center overflow-hidden border-y border-ink bg-paper-2">
      <div className="flex w-max animate-marquee whitespace-nowrap hover:[animation-play-state:paused]">
        <span className="pr-12 font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-ink md:text-[13px]">
          {strip}
        </span>
        <span
          aria-hidden="true"
          className="pr-12 font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-ink md:text-[13px]"
        >
          {strip}
        </span>
      </div>
    </div>
  );
}