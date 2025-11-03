import logging
import json
import os
import copy
from collections import OrderedDict
from pathlib import Path
from typing import List, Dict, Any, Tuple
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

# Set up logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler()
    ]
)
# Suppress noisy third-party logs
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)
logging.getLogger("urllib3").setLevel(logging.WARNING)
logging.getLogger("litellm").setLevel(logging.WARNING)
# Suppress noisy third-party logs
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)
logging.getLogger("urllib3").setLevel(logging.WARNING)
logging.getLogger("litellm").setLevel(logging.WARNING)
logger = logging.getLogger(__name__)

# Load environment variables from .env if present (project root)
BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

app = FastAPI(title="RAG-Debugger Backend", version="1.0.0")

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include agent routes
try:
    from agent.routes import router as agent_router
    app.include_router(agent_router, prefix="/agent")
    logger.info("Agent routes mounted at /agent")
except Exception as e:
    logger.warning(f"Agent routes not mounted: {e}")

COLLECTIONS_DIR = Path("collections")

# Simple in-memory LRU caches for runs (raw and derived)
RUN_CACHE_SIZE = 3
_RUN_CACHE_RAW: "OrderedDict[Tuple[str, str], Dict[str, Any]]" = OrderedDict()
_RUN_CACHE_DERIVED: "OrderedDict[Tuple[str, str], Dict[str, Any]]" = OrderedDict()

def _cache_get(cache: "OrderedDict[Tuple[str, str], Dict[str, Any]]", key: Tuple[str, str]):
    if key in cache:
        val = cache.pop(key)
        cache[key] = val
        return val
    return None

def _cache_set(cache: "OrderedDict[Tuple[str, str], Dict[str, Any]]", key: Tuple[str, str], value: Dict[str, Any]):
    cache[key] = value
    while len(cache) > RUN_CACHE_SIZE:
        cache.popitem(last=False)

# Path safety helpers
_DEF_ERR = "Invalid path"

def _is_simple_name(s: str) -> bool:
    # Allow simple names without separators or traversal
    if not s:
        return False
    if ".." in s:
        return False
    if any(ch in s for ch in ("/", "\\", ":")):
        return False
    return True

def _safe_run_path(collection: str, run_file: str) -> Path:
    if not _is_simple_name(collection) or not _is_simple_name(run_file):
        raise HTTPException(status_code=400, detail=_DEF_ERR)
    if not run_file.lower().endswith(".json"):
        raise HTTPException(status_code=400, detail="Only .json run files are allowed")
    base = (COLLECTIONS_DIR / collection).resolve()
    target = (base / run_file).resolve()
    try:
        common = os.path.commonpath([str(base), str(target)])
    except Exception:
        raise HTTPException(status_code=400, detail=_DEF_ERR)
    if common != str(base):
        raise HTTPException(status_code=400, detail=_DEF_ERR)
    return target

@app.get("/")
async def root():
    return {"message": "RAG-Debugger Backend is running"}

@app.get("/collections")
async def get_collections():
    """Get list of collections and their run files."""
    try:
        logger.info("Listing collections...")
        if not COLLECTIONS_DIR.exists():
            logger.error("Collections directory does not exist")
            raise HTTPException(status_code=404, detail="Collections directory not found")
        
        collections = {}
        for collection_dir in COLLECTIONS_DIR.iterdir():
            if collection_dir.is_dir():
                run_files = []
                for file_path in collection_dir.glob("*.json"):
                    run_files.append(file_path.name)
                collections[collection_dir.name] = sorted(run_files)
        
        logger.info(f"Found {len(collections)} collections")
        return collections
    except Exception as e:
        logger.error(f"Error listing collections: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/collections/{collection}/runs/{run_file}")
