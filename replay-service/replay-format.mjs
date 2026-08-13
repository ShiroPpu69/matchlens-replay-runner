export const replayCompression = Object.freeze({
  bzip2: "bzip2",
  zstd: "zstd",
  raw: "raw",
  unknown: "unknown",
});

export function detectReplayCompression(header) {
  const bytes = Buffer.from(header);
  if (bytes.length >= 3 && bytes[0] === 0x42 && bytes[1] === 0x5a && bytes[2] === 0x68) {
    return replayCompression.bzip2;
  }
  if (bytes.length >= 4 && bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd) {
    return replayCompression.zstd;
  }
  if (bytes.length >= 7 && bytes.subarray(0, 7).toString("ascii") === "PBDEMS2") {
    return replayCompression.raw;
  }
  return replayCompression.unknown;
}
