"use client";

import Image from "next/image";
import { useState } from "react";

interface ProductImageProps {
    src: string;
    alt: string;
    label?: string;
    sizes?: string;
    priority?: boolean;
}

export default function ProductImage({
    src,
    alt,
    label = "IMAGE",
    sizes = "(max-width: 640px) 50vw, 25vw",
    priority = false,
}: ProductImageProps) {
   // Track whether the image failed to load
   const [failed, setFailed] = useState<boolean>(false); 

    //   The image URL is empty / missing (!src)
    // The image tried to load but failed (failed === true)
   if (failed || !src) {
    return (
        <div 
            className="absolute inset-0 flex h-full w-full items-center justify-center bg-placeholder"
            role="img"
            aria-label={alt}
        >
            <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-muted">
            {label}
            </span>    
        </div>
    )
   }

     return (
    <Image
      src={src}
      alt={alt}
      fill
      sizes={sizes}
      priority={priority}
      className="object-cover"
      onError={() => setFailed(true)} 
    />
  );
}