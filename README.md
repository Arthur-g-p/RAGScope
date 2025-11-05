# RAG-Scope

An interactive analyzer for inspecting and debugging RAGChecker results.
Built with React and FastAPI for single-run, forensic-style evaluation of retrieval pipelines.

## Features

-   **Run Selection**: Load and analyze RAG experiment runs from JSON files
-   **Overview Tab**: All metrics showing overall, retriever, and generator metrics
-   **Metrics Tab**: Interactive bar charts comparing metrics across questions
-   **Inspector Tab**: Detailed question analysis with claims, entailments, and chunk inspection
-   **Chunks Tab**: Analysis of chunk retrieval frequency, length distribution, and duplicates

## Setup Instructions (Windows)

### Prerequisites

-   Python 3.8+ installed
-   Node.js 16+ installed
-   Windows environment

### Quick Start

1. Clone or download the project to your desired directory

2. Start the backend (Terminal A):

    ```cmd
    python -m venv venv
    venv\Scripts\activate
    pip install -r requirements.txt
    python main.py
    ```

3. Start the frontend (Terminal B):

    ```cmd
    cd frontend
    npm install
    npm start
    ```

4. Access the application:
    - Frontend: http://localhost:3000
    - Backend API: http://127.0.0.1:8000

## Usage

1. **Select a Run**: Use the dropdown in the top-right to select a collection and run
2. **Explore Tabs**:
    - **Overview**: See overall performance metrics
    - **Metrics**: Compare metrics across questions with interactive charts
    - **Inspector**: Dive deep into individual questions
    - **Chunks**: Analyze chunk retrieval patterns

## Data Structure

The application expects JSON files in the `collections/` directory with the following structure:

```
collections/
├── collection_name_1/
│   ├── run_1.json
│   ├── run_2.json
│   └── ...
├── collection_name_2/
│   └── ...
```

The name of the collection or the run JSON file does not matter.

Each run JSON file should follow the schema defined in RAGChecker (https://github.com/amazon-science/RAGChecker). Two example files are provided.

## Logging

-   Backend: Console output only (no log files are written)
-   Frontend: Browser console + in-memory log storage

## Architecture

-   **Frontend**: React + TypeScript + utility CSS classes (no Tailwind)
-   **Backend**: FastAPI (Python)
-   **Charts**: Recharts library
-   **No Authentication**: As specified in requirements

## Agentic Assistant (experimental)

The application provides an ReAct Agent at the bottom of right corner to answer questions about the application, the data, and the methodology. This feature is optional and requires your own API Key to an LLM provider of your choice. Save the key in the `.env` file.

## Troubleshooting

1. **Backend not accessible**: Check that port 8000 is not in use
2. **Frontend build errors**: Ensure Node.js 16+ is installed
3. **Python import errors**: Verify virtual environment is activated
4. **Run loading fails**: Ensure JSON files are valid and follow the expected schema. It must be the complete output Json of the RAGChecker. (https://github.com/amazon-science/RAGChecker)

## Contributions

All contributions are welcome. Important next features might be:

-   Agentic retrieval examples
-   Multi-Run View (comparison of runs)
