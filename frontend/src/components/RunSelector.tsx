import React, { useState, useEffect } from 'react';
import { RunData, CollectionData } from '../types';
import { logger } from '../utils/logger';

interface RunSelectorProps {
  onRunLoaded: (run: RunData) => void;
}

const RunSelector: React.FC<RunSelectorProps> = ({ onRunLoaded }) => {
  const [collections, setCollections] = useState<CollectionData>({});
  const [selectedCollection, setSelectedCollection] = useState<string>('');
  const [selectedRun, setSelectedRun] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);
  const [collectionsLoading, setCollectionsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>('');
  const [loadingDetails, setLoadingDetails] = useState<string>('');

  useEffect(() => {
    loadCollections();
  }, []);

  const loadCollections = async () => {
    try {
      setCollectionsLoading(true);
      setError('');
      logger.info('Loading collections...');
      
      const response = await fetch('http://127.0.0.1:8000/collections');
      if (!response.ok) {
        if (response.status === 404) {
          throw new Error('Backend not found. Make sure the server is running on port 8000.');
        } else if (response.status >= 500) {
          throw new Error('Server error. Check backend logs for details.');
        } else {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
      }
      
      const data: CollectionData = await response.json();
      setCollections(data);
      
      const totalCollections = Object.keys(data).length;
      const totalRuns = Object.values(data).reduce((sum, runs) => sum + runs.length, 0);
      
      logger.info(`Loaded ${totalCollections} collections with ${totalRuns} runs total`);
      
      if (totalCollections === 0) {
        setError('No collections found. Check that the collections directory contains valid JSON files.');
      }
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to connect to backend';
      logger.error(`Collection loading error: ${errorMessage}`);
      setError(errorMessage);
    } finally {
      setCollectionsLoading(false);
    }
  };

  const validateAndNormalizeRunData = (runData: any): RunData => {
    if (!runData || typeof runData !== 'object') {
      throw new Error('Invalid JSON: not an object');
    }
    
    if (!runData.metrics) {
      throw new Error('Missing required field: metrics');
    }
    
    // Handle nested results structure: "results": { "results": [...] }
    let resultsArray;
    if (runData.results) {
      if (Array.isArray(runData.results)) {
        // Direct array format: "results": [...]
        resultsArray = runData.results;
      } else if (runData.results.results && Array.isArray(runData.results.results)) {
        // Nested format: "results": { "results": [...] }
        resultsArray = runData.results.results;
      } else {
        throw new Error('Invalid results structure - expected array or nested results object');
      }
    } else {
      throw new Error('Missing results field');
    }
    
    if (resultsArray.length === 0) {
      throw new Error('Empty results array - no questions found');
    }
    
    // Normalize the structure to always have results as a direct array
    return {
      ...runData,
      results: resultsArray
    } as RunData;
  };

  const loadRun = async () => {
    if (!selectedCollection || !selectedRun) return;

    setLoading(true);
    setError('');
    setLoadingDetails('Connecting to server...');

    try {
      logger.info(`Loading run: ${selectedCollection}/${selectedRun}`);
      
      setLoadingDetails('Fetching run data...');
      const response = await fetch(`http://127.0.0.1:8000/collections/${selectedCollection}/runs/${selectedRun}`);
      
      if (!response.ok) {
        if (response.status === 404) {
          throw new Error(`Run file not found: ${selectedRun}. Check that the file exists and is accessible.`);
        } else if (response.status === 400) {
          throw new Error(`Invalid JSON file: ${selectedRun}. The file may be corrupted or have syntax errors.`);
        } else if (response.status >= 500) {
          throw new Error(`Server error while loading ${selectedRun}. Check backend logs.`);
        } else {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
      }

      setLoadingDetails('Parsing JSON data...');
      const rawData = await response.json();
      
      setLoadingDetails('Validating data structure...');
      const runData = validateAndNormalizeRunData(rawData);
      
      setLoadingDetails('Computing effectiveness analysis...');
      // Call backend /derive endpoint for advanced metrics calculation
      const deriveResponse = await fetch('http://127.0.0.1:8000/derive', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(runData),
      });
      
      if (!deriveResponse.ok) {
        throw new Error(`Failed to compute metrics: HTTP ${deriveResponse.status}`);
      }
      
      const enhancedRunData = await deriveResponse.json();

      // Attach metadata so downstream components (e.g., AgentChat) can reference source
      const withMeta = {
        ...enhancedRunData,
        collection: selectedCollection,
        file_origin: selectedRun,
      } as any;

      setLoadingDetails('Finalizing...');
      onRunLoaded(withMeta);
      logger.info(`Successfully loaded run: ${selectedCollection}/${selectedRun} (${runData.results.length} questions)`);
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      logger.error(`Run loading error: ${errorMessage}`);
      setError(errorMessage);
    } finally {
      setLoading(false);
      setLoadingDetails('');
    }
  };

  const retryConnection = () => {
    setError('');
    loadCollections();
  };

  return (
    <div className="flex items-center space-x-4">
      <div className="flex items-center space-x-2">
        <select
          value={selectedCollection}
          onChange={(e) => {
            setSelectedCollection(e.target.value);
            setSelectedRun('');
            setError('');
          }}
          className="block w-48 rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:ring-indigo-500"
          disabled={loading || collectionsLoading}
        >
          <option value="">
            {collectionsLoading ? 'Loading collections...' : 'Select Collection'}
          </option>
          {Object.keys(collections).map((collection) => (
            <option key={collection} value={collection}>
              {collection} ({collections[collection].length} runs)
            </option>
          ))}
        </select>

        <select
          value={selectedRun}
          onChange={(e) => {
            setSelectedRun(e.target.value);
            setError('');
          }}
          className="block w-48 rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:ring-indigo-500"
          disabled={!selectedCollection || loading || collectionsLoading}
        >
          <option value="">Select Run</option>
          {selectedCollection && collections[selectedCollection]?.map((run) => (
            <option key={run} value={run}>
              {run}
            </option>
          ))}
        </select>

        <button
          onClick={loadRun}
          disabled={!selectedCollection || !selectedRun || loading || collectionsLoading}
          className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? 'Loading...' : 'Load Run'}
        </button>
      </div>

      {/* Loading details */}
      {loading && loadingDetails && (
        <div className="text-sm text-blue-600">
          {loadingDetails}
        </div>
      )}

      {/* Error display with retry option */}
      {error && (
        <div className="flex items-center space-x-2">
          <div className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-md border border-red-200">
            <div className="font-medium">Error:</div>
            <div>{error}</div>
          </div>
          {error.includes('backend') && (
            <button
              onClick={retryConnection}
              className="text-xs bg-red-100 text-red-700 px-2 py-1 rounded hover:bg-red-200"
            >
              Retry
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default RunSelector;