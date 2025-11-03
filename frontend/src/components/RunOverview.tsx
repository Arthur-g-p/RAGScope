import React from 'react';
import { RunData } from '../types';
import MetricsDisplay from './MetricsDisplay';

interface RunOverviewProps {
  run: RunData;
  abstentions: Set<string>;
  useAbstentions: boolean;
  onToggleUseAbstentions?: (val: boolean) => void;
}

const avg = (values: number[]) => {
  const arr = values.filter(v => typeof v === 'number' && isFinite(v));
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
};

const RunOverview: React.FC<RunOverviewProps> = ({ run, abstentions, useAbstentions, onToggleUseAbstentions }) => {
  const filtered = React.useMemo(() => {
    const used = useAbstentions ? run.results.filter(q => !abstentions.has(q.query_id)) : run.results;
    const overallKeys = ['precision','recall','f1'] as const;
    const generatorKeys = ['context_utilization','noise_sensitivity_in_relevant','noise_sensitivity_in_irrelevant','hallucination','self_knowledge','faithfulness'] as const;

    const overall_metrics: any = {};
    overallKeys.forEach(k => {
      overall_metrics[k] = avg(used.map(q => Number((q as any).metrics?.[k] ?? NaN)));
    });
    const generator_metrics: any = {};
    generatorKeys.forEach(k => {
      generator_metrics[k] = avg(used.map(q => Number((q as any).metrics?.[k] ?? NaN)));
    });
    return { overall_metrics, generator_metrics };
  }, [run, abstentions, useAbstentions]);

  const abstainedCount = abstentions.size;
  const metricsForDisplay = React.useMemo(() => ({
    overall_metrics: filtered.overall_metrics,
    retriever_metrics: run.metrics.retriever_metrics,
    generator_metrics: filtered.generator_metrics,
  }), [filtered, run.metrics.retriever_metrics]);

  return (
    <div>
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-6 mx-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-gray-900">Experiment Summary</h3>
          {onToggleUseAbstentions && (
            <label className="text-sm text-gray-700 inline-flex items-center gap-2" title="When enabled, questions marked as Abstention are excluded from Overall and Generator metrics in this dashboard.">
              <input type="checkbox" checked={useAbstentions} onChange={(e) => onToggleUseAbstentions?.(e.target.checked)} />
              Use abstentions
            </label>
          )}
        </div>
        <div className="grid grid-cols-2 gap-6">
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-center">
            <div className="text-2xl font-bold text-blue-800">{run.results.length}</div>
            <div className="text-sm text-blue-700">Questions</div>
          </div>
          <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 text-center">
            <div className="text-2xl font-bold text-gray-800">{abstainedCount}</div>
            <div className="text-sm text-gray-700">Abstentions</div>
            <div className="text-xs text-gray-500 mt-1">in-memory only; lost on restart</div>
          </div>
        </div>
      </div>

      <MetricsDisplay
        title="Metric Overview - Single-Run View"
        subtitle={useAbstentions ? "Overview excludes questions marked as Abstention." : "Overview includes all questions."}
        metrics={metricsForDisplay}
        showHeader={true}
      />
    </div>
  );
};

export default RunOverview;
