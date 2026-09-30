export function devBackendPort(env: Record<string, string | undefined> = process.env): string {
  const port = env.PI_WEB_DEV_PORT ?? "3141";
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error("PI_WEB_DEV_PORT must be an integer between 1 and 65535");
  }
  return String(Number(port));
}
