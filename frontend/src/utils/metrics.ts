export const normalizeMetric = (value: number): number => {
  if (value >= 0 && value <= 1) {
    return value;
  } else if (value > 1 && value <= 100) {
    return value / 100;
  } else {
    console.warn(`Metric value ${value} is out of expected range, clamping to [0,1]`);
    return Math.max(0, Math.min(1, value));
  }
};

export const HIGHER_IS_BETTER_METRICS = new Set([
  'precision',
  'recall',
  'f1',
  'faithfulness',
  'context_utilization',
  'claim_recall',
  'context_precision',
  'self_knowledge'
]);

export const LOWER_IS_BETTER_METRICS = new Set([
  'hallucination',
  'noise_sensitivity_in_relevant',
  'noise_sensitivity_in_irrelevant'
]);

export const isHigherBetter = (metricKey: string): boolean => {
  return HIGHER_IS_BETTER_METRICS.has(metricKey);
};

export const convertToGoodness = (value: number, metricKey: string): number => {
  const normalized = normalizeMetric(value);
  if (isHigherBetter(metricKey)) {
    return normalized;
  } else {
    return 1 - normalized;
  }
};

export const getMetricDisplayInfo = (rawValue: number, metricKey: string) => {
  const normalized = normalizeMetric(rawValue);
  const goodness = convertToGoodness(rawValue, metricKey);
  const isInverted = !isHigherBetter(metricKey);
  
  return {
    rawValue,
    normalizedValue: normalized,
    goodnessValue: goodness,
    isInverted
  };
};