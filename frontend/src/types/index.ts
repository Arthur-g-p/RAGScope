export interface RunData {
  collection: string;
  timestamp: string;
  file_origin: string;
  metrics: {
    overall_metrics: {
      precision: number;
      recall: number;
      f1: number;
    };
    retriever_metrics: {
      claim_recall: number;
      context_precision: number;
    };
    generator_metrics: {
      context_utilization: number;
      noise_sensitivity_in_relevant: number;
      noise_sensitivity_in_irrelevant: number;
      hallucination: number;
      self_knowledge: number;
      faithfulness: number;
    };
  };
  performance: {
    rag_retrieval_seconds: number;
    rag_checker_processing_seconds: number;
  };
  results: Question[];
}

export interface Question {
  query_id: string;
  query: string;
  gt_answer: string;
  response: string;
  retrieved_context: RetrievedChunk[];
  response_claims: string[];
  gt_answer_claims: string[];
  retrieved2response: Array<Array<'Entailment' | 'Contradiction' | 'Neutral'>>;
  retrieved2answer: Array<Array<'Entailment' | 'Contradiction' | 'Neutral'>>;
  metrics: Record<string, number>;
  context_length?: number;
  num_chunks?: number;
}

export interface RetrievedChunk {
  doc_id: string;
  text: string;
  effectiveness_analysis?: {
    total_appearances: number;
    questions_appeared: string[];
    frequency_rank: number;
    total_unique_chunks: number;
    gt_entailments: number;
    gt_neutrals: number;
    gt_contradictions: number;
    response_entailments: number;
    response_neutrals: number;
    response_contradictions: number;
    total_gt_relations: number;
    total_response_relations: number;
    gt_entailment_rate: number;
    response_entailment_rate: number;
  };
  local_analysis?: {
    local_gt_entailments: number;
    local_gt_neutrals: number;
    local_gt_contradictions: number;
    local_gt_total: number;
    local_response_entailments: number;
    local_response_neutrals: number;
    local_response_contradictions: number;
    local_response_total: number;
  };
}

export interface CollectionData {
  [collection: string]: string[];
}