export interface IInventoryLocationService {
  findOptimalFulfillmentNode(
    productId: string,
    quantity: number,
    customerLocation: { lat: number; lng: number },
    options: { allowSplitAcrossLocations: boolean },
  ): Promise<{ locationId: string; distance: number } | null>;
}
