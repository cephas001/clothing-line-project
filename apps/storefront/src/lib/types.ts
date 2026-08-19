export type {
  Product,
  ProductVariant,         
  Cart,
  CartLineItem,
  Category,      
  StandardError,
  ListProductsResponse,
  AddLineItemRequest,
} from "../../../../packages/shared-types/src/index";



// A selectable option on the product page 
export interface VariantView {
  id: string;         
  sku: string;
  label: string;      
  available: boolean; 
}

export interface ProductView {
  id: string;
  slug: string;                             
  name: string;                             
  description: string;                      
  priceAmount: number;                      
  currencyCode: string;                     
  images: { studio: string; styled: string };
  isSoldOut: boolean;
  sellingFast: boolean;
  variants: VariantView[];
  category: CategorySlug;
}

export type CategorySlug = "jackets" | "jewelry" | "accessories" | "off-duties";

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