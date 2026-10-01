/**
 * useIntelligentPipeline - Custom Hook for 3-Stage AI Data Pipeline
 * 
 * Orchestrates:
 * 1. Stage 1: News ingestion with structured summaries
 * 2. Stage 2: Schema-enforced webpage scraping (PRIORITY)
 * 3. Stage 3: Cerebras fallback verification
 */

import { useState, useCallback } from 'react';
import { useAppContext } from '../context/AppContext';
import apiClient from '../api/axiosConfig';

/**
 * Hook for managing the 3-stage intelligent pipeline
 * 
 * Usage:
 * const {
 *   stage1SummarizeNews,
 *   stage2ScrapeSchema,
 *   stage3FallbackLookup,
 *   loading,
 *   error,
 *   results
 * } = useIntelligentPipeline();
 */
export const useIntelligentPipeline = () => {
  const { setAnalysisResults } = useAppContext();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [results, setResults] = useState({
    stage1: null,
    stage2: null,
    stage3: null
  });

  /**
   * Stage 1: AI-Powered News Ingestion & Extraction
   * Extracts 3-bullet summary + structured entities from news text
   * 
   * Maps to:
   * - RTI Progress List (summary_bullets)
   * - Government Organizations List (entities.Government_Organization)
   * - RTI Officers List (entities.Person_Names + Designations)
   */
  const stage1SummarizeNews = useCallback(async (newsText, newsTitle = '') => {
    if (!newsText) {
      setError('News text is required');
      return null;
    }

    setLoading(true);
    setError(null);

    try {
      console.log('📰 [Pipeline] Stage 1: Summarizing news article...');
      
      const response = await apiClient.post('/api/stage1-summarize', {
        text: newsText,
        title: newsTitle,
        llm_provider: 'openai' // Uses gpt-4o-mini for summaries
      });

      if (response.data.success) {
        const stage1Data = response.data;
        
        // Map summary bullets to RTI Progress List component
        const summaryBullets = stage1Data.summary_bullets || ['', '', ''];
        
        // Map entities for Government Organizations and Officers lists
        const entityMappings = {
          governments: stage1Data.entities?.Government_Organization || [],
          officers: stage1Data.entities?.Person_Names || [],
          designations: stage1Data.entities?.Designations || [],
          entities: stage1Data.entities?.Entities || []
        };

        const transformedStage1 = {
          summaryBullets,
          entityMappings,
          rawEntities: stage1Data.entities,
          metadata: stage1Data.article_metadata
        };

        setResults(prev => ({ ...prev, stage1: transformedStage1 }));
        setAnalysisResults((prev) => ({
          ...(prev || {}),
          pipeline_stage1: transformedStage1,
        }));
        console.log('✅ Stage 1 complete:', transformedStage1);
        return transformedStage1;
      }
    } catch (err) {
      const errorMsg = err.response?.data?.details || err.message || 'Stage 1 failed';
      setError(errorMsg);
      console.error('❌ Stage 1 error:', errorMsg);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Stage 2: Schema-Enforced Webpage Scraping (PRIORITY)
   * Scrapes .gov.bd links and maps to exact 26-column database schema
   * 
   * Maps to:
   * - VerificationGrid component (officer cards with images)
   * - Static Data Tables (ministry, office, contact details)
   */
  const stage2ScrapeSchema = useCallback(async (govWebsiteUrl, llmProvider = 'gemini') => {
    if (!govWebsiteUrl) {
      const msg = 'Website URL is required';
      setError(msg);
      return { success: false, error: msg };
    }

    setLoading(true);
    setError(null);

    try {
      console.log('🌐 [Pipeline] Stage 2: Scraping webpage schema...');
      
      const response = await apiClient.post('/api/stage2-scrape', {
        url: govWebsiteUrl,
        llm_provider: llmProvider
      });

      if (response.data.success) {
        const stage2Data = response.data.data;
        
        // Transform for VerificationGrid component
        const verificationGridData = {
          // Office information
          office_name: stage2Data.Office || '',
          Ministry: stage2Data.Ministry || '',
          Division: stage2Data.Division || '',
          Website_Link: stage2Data.Website_Link || '',
          
          // Primary Officer
          Primary_Officer: stage2Data.Primary_Officer_Name || '',
          Primary_Designation: stage2Data.Primary_Designation || '',
          Primary_Phone: stage2Data.Primary_Phone || '',
          Primary_Mobile: stage2Data.Primary_Mobile || '',
          Primary_Email: stage2Data.Primary_Email || '',
          Primary_Address: stage2Data.Primary_Address || '',
          Primary_Photo: stage2Data.Primary_Image_URL || '',
          Primary_Image_URL: stage2Data.Primary_Image_URL || '',
          
          // Alternate Officer
          Alternate_Officer: stage2Data.Alternate_Officer_Name || '',
          Alternate_Designation: stage2Data.Alternate_Designation || '',
          Alternate_Phone: stage2Data.Alternate_Phone || '',
          Alternate_Mobile: stage2Data.Alternate_Mobile || '',
          Alternate_Email: stage2Data.Alternate_Email || '',
          Alternate_Address: stage2Data.Alternate_Address || '',
          Alternate_Photo: stage2Data.Alternate_Image_URL || '',
          Alternate_Image_URL: stage2Data.Alternate_Image_URL || '',
          
          // Appellate Officer
          Appellate_Officer: stage2Data.Appellate_Officer_Name || '',
          Appellate_Officer_Name: stage2Data.Appellate_Officer_Name || '',
          Appellate_Designation: stage2Data.Appellate_Designation || '',
          Appellate_Phone: stage2Data.Appellate_Phone || '',
          Appellate_Mobile: stage2Data.Appellate_Mobile || '',
          Appellate_Email: stage2Data.Appellate_Email || '',
          Appellate_Address: stage2Data.Appellate_Address || '',
          Appellate_Photo: stage2Data.Appellate_Image_URL || '',
          Appellate_Image_URL: stage2Data.Appellate_Image_URL || '',
          
          Last_Updated: stage2Data.Last_Updated || new Date().toISOString().split('T')[0],
          _source: 'stage2_web_scrape'
        };

        // Calculate officer slots availability (for VerificationGrid error states)
        const officerSlots = {
          primary_found: Boolean(stage2Data.Primary_Officer_Name?.trim()),
          alternate_found: Boolean(stage2Data.Alternate_Officer_Name?.trim()),
          appellate_found: Boolean(stage2Data.Appellate_Officer_Name?.trim())
        };

        const transformedStage2 = {
          success: true,
          verificationData: verificationGridData,
          rawSchema: stage2Data,
          confidence: response.data.confidence,
          officerSlots,
          scrapingMetadata: response.data.scraping_metadata,
          rawHtmlSections: response.data.raw_html_sections
        };

        setResults(prev => ({ ...prev, stage2: transformedStage2 }));
        setAnalysisResults((prev) => ({
          ...(prev || {}),
          ...verificationGridData,
          officer_slots: officerSlots,
          pipeline_stage2: transformedStage2,
        }));
        console.log('✅ Stage 2 complete:', transformedStage2);
        return transformedStage2;
      }

      const failMsg = response.data.error || response.data.message || 'Stage 2 scrape did not succeed';
      setError(failMsg);
      return { success: false, error: failMsg };
    } catch (err) {
      const errorMsg = err.response?.data?.details || err.message || 'Stage 2 failed';
      setError(errorMsg);
      console.error('❌ Stage 2 error:', errorMsg);
      return { success: false, error: errorMsg };
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Stage 3: Real-Time Dynamic Verification Fallback
   * Uses Cerebras for ultra-fast synthesis when local DB has no match
   * 
   * Maps to:
   * - Suggestion modal/drawer in search interface
   * - VerificationGrid as fallback display
   */
  const stage3FallbackLookup = useCallback(async (officerName, ministry = '', context = '') => {
    if (!officerName) {
      setError('Officer name is required');
      return null;
    }

    setLoading(true);
    setError(null);

    try {
      console.log('⚡ [Pipeline] Stage 3: Cerebras fallback lookup...');
      
      const response = await apiClient.post('/api/stage3-fallback', {
        officer_name: officerName,
        ministry,
        context
      });

      if (response.data.success) {
        const stage3Data = response.data.officer_data;
        
        // Transform for VerificationGrid component (same schema as Stage 2)
        const fallbackGridData = {
          office_name: stage3Data.Office || ministry || 'Unknown Office',
          Ministry: stage3Data.Ministry || ministry || '',
          Primary_Officer: stage3Data.Primary_Officer_Name || officerName || '',
          Primary_Designation: stage3Data.Primary_Designation || '',
          Primary_Mobile: stage3Data.Primary_Mobile || '',
          Primary_Email: stage3Data.Primary_Email || '',
          Website_Link: stage3Data.Website_Link || '',
          Alternate_Officer: '',
          Appellate_Officer: '',
          _source: 'stage3_cerebras_fallback'
        };

        const transformedStage3 = {
          fallbackData: fallbackGridData,
          rawSynthesis: stage3Data,
          confidence: response.data.confidence,
          warning: response.data.fallback_note,
          responseTime: response.data.response_time
        };

        setResults(prev => ({ ...prev, stage3: transformedStage3 }));
        setAnalysisResults((prev) => ({
          ...(prev || {}),
          ...fallbackGridData,
          pipeline_stage3: transformedStage3,
        }));
        console.log('✅ Stage 3 complete:', transformedStage3);
        return transformedStage3;
      }
    } catch (err) {
      const errorMsg = err.response?.data?.details || err.message || 'Stage 3 failed';
      setError(errorMsg);
      console.error('❌ Stage 3 error:', errorMsg);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Orchestrate all 3 stages in sequence
   * Useful for complete news → verification workflow
   */
  const executeFullPipeline = useCallback(async (newsText, websiteUrl, llmProvider = 'gemini') => {
    try {
      console.log('🚀 [Pipeline] Executing full 3-stage pipeline...');
      
      // Stage 1: Summarize news
      const stage1Result = await stage1SummarizeNews(newsText);
      if (!stage1Result) return null;

      // Stage 2: Scrape website schema
      const stage2Result = await stage2ScrapeSchema(websiteUrl, llmProvider);
      if (!stage2Result) return null;

      console.log('✅ Full pipeline complete!');
      return {
        stage1: stage1Result,
        stage2: stage2Result,
        pipelineStatus: 'success'
      };
    } catch (err) {
      const errorMsg = err.message || 'Pipeline execution failed';
      setError(errorMsg);
      console.error('❌ Pipeline error:', errorMsg);
      return null;
    }
  }, [stage1SummarizeNews, stage2ScrapeSchema]);

  return {
    // Methods
    stage1SummarizeNews,
    stage2ScrapeSchema,
    stage3FallbackLookup,
    executeFullPipeline,
    
    // State
    loading,
    error,
    results,
    
    // Computed
    stage1Result: results.stage1,
    stage2Result: results.stage2,
    stage3Result: results.stage3
  };
};

export default useIntelligentPipeline;
