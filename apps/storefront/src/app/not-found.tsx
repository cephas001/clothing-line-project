import Link from "next/link";



export default function NotFound() {
  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center gap-6 px-4 text-center md:px-8">
      <div className="font-mono text-[11px] tracking-[0.1em] text-muted md:text-[12px]">
        [ 404 ]
      </div>
      <h1 className="m-0 font-display text-[clamp(40px,9vw,96px)] font-black uppercase leading-[0.95]">
        LOST THE THREAD.
      </h1>
      <Link
        href="/"
        className="inline-block border border-ink bg-transparent px-6 py-3.5 font-mono text-[11px] uppercase tracking-[0.1em] text-ink hover:!bg-ink hover:!text-paper-2 hover:!opacity-100 md:px-8 md:py-4 md:text-[12px]"
      >
        BACK TO HOME
      </Link>
    </div>
  );
}