/** Redact known credentials and secret-bearing keys from local records and inspection. */
export function redactLogEvent(event: unknown, secrets: readonly string[] = []): unknown {
  const tokens = secrets.filter((value) => value.length > 0).sort((a, b) => b.length - a.length);
  return JSON.parse(JSON.stringify(event, (key, value: unknown) => {
    if (/(authorization|api[_-]?key|access[_-]?token|secret|password|cookie)$/i.test(key)) return "[REDACTED]";
    if (typeof value !== "string") return value;
    let text = value.replace(/Bearer\s+[^\s"',;]+/gi, "Bearer [REDACTED]");
    for (const token of tokens) text = text.replaceAll(token, "[REDACTED]");
    return text;
  }) ?? "null") as unknown;
}
