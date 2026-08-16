export interface ClosableHttpServer {
  close(callback: (error?: Error) => void): void;
  closeAllConnections?(): void;
}

export interface ShutdownHttpServerOptions {
  gracePeriodMs?: number;
}

export interface ShutdownHttpServerResult {
  forced: boolean;
}

export const DEFAULT_SHUTDOWN_GRACE_PERIOD_MS = 5_000;

export async function shutdownHttpServer(
  httpServer: ClosableHttpServer,
  closeApplication: () => Promise<void>,
  options: ShutdownHttpServerOptions = {},
): Promise<ShutdownHttpServerResult> {
  const gracePeriodMs = options.gracePeriodMs ?? DEFAULT_SHUTDOWN_GRACE_PERIOD_MS;
  if (!Number.isFinite(gracePeriodMs) || gracePeriodMs < 0) {
    throw new Error(`Invalid HTTP shutdown grace period: ${gracePeriodMs}`);
  }

  const httpClosed = new Promise<void>((resolve, reject) => {
    httpServer.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });

  const gracefulOutcome = Promise.all([
    Promise.resolve().then(closeApplication),
    httpClosed,
  ]).then(
    () => ({ status: "closed" as const }),
    (error: unknown) => ({ status: "error" as const, error }),
  );
  let timer: NodeJS.Timeout | undefined;
  try {
    const outcome = await Promise.race([
      gracefulOutcome,
      new Promise<{ status: "timeout" }>((resolve) => {
        timer = setTimeout(() => resolve({ status: "timeout" }), gracePeriodMs);
      }),
    ]);
    if (outcome.status === "closed") return { forced: false };
    if (outcome.status === "error") throw outcome.error;

    httpServer.closeAllConnections?.();
    return { forced: true };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
