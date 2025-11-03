import React, { useMemo, useState } from 'react';
import { RunData, Question } from '../types';
import { relAt as relationAt } from '../utils/relations';

// Lightweight markdown -> HTML formatter (safe subset)
function formatToHtml(input: string): string {
  try {
    // Escape HTML
    let s = input
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    // Code blocks ```
    s = s.replace(/```([\s\S]*?)```/g, (_m, code) => {
      const esc = String(code)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      return `<pre class="agent-pre"><code>${esc}</code></pre>`;
    });

    // Inline code
    s = s.replace(/`([^`]+)`/g, (_m, code) => `<code class="agent-code">${code}</code>`);

    // Bold and italic (simple)
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');

    // Newlines
    s = s.replace(/\n/g, '<br/>');

    return s;
  } catch {
    return input;
  }
}

export type AgentTab = 'overview' | 'metrics' | 'inspector' | 'chunks';

export interface AgentUIContext {
  activeTab: AgentTab;
  selectedRun: RunData | null;
  selectedQuestion: Question | null;
  metricsVisible?: string[]; // for metrics tab: currently visible metric keys
  inspectorVC?: any; // for inspector tab: filters/connectors state
  chunksVC?: any; // for chunks tab: filters, view-specific data
}

interface AgentChatProps {
  ui: AgentUIContext;
}

interface ToolFunctionCall { id: string; type: 'function'; function: { name: string; arguments: string } }
interface ChatMessage {
  id: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  raw: string; // plain text content (for assistant/user)
  html: string; // formatted HTML for display
  // OpenAI-style fields for tool calls/results
  tool_calls?: ToolFunctionCall[]; // assistant tool_call message
  name?: string; // tool name for role='tool'
  tool_call_id?: string; // tool result linkage
}

const uniqueId = (() => {
  // Closure counter + random suffix for uniqueness
  let c = 0;
  const rand = Math.random().toString(36).slice(2);
  return () => `m-${Date.now().toString(36)}-${(c++).toString(36)}-${rand}`;
})();

const AgentChat: React.FC<AgentChatProps> = ({ ui }) => {
const [open, setOpen] = useState<boolean>(false);
  type ChatSession = { id: string; title: string; messages: ChatMessage[]; isStreaming: boolean; currentStreamId?: string };
  const [sessions, setSessions] = useState<ChatSession[]>(() => [{
    id: 's-1',
    title: 'Session 1',
    isStreaming: false,
    currentStreamId: undefined,
    messages: []
  }]);
  const [currentSessionId, setCurrentSessionId] = useState<string>('s-1');
  const controllersRef = React.useRef<Map<string, AbortController>>(new Map());
  const [draft, setDraft] = useState<string>('');
  const [showTools, setShowTools] = useState<boolean>(false);
  const [editingMsgId, setEditingMsgId] = useState<string | null>(null);

  // Observations removed per request


  const currentSession = React.useMemo(() => sessions.find(s => s.id === currentSessionId)!, [sessions, currentSessionId]);

  const updateCurrentSession = (updater: (s: ChatSession) => ChatSession) => {
    setSessions(prev => prev.map(s => s.id === currentSessionId ? updater(s) : s));
  };

  const pushAssistant = (text: string) => {
    updateCurrentSession(s => ({
      ...s,
      messages: s.messages.concat({ id: uniqueId(), role: 'assistant', raw: text, html: formatToHtml(text) })
    }));
  };
  const pushUser = (text: string) => {
    updateCurrentSession(s => ({
      ...s,
      title: s.title === `Session ${s.id.split('-')[1]}` || s.title.startsWith('Session ') && s.messages.length <= 1 ? (text.length > 32 ? text.slice(0, 32) + '…' : text) : s.title,
      messages: s.messages.concat({ id: uniqueId(), role: 'user', raw: text, html: formatToHtml(text) })
    }));
  };

  const handleSend = () => {
    const t = draft.trim();
    if (!t) return;
    if (!ui?.selectedRun) {
      pushAssistant('Please load a run first (no run handle available).');
      setDraft('');
      return;
    }
    if (editingMsgId) {
      // Reset this session to a single edited user message, then stream
      updateCurrentSession(s => ({
        ...s,
        title: t.length > 32 ? t.slice(0, 32) + '…' : t,
        messages: [{ id: uniqueId(), role: 'user', raw: t, html: formatToHtml(t) }],
        isStreaming: false,
      }));
      setEditingMsgId(null);
    } else {
      pushUser(t);
    }
    setDraft('');
    startStream(t).catch(() => {
      pushAssistant('Request failed.');
      updateCurrentSession(s => ({ ...s, isStreaming: false }));
    });
  };


  const getRunFileName = (): string => {
    try {
      const run: any = ui.selectedRun || {};
      const fo = run.file_origin || run.run_file || '';
      if (!fo) return '';
      const parts = String(fo).split(/[/\\\\]/);
      return parts[parts.length - 1] || String(fo);
    } catch {
      return '';
    }
  };

  const startStream = async (userText: string) => {
    const run = ui.selectedRun as any;
    if (!run) return;
    const controller = new AbortController();
    controllersRef.current.set(currentSessionId, controller);
    updateCurrentSession(s => ({ ...s, isStreaming: true }));

    // Build conversation history (include tool calls/results)
    const history = currentSession.messages.map((m) => {
      if (m.role === 'user') return { role: 'user', content: m.raw } as any;
      if (m.role === 'assistant') {
        const base: any = { role: 'assistant' };
        if (m.tool_calls) {
          base.tool_calls = m.tool_calls;
          base.content = null;
        } else {
          base.content = m.raw;
        }
        return base;
      }
      if (m.role === 'tool') {
        // Pass through tool message to reduce recomputation
        return { role: 'tool', name: m.name || 'dataset_query', content: m.raw, tool_call_id: m.tool_call_id } as any;
      }
      return null;
    }).filter(Boolean);

    // Build view_context
    let view_context: any = {};
    if (ui.activeTab === 'metrics' && Array.isArray(ui.metricsVisible) && ui.metricsVisible.length > 0) {
      view_context.metrics_visible = ui.metricsVisible;
    }
    if (ui.activeTab === 'inspector') {
      view_context.subtab = 'inspector';
      view_context.inspector = {
        ...(ui.inspectorVC || {}),
        question_id: ui.selectedQuestion?.query_id || null,
        question_text: ui.selectedQuestion?.query || null,
      };
    }
    if (ui.activeTab === 'chunks' && ui.chunksVC) {
      view_context.chunks = ui.chunksVC;
      view_context.subtab = 'chunks';
    }
    const payload = {
      messages: (history as any[]).concat([{ role: 'user', content: userText }]),
      active_tab: ui.activeTab,
      view_context,
      source: {
        collection: run.collection || '',
        run_file: getRunFileName() || '',
        derived: true
      }
    };

    // Log request payload
    try {
      console.group('AgentChat ▶ request');
      console.log('POST', 'http://localhost:8000/agent/chat/stream');
      console.log('payload', payload);
      console.log('payload (json):', JSON.stringify(payload, null, 2));
      console.groupEnd();
    } catch {}

    // Create a streaming assistant message placeholder
    const streamMsgId = uniqueId();
    updateCurrentSession(s => ({
      ...s,
      currentStreamId: streamMsgId,
      messages: s.messages.concat({ id: streamMsgId, role: 'assistant', raw: '', html: '', tool_calls: undefined })
    }));

    const primaryUrl = 'http://127.0.0.1:8000/agent/chat/stream';
    const altUrl = 'http://localhost:8000/agent/chat/stream';
    let urlTried = primaryUrl;
    let res: Response | null = null;
    try {
      const doFetch = async (url: string) => fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream'
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      // First attempt
      res = await doFetch(urlTried);
      if ((!res.ok || !res.body) && (res.status === 404 || res.status === 502)) {
        // Retry with alternate host
        try { console.warn('AgentChat retrying with alternate URL'); } catch {}
        urlTried = altUrl;
        res = await doFetch(urlTried);
      }

      try {
        console.group('AgentChat ◀ response-init');
        console.log('url', urlTried);
        console.log('status', res.status, res.statusText);
        const hdrs: Record<string, string> = {};
        res.headers.forEach((v, k) => { hdrs[k] = v; });
        console.log('headers', hdrs);
        console.groupEnd();
      } catch {}

      if (!res.ok || !res.body) {
        pushAssistant(`HTTP ${res.status}: ${res.statusText}`);
        try {
          const text = await res.text();
          console.error('AgentChat error body:', text);
        } catch {}
        updateCurrentSession(s => ({ ...s, isStreaming: false }));
        controllersRef.current.delete(currentSessionId);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let done = false;
      let accumulated = '';
      let sawFinalContent = false;
      console.groupCollapsed('AgentChat ◀ SSE stream');
      const flushEvent = (evName: string | null, dataStr: string) => {
        if (dataStr === '[DONE]') { done = true; return; }
        try { console.debug('SSE parsed event', { evName, dataStr }); } catch {}
        if (evName === 'tool_call') {
          // Assistant tool-call message
          try {
            const obj = JSON.parse(dataStr);
            const toolCalls: ToolFunctionCall[] = Array.isArray(obj?.tool_calls) ? obj.tool_calls : (obj?.assistant_tool_msg?.tool_calls || []);
            setSessions(prev => prev.map(s => {
              if (s.id !== currentSessionId) return s;
              const msgs = s.messages.slice();
              msgs.push({ id: uniqueId(), role: 'assistant', raw: '', html: '', tool_calls: toolCalls });
              return { ...s, messages: msgs };
            }));
          } catch (e) {
            try { console.warn('Bad tool_call payload', e, dataStr); } catch {}
          }
          return;
        }
        if (evName === 'tool_result') {
          // Tool role message (result or error)
          try {
            const obj = JSON.parse(dataStr);
            // Expect shape similar to backend tool message; allow minimal
            const name = obj?.name || 'dataset_query';
            const content = typeof obj?.content === 'string' ? obj.content : JSON.stringify(obj?.content ?? obj);
            const tool_call_id = obj?.tool_call_id || obj?.id || undefined;
            setSessions(prev => prev.map(s => {
              if (s.id !== currentSessionId) return s;
              const msgs = s.messages.slice();
              msgs.push({ id: uniqueId(), role: 'tool', raw: content, html: formatToHtml(content), name, tool_call_id });
              return { ...s, messages: msgs };
            }));
          } catch (e) {
            try { console.warn('Bad tool_result payload', e, dataStr); } catch {}
          }
          return;
        }
        if (evName === 'done') { done = true; return; }
        // Default: final answer token
        let deltaText = '';
        try {
          const obj = JSON.parse(dataStr);
          if (obj?.delta?.content) deltaText = String(obj.delta.content);
          else if (typeof obj?.content === 'string') deltaText = obj.content;
          else if (typeof obj?.message === 'string') deltaText = obj.message;
          else if (typeof obj === 'string') deltaText = obj;
        } catch {
          deltaText = dataStr;
        }
        if (deltaText) {
          sawFinalContent = true;
          accumulated += deltaText;
          setSessions(prev => prev.map(s => {
            if (s.id !== currentSessionId) return s;
            const msgs = s.messages.slice();
            const idxMsg = msgs.findIndex(m => m.id === streamMsgId);
            if (idxMsg >= 0) {
              const m = msgs[idxMsg];
              const newRaw = (m.raw || '') + deltaText;
              msgs[idxMsg] = { ...m, raw: newRaw, html: formatToHtml(newRaw) };
            }
            return { ...s, messages: msgs };
          }));
        }
      };

      while (!done) {
        const { value, done: readerDone } = await reader.read();
        if (readerDone) break;
        const chunkText = decoder.decode(value, { stream: true });
        buffer += chunkText;
        try { console.debug('SSE raw chunk:', chunkText); } catch {}
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const eventChunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          try { console.debug('SSE event chunk:', eventChunk); } catch {}
          const lines = eventChunk.split('\n');
          let evName: string | null = null;
          let dataLines: string[] = [];
          for (const line of lines) {
            if (!line.trim()) continue;
            if (line.startsWith('event:')) { evName = line.slice(6).trim(); continue; }
            if (line.startsWith('data:')) { dataLines.push(line.slice(5).trim()); continue; }
          }
          const dataStr = dataLines.join('\n');
          flushEvent(evName, dataStr);
        }
      }
      console.groupEnd();
      try { console.log('AgentChat full assistant message:', accumulated); } catch {}
    } catch (err: any) {
      pushAssistant('Streaming error or aborted.');
      try {
        if (err?.name === 'AbortError') {
          console.warn('AgentChat stream aborted');
        } else {
          console.error('AgentChat streaming error:', err);
        }
      } catch {}
    } finally {
      // Move the streaming assistant message to the end so final prose is at the bottom
      const sid = currentSessionId;
      const mid = streamMsgId;
      setSessions(prev => prev.map(s => {
        if (s.id !== sid) return s;
        const msgs = s.messages.slice();
        const i = msgs.findIndex(m => m.id === mid);
        if (i >= 0 && i !== msgs.length - 1) {
          const [m] = msgs.splice(i, 1);
          msgs.push(m);
        }
        return { ...s, isStreaming: false, currentStreamId: undefined, messages: msgs };
      }));
      controllersRef.current.delete(currentSessionId);
    }
  };

  const handleStop = () => {
    const ctrl = controllersRef.current.get(currentSessionId);
    if (ctrl) {
      try { ctrl.abort(); } catch {}
      controllersRef.current.delete(currentSessionId);
    }
    updateCurrentSession(s => ({ ...s, isStreaming: false }));
  };

  // Heuristics-based insights for quick guidance
  const heuristics = useMemo(() => {
    const run = ui.selectedRun;
    const result = {
      harmfulTop: [] as Array<{ doc_id: string; count: number }>,
      missedOpp: [] as Array<{ doc_id: string; count: number }>,
      overReliance: [] as Array<{ doc_id: string; count: number }>,
      duplicateGroups: [] as Array<{ size: number; sampleText: string; doc_ids: string[] }>,
      metricOutliers: {
        worstByF1: [] as Array<{ query_id: string; f1: number }>,
        worstByPrecision: [] as Array<{ query_id: string; precision: number }>,
        worstByRecall: [] as Array<{ query_id: string; recall: number }>,
        highHallucination: Number(run?.metrics?.generator_metrics?.hallucination ?? 0),
        noiseRelevant: Number(run?.metrics?.generator_metrics?.noise_sensitivity_in_relevant ?? 0),
        noiseIrrelevant: Number(run?.metrics?.generator_metrics?.noise_sensitivity_in_irrelevant ?? 0),
      },
      perQuestionFlags: {
        lengthGaps: [] as Array<{ query_id: string; diff: number; gtWords: number; respWords: number }>,
        lowUtilization: [] as Array<{ query_id: string; chunks: number; context_utilization: number }>,
      },
    };
    if (!run) return result;
    try {
      const chunkMap = new Map<string, any>();
      const dupMap = new Map<string, Set<string>>();
      for (const q of run.results || []) {
        if (!Array.isArray(q.retrieved_context)) continue;
        for (const c of q.retrieved_context) {
          const text = String(c?.text || '').trim().replace(/\s+/g, ' ');
          const key = `${c?.doc_id || 'unknown'}:::${text}`;
          if (!chunkMap.has(key)) chunkMap.set(key, c.effectiveness_analysis || {});
          if (text.length > 0) {
            if (!dupMap.has(text)) dupMap.set(text, new Set());
            dupMap.get(text)!.add(String(c?.doc_id || 'unknown'));
          }
        }
      }
      const chunks = Array.from(chunkMap.entries()).map(([key, eff]) => {
        const [doc_id] = key.split(':::');
        const e = eff || {};
        return {
          doc_id,
          gt_contradictions: Number(e.gt_contradictions) || 0,
          gt_entailments: Number(e.gt_entailments) || 0,
          gt_neutrals: Number(e.gt_neutrals) || 0,
          response_entailments: Number(e.response_entailments) || 0,
          response_contradictions: Number(e.response_contradictions) || 0,
          total_appearances: Number(e.total_appearances) || 0,
        };
      });

      result.harmfulTop = chunks
        .filter((c) => c.gt_contradictions > 0)
        .sort((a, b) => (b.gt_contradictions - a.gt_contradictions) || (b.total_appearances - a.total_appearances))
        .slice(0, 5)
        .map((c) => ({ doc_id: c.doc_id, count: c.gt_contradictions }));

      result.missedOpp = chunks
        .filter((c) => c.gt_entailments > 0 && c.response_entailments === 0)
        .sort((a, b) => b.gt_entailments - a.gt_entailments)
        .slice(0, 5)
        .map((c) => ({ doc_id: c.doc_id, count: c.gt_entailments }));

      result.overReliance = chunks
        .filter((c) => c.response_entailments > 0 && c.gt_entailments === 0 && c.gt_contradictions === 0 && c.gt_neutrals > 0)
        .sort((a, b) => b.response_entailments - a.response_entailments)
        .slice(0, 5)
        .map((c) => ({ doc_id: c.doc_id, count: c.response_entailments }));

      result.duplicateGroups = Array.from(dupMap.entries())
        .map(([text, ids]) => ({ size: ids.size, sampleText: text.slice(0, 140), doc_ids: Array.from(ids) }))
        .filter((g) => g.size > 1)
        .sort((a, b) => b.size - a.size)
        .slice(0, 3);

      const qs = Array.isArray(run.results) ? run.results : [];
      result.metricOutliers.worstByF1 = [...qs]
        .map((q) => ({ query_id: q.query_id, f1: Number(q.metrics?.f1 ?? 0) }))
        .sort((a, b) => a.f1 - b.f1)
        .slice(0, 3);
      result.metricOutliers.worstByPrecision = [...qs]
        .map((q) => ({ query_id: q.query_id, precision: Number((q as any).metrics?.precision ?? Number.POSITIVE_INFINITY) }))
        .filter((x) => Number.isFinite(x.precision))
        .sort((a, b) => a.precision - b.precision)
        .slice(0, 3);
      result.metricOutliers.worstByRecall = [...qs]
        .map((q) => ({ query_id: q.query_id, recall: Number((q as any).metrics?.recall ?? Number.POSITIVE_INFINITY) }))
        .filter((x) => Number.isFinite(x.recall))
        .sort((a, b) => a.recall - b.recall)
        .slice(0, 3);

      const lengthGaps: Array<{ query_id: string; diff: number; gtWords: number; respWords: number }> = [];
      const lowUtil: Array<{ query_id: string; chunks: number; context_utilization: number }> = [];
      for (const q of qs) {
        const gtWords = (q.gt_answer || '').split(/\s+/).filter(Boolean).length;
        const respWords = (q.response || '').split(/\s+/).filter(Boolean).length;
        const diff = gtWords > 0 ? respWords / gtWords : respWords > 0 ? Infinity : 1;
        if (diff >= 2 || diff <= 0.5) {
          lengthGaps.push({ query_id: q.query_id, diff, gtWords, respWords });
        }
        const chunksCount = Array.isArray(q.retrieved_context) ? q.retrieved_context.length : 0;
        const cu = Number((q as any).metrics?.context_utilization ?? NaN);
        if (chunksCount >= 6 && Number.isFinite(cu) && cu < 0.2) {
          lowUtil.push({ query_id: q.query_id, chunks: chunksCount, context_utilization: cu });
        }
      }
      result.perQuestionFlags.lengthGaps = lengthGaps
        .sort((a, b) => Math.abs(b.diff - 1) - Math.abs(a.diff - 1))
        .slice(0, 3);
      result.perQuestionFlags.lowUtilization = lowUtil.sort((a, b) => b.chunks - a.chunks).slice(0, 3);
    } catch {}
    return result;
  }, [ui]);

  const suggestedQuestions = useMemo(() => {
    const s: string[] = [];
    const tab = ui.activeTab;
    if (tab === 'overview') {
      if (heuristics.metricOutliers.worstByF1.length > 0) s.push('Give me a brief overview of top metric outliers (precision/recall/f1) in this run.');
      if (heuristics.harmfulTop.length > 0 || heuristics.missedOpp.length > 0 || heuristics.duplicateGroups.length > 0) {
        s.push('Summarize the top issues at a glance (harmful retrieval, missed opportunities, duplicates).');
      }
    } else if (tab === 'metrics') {
      if (heuristics.metricOutliers.worstByF1.length > 0) s.push('List the 3 questions with lowest F1.');
      if (heuristics.metricOutliers.worstByPrecision.length > 0) s.push('Show the 3 questions with lowest precision.');
      if (heuristics.metricOutliers.worstByRecall.length > 0) s.push('Show the 3 questions with lowest recall.');
    } else if (tab === 'inspector') {
      if (ui.selectedQuestion) {
        s.push('For this question, show chunks contradicting the ground truth.');
        s.push('For this question, list relevant but unused chunks (missed opportunities).');
        s.push('For this question, list response claims not supported by any chunk.');
      } else {
        s.push('Select a question to analyze, then ask about harmful or missed-opportunity chunks.');
      }
    } else if (tab === 'chunks') {
      if (heuristics.harmfulTop.length > 0) s.push('List top 5 harmful chunks (GT contradictions) and where they appear.');
      if (heuristics.missedOpp.length > 0) s.push('List chunks that entail GT but were not used by the response.');
      if (heuristics.duplicateGroups.length > 0) s.push('Summarize duplicate chunk groups with examples.');
      if (heuristics.overReliance.length > 0) s.push('Show chunks used by the response that are neutral to GT (possible over-reliance).');
    }
    return s;
  }, [heuristics, ui.activeTab, ui.selectedQuestion]);

  return (
    <>
      {/* Floating action button */}
      <button
        type="button"
        aria-label="Open Agent Chat"
        className="agent-fab"
        onClick={() => setOpen(true)}
        title="Open Agent"
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M4 5.5C4 4.12 5.12 3 6.5 3h11C18.88 3 20 4.12 20 5.5v7c0 1.38-1.12 2.5-2.5 2.5H12l-4 4v-4H6.5C5.12 15 4 13.88 4 12.5v-7z" fill="#2563eb"/>
          <circle cx="8.5" cy="9" r="1" fill="white"/>
          <circle cx="12" cy="9" r="1" fill="white"/>
          <circle cx="15.5" cy="9" r="1" fill="white"/>
        </svg>
      </button>

      {open && (
        <div className="agent-window" role="dialog" aria-modal="true" aria-label="Agent Chat">
      <div className="agent-header">
            <div className="agent-title">Agent</div>
            <div className="agent-actions" style={{ gap: 6 }}>
              <label style={{ fontSize: 12, color: '#374151' }}>
                Session:
                <select
                  value={currentSessionId}
                  onChange={(e) => setCurrentSessionId(e.target.value)}
                  style={{ marginLeft: 6, padding: '2px 6px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 12 }}
                >
                  {sessions.map(s => (
                    <option key={s.id} value={s.id}>{s.title}</option>
                  ))}
                </select>
              </label>
              <button
                className="agent-btn"
                onClick={() => {
                  const n = sessions.length + 1;
                  const id = `s-${n}`;
                  setSessions(prev => prev.concat([{
                    id,
                    title: `Session ${n}`,
                    isStreaming: false,
                    currentStreamId: undefined,
                    messages: []
                  }]));
                  setCurrentSessionId(id);
                }}
                title="New session"
              >New</button>
              {currentSession?.isStreaming && (
                <button className="agent-btn" onClick={handleStop} title="Stop streaming">Stop</button>
              )}
              <button className="agent-close" onClick={() => setOpen(false)} aria-label="Close">×</button>
            </div>
          </div>
          <div className="agent-toolbar">
            <span className="agent-chip" aria-label={`Active tab ${ui.activeTab}`}>Tab: {ui.activeTab}</span>
            {ui.activeTab === 'inspector' && ui.selectedQuestion && (
              <>
                <span className="agent-chip">Q: {ui.selectedQuestion.query_id}</span>
                <span className="agent-chip" title={ui.selectedQuestion.query}>
                  “{(ui.selectedQuestion.query || '').slice(0, 28)}{(ui.selectedQuestion.query || '').length > 28 ? '…' : ''}”
                </span>
              </>
            )}
            {ui.activeTab === 'metrics' && Array.isArray(ui.metricsVisible) && ui.metricsVisible.length > 0 && (
              <span className="agent-chip" title={`Visible metrics: ${ui.metricsVisible.join(', ')}`}>Metrics: {ui.metricsVisible.slice(0,3).join(', ')}{ui.metricsVisible.length>3? '…':''}</span>
            )}
            {ui.activeTab === 'chunks' && ui.chunksVC && (
              <span className="agent-chip" title={`Chunks ${ui.chunksVC.selected_view}`}>
                {ui.chunksVC.selected_view === 'duplicates' && `Chunks: duplicates (${ui.chunksVC?.duplicates?.groups_count ?? 0})`}
                {ui.chunksVC.selected_view === 'length' && `Chunks: length (${ui.chunksVC?.length_hist?.bins_count ?? 0} bins)`}
                {ui.chunksVC.selected_view === 'frequency' && `Chunks: frequency (top ${ui.chunksVC?.filters?.top_n ?? ''})`}
              </span>
            )}
          </div>

          <div className="agent-body">
            {/* Observations banner */}
            {suggestedQuestions.length > 0 && (
              <div className="agent-suggestions" aria-live="polite">
                <div className="agent-ob-title">Ask me:</div>
                <div className="agent-suggestion-list">
                  {suggestedQuestions.map((q, i) => (
                    <button key={`sugg-${i}`} className="agent-suggestion-btn" onClick={() => setDraft(q)}>{q}</button>
                  ))}
                </div>
              </div>
            )}

            {/* Tools expander */}
            <div className="agent-tool-steps" style={{ marginTop: 4 }}>
              <button className="agent-btn" onClick={() => setShowTools(v => !v)} title="Show or hide tool steps">
                {showTools ? 'Hide tool steps' : 'Show tool steps'}
              </button>
            </div>

            <div className="agent-messages">
              {currentSession?.messages.map((m, i) => {
                // Render tool steps as compact chips (behind expander)
                if ((m.role === 'tool' || (m.role === 'assistant' && m.tool_calls)) && !showTools) {
                  return null;
                }
                if (m.role === 'tool' || (m.role === 'assistant' && m.tool_calls)) {
                  // Build chip text
                  if (m.role === 'assistant' && m.tool_calls) {
                    // Assistant tool-call
                    const tc = m.tool_calls[0];
                    let argsPretty = '';
                    try { const obj = JSON.parse(tc.function.arguments || '{}'); argsPretty = obj.expr ? String(obj.expr).slice(0, 80) : ''; } catch {}
                    const label = `${tc.function.name || 'tool'} call`;
                    return (
                      <div key={`${currentSession.id}-${m.id}`} className="agent-tool-steps">
                        <span className="agent-tool-chip loading" title={argsPretty ? `expr: ${argsPretty}` : 'tool call'}>{label}<span className="meta"> loading…</span></span>
                      </div>
                    );
                  }
                  if (m.role === 'tool') {
                    // Tool result
                    let statusClass = 'ok';
                    let title = '';
                    try {
                      const obj = JSON.parse(m.raw || '{}');
                      if (obj.error) { statusClass = 'err'; title = String(obj.error); }
                      else {
                        let rows = 0;
                        if (Array.isArray(obj.result)) rows = obj.result.length;
                        else if (obj.result && typeof obj.result === 'object') rows = Object.keys(obj.result).length;
                        const flags: string[] = [];
                        if (obj.truncated) flags.push('truncated');
                        if (obj.char_truncated) flags.push('char_truncated');
                        title = `rows=${rows}${flags.length? ' • ' + flags.join(', ') : ''}`;
                      }
                    } catch { title = 'tool result'; }
                    const label = `${m.name || 'tool'} result`;
                    return (
                      <div key={`${currentSession.id}-${m.id}`} className="agent-tool-steps">
                        <span className={`agent-tool-chip ${statusClass}`} title={title}>{label}</span>
                      </div>
                    );
                  }
                }
                // Regular bubbles
                return (
                  <div key={`${currentSession.id}-${m.id}`} className={`agent-msg agent-${m.role}`}>
                    <div className="agent-msg-bubble" dangerouslySetInnerHTML={{ __html: m.html }} />
                    {m.role === 'user' && (
                      <div style={{ marginTop: 4 }}>
                        <button
                          className="agent-btn"
                          title="Edit this prompt (resets chat)"
                          onClick={() => { setEditingMsgId(m.id); setDraft(m.raw || ''); }}
                        >Edit</button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {(currentSession?.isStreaming || editingMsgId) && (
              <div className="agent-tool-steps" aria-live="polite">
                {currentSession?.isStreaming && <span className="agent-tool-chip loading">Computing…</span>}
                {editingMsgId && <span className="agent-tool-chip" title="Editing an earlier prompt will reset this chat upon sending.">Editing mode</span>}
              </div>
            )}
          </div>
          <div className="agent-footer">
            <textarea
              className="agent-input"
placeholder="Ask a question or request calculations."
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
              }}
              rows={2}
            />
            {currentSession?.isStreaming ? (
              <button className="agent-send" disabled>
                <span className="agent-spinner" aria-hidden="true"></span>
                <span style={{ marginLeft: 6 }}>Loading…</span>
              </button>
            ) : (
              <button className="agent-send" onClick={handleSend}>Send</button>
            )}
          </div>
        </div>
      )}
    </>
  );
};

export default AgentChat;

