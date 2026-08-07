export interface IInsuranceService {
  getQuote(cartTotalMinor: number): Promise<number>;
}
