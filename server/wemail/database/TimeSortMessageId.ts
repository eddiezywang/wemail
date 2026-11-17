const MESSAGE_SEQUENCE_BITS = 20n;
const MESSAGE_SEQUENCE_CAPACITY = 1n << MESSAGE_SEQUENCE_BITS;
const MESSAGE_EPOCH_MS = Date.UTC(2000, 0, 1);
const MAX_SIGNED_SQLITE_INTEGER = (1n << 63n) - 1n;
const MIN_SIGNED_SQLITE_INTEGER = -(1n << 63n);

export interface TimeSortMessageIdParts {
  receivedAtMs: number;
  sequence: number;
}

export function encodeTimeSortMessageId({
  receivedAtMs,
  sequence,
}: TimeSortMessageIdParts): bigint {
  if (!Number.isSafeInteger(receivedAtMs)) {
    throw new Error("receivedAtMs must be a safe integer");
  }
  if (!Number.isInteger(sequence) || sequence < 0 || sequence >= Number(MESSAGE_SEQUENCE_CAPACITY)) {
    throw new Error("message sequence is outside the 20-bit range");
  }
  const timestampPart = BigInt(receivedAtMs - MESSAGE_EPOCH_MS);
  const id = timestampPart * MESSAGE_SEQUENCE_CAPACITY + BigInt(sequence);
  if (id < MIN_SIGNED_SQLITE_INTEGER || id > MAX_SIGNED_SQLITE_INTEGER) {
    throw new Error("time-sort message id exceeds SQLite signed integer range");
  }
  return id;
}

export function decodeTimeSortMessageId(id: bigint): TimeSortMessageIdParts {
  if (id < MIN_SIGNED_SQLITE_INTEGER || id > MAX_SIGNED_SQLITE_INTEGER) {
    throw new Error("time-sort message id exceeds SQLite signed integer range");
  }
  let timestampPart = id / MESSAGE_SEQUENCE_CAPACITY;
  let sequencePart = id % MESSAGE_SEQUENCE_CAPACITY;
  if (sequencePart < 0n) {
    timestampPart -= 1n;
    sequencePart += MESSAGE_SEQUENCE_CAPACITY;
  }
  const receivedAtMs = Number(timestampPart) + MESSAGE_EPOCH_MS;
  if (!Number.isSafeInteger(receivedAtMs)) {
    throw new Error("decoded timestamp exceeds JavaScript safe integer range");
  }
  return {
    receivedAtMs,
    sequence: Number(sequencePart),
  };
}

export function compareTimeSortMessageIds(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export const TIME_SORT_MESSAGE_SEQUENCE_CAPACITY = Number(MESSAGE_SEQUENCE_CAPACITY);
