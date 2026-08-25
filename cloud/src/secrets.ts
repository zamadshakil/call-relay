export interface SecretBinding {
  get(): Promise<string>;
}

export type SecretValue = string | SecretBinding | undefined;

export async function secretValue(value: SecretValue, name: string): Promise<string> {
  const resolved = typeof value === "string" ? value : await value?.get();
  if (!resolved) throw new Error(`${name} is not configured`);
  return resolved;
}
