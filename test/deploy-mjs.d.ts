declare module "*.mjs" {
  export function manifestSignedString(
    version: string,
    sha256: string,
    url: string,
    rollbackTo?: string,
  ): string;
}
