/** Replace secret values so they never appear in errors or tool output. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    const value = secret.trim();
    if (value.length < 4) continue;
    out = out.split(value).join("[redacted]");
  }
  return out;
}
