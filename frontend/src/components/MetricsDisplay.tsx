import React from 'react';
import { logger } from '../utils/logger';

interface MetricConfig {
  label: string;
  key: string;
  lowerIsBetter?: boolean;
  tooltip: string;
}

interface MetricsDisplayProps {
  title: string;
  subtitle?: string;
  metrics: {
    overall_metrics: Record<string, number>;
    retriever_metrics: Record<string, number>;
    generator_metrics: Record<string, number>;
  };
  showHeader?: boolean;
}

const MetricsDisplay: React.FC<MetricsDisplayProps> = ({ 
  title, 
  subtitle, 
  metrics, 
  showHeader = true 
}) => {
  React.useEffect(() => {
    logger.info('MetricsDisplay rendered successfully');
  }, []);

  const normalize = (val: number) => {
    if (val > 1) return Math.min(val / 100, 1); // treat as percentage
    return Math.max(0, Math.min(val, 1)); // clamp 0–1
  };

  const calcColor = (val: number, lowerIsBetter = false) => {
    const v = normalize(val);
    const effective = lowerIsBetter ? 1 - v : v;
    const hue = effective * 120;
    return `hsl(${hue}, 85%, 45%)`;
  };

  const MetricBar: React.FC<{
    label: string;
    value: number;
    lowerIsBetter?: boolean;
    tooltip: string;
  }> = ({ label, value, lowerIsBetter, tooltip }) => {
    const norm = normalize(value);
    const percent = Math.round(norm * 100);
    const color = calcColor(value, lowerIsBetter);

    return (
      <div className="mb-4">
        <div className="flex items-center justify-between text-sm mb-1">
          <span 
            className="font-medium text-gray-700 cursor-help" 
            title={tooltip}
          >
            {label}
          </span>
          <span className="font-medium" style={{ color }}>{percent}%</span>
        </div>
        <div className="w-full bg-gray-200 h-3 rounded-lg overflow-hidden">
          <div
            className="h-full transition-all duration-300 ease-in-out"
            style={{
              width: `${percent}%`,
              backgroundColor: color
            }}
          />
        </div>
        {lowerIsBetter && (
          <div className="text-xs text-gray-500 mt-1">* Lower values are better</div>
        )}
      </div>
    );
  };

  const sections: {
    title: string;
    metrics: MetricConfig[];
    data: Record<string, number>;
  }[] = [
    {
      title: "Overall Metrics",
      metrics: [
        { label: "Precision", key: "precision", tooltip: "Correctness of the response" },
        { label: "Recall", key: "recall", tooltip: "Completeness of the response" },
        { label: "F1 Score", key: "f1", tooltip: "Overall quality of the response" },
      ],
      data: metrics.overall_metrics,
    },
    {
      title: "Retriever Metrics",
      metrics: [
        { label: "Claim Recall", key: "claim_recall", tooltip: "Proportion of ground truth claims covered by retrieved chunks." },
        { label: "Context Precision", key: "context_precision", tooltip: "Portion of relevant chunks in retrieved context" },
      ],
      data: metrics.retriever_metrics,
    },
    {
      title: "Generator Metrics",
      metrics: [
        { label: "Context Utilization", key: "context_utilization", tooltip: "How effectively the generator uses relevant information in the context" },
        { label: "Noise Sensitivity (Relevant)", key: "noise_sensitivity_in_relevant", lowerIsBetter: true, tooltip: "How much the generator influenced by noise in relevant chunks (lower is better)" },
        { label: "Noise Sensitivity (Irrelevant)", key: "noise_sensitivity_in_irrelevant", lowerIsBetter: true, tooltip: "How much the generator influenced by noise in irrelevant chunks (lower is better)" },
        { label: "Hallucination", key: "hallucination", lowerIsBetter: true, tooltip: "Incorrect information made up by the generator (lower is better)" },
        { label: "Self Knowledge", key: "self_knowledge", lowerIsBetter: true, tooltip: "Use of the model's own knowledge instead of the context (whether lower is better depends on user's preference)" },
        { label: "Faithfulness", key: "faithfulness", tooltip: "How well the generator sticks to the retrieved context" },
      ],
      data: metrics.generator_metrics,
    },
  ];

  return (
    <div className="p-6">
      <div className="max-w-7xl mx-auto">
        {showHeader && (
          <header className="text-center mb-10">
            <h1 className="text-3xl sm:text-4xl font-bold text-gray-900">{title}</h1>
            {subtitle && <p className="mt-2 text-md text-gray-600">{subtitle}</p>}
          </header>
        )}

        <main className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
          {sections.map((section) => (
            <div
              key={section.title}
              className="bg-white p-6 rounded-2xl shadow-md border-t-4 border-gray-200 transition-all duration-200 hover:transform hover:-translate-y-1 hover:shadow-lg"
            >
              <h2 className="text-xl font-bold mb-6 text-gray-800">{section.title}</h2>
              {section.metrics.map((m) => (
                <MetricBar
                  key={m.key}
                  label={m.label}
                  value={section.data[m.key] || 0}
                  lowerIsBetter={m.lowerIsBetter}
                  tooltip={m.tooltip}
                />
              ))}
            </div>
          ))}
        </main>
      </div>
    </div>
  );
};

export default MetricsDisplay;