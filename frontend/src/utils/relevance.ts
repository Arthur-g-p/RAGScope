export const isIrrelevantFromCounts = (
  gtEntailments?: number,
  gtNeutrals?: number,
  gtContradictions?: number
): boolean => {
  const e = Math.max(0, Number(gtEntailments) || 0);
  const n = Math.max(0, Number(gtNeutrals) || 0);
  const c = Math.max(0, Number(gtContradictions) || 0);
  return e === 0 && c === 0 && n > 0;
};

export const isIrrelevantFromSets = (sets: {
  gt: { entailments: string[]; neutrals: string[]; contradictions: string[] };
}): boolean => {
  try {
    const e = Array.isArray(sets?.gt?.entailments) ? sets.gt.entailments.length : 0;
    const n = Array.isArray(sets?.gt?.neutrals) ? sets.gt.neutrals.length : 0;
    const c = Array.isArray(sets?.gt?.contradictions) ? sets.gt.contradictions.length : 0;
    return e === 0 && c === 0 && n > 0;
  } catch {
    return false;
  }
};

