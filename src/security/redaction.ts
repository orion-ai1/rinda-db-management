export function redactSensitiveText(value: unknown, secrets: readonly string[] = []): string {
  let text = value instanceof Error ? value.message : String(value);
  for (const secret of secrets) {
    if (secret) {
      text = text.split(secret).join('[REDACTED]');
    }
  }
  return text
    .replace(/(password\s*[=:]\s*)[^\s;,]+/gi, '$1[REDACTED]')
    .replace(/(mysql(?:s)?:\/\/[^:\s/@]+:)[^@\s/]+@/gi, '$1[REDACTED]@');
}
