export interface Price {
  amount: number;        // integer from the API — see the note in lib/format.ts
  currency_code: string; // e.g. "ngn", "usd"
}

export interface ProductVariant {
  id: string;
  sku: string;
  inventory_quantity: number;
  allow_backorder: boolean;
  prices: Price[];
}

export interface Product {
  id: string;
  title: string;
  handle: string;         // url-safe id, e.g. "cool-jacket"
  description?: string;
  options?: unknown[];    // contract doesn't pin this down yet -> `unknown[]`
  variants: ProductVariant[];
}


// One selectable option on the product page, it maps to a real variant.
export interface VariantView {
  id: string;
  sku: string;
  label: string;
  available: boolean;
}

export interface ProductView {
    id: string;
    slug: string;   // URL-friendly id, used in /product/[slug]
    name: string;
    priceAmount: number;
    sku: string;
    currencyCode: string; 
    description: string;
    images: {
        studio: string;
        styled: string;
    };
    isSoldOut: boolean;                    
    sellingFast: boolean;                  
    variants: VariantView[];               
}

export type Category = "streetwear" | "jewelry";

export interface CartItem {
  productId: string;
  variantId: string; 
  qty: number;
}

export interface CartLine extends CartItem {
  key: string;        
  product: ProductView;  
  variant?: VariantView;  
}
