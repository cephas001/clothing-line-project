import type { Metadata } from "next";
import { Archivo, Space_Mono } from "next/font/google";
import "./globals.css";
import { CurrencyProvider } from "@/context/CurrencyContext";
import { ToastProvider } from "@/context/ToastContext";
import { AuthProvider } from "@/context/AuthContext";
import { CartProvider } from "@/context/CartContext";
import { WishlistProvider } from "@/context/WishlistContext";
import Header from "@/components/Header/Header";
import Footer from "@/components/Footer/Footer";
import CartDrawer from "@/components/CartDrawer/CartDrawer";
import AuthDrawer from "@/components/AuthDrawer/AuthDrawer";
import BackToTop from "@/components/BackToTop/BackToTop";
import Toaster from "@/components/Toaster/Toaster";
const archivo = Archivo({
  variable: "--font-archivo",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800", "900"],
  display: "swap",
});

const spaceMono = Space_Mono({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-space-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "QUHÁ",
  description: "Raw materials, hard edges. Small-batch drops, no restocks.",
  icons:{
    icon: "/Black-logo.png"
  }
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${archivo.variable} ${spaceMono.variable}`}
    >
      <body>
        <CurrencyProvider>
        <ToastProvider>
        <AuthProvider>
        <CartProvider>
          <WishlistProvider>
          <Header />
          <main className="pt-14 md:pt-16">{children}</main>
          <Footer />
          <Toaster />
          <CartDrawer />
          <AuthDrawer />
          <BackToTop />
          </WishlistProvider>
        </CartProvider>
        </AuthProvider>
        </ToastProvider>
        </CurrencyProvider>
      </body>
    </html>
  );
}
