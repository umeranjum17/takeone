// Only individual alphabetic words may leave the machine with --screen-text.
export function redactText(s: string): string {
  return s.split(/\s+/).filter(Boolean).map((word) =>
    /^[A-Za-z]{2,15}$/.test(word) ? word : "[redacted]"
  ).join(" ");
}
