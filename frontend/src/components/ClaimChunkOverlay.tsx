import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Question } from '../types';
import { logger } from '../utils/logger';
import { relAt as relAtSafe } from '../utils/relations';

// Draw connectors between GT claims ↔ Chunks and Chunks ↔ Response claims
// directly over the existing three-panel grid in the Question Inspector.
// Uses data attributes placed on DOM nodes:
//  - [data-gt-claim-index]
//  - [data-chunk-index]
//  - [data-resp-claim-index]
// The overlay measures these nodes and draws SVG rectangles across the gaps
// where relations are 'Entailment'.

interface Props {
  question: Question;
  gridRef: React.RefObject<HTMLDivElement>;
  showGTClaims: boolean;
  showRespClaims: boolean;
  showChunks: boolean;
  // When this string changes, we recompute paths (used for filters)
  recalcKey?: string;
}

type Rel = 'Entailment' | 'Neutral' | 'Contradiction' | undefined;

type Rect = { x: number; y: number; width: number; height: number; fill: string; stroke: string; label: string };

// Orthogonal connector path (rectangular polyline)
type ConnPath = { d: string; stroke: string; width: number; label: string; tooltip: string; kind: 'gtChunk' | 'chunkResp'; rel: Rel; src?: { col: 'gt'|'chunk'|'resp'; index: number }; dst?: { col: 'gt'|'chunk'|'resp'; index: number } };

const relColor = (rel: Rel) => {
  switch (rel) {
    case 'Entailment':
      return { fill: 'rgba(16,185,129,0.28)', stroke: '#10b981' }; // green
    case 'Contradiction':
      return { fill: 'rgba(239,68,68,0.25)', stroke: '#ef4444' }; // red
    case 'Neutral':
    default:
      return { fill: 'rgba(156,163,175,0.18)', stroke: '#9ca3af' }; // gray
  }
};

// use shared relations helper

