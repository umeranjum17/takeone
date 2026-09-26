// Redaction of private text before anything leaves the machine (--screen-text
// only). Pure functions over plain data.

/**
 * Replace emails, runs of 6+ digits and 20+ character mixed alphanumeric
 * strings with [redacted].
 */
export function redactText(s: string): string {
  return s
    .replace(/[\w.+-]+\s*@\s*[\w-]+(?:\s*\.\s*[\w-]+)+/g, "[redacted]")
    .replace(/\d{6,}/g, "[redacted]")
    .replace(/(?=[A-Za-z]*\d)[A-Za-z0-9]{20,}/g, "[redacted]");
}
