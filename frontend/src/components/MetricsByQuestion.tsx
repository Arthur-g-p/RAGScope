import React, { useState, useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { Question } from '../types';
import { convertToGoodness, getMetricDisplayInfo } from '../utils/metrics';
import { logger } from '../utils/logger';

interface MetricsByQuestionProps {
  questions: Question[];
  onSelectQuestion: (queryId: string) => void;
  onVisibleMetricsChange?: (visible: string[]) => void;
}

const DEFAULT_VISIBLE_METRICS = [
  'precision',
  'recall'
];

const STORAGE_KEY = 'rageval_metrics_by_question_visible';

const METRIC_COLORS = [
  '#3B82F6', '#EF4444', '#10B981', '#F59E0B', '#8B5CF6', '#F97316'
];

const MetricsByQuestion: React.FC<MetricsByQuestionProps> = ({ questions, onSelectQuestion, onVisibleMetricsChange }) => {
  const [visibleMetrics, setVisibleMetrics] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) return new Set(arr as string[]);
      }
    } catch {}
    return new Set(DEFAULT_VISIBLE_METRICS);
  });

  // Notify parent on mount and when selection changes
  React.useEffect(() => {
    try { onVisibleMetricsChange?.(Array.from(visibleMetrics)); } catch {}
  }, []);

  React.useEffect(() => {
    logger.info('MetricsByQuestion rendered successfully');
  }, []);

  const chartData = useMemo(() => {
    return questions.map((question, index) => {
      const dataPoint: any = {
        index: index + 1,
        queryId: question.query_id,
        contextLength: question.context_length || 0,
        numChunks: question.num_chunks || 0,
        query: question.query,
        questionLabel: `Q${question.query_id} • ${question.context_length || 0}w`
      };

      Object.entries(question.metrics).forEach(([key, value]) => {
        dataPoint[key] = convertToGoodness(value, key);
        dataPoint[`${key}_raw`] = value;
      });


      return dataPoint;
    });
  }, [questions]);

  const allMetrics = useMemo(() => {
    const metricSet = new Set<string>();
    questions.forEach(question => {
      Object.keys(question.metrics).forEach(key => metricSet.add(key));
    });
    return Array.from(metricSet).sort();
  }, [questions]);

  // Persist visible metrics and reconcile with available metrics
  React.useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(visibleMetrics)));
    } catch {}
    try { onVisibleMetricsChange?.(Array.from(visibleMetrics)); } catch {}
  }, [visibleMetrics]);

  React.useEffect(() => {
    const allowed = new Set(allMetrics);
    const current = Array.from(visibleMetrics).filter(m => allowed.has(m));
    // If no valid selection, default to precision/recall when available
    if (current.length === 0) {
      const next = DEFAULT_VISIBLE_METRICS.filter(m => allowed.has(m));
      if (next.length > 0) setVisibleMetrics(new Set(next));
      return;
    }
    if (current.length !== visibleMetrics.size) {
      setVisibleMetrics(new Set(current));
    }
  }, [allMetrics]);

  const groupedMetricKeys = useMemo(() => {
    const groupDefs = [
      { title: 'Overall', keys: ['precision', 'recall', 'f1'] },
      { title: 'Retriever', keys: ['claim_recall', 'context_precision'] },
      { title: 'Generator', keys: ['context_utilization', 'faithfulness', 'hallucination', 'self_knowledge', 'noise_sensitivity_in_relevant', 'noise_sensitivity_in_irrelevant'] },
    ];
    const groups = groupDefs.map(g => ({
      title: g.title,
      metrics: g.keys.filter(k => allMetrics.includes(k)),
    })).filter(g => g.metrics.length > 0);
    const assigned = new Set(groups.flatMap(g => g.metrics));
    const other = allMetrics.filter(k => !assigned.has(k));
    if (other.length > 0) groups.push({ title: 'Other', metrics: other });
    return groups;
  }, [allMetrics]);

  const toggleMetric = (metric: string) => {
    const newVisible = new Set(visibleMetrics);
    if (newVisible.has(metric)) {
      newVisible.delete(metric);
    } else {
      newVisible.add(metric);
    }
    setVisibleMetrics(newVisible);
  };

  const handleBarClick = (entry: any) => {
    try {
      const qid = entry?.payload?.queryId ?? entry?.activePayload?.[0]?.payload?.queryId;
      if (qid) onSelectQuestion(qid);
    } catch {}
  };

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload;
      return (
        <div className="bg-white p-3 border border-gray-300 rounded-lg shadow-lg max-w-sm">
          <p className="font-semibold text-gray-900 mb-2">{label}</p>
          <p className="text-sm text-gray-600 mb-2 truncate">{data.query}</p>
          <div className="text-xs text-gray-500 mb-2">
            Context: {data.contextLength}w • Chunks: {data.numChunks}
          </div>
          {payload.map((entry: any, index: number) => {
            const displayInfo = getMetricDisplayInfo(data[`${entry.dataKey}_raw`], entry.dataKey);
            return (
              <div key={index} className="text-sm">
                <span style={{ color: entry.color }} className="font-medium">
                  {entry.dataKey}:
                </span>
                <span className="ml-1">
                  {(entry.value * 100).toFixed(1)}%
                </span>
                <span className="text-gray-500 ml-1">
                  (raw: {displayInfo.rawValue.toFixed(3)}
                  {displayInfo.isInverted ? ', inverted' : ''})
                </span>
              </div>
            );
          })}
          <div className="text-xs text-blue-600 mt-2">
            Click to inspect this question
          </div>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="p-6">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-900 mb-4">Metrics by Question</h2>
        
        <div className="mb-4">
          <h3 className="text-sm font-medium text-gray-700 mb-2">Visible Metrics:</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {groupedMetricKeys.map(group => (
              <div key={group.title} className="bg-white p-6 rounded-2xl shadow-md border-t-4 border-gray-200 transition-all duration-200 hover:transform hover:-translate-y-1 hover:shadow-lg">
                <h4 className="text-md font-semibold text-gray-800 mb-3">{group.title}</h4>
                <div className="flex flex-wrap gap-2">
                  {group.metrics.map(metric => (
                    <button
                      key={metric}
                      onClick={() => toggleMetric(metric)}
                      className={`px-3 py-1 text-xs rounded-full transition-colors ${
                        visibleMetrics.has(metric)
                          ? 'bg-blue-100 text-blue-800 border border-blue-300'
                          : 'bg-gray-100 text-gray-600 border border-gray-300'
                      }`}
                    >
                      {metric}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <p className="text-xs text-gray-500 mt-1">
            Showing up to 6 metrics. Click to toggle visibility.
          </p>
        </div>
      </div>

      <div className="bg-white border border-gray-200 rounded-lg p-4" style={{ height: '600px' }}>
        <h3 className="text-lg font-semibold text-center mb-4 text-gray-800">Performance Metrics Comparison Across Questions</h3>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={chartData}
            margin={{ top: 20, right: 30, left: 20, bottom: 80 }}
          >
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis 
              dataKey="questionLabel" 
              angle={-45}
              textAnchor="end"
              height={100}
              fontSize={10}
              interval={0}
            />
            <YAxis 
              domain={[0, 1]}
              tickFormatter={(value) => `${(value * 100).toFixed(0)}%`}
            />
            <Tooltip content={<CustomTooltip />} />
            <Legend />
            {Array.from(visibleMetrics).slice(0, 6).map((metric, index) => (
              <Bar
                key={metric}
                dataKey={metric}
                fill={METRIC_COLORS[index % METRIC_COLORS.length]}
                name={metric}
                cursor="pointer"
                onClick={handleBarClick}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="mt-4 text-sm text-gray-600">
        <p>
          <strong>Note:</strong> All metrics are displayed as "goodness" values (0-100%) where higher is better.
          Negative metrics like "hallucination" are inverted for display purposes.
        </p>
        <p className="mt-1">
          Click on any bar to inspect the corresponding question in detail.
        </p>
      </div>
    </div>
  );
};

export default MetricsByQuestion;