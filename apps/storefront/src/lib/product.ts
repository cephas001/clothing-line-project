
import type {
  Product,
  ProductView,
  VariantView,
  CategorySlug,
} from "./types";

const DEFAULT_CURRENCY = "ngn";

const RAW_PRODUCTS: Product[] = [
  // --- JACKETS ---
  {
    id: "11111111-1111-1111-1111-111111111111",
    title: "Shadow Work Jacket",
    handle: "shadow-work-jacket",
    description: "Waxed-cotton chore jacket with triple-needle stitching. Full sleeves, boxy fit.",
    variants: [
      { id: "v-shadow-s", productId: "11111111-1111-1111-1111-111111111111", sku: "GW-JK-001-S", inventoryQuantity: 4, allowBackorder: false, version: 1 },
      { id: "v-shadow-m", productId: "11111111-1111-1111-1111-111111111111", sku: "GW-JK-001-M", inventoryQuantity: 6, allowBackorder: false, version: 1 },
      { id: "v-shadow-l", productId: "11111111-1111-1111-1111-111111111111", sku: "GW-JK-001-L", inventoryQuantity: 0, allowBackorder: false, version: 1 },
    ],
  },
  {
    id: "22222222-2222-2222-2222-222222222222",
    title: "Cutoff Utility Vest",
    handle: "cutoff-utility-vest",
    description: "Sleeveless canvas vest with mapped chest pockets and a raw hem.",
    variants: [
      { id: "v-vest-s", productId: "22222222-2222-2222-2222-222222222222", sku: "GW-JK-002-S", inventoryQuantity: 8, allowBackorder: false, version: 1 },
      { id: "v-vest-m", productId: "22222222-2222-2222-2222-222222222222", sku: "GW-JK-002-M", inventoryQuantity: 5, allowBackorder: false, version: 1 },
      { id: "v-vest-l", productId: "22222222-2222-2222-2222-222222222222", sku: "GW-JK-002-L", inventoryQuantity: 3, allowBackorder: false, version: 1 },
    ],
  },
  {
    id: "12121212-1212-1212-1212-121212121212",
    title: "Ash Bomber Jacket",
    handle: "ash-bomber",
    description: "Cropped bomber in heavy cotton twill with ribbed cuffs and a matte zipper.",
    variants: [
      { id: "v-bomber-s", productId: "12121212-1212-1212-1212-121212121212", sku: "GW-JK-003-S", inventoryQuantity: 5, allowBackorder: false, version: 1 },
      { id: "v-bomber-m", productId: "12121212-1212-1212-1212-121212121212", sku: "GW-JK-003-M", inventoryQuantity: 7, allowBackorder: false, version: 1 },
      { id: "v-bomber-l", productId: "12121212-1212-1212-1212-121212121212", sku: "GW-JK-003-L", inventoryQuantity: 4, allowBackorder: false, version: 1 },
    ],
  },
  {
    id: "13131313-1313-1313-1313-131313131313",
    title: "Forge Field Jacket",
    handle: "forge-field-jacket",
    description: "Multi-pocket field jacket with reinforced elbows and adjustable waist tabs.",
    variants: [
      { id: "v-forge-s", productId: "13131313-1313-1313-1313-131313131313", sku: "GW-JK-004-S", inventoryQuantity: 3, allowBackorder: false, version: 1 },
      { id: "v-forge-m", productId: "13131313-1313-1313-1313-131313131313", sku: "GW-JK-004-M", inventoryQuantity: 6, allowBackorder: false, version: 1 },
      { id: "v-forge-l", productId: "13131313-1313-1313-1313-131313131313", sku: "GW-JK-004-L", inventoryQuantity: 2, allowBackorder: false, version: 1 },
    ],
  },

  // --- JEWELRY ---
  {
    id: "44444444-4444-4444-4444-444444444444",
    title: "Signal Cuff",
    handle: "signal-cuff",
    description: "Solid, hand-finished cuff with a brushed face.",
    variants: [
      { id: "v-cuff-os", productId: "44444444-4444-4444-4444-444444444444", sku: "GW-JW-001-OS", inventoryQuantity: 5, allowBackorder: false, version: 1 },
    ],
  },
  {
    id: "55555555-5555-5555-5555-555555555555",
    title: "Heavy Link Chain",
    handle: "link-chain",
    description: "6mm curb chain with a hidden box clasp.",
    variants: [
      { id: "v-chain-os", productId: "55555555-5555-5555-5555-555555555555", sku: "GW-JW-002-OS", inventoryQuantity: 20, allowBackorder: true, version: 1 },
    ],
  },
  {
    id: "66666666-6666-6666-6666-666666666666",
    title: "Monolith Signet Ring",
    handle: "monolith-ring",
    description: "Flat-top signet with a matte-blasted face.",
    variants: [
      { id: "v-ring-8", productId: "66666666-6666-6666-6666-666666666666", sku: "GW-JW-003-8", inventoryQuantity: 3, allowBackorder: false, version: 1 },
      { id: "v-ring-9", productId: "66666666-6666-6666-6666-666666666666", sku: "GW-JW-003-9", inventoryQuantity: 7, allowBackorder: false, version: 1 },
    ],
  },
  {
    id: "77777777-7777-7777-7777-777777777771",
    title: "Obsidian Pendant",
    handle: "obsidian-pendant",
    description: "Geometric matte-black pendant on a heavy curb chain.",
    variants: [
      { id: "v-pendant-os", productId: "77777777-7777-7777-7777-777777777771", sku: "GW-JW-004-OS", inventoryQuantity: 8, allowBackorder: false, version: 1 },
    ],
  },

  // --- ACCESSORIES ---
  {
    id: "77777777-7777-7777-7777-777777777777",
    title: "Bracket Web Belt",
    handle: "bracket-belt",
    description: "Woven cotton belt with a matte-black anodized bracket buckle.",
    variants: [
      { id: "v-belt-30", productId: "77777777-7777-7777-7777-777777777777", sku: "GW-AC-001-30", inventoryQuantity: 10, allowBackorder: false, version: 1 },
      { id: "v-belt-34", productId: "77777777-7777-7777-7777-777777777777", sku: "GW-AC-001-34", inventoryQuantity: 6, allowBackorder: false, version: 1 },
    ],
  },
  {
    id: "88888888-8888-8888-8888-888888888888",
    title: "Sling Pouch",
    handle: "sling-pouch",
    description: "Compact ripstop sling with a magnetic snap and adjustable webbing strap.",
    variants: [
      { id: "v-pouch-os", productId: "88888888-8888-8888-8888-888888888888", sku: "GW-AC-002-OS", inventoryQuantity: 12, allowBackorder: false, version: 1 },
    ],
  },
  {
    id: "99999999-9999-9999-9999-999999999999",
    title: "Forge Cap",
    handle: "forge-cap",
    description: "Structured six-panel cap with tonal embroidery and an adjustable strap.",
    variants: [
      { id: "v-cap-os", productId: "99999999-9999-9999-9999-999999999999", sku: "GW-AC-003-OS", inventoryQuantity: 15, allowBackorder: false, version: 1 },
    ],
  },
  {
    id: "10101010-1010-1010-1010-101010101010",
    title: "Utility Tote",
    handle: "utility-tote",
    description: "Heavy canvas tote with reinforced base and internal zip pocket.",
    variants: [
      { id: "v-tote-os", productId: "10101010-1010-1010-1010-101010101010", sku: "GW-AC-004-OS", inventoryQuantity: 9, allowBackorder: false, version: 1 },
    ],
  },
  
  // --- OFF-DUTIES ---
  {
    id: "99999999-9999-9999-9999-999999999999",
    title: "Bracket Keyholder",
    handle: "bracket-keyholder",
    description: "Machined brass keyholder with a leather pull. Heavy in the pocket.",
    variants: [
      { id: "v-keyh-os", productId: "99999999-9999-9999-9999-999999999999", sku: "GW-OD-001-OS", inventoryQuantity: 14, allowBackorder: false, version: 1 },
    ],
  },
  {
    id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    title: "Static Weave Rug",
    handle: "static-weave-rug",
    description: "Hand-loomed accent rug in a heavy monochrome weave. 90 × 150cm.",
    variants: [
      { id: "v-rug-os", productId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", sku: "GW-OD-002-OS", inventoryQuantity: 4, allowBackorder: false, version: 1 },
    ],
  },
  {
    id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    title: "Concrete Vessel",
    handle: "concrete-vessel",
    description: "Cast-concrete display vessel. Raw finish, sealed interior.",
    variants: [
      { id: "v-vessel-s", productId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", sku: "GW-OD-003-S", inventoryQuantity: 6, allowBackorder: false, version: 1 },
      { id: "v-vessel-l", productId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", sku: "GW-OD-003-L", inventoryQuantity: 2, allowBackorder: false, version: 1 },
    ],
  },
  {
    id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
    title: "Matte Incense Block",
    handle: "matte-incense-block",
    description: "Solid ash-wood incense holder with a low profile and charcoal finish.",
    variants: [
      { id: "v-incense-os", productId: "cccccccc-cccc-cccc-cccc-cccccccccccc", sku: "GW-OD-004-OS", inventoryQuantity: 11, allowBackorder: false, version: 1 },
    ],
  },
];

// Replace with the /store/product-categories endpoint + category_id filtering later.
const DEV_CATEGORY: Record<string, CategorySlug> = {
  // Jackets
  "shadow-work-jacket": "jackets",
  "cutoff-utility-vest": "jackets",
  "ash-bomber": "jackets",
  "forge-field-jacket": "jackets",

  // Jewelry
  "signal-cuff": "jewelry",
  "link-chain": "jewelry",
  "monolith-ring": "jewelry",
  "obsidian-pendant": "jewelry",

  // Accessories
  "bracket-belt": "accessories",
  "sling-pouch": "accessories",
  "forge-cap": "accessories",
  "utility-tote": "accessories",

  // Off-Duties
  "bracket-keyholder": "off-duties",
  "static-weave-rug": "off-duties",
  "concrete-vessel": "off-duties",
  "matte-incense-block": "off-duties",
};


 const PLACEHOLDER_PRICE = 0;

// API Product -> friendly ProductView.
function toProductView(
  p: Product,
  category: CategorySlug,
  preferredCurrency = DEFAULT_CURRENCY
): ProductView {
  const variants = p.variants ?? [];

  const isAvailable = (v: { inventoryQuantity: number; allowBackorder: boolean }) =>
    v.inventoryQuantity > 0 || v.allowBackorder;

  const totalStock = variants.reduce((sum, v) => sum + v.inventoryQuantity, 0);

  const viewVariants: VariantView[] = variants.map((v) => ({
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
    priceAmount:PLACEHOLDER_PRICE,
    currencyCode: DEFAULT_CURRENCY,
    images: { studio: "", styled: "" },
    // If no variants, treat the product as sold out
    isSoldOut: variants.length === 0 || !variants.some(isAvailable),
    sellingFast: totalStock > 0 && totalStock <= 8,
    variants: viewVariants,
    category
  };
}

// ---- Helpers the pages call ------------------------------------------------
export function getAllProducts(): ProductView[] {
  return RAW_PRODUCTS.map((p) => toProductView(p, DEV_CATEGORY[p.handle] ?? "off-duties"));
}

export function getProductBySlug(slug: string): ProductView | undefined {
  const raw = RAW_PRODUCTS.find((p) => p.handle === slug);
  return raw ? toProductView(raw, DEV_CATEGORY[raw.handle] ?? "off-duties") : undefined;
}

export function getByCategory(category: CategorySlug): ProductView[] {
  return RAW_PRODUCTS
    .filter((p) => DEV_CATEGORY[p.handle] === category)
    .map((p) => toProductView(p, category));
}

export function getRelated(product: ProductView, limit = 4): ProductView[] {
  const cat = DEV_CATEGORY[product.slug];
  return RAW_PRODUCTS
    .filter((p) => DEV_CATEGORY[p.handle] === cat && p.handle !== product.slug)
    .map((p) => toProductView(p, cat))
    .slice(0, limit);
}
