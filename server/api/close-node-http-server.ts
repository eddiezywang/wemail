interface ClosableNodeHttpServer {
  close(callback: (error?: Error) => void): unknown;
  closeIdleConnections?(): void;
  closeAllConnections?(): void;
}

/**
 * Stop accepting requests and tear down persistent local connections such as
 * SSE. Waiting for those clients to disconnect on their own can deadlock the
 * desktop quit path because renderer teardown happens after service shutdown.
 */
export function closeNodeHttpServer(server: ClosableNodeHttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };

    try {
      server.close(finish);
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