const ClaimChunkOverlay: React.FC<Props> = ({ question, gridRef, showGTClaims, showRespClaims, showChunks, recalcKey }) => {
  const [svgSize, setSvgSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const [paths, setPaths] = useState<ConnPath[]>([]);
  const [debugDots, setDebugDots] = useState<Array<{ x: number; y: number; color: string; label: string }>>([]);
  const [debugLines, setDebugLines] = useState<Array<{ x: number; color: string; label: string }>>([]);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [hoverPathSet, setHoverPathSet] = useState<Set<number>>(new Set());

  const compute = React.useCallback(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const rootRect = grid.getBoundingClientRect();

    const BULLET_OFFSET = 24; // attach deeper inside response item near bullet
    const CURVE = 0.30;       // slightly tighter curve
    const STROKE_W = 3;       // thinner lines for clarity

    // Identify the three columns explicitly by child index to avoid accidental scope issues
    const gtCol = grid.children.item(0) as HTMLElement | null;      // left column (GT)
    const chunkCol = grid.children.item(1) as HTMLElement | null;   // middle column (Chunks)
    const respCol = grid.children.item(2) as HTMLElement | null;    // right column (Response)

    const gtNodes = showGTClaims && gtCol
      ? (Array.from(gtCol.querySelectorAll('[data-gt-claim-index]')) as HTMLElement[])
      : [];
    const respNodes = showRespClaims && respCol
      ? (Array.from(respCol.querySelectorAll('[data-resp-claim-index]')) as HTMLElement[])
      : [];
    const chunkNodes = showChunks && chunkCol
      ? (Array.from(chunkCol.querySelectorAll('[data-chunk-index]')) as HTMLElement[])
      : [];

    // Pre-measure rects and midlines to reduce layout thrash and anchor to chunks
    const out: Rect[] = [];
    const pathsOut: ConnPath[] = [];
    const dots: Array<{ x: number; y: number; color: string; label: string }> = [];
    const lines: Array<{ x: number; color: string; label: string }> = [];
    const cleanupListeners: Array<() => void> = [];

    // Extract rects and real matrix indices from DOM attributes
    const chunkInfos = chunkNodes.map((n, i) => {
      const rect = n.getBoundingClientRect();
      const head = n.querySelector('.bg-gray-100') as HTMLElement | null;
      const headRect = head ? head.getBoundingClientRect() : rect;
      const idxAttr = n.getAttribute('data-chunk-index');
      const matrixIdx = idxAttr ? parseInt(idxAttr, 10) : i;
      return { rect, headRect, matrixIdx };
    });
    const yChunkHead = chunkInfos.map(ci => ci.headRect.top - rootRect.top + ci.headRect.height / 2);
    const gtRects = gtNodes.map(n => n.getBoundingClientRect());
    const gtRightX = gtRects.map(r => r.right - rootRect.left);
    const respRects = respNodes.map(n => n.getBoundingClientRect());
    const respLeftX = respRects.map(r => r.left - rootRect.left);
    const respBulletAnchors = respNodes.map((n, idx) => {
      const rr = respRects[idx];
      const shift = Math.max(1, STROKE_W * 0.5);
      return {
        x: rr.left - rootRect.left - shift, // just outside the left border of the li
        y: rr.top - rootRect.top + rr.height / 2,
      };
    });

    const totalChunkCount = Array.isArray((question as any).retrieved_context) ? ((question as any).retrieved_context as any[]).length : chunkInfos.length;

    // Column guide lines
    if (gtCol) {
      const r = gtCol.getBoundingClientRect();
      lines.push({ x: r.right - rootRect.left, color: '#eab308', label: 'GT.right' }); // amber
    }
    if (chunkCol) {
      const r = chunkCol.getBoundingClientRect();
      lines.push({ x: r.left - rootRect.left, color: '#60a5fa', label: 'Chunk.left' }); // blue
      lines.push({ x: r.right - rootRect.left, color: '#60a5fa', label: 'Chunk.right' });
    }
    if (respCol) {
      const r = respCol.getBoundingClientRect();
      lines.push({ x: r.left - rootRect.left, color: '#a78bfa', label: 'Resp.left' }); // purple
    }

    const r2a: any[] = Array.isArray((question as any).retrieved2answer) ? ((question as any).retrieved2answer as any[]) : [];
    const r2r: any[] = Array.isArray((question as any).retrieved2response) ? ((question as any).retrieved2response as any[]) : [];


    // GT claim → Chunk connectors (only for Entailment or Contradiction; skip Neutral by default)
    gtNodes.forEach((el, visIdx) => {
      const attr = el.getAttribute('data-gt-claim-index');
      const gi = attr != null ? parseInt(attr, 10) : visIdx; // use original index from dataset when filtered
      const xGT = gtRightX[visIdx] ?? 0;
      const rGT = gtRects[visIdx];
      const yGT = rGT ? rGT.top - rootRect.top + rGT.height / 2 : 0;
      chunkInfos.forEach((ci, idx) => {
        const cjMatrix = ci.matrixIdx;
        const rel = relAtSafe(r2a, cjMatrix, gi, totalChunkCount, gtNodes.length) as Rel;
        if (!rel || rel === 'Neutral') return; // reduce clutter
        const xChunkL = ci.rect.left - rootRect.left;
        const yChunk = yChunkHead[idx];
        // cubic bezier for smooth curve
        const dx = xChunkL - xGT;
        const c1x = xGT + dx * CURVE;
        const c2x = xGT + dx * (1 - CURVE);
        const { fill, stroke } = relColor(rel);
        const d = `M ${xGT} ${yGT} C ${c1x} ${yGT}, ${c2x} ${yChunk}, ${xChunkL} ${yChunk}`;
        const tooltip = String(rel) === 'Contradiction'
          ? 'This claim is contradicting at least one chunk. Metric: Context Precision: ▼ Note: This conflict requires attention.'
          : 'This claim can be entailed (i.e. found) in the chunks, therefore the retrieved chunks are relevant. Claim Recall ▲';
        pathsOut.push({ d, stroke, width: STROKE_W, label: `GT[${gi}] → Chunk[${cjMatrix}] :: ${rel}` , tooltip, kind: 'gtChunk', rel, src: { col: 'gt', index: gi }, dst: { col: 'chunk', index: cjMatrix } });
        dots.push({ x: xGT, y: yGT, color: stroke, label: `src GT[${gi}]` });
        dots.push({ x: xChunkL, y: yChunk, color: stroke, label: `dst Chunk[${cjMatrix}]` });
      });
    });

    // Chunk → Response claim connectors
    respNodes.forEach((el, visIdx) => {
      const attr = el.getAttribute('data-resp-claim-index');
      const ri = attr != null ? parseInt(attr, 10) : visIdx;
      const anchor = respBulletAnchors[visIdx];
      const yResp = anchor ? anchor.y : (respRects[visIdx] ? respRects[visIdx].top - rootRect.top + respRects[visIdx].height / 2 : 0);
      const xRespAttach = anchor ? anchor.x : ((respLeftX[visIdx] ?? 0) + 24);
      chunkInfos.forEach((ci, idx) => {
        const cjMatrix = ci.matrixIdx;
        const rel = relAtSafe(r2r, cjMatrix, ri, totalChunkCount, undefined) as Rel;
        if (!rel || rel === 'Neutral') return; // skip neutrals
        const xChunkR = ci.rect.right - rootRect.left;
        const yChunk = yChunkHead[idx];
        const dx = xRespAttach - xChunkR;
        const c1x = xChunkR + dx * CURVE;
        const c2x = xChunkR + dx * (1 - CURVE);
        const { fill, stroke } = relColor(rel);
        const d = `M ${xChunkR} ${yChunk} C ${c1x} ${yChunk}, ${c2x} ${yResp}, ${xRespAttach} ${yResp}`;
        const tooltip = String(rel) === 'Contradiction'
          ? 'This claim is contradicting at least one chunk.'
          : 'This claim can be entailed (i.e. found) in the chunks, therefore the retrieved chunks are used as source. Metrics: Context Utilization ▲ (if the chunk is relevant); Faithfulness ▲ (any case).';
        pathsOut.push({ d, stroke, width: STROKE_W, label: `Chunk[${cjMatrix}] → Resp[${ri}] :: ${rel}`, tooltip, kind: 'chunkResp', rel, src: { col: 'chunk', index: cjMatrix }, dst: { col: 'resp', index: ri } });
        dots.push({ x: xChunkR, y: yChunk, color: stroke, label: `src Chunk[${cjMatrix}]` });
        dots.push({ x: xRespAttach, y: yResp, color: stroke, label: `dst Resp[${ri}]` });
      });
    });

    setPaths(pathsOut);
    setDebugDots(dots);
    setDebugLines(lines);
    setSvgSize({ width: rootRect.width, height: rootRect.height });

    // DOM hover interactions: highlight related connectors when hovering claims or chunks
    const attachHover = (el: HTMLElement, selectPaths: () => number[]) => {
      const enter = () => setHoverPathSet(new Set(selectPaths()));
      const leave = () => setHoverPathSet(new Set());
      el.addEventListener('mouseenter', enter);
      el.addEventListener('mouseleave', leave);
      cleanupListeners.push(() => {
        el.removeEventListener('mouseenter', enter);
        el.removeEventListener('mouseleave', leave);
      });
    };
    // Hover over GT claim: include GT→Chunk and those chunk→Resp connectors
    gtNodes.forEach((el, gi) => attachHover(el, () => {
      const direct = pathsOut.map((p, idx) => (p.src?.col==='gt' && p.src.index===gi) ? idx : -1).filter(i=>i>=0);
      const chunkIdxs = new Set<number>(direct.map(i => (pathsOut[i].dst?.col==='chunk' ? (pathsOut[i].dst!.index) : -1)).filter(v=>v>=0));
      const chain = pathsOut.map((p, idx) => (p.src?.col==='chunk' && chunkIdxs.has(p.src.index)) ? idx : -1).filter(i=>i>=0);
      return Array.from(new Set([...direct, ...chain]));
    }));
    // Hover over Chunk: include both GT→Chunk and Chunk→Resp
    chunkInfos.forEach((ci) => {
      const el = chunkCol?.querySelector(`[data-chunk-index=\"${ci.matrixIdx}\"]`) as HTMLElement | null;
      if (el) attachHover(el, () => pathsOut.map((p, idx) => ((p.src?.col==='chunk'&&p.src.index===ci.matrixIdx)||(p.dst?.col==='chunk'&&p.dst.index===ci.matrixIdx))?idx:-1).filter(i=>i>=0));
    });
    // Hover over Response claim: include Chunk→Resp and also the GT→Chunk connectors for those chunks
    respNodes.forEach((el, ri) => attachHover(el, () => {
      const direct = pathsOut.map((p, idx) => (p.dst?.col==='resp' && p.dst.index===ri) ? idx : -1).filter(i=>i>=0);
      const chunkIdxs = new Set<number>(direct.map(i => (pathsOut[i].src?.col==='chunk' ? (pathsOut[i].src!.index) : -1)).filter(v=>v>=0));
      const chain = pathsOut.map((p, idx) => (p.dst?.col==='chunk' && chunkIdxs.has(p.dst.index)) ? idx : -1).filter(i=>i>=0);
      return Array.from(new Set([...direct, ...chain]));
    }));

    logger.info(`ClaimChunkOverlay: drew ${pathsOut.length} connectors (curved to chunk head)`);
  }, [gridRef, question, showGTClaims, showRespClaims, showChunks, recalcKey]);
  // Recompute when layout or toggles change
  useLayoutEffect(() => {
    // slight delay to allow expanded sections to mount
    const t = setTimeout(() => compute(), 0);
    return () => clearTimeout(t);
  }, [compute]);

  useEffect(() => {
    const handle = () => compute();
    window.addEventListener('resize', handle);
    let ro: ResizeObserver | null = null;
    try {
      // @ts-ignore
      if (typeof ResizeObserver !== 'undefined') {
        // @ts-ignore
        ro = new ResizeObserver(() => compute());
        if (gridRef.current) ro.observe(gridRef.current);
      }
    } catch {}
    return () => {
      window.removeEventListener('resize', handle);
      if (ro) try { ro.disconnect(); } catch {}
    };
  }, [compute, gridRef]);

  // Highlight related DOM elements on hover
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    // Clear previous highlights
    Array.from(grid.querySelectorAll('.qi-highlight')).forEach((el) => {
      (el as HTMLElement).classList.remove('qi-highlight');
    });
    const mark = (sel: string) => {
      const el = grid.querySelector(sel) as HTMLElement | null;
      if (el) el.classList.add('qi-highlight');
    };
    const indices = new Set<number>(hoverPathSet);
    if (hoverIdx !== null) indices.add(hoverIdx);
    indices.forEach((idx) => {
      const p = paths[idx];
      if (!p) return;
      if (p.src) {
        if (p.src.col === 'gt') mark(`[data-gt-claim-index="${p.src.index}"]`);
        if (p.src.col === 'chunk') mark(`[data-chunk-index="${p.src.index}"]`);
        if (p.src.col === 'resp') mark(`[data-resp-claim-index="${p.src.index}"]`);
      }
      if (p.dst) {
        if (p.dst.col === 'gt') mark(`[data-gt-claim-index="${p.dst.index}"]`);
        if (p.dst.col === 'chunk') mark(`[data-chunk-index="${p.dst.index}"]`);
        if (p.dst.col === 'resp') mark(`[data-resp-claim-index="${p.dst.index}"]`);
      }
    });
  }, [hoverIdx, hoverPathSet, paths, gridRef]);

  if (!gridRef.current) return null;

  return (
    <svg
      width={svgSize.width}
      height={svgSize.height}
      style={{ position: 'absolute', top: 0, left: 0, zIndex: 10, pointerEvents: 'none' }}
      aria-hidden="true"
      onMouseLeave={() => { setHoverIdx(null); setHoverPathSet(new Set()); }}
    >
      <defs>
        <filter id="dropShadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="1" stdDeviation="1" floodColor="#000" floodOpacity="0.12" />
        </filter>
      </defs>
      {paths.map((p, i) => (
        <g key={`p-${i}`}>
          <path
            d={p.d}
            stroke={(hoverPathSet.has(i) || hoverIdx === i) ? '#0ea5e9' : p.stroke}
            strokeWidth={(hoverPathSet.has(i) || hoverIdx === i) ? p.width + 1.5 : p.width}
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={(hoverPathSet.has(i) || hoverIdx === i) ? 1 : 0.85}
            filter="url(#dropShadow)"
            onMouseEnter={() => setHoverIdx(i)}
            pointerEvents="visibleStroke"
          >
            <title>{p.tooltip}</title>
          </path>
        </g>
      ))}
      {/* Debug endpoint dots */}
      {debugDots.map((d, i) => (
        <g key={`dot-${i}`}> 
          <circle cx={d.x} cy={d.y} r={3} fill={d.color} pointerEvents="none" />
        </g>
      ))}

      {/* Hover tooltip */}
      {hoverIdx !== null && paths[hoverIdx] && (
        <g>
          <title>{paths[hoverIdx].label}</title>
        </g>
      )}
    </svg>
  );
};

export default ClaimChunkOverlay;

