"use client";
import Link from "next/link";
import Image from "next/image";
import Logo from "@/assets/logo.png"
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useCart } from "@/context/CartContext";
import { useCurrency } from "@/context/CurrencyContext";
import { useWishlist } from "@/context/WishlistContext";
import { Menu, Search, ShoppingBag, X, Heart } from "lucide-react";
// A list of supported currencies.
const CURRENCIES = [
  { code: "NGN", label: "🇳🇬 NGN" },
  { code: "USD", label: "🇺🇸 USD" },
  { code: "GBP", label: "🇬🇧 GBP" },
  { code: "CAD", label: "🇨🇦 CAD" },
] as const;

export default function Header() {
    const router = useRouter();
    // Gets the number of items in the cart (count) and the function to open/close the cart (toggleCart)
    const { count, toggleCart} = useCart();
    // Gets the current selected currency and the function to change it
    const { currency, setCurrency } = useCurrency();
    // Gets the number of items in the wishlist
    const { items } = useWishlist();
    // Controls whether the search bar is open or closed
    const [searchOpen, setSearchOpen] = useState(false);
    // Stores what the user is typing in the search input
    const [query, setQuery] = useState("");
    // Controls whether the mobile menu is open or closed
    const [menuOpen, setMenuOpen] = useState(false);

    const onSearch = (e: React.FormEvent) => {
        e.preventDefault();
        const q = query.trim();
        // If the user typed something, go to /shop?q=whatever-they-typed
        // If the search is empty, just go to /shop
        // encodeURIComponent(q) makes the search text safe to put in a URL.
        router.push(q ? `/shop?q=${encodeURIComponent(q)}` : "/shop");
        // Clean up after searching
        setSearchOpen(false);
        setMenuOpen(false);
        setQuery("");
    }

    useEffect(() => {
        document.body.style.overflow = menuOpen ? "hidden" : "";
        return () => { document.body.style.overflow = "";};
    }, [menuOpen]);

    // Tiny helper function in the mobile menu
    //  To close when tapped or otherwise 
    // you'd navigate but the menu would stay open
    const closeMenuAnd = (fn?: () => void) => () => {
        setMenuOpen(false);
        fn?.();
    };

    return (
        <>
         <header className="fixed inset-x-0 top-0 z-[100] flex h-14 items-center justify-between border-b border-[#2b2b2b] bg-ink px-4 md:h-16 md:px-8">
            <button
              type="button"
              onClick={() => setMenuOpen(true)}
              aria-label="Open Menu"
              aria-expanded={menuOpen}
              className="flex cursor-pointer border-none bg-transparent p-1 text-paper-2 md:hidden"
            >
               <Menu size={20} strokeWidth={1.5} />
            </button>  

            <nav className="hidden items-center gap-7 md:flex">
                <Link 
                   className="font-mono text-[12px] hover:opacity-60 tracking-[0.08em] uppercase text-paper-2"
                   href="/shop"
                >
                    SHOP ALL
                </Link>
                <Link 
                   className="font-mono text-[12px] hover:opacity-60 tracking-[0.08em] uppercase text-paper-2"
                   href="/new"
                >
                    NEW ARRIVALS
                </Link>
            </nav> 

        {/* TO BE REPLACED WITH THE REAL LOGO */}
             <Link 
                className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 font-display text-[15px] font-extrabold tracking-[0.1em] text-paper-2 hover:opacity-60 md:text-[20px] md:tracking-[0.14em]"
                href="/"
              >
                <Image
                  src={Logo}
                  alt="QUHÁ logo"
                  width={120}        
                  height={28}
                  priority          
                  className="h-5 w-auto md:h-6" 
                />

              </Link>
              <div className="flex items-center gap-4 md:gap-5">
                <select
                   aria-label="Currency" 
                   className="hidden cursor-pointer borderborder-[#3a3a3a] bg-transparent px-2 py-1.5 font-mono text-[11px] uppercase tracking-[0.05em] text-paper-2 md:block"
                   value={currency.toUpperCase()}
                   onChange={(e) => setCurrency(e.target.value.toLowerCase())}
                >
                    {CURRENCIES.map((c) => (
                        <option key={c.code} className="text-ink">{c.label}</option>
                    ))}
                </select>

                <button
                   type="button"
                   onClick={() => setSearchOpen((o) => !o)} 
                   aria-label="Search"
                   className="flex cursor-pointer border-none bg-transparent p-1 text-paper-2"
                >
                    <Search size={17} strokeWidth={1.5} className="md:!h-[18px] md:!w-[18px]" />
                </button>
                <button
                   type="button"
                   onClick={toggleCart} 
                   aria-label={`Cart, ${count} items`}
                   className="relative flex cursor-pointer border-none bg-transparent p-1 text-paper-2"
                >
                    <ShoppingBag size={17} strokeWidth={1.5} className="md:!h-[18px] md:!w-[18px]" />
                    {count > 0 && (
                        <span className="absolute -right-2 -top-1.5 flex h-[15px] min-w-[15px] items-center justify-center bg-paper-2 px-1 font-mono text-[9px] text-ink md:h-4 md:min-w-4 md:text-[10px]">
                            {count}
                        </span>
                    )}
                </button>
                <Link
                  href="/wishlist"
                  aria-label={`Wishlist, ${items.length} items`}
                  className="relative flex cursor-pointer p-1 text-paper-2"
                >
                  <Heart size={17} strokeWidth={1.5} className="md:!h-[18px] md:!w-[18px]" />
                  {items.length > 0 && (
                    <span>{items.length}</span>
                  )}
                </Link>
              </div>
        </header> 

         <AnimatePresence>
            {searchOpen && (
                <motion.div
                  key="searchbar"
                  className="fixed inset-x-0 top-14 z-[99] overflow-hidden border-b border-ink bg-paper md:top-16"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }} 
                >
                    <form
                      onSubmit={onSearch}
                      className="flex max-w-[600px] items-center gap-3 px-4 py-3.5 md:gap-4 md:px-8 md:py-5"
                    >
                      <input
                        autoFocus
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="SEARCH"
                        className="min-w-0 flex-1 border-none border-b border-ink bg-transparent py-1.5 font-mono text-[13px] uppercase tracking-[0.03em] text-ink outline-none placeholder:text-muted md:py-2 md:text-[14px]"
                       />
                       <button
                          type="submit" 
                          className="shrink-0 cursor-pointer border-none border-b border-ink bg-transparent py-1.5 font-mono text-[13px] uppercase tracking-[0.03em] text-ink outline-none placeholder:text-muted md:py-2 md:text-[14px]"
                        >
                            GO
                        </button>  
                    </form>
                </motion.div>
            )}
         </AnimatePresence>
         {/* MOBILE MENU */}
         <AnimatePresence>
            {menuOpen && (
                <>
                <motion.div
                  key="menu-backdrop"
                  onClick={() => setMenuOpen(false)}
                  className="fixed inset-0 z-[130] bg-black/60 md:hidden"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.25 }}
                >
                    <motion.aside
                        key="menu-panel" 
                        className="flex top-0 h-full left-0 z-[131] flex w-[78%] flex-col bg-ink md:hidden"
                        role="dialog"
                        aria-label="Menu"
                        initial={{ x: "-100%" }}
                        animate={{ x: 0 }}
                        exit={{ x: "-100%" }}
                        transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
                    >
                      <div className="flex items-center justify-between border-b border-[#2b2b2b] p-5">
                        <Image
                          src={Logo}
                          alt="QUHÁ logo"
                          width={120}        
                          height={28}
                          priority          
                          className="h-5 w-auto md:h-6" 
                        />
                        <button
                           type="button"
                           onClick={() => setMenuOpen(false)}
                           aria-label="Close menu" 
                           className="cursor-pointer border-none bg-transparent p-1 text-paper-2"
                        >
                            <X size={20} strokeWidth={1.5} />
                        </button>
                       </div>
                      <nav className="flex flex-col p-5">
                        <Link
                           href="/shop"
                           onClick={closeMenuAnd()}
                           className="border-b border-[#2b2b2b] py-3.5 font-mono text-[13px] tracking-[0.06em] text-paper-2"
                        >
                           SHOP ALL
                        </Link>
                        <Link
                           href="/shop?sort=new"
                           onClick={closeMenuAnd()}
                           className="border-b border-[#2b2b2b] py-3.5 font-mono text-[13px] tracking-[0.06em] text-paper-2"
                        >
                           NEW ARRIVALS
                        </Link>
                        <Link
                           href="/shop?category=jackets"
                           onClick={closeMenuAnd()}
                           className="border-b border-[#2b2b2b] py-3.5 font-mono text-[13px] tracking-[0.06em] text-paper-2"
                        >
                           JACKETS
                        </Link>
                        <Link
                           href="/shop?category=jewelry"
                           onClick={closeMenuAnd()}
                           className="border-b border-[#2b2b2b] py-3.5 font-mono text-[13px] tracking-[0.06em] text-paper-2"
                        >
                           JEWELRY
                        </Link>
                        <Link
                           href="/shop?category=accessories"
                           onClick={closeMenuAnd()}
                           className="border-b border-[#2b2b2b] py-3.5 font-mono text-[13px] tracking-[0.06em] text-paper-2"
                        >
                           ACCESSORIES
                        </Link>
                        <Link
                           href="/shop?category=off-duties"
                           onClick={closeMenuAnd()}
                           className="border-b border-[#2b2b2b] py-3.5 font-mono text-[13px] tracking-[0.06em] text-paper-2"
                        >
                           OFF-DUTIES
                        </Link>
                      </nav>

                      <div className="mt-auto p-5">
                         <div className="mb-3 font-mono text-[10px] tracking-[0.06em] text-muted-2">
                           CURRENCY
                          </div>
                          <div className="grid grid-cols-4 gap-2">
                            {CURRENCIES.map((c) => {
                              const isActive = currency.toUpperCase() === c.code;
                              return (
                              <button 
                                key={c.code}
                                onClick={() => setCurrency(c.code.toLowerCase())}
                                className={`cursor-pointer border py-2.5 font-mono text-[11px] tracking-[0.04em] ${
                                  isActive
                                    ? "border-paper-2 bg-paper-2 text-ink"
                                    : "border-[#3a3a3a] bg-transparent text-paper-2"
                                }`}
                                >
                                  {c.label}
                              </button>
                              )
                            })}
                          </div>
                      </div>  
                    </motion.aside>
                </motion.div>
                </>
            )}
         </AnimatePresence>
        </>
    )
}