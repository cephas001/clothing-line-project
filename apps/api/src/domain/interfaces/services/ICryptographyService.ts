export interface ICryptographyService {
  generateHmacSha512(payload: Buffer, secretKey: string): string;
  constantTimeCompare(hashA: string, hashB: string): boolean;
}
