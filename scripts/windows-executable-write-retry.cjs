const fsPromises = require("node:fs/promises");

const RETRIABLE_ERROR_CODES = new Set(["UNKNOWN", "EBUSY", "EPERM", "EACCES"]);
const RETRY_DELAYS_MS = [125, 250, 500, 750, 1_000, 1_000];

function isRetriableExecutableWrite(error, file, platform = process.platform) {
  const filePath = typeof file === "string" ? file : file?.toString?.();
  return (
    platform === "win32" &&
    typeof filePath === "string" &&
    filePath.toLowerCase().endsWith(".exe") &&
    RETRIABLE_ERROR_CODES.has(error?.code)
  );
}

function createWriteFileWithRetry(
  originalWriteFile,
  { delays = RETRY_DELAYS_MS, sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay)), platform = process.platform } = {},
) {
  return async function writeFileWithRetry(file, ...args) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await originalWriteFile(file, ...args);
      } catch (error) {
        if (!isRetriableExecutableWrite(error, file, platform) || attempt >= delays.length) {
          throw error;
        }
        await sleep(delays[attempt]);
      }
    }
  };
}

const originalWriteFile = fsPromises.writeFile.bind(fsPromises);
fsPromises.writeFile = createWriteFileWithRetry(originalWriteFile);

module.exports = {
  createWriteFileWithRetry,
  isRetriableExecutableWrite,
};
