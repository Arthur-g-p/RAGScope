"""
Demo server that serves both the FastAPI backend and the built React frontend.
This file is for ngrok demos only - not tracked in git.
"""
import logging
from pathlib import Path
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

# Set up logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[logging.StreamHandler()]
)
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)
logging.getLogger("urllib3").setLevel(logging.WARNING)
logging.getLogger("litellm").setLevel(logging.WARNING)
logger = logging.getLogger(__name__)

# Load environment variables
BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

# Create FastAPI app
app = FastAPI(title="RAG-Debugger Demo", version="1.0.0")

# Add request logging middleware
@app.middleware("http")
async def log_requests(request, call_next):
    logger.info(f"{request.method} {request.url.path}")
    response = await call_next(request)
    logger.info(f"  -> {response.status_code}")
    return response

# Add CORS middleware (still needed for any direct API calls during dev)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include all the backend routes from main.py
# Import the collections endpoints and cache setup
from main import (
    get_collections,
    get_run,
    COLLECTIONS_DIR,
    _RUN_CACHE_RAW,
    _RUN_CACHE_DERIVED,
    _cache_get,
    _cache_set,
    _safe_run_path,
    compute_derived_metrics
)

# Import derive endpoint
from main import derive_metrics

# Mount the collections endpoints
app.get("/collections")(get_collections)
app.get("/collections/{collection}/runs/{run_file}")(get_run)
app.post("/derive")(derive_metrics)

# Include agent routes
try:
    from agent.routes import router as agent_router
    app.include_router(agent_router, prefix="/agent")
    logger.info("Agent routes mounted at /agent")
except Exception as e:
    logger.warning(f"Agent routes not mounted: {e}")

# Serve the built React app
FRONTEND_BUILD = BASE_DIR / "frontend" / "build"

if FRONTEND_BUILD.exists():
    # Serve static files (JS, CSS, images, etc.)
    app.mount("/static", StaticFiles(directory=FRONTEND_BUILD / "static"), name="static")
    
    # Serve index.html for root
    @app.get("/")
    async def serve_root():
        index_file = FRONTEND_BUILD / "index.html"
        if index_file.exists():
            return FileResponse(index_file)
        return {"error": "Frontend build not found"}
    
    # Catch-all for non-API paths (must be last)
    # This catches any path that doesn't start with /collections or /agent
    @app.get("/{full_path:path}")
    async def serve_react_app(full_path: str):
        """
        Serve index.html for all non-API routes to support React Router.
        API routes (/collections, /agent) are registered first so they take priority.
        """
        # Only serve index.html for non-API paths
        if not full_path.startswith(("collections", "agent")):
            index_file = FRONTEND_BUILD / "index.html"
            if index_file.exists():
                return FileResponse(index_file)
        
        # If we got here, it's an API path that wasn't found
        return {"error": "Not found"}
    
    logger.info(f"✅ Serving frontend from {FRONTEND_BUILD}")
else:
    logger.warning(f"⚠️  Frontend build not found at {FRONTEND_BUILD}")
    logger.warning("   Run: cd frontend && npm run build")
    
    @app.get("/")
    async def root():
        return {
            "message": "RAG-Debugger Demo API is running",
            "error": "Frontend build not found. Run: cd frontend && npm run build"
        }
