import Link from "next/link";
import Image from "next/image";
import logo from "@/assets/logo.png"

export default function Footer() {
    return (
      <footer className="bg-ink px-4 pb-8 pt-10 text-paper-2 md:px-8 md:pb-8 md:pt-16">
        <div className="mb-8 grid grid-cols-2 gap-8 md:mb-12 md:grid-cols-4 md:gap-10">
          {/* Brand column */}
           <div className="col-span-2 md:col-span-1">
              <Image
                src={logo}
                alt="QUHÁ logo"
                width={120}        
                height={28}
                priority          
                className="h-5 w-auto md:h-6" 
              />
              <p className="m-0 max-w-[240px] font-display text-[12px] leading-relaxed mt-2 text-muted-2 md:text-[13px]">
                Raw materials, hard edges. Small-batch drops, no restocks.
              </p>
            </div> 

            {/* Shop column */}
            <div>
              <div className="mb-3 font-mono text-[10px] tracking-[0.08em] text-muted-2 md:mb-4 md:text-[11px]">
                SHOP
              </div>
              <div className="flex flex-col gap-2.5">
                <Link href="/shop" className="font-display text-[13px] hover:opacity-60 text-paper-2">SHOP ALL</Link>
                <Link href="/shop?category=jackets" className="font-display text-[13px] hover:opacity-60 text-paper-2">JACKETS</Link>
                <Link href="/shop?category=jewelry" className="font-display text-[13px] hover:opacity-60 text-paper-2">JEWELRY</Link>
                <Link href="/shop?category=accessories" className="font-display text-[13px] hover:opacity-60 text-paper-2">ACCESSORIES</Link>
                <Link href="/shop?category=off-duties" className="font-display text-[13px] text-paper-2 hover:opacity-60">OFF-DUTIES</Link>
              </div>
            </div>

           {/* Help column */}
           <div>
              <div className="mb-3 font-mono text-[10px] tracking-[0.08em] text-muted-2 md:mb-4 md:text-[11px]">
                HELP
              </div>
              <div className="flex flex-col gap-2.5">
                <a href="#" className="font-display text-[13px] text-paper-2 hover:opacity-60">SHIPPING &amp; RETURNS</a>
                <a href="#" className="font-display text-[13px] text-paper-2 hover:opacity-60">SIZE GUIDE</a>
                <a href="#" className="font-display text-[13px] text-paper-2 hover:opacity-60">CONTACT</a>
              </div>
           </div> 

           {/* About column */}
           <div>
              <div className="mb-3 font-mono text-[10px] tracking-[0.08em] text-muted-2 md:mb-4 md:text-[11px]">
                BRAND
              </div>
              <div className="flex flex-col gap-2.5">
                <Link href="/about" className="font-display text-[13px] text-paper-2 hover:opacity-60">ABOUT</Link>
              </div>
           </div> 
        </div>

        {/* Socials column */}
        <div>
          <div className="mb-3 font-mono text-[10px] tracking-[0.08em] text-muted-2 md:mb-4 md:text-[11px]">
            FOLLOW
          </div>
          <div className="flex flex-col gap-2.5">
            <a
              href="https://instagram.com"
              target="_blank"
              rel="noopener noreferrer"
              className="font-display text-[13px] text-paper-2 hover:opacity-60"
            >
              INSTAGRAM
            </a>
            <a
              href="https://tiktok.com"
              target="_blank"
              rel="noopener noreferrer"
              className="font-display text-[13px] text-paper-2 hover:opacity-60"
            >
              TIKTOK
            </a>
            <a
              href="https://twitter.com"
              target="_blank"
              rel="noopener noreferrer"
              className="font-display text-[13px] text-paper-2 hover:opacity-60"
            >
              X
            </a>
          </div>
        </div>

        {/* Bottom bar */}
        <div className="flex flex-wrap justify-between gap-4 border-t border-[#2b2b2b] pt-6 font-mono text-[11px] tracking-[0.04em] text-muted">
          <span>© {new Date().getFullYear()} QUHÁ</span>
          <span>© [ LOUD IN SILENCE ]</span>
        </div>
      </footer>  
    )
}