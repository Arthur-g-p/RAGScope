export const relAt = (matrix: any[], chunkIdx: number, claimIdx: number, chunkCount?: number, claimCount?: number): any => {
  try {
    if (!Array.isArray(matrix)) return undefined;
    const outer = matrix.length;
    if (typeof chunkCount === 'number' && outer === chunkCount) {
      const row = matrix[chunkIdx];
      if (Array.isArray(row)) return row[claimIdx];
    }
    if (typeof claimCount === 'number' && outer === claimCount) {
      const row = matrix[claimIdx];
      if (Array.isArray(row)) return row[chunkIdx];
    }
    const first = matrix[0];
    if (Array.isArray(first)) {
      if (typeof claimCount === 'number' && first.length === claimCount) {
        const row = matrix[chunkIdx];
        if (Array.isArray(row)) return row[claimIdx];
      }
      if (typeof chunkCount === 'number' && first.length === chunkCount) {
        const row = matrix[claimIdx];
        if (Array.isArray(row)) return row[chunkIdx];
      }
    }
    const byChunk = Array.isArray(matrix?.[chunkIdx]) ? matrix[chunkIdx] : undefined;
    if (Array.isArray(byChunk) && byChunk.length > claimIdx) return byChunk[claimIdx];
    const byClaim = Array.isArray(matrix?.[claimIdx]) ? matrix[claimIdx] : undefined;
    if (Array.isArray(byClaim) && byClaim.length > chunkIdx) return byClaim[chunkIdx];
    return undefined;
  } catch {
    return undefined;
  }
};
