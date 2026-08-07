import type { Product, ProductView, VariantView, Category } from "./types";

const DEFAULT_CURRENCY = "ngn";

// SAMPLE DATA — shaped EXACTLY like the API's Product schema.
// Array to be replaced with a fetch()

 const RAW_PRODUCTS: Product[] =[
    {
        id: "11111111-1111-1111-1111-111111111111",
        title: "Static Heavyweight Hoodie",
        handle: "static-hoodie",
        description: "480gsm brushed-back fleece with a boxy, structured fit.",
        variants: [
            { id: "v-hoodie-s", sku: "GW-SW-001-S", inventory_quantity: 4, allow_backorder: false, prices: [{ amount: 45000, currency_code: "ngn" }, { amount: 145, currency_code: "usd" }] },
            { id: "v-hoodie-m", sku: "GW-SW-001-M", inventory_quantity: 6, allow_backorder: false, prices: [{ amount: 45000, currency_code: "ngn" }, { amount: 145, currency_code: "usd" }] },
            { id: "v-hoodie-l", sku: "GW-SW-001-L", inventory_quantity: 0, allow_backorder: false, prices: [{ amount: 45000, currency_code: "ngn" }, { amount: 145, currency_code: "usd" }] },
        ],  
    },
    {
        id: "22222222-2222-2222-2222-222222222222",
        title: "Grid Cargo Pant",
        handle: "grid-cargo-pant",
        description: "Relaxed ripstop cargo with mapped utility pockets.",
        variants: [
            { id: "v-cargo-30", sku: "GW-SW-002-30", inventory_quantity: 12, allow_backorder: false, prices: [{ amount: 52000, currency_code: "ngn" }] },
            { id: "v-cargo-32", sku: "GW-SW-002-32", inventory_quantity: 9, allow_backorder: false, prices: [{ amount: 52000, currency_code: "ngn" }] },
        ],
    },
    {
        id: "33333333-3333-3333-3333-333333333333",
        title: "Shadow Work Jacket",
        handle: "shadow-work-jacket",
        description: "Waxed-cotton chore jacket with triple-needle stitching.",
        variants: [
            { id: "v-jacket-m", sku: "GW-SW-004-M", inventory_quantity: 0, allow_backorder: false, prices: [{ amount: 70000, currency_code: "ngn" }] },
            { id: "v-jacket-l", sku: "GW-SW-004-L", inventory_quantity: 0, allow_backorder: false, prices: [{ amount: 70000, currency_code: "ngn" }] },
        ],
  },
  {
    id: "44444444-4444-4444-4444-444444444444",
    title: "Signal Cuff",
    handle: "signal-cuff",
    description: "Solid, hand-finished cuff with a brushed face.",
    variants: [
      { id: "v-cuff-os", sku: "GW-JW-001-OS", inventory_quantity: 5, allow_backorder: false, prices: [{ amount: 60000, currency_code: "ngn" }] },
    ],
  },
  {
    id: "55555555-5555-5555-5555-555555555555",
    title: "Heavy Link Chain",
    handle: "link-chain",
    description: "6mm curb chain with a hidden box clasp.",
    variants: [
      { id: "v-chain-os", sku: "GW-JW-002-OS", inventory_quantity: 20, allow_backorder: true, prices: [{ amount: 78000, currency_code: "ngn" }] },
    ],
  },
  {
    id: "66666666-6666-6666-6666-666666666666",
    title: "Monolith Signet Ring",
    handle: "monolith-ring",
    description: "Flat-top signet with a matte-blasted face.",
    variants: [
      { id: "v-ring-8", sku: "GW-JW-003-8", inventory_quantity: 3, allow_backorder: false, prices: [{ amount: 41000, currency_code: "ngn" }] },
      { id: "v-ring-9", sku: "GW-JW-003-9", inventory_quantity: 7, allow_backorder: false, prices: [{ amount: 41000, currency_code: "ngn" }] },
    ],
  },
]
// Replace with the /store/product-categories endpoint + category_id filtering later.
const DEV_CATEGORY: Record<string, Category> = {
  "static-hoodie": "streetwear",
  "grid-cargo-pant": "streetwear",
  "shadow-work-jacket": "streetwear",
  "signal-cuff": "jewelry",
  "link-chain": "jewelry",
  "monolith-ring": "jewelry",
};

// API Product to friendly ProductView.
function toProductView(p: Product, preferredCurrency = DEFAULT_CURRENCY): ProductView {
    const firstVariant = p.variants[0];
    const price = 
        firstVariant?.prices.find((pr) => pr.currency_code === preferredCurrency) ?? firstVariant?.prices[0];

    // A variant is available if it has stock or the shop allows backorders.
    const isAvailable = (v: Product["variants"][number]) => v.inventory_quantity > 0 || v.allow_backorder;

    const totalStock = p.variants.reduce((sum, v) => sum + v.inventory_quantity, 0);

    const variants: VariantView[] = p.variants.map((v) => ({
        id: v.id,
        sku: v.sku,
        label: v.sku.split("-").pop() ?? v.sku,
        available: isAvailable(v),
    }));

    return {
        id: p.id,
        slug: p.handle,
        name: p.title,
        description: p.description ?? "",
        priceAmount: price?.amount ?? 0,
        currencyCode: price?.currency_code ?? preferredCurrency,
        images: { studio: "", styled: "" },
        isSoldOut: !p.variants.some(isAvailable),
        sellingFast: totalStock > 0 && totalStock <= 8,
        variants
    }
}


export function getAllProducts(): Product[] {
    return RAW_PRODUCTS.map(p => toProductView(p));
}

export function getProductsBySlug(slug: string): ProductView | undefined {
    const raw = RAW_PRODUCTS.find((p) => p.handle === slug);
    return raw ? toProductView(raw) : undefined;
}

export function getByCategory(category: Category): ProductView[] {
  return RAW_PRODUCTS
    .filter((p) => DEV_CATEGORY[p.handle] === category)
    .map((p) => toProductView(p));
}

export function getRelated(product: ProductView, limit = 4): ProductView[] {
    const cart = DEV_CATEGORY[product.slug];
    return RAW_PRODUCTS
        .filter((p) => DEV_CATEGORY[p.handle] === cart && p.handle !== product.slug)
        .map((p) => toProductView(p))
        .slice(0, limit)
}