async def get_run(collection: str, run_file: str, derived: bool = False):
    """Get a specific run JSON file. With derived=true, returns a cached enriched version."""
    try:
        key = (collection, run_file)
        if derived:
            cached = _cache_get(_RUN_CACHE_DERIVED, key)
            if cached is not None:
                logger.info(f"Cache hit (derived): {collection}/{run_file}")
                return cached
        else:
            cached = _cache_get(_RUN_CACHE_RAW, key)
            if cached is not None:
                logger.info(f"Cache hit (raw): {collection}/{run_file}")
                return cached

        logger.info(f"Loading run: {collection}/{run_file}")
        run_path = _safe_run_path(collection, run_file)
        if not run_path.exists():
            logger.error(f"Run file not found: {run_path}")
            raise HTTPException(status_code=404, detail="Run file not found")

        with open(run_path, 'r', encoding='utf-8') as f:
            raw_run = json.load(f)
        _cache_set(_RUN_CACHE_RAW, key, raw_run)

        if derived:
            # Work on a deep copy to keep raw cache pristine
            run_copy = json.loads(json.dumps(raw_run))
            enriched = compute_derived_metrics(run_copy)
            _cache_set(_RUN_CACHE_DERIVED, key, enriched)
            logger.info(f"Successfully loaded + derived: {collection}/{run_file}")
            return enriched
        else:
            logger.info(f"Successfully loaded run: {collection}/{run_file}")
            return raw_run
    except json.JSONDecodeError as e:
        logger.error(f"Invalid JSON in run file {collection}/{run_file}: {str(e)}")
        raise HTTPException(status_code=400, detail="Invalid JSON file")
    except Exception as e:
        logger.error(f"Error loading run {collection}/{run_file}: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

def analyze_entailment_relations(relations_matrix: List[List[str]], chunk_count: int) -> Dict[str, int]:
    """Analyze entailment relations for chunks.

    Handles both orientations:
    - chunks-first: rows = chunks, cols = claims
    - claims-first: rows = claims, cols = chunks

    We infer orientation by comparing outer length and first-row length to chunk_count.
    """
    chunk_relations: Dict[int, Dict[str, int]] = {}

    try:
        rows = len(relations_matrix) if isinstance(relations_matrix, list) else 0
        cols = 0
        for r in relations_matrix:
            try:
                if isinstance(r, list):
                    cols = max(cols, len(r))
            except Exception:
                pass

        # Determine orientation
        # Default to claims-first if ambiguous and cols matches chunk_count
        if rows == chunk_count:
            orientation = 'rows_are_chunks'
            claim_count = cols
        elif cols == chunk_count:
            orientation = 'rows_are_claims'
            claim_count = rows
        else:
            # Heuristics
            if cols >= chunk_count and (rows < chunk_count or rows == 0):
                orientation = 'rows_are_claims'
                claim_count = rows
            else:
                orientation = 'rows_are_chunks'
                claim_count = cols

        def safe_get(r: int, c: int) -> str:
            try:
                row = relations_matrix[r] if r < len(relations_matrix) and isinstance(relations_matrix[r], list) else None
                if row is None:
                    return ''
                return row[c] if c < len(row) else ''
            except Exception:
                return ''

        for chunk_idx in range(chunk_count):
            entailments = neutrals = contradictions = total = 0

            if orientation == 'rows_are_chunks':
                # Iterate claims along columns
                for claim_idx in range(max(0, claim_count)):
                    rel = safe_get(chunk_idx, claim_idx)
                    if not rel:
                        continue
                    total += 1
                    if rel == "Entailment":
                        entailments += 1
                    elif rel == "Neutral":
                        neutrals += 1
                    elif rel == "Contradiction":
                        contradictions += 1
            else:  # rows_are_claims
                for claim_idx in range(max(0, claim_count)):
                    rel = safe_get(claim_idx, chunk_idx)
                    if not rel:
                        continue
                    total += 1
                    if rel == "Entailment":
                        entailments += 1
                    elif rel == "Neutral":
                        neutrals += 1
                    elif rel == "Contradiction":
                        contradictions += 1

            chunk_relations[chunk_idx] = {
                "entailments": entailments,
                "neutrals": neutrals,
                "contradictions": contradictions,
                "total": total
            }

        return chunk_relations
    except Exception:
        # Fallback: return zeros with expected keys
        for chunk_idx in range(chunk_count):
            chunk_relations[chunk_idx] = {
                "entailments": 0,
                "neutrals": 0,
                "contradictions": 0,
                "total": 0
            }
        return chunk_relations

def calculate_chunk_frequency_stats(questions: List[Dict]) -> Dict[str, Any]:
    """Calculate chunk frequency statistics. Reusable across different analysis types."""
    chunk_stats = {}
    
    for question in questions:
        if "retrieved_context" not in question:
            continue
            
        query_id = question.get("query_id", "unknown")
        retrieved_context = question.get("retrieved_context", [])
        
        for chunk in retrieved_context:
            chunk_key = f"{chunk['doc_id']}::{chunk['text']}"
            
            if chunk_key not in chunk_stats:
                chunk_stats[chunk_key] = {
                    "doc_id": chunk["doc_id"],
                    "text": chunk["text"],
                    "total_appearances": 0,
                    "questions_appeared": []
                }
            
            stats = chunk_stats[chunk_key]
            stats["total_appearances"] += 1
            
            if query_id not in stats["questions_appeared"]:
                stats["questions_appeared"].append(query_id)
    
    # Add frequency rankings
    chunks_by_frequency = sorted(
        chunk_stats.values(),
        key=lambda x: x["total_appearances"],
        reverse=True
    )
    
    ranked_stats = {}
    for rank, chunk_info in enumerate(chunks_by_frequency, 1):
        chunk_key = f"{chunk_info['doc_id']}::{chunk_info['text']}"
        ranked_stats[chunk_key] = {
            **chunk_info,
            "frequency_rank": rank,
            "total_unique_chunks": len(chunks_by_frequency)
        }
    
    return ranked_stats

def calculate_importance_metrics(frequency: int, gt_entailments: int, total_gt_relations: int, response_entailments: int, total_response_relations: int) -> Dict[str, Any]:
    """Calculate entailment rates only."""
    gt_entailment_rate = gt_entailments / max(total_gt_relations, 1)
    response_entailment_rate = response_entailments / max(total_response_relations, 1)
    
    return {
        "gt_entailment_rate": round(gt_entailment_rate, 3),
        "response_entailment_rate": round(response_entailment_rate, 3)
    }

def analyze_local_chunk_relations(question: Dict[str, Any]) -> Dict[int, Dict[str, Any]]:
    """Analyze entailment relations for chunks within the current question only."""
    retrieved_context = question.get("retrieved_context", [])
    retrieved2answer = question.get("retrieved2answer", [])
    retrieved2response = question.get("retrieved2response", [])
    
    logger.info(f"Analyzing local relations: {len(retrieved_context)} chunks, {len(retrieved2answer)} GT relations, {len(retrieved2response)} response relations")
    
    local_relations = {}
    
    for chunk_idx in range(len(retrieved_context)):
        # Initialize counters
        gt_entailments = gt_neutrals = gt_contradictions = 0
        response_entailments = response_neutrals = response_contradictions = 0
        
        # Analyze GT relations for this chunk
        if chunk_idx < len(retrieved2answer):
            for relation in retrieved2answer[chunk_idx]:
                if relation == "Entailment":
                    gt_entailments += 1
                elif relation == "Neutral":
                    gt_neutrals += 1
                elif relation == "Contradiction":
                    gt_contradictions += 1
        
        # Analyze response relations for this chunk
        if chunk_idx < len(retrieved2response):
            for relation in retrieved2response[chunk_idx]:
                if relation == "Entailment":
                    response_entailments += 1
                elif relation == "Neutral":
                    response_neutrals += 1
                elif relation == "Contradiction":
                    response_contradictions += 1
        
        result = {
            "local_gt_entailments": gt_entailments,
            "local_gt_neutrals": gt_neutrals,
            "local_gt_contradictions": gt_contradictions,
            "local_gt_total": gt_entailments + gt_neutrals + gt_contradictions,
            "local_response_entailments": response_entailments,
            "local_response_neutrals": response_neutrals,
            "local_response_contradictions": response_contradictions,
            "local_response_total": response_entailments + response_neutrals + response_contradictions
        }
        
        local_relations[chunk_idx] = result
        logger.info(f"Chunk {chunk_idx}: GT={gt_entailments}E/{gt_neutrals}N/{gt_contradictions}C, Resp={response_entailments}E/{response_neutrals}N/{response_contradictions}C")
    
    return local_relations

def build_chunk_effectiveness_lookup(questions: List[Dict]) -> Dict[str, Any]:
    """Build comprehensive chunk effectiveness lookup. Orchestrates all analysis functions."""
    # Get frequency statistics
    frequency_stats = calculate_chunk_frequency_stats(questions)
    chunk_lookup = {}
    
    # Analyze each question for entailment data
    chunk_entailment_data = {}
    for question in questions:
        if "retrieved_context" not in question:
            continue
            
        retrieved_context = question.get("retrieved_context", [])
        retrieved2answer = question.get("retrieved2answer", [])
        retrieved2response = question.get("retrieved2response", [])
        
        # Analyze entailments for this question
        gt_relations = analyze_entailment_relations(retrieved2answer, len(retrieved_context))
        response_relations = analyze_entailment_relations(retrieved2response, len(retrieved_context))
        
        # Accumulate data for each chunk
        for chunk_idx, chunk in enumerate(retrieved_context):
            chunk_key = f"{chunk['doc_id']}::{chunk['text']}"
            
            if chunk_key not in chunk_entailment_data:
                chunk_entailment_data[chunk_key] = {
                    "gt_entailments": 0, "gt_neutrals": 0, "gt_contradictions": 0, "total_gt_relations": 0,
                    "response_entailments": 0, "response_neutrals": 0, "response_contradictions": 0, "total_response_relations": 0
                }
            
            data = chunk_entailment_data[chunk_key]
            
            # Add GT relations
            if chunk_idx in gt_relations:
                gt_rel = gt_relations[chunk_idx]
                data["gt_entailments"] += gt_rel["entailments"]
                data["gt_neutrals"] += gt_rel["neutrals"]
                data["gt_contradictions"] += gt_rel["contradictions"]
                data["total_gt_relations"] += gt_rel["total"]
            
            # Add response relations
            if chunk_idx in response_relations:
                resp_rel = response_relations[chunk_idx]
                data["response_entailments"] += resp_rel["entailments"]
                data["response_neutrals"] += resp_rel["neutrals"]
                data["response_contradictions"] += resp_rel["contradictions"]
                data["total_response_relations"] += resp_rel["total"]
    
    # Build final lookup combining frequency and entailment data
    for chunk_key, freq_data in frequency_stats.items():
        entailment_data = chunk_entailment_data.get(chunk_key, {
            "gt_entailments": 0, "gt_neutrals": 0, "gt_contradictions": 0, "total_gt_relations": 0,
            "response_entailments": 0, "response_neutrals": 0, "response_contradictions": 0, "total_response_relations": 0
        })
        
        # Calculate importance metrics
        importance = calculate_importance_metrics(
            freq_data["total_appearances"],
            entailment_data["gt_entailments"],
            entailment_data["total_gt_relations"],
            entailment_data["response_entailments"],
            entailment_data["total_response_relations"]
        )
        
        # Combine all data
        chunk_lookup[chunk_key] = {
            **freq_data,
            **entailment_data,
            **importance
        }
    
    return chunk_lookup

def compute_derived_metrics(run_data: Dict[str, Any]) -> Dict[str, Any]:
    """Compute and attach derived metrics to the run_data (in-place) and return it."""
    logger.info("Computing derived metrics...")

    # Handle both direct results and nested results structure
    questions = run_data.get("results", [])
    if isinstance(questions, dict) and "results" in questions:
        questions = questions["results"]

    # Calculate chunk effectiveness analysis using modular functions
    chunk_effectiveness_lookup = build_chunk_effectiveness_lookup(questions)

    # Add derived metrics for each question
    for question in questions:
        if "retrieved_context" in question:
            # Calculate context length in words
            context_text = " ".join([chunk["text"] for chunk in question["retrieved_context"]])
            question["context_length"] = len(context_text.split())
            question["num_chunks"] = len(question["retrieved_context"])

            # Get local entailment analysis for this question
            local_relations = analyze_local_chunk_relations(question)
            logger.info(f"Question {question.get('query_id')}: Created local analysis for {len(local_relations)} chunks")

            # Add effectiveness analysis to each chunk
            for chunk_idx, chunk in enumerate(question["retrieved_context"]):
                chunk_key = f"{chunk['doc_id']}::{chunk['text']}"

                # Add global effectiveness analysis
                if chunk_key in chunk_effectiveness_lookup:
                    chunk["effectiveness_analysis"] = chunk_effectiveness_lookup[chunk_key]

                # Add local analysis for this question - FORCE IT
                if chunk_idx in local_relations:
                    chunk["local_analysis"] = local_relations[chunk_idx]
                    logger.info(f"Chunk {chunk_idx}: Added local analysis {chunk['local_analysis']}")
                else:
                    chunk["local_analysis"] = {
                        "local_gt_entailments": 0,
                        "local_gt_neutrals": 0,
                        "local_gt_contradictions": 0,
                        "local_gt_total": 0,
                        "local_response_entailments": 0,
                        "local_response_neutrals": 0,
                        "local_response_contradictions": 0,
                        "local_response_total": 0
                    }
                    logger.warning(f"Chunk {chunk_idx}: NO local relations found, using zeros")

    logger.info("Successfully computed derived metrics with chunk effectiveness analysis")
    return run_data

@app.post("/derive")
async def derive_metrics(run_data: Dict[str, Any]):
    """Add derived metrics to run data."""
    try:
        result = compute_derived_metrics(run_data)
        return result
    except Exception as e:
        logger.error(f"Error computing derived metrics: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    host = "127.0.0.1"
    port = 8000
    logger.info(f"Starting FastAPI server on http://{host}:{port}")
    uvicorn.run("main:app", host=host, port=port, reload=True)
