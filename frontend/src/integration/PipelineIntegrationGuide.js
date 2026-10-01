/**
 * INTEGRATION GUIDE: 3-Stage Intelligent Pipeline → Existing UI Components
 * 
 * This guide shows how to integrate the pipeline without changing existing component structure.
 * The pipeline returns data pre-formatted for seamless mapping to your components.
 */

// ═══════════════════════════════════════════════════════════════════════════════════════
// INTEGRATION EXAMPLE 1: Home.js - Using Stage 1 + Stage 2 Pipeline
// ═══════════════════════════════════════════════════════════════════════════════════════

/*
import useIntelligentPipeline from '../hooks/useIntelligentPipeline';

function Home() {
  const {
    stage1SummarizeNews,
    stage2ScrapeSchema,
    executeFullPipeline,
    loading,
    error,
    stage1Result,
    stage2Result
  } = useIntelligentPipeline();

  const [newsText, setNewsText] = useState('');
  const [govUrl, setGovUrl] = useState('');
  const [verificationData, setVerificationData] = useState(null);
  const [summaryBullets, setSummaryBullets] = useState(['', '', '']);

  // WORKFLOW 1: User pastes news text → Stage 1 extracts summary + entities
  const handleNewsSubmit = async (newsInput) => {
    const result = await stage1SummarizeNews(newsInput, 'Article Title');
    if (result) {
      // Update RTI Progress List component with bullets
      setSummaryBullets(result.summaryBullets);
      
      // Update Government Organizations list
      setGovernmentOrganizations(result.entityMappings.governments);
      
      // Update RTI Officers list
      setRTIOfficers(result.entityMappings.officers);
    }
  };

  // WORKFLOW 2: User submits gov.bd URL → Stage 2 scrapes to schema
  const handleWebsiteScrape = async (websiteUrl) => {
    const result = await stage2ScrapeSchema(websiteUrl);
    if (result) {
      // Pass directly to VerificationGrid - no transformation needed!
      setVerificationData(result.verificationData);
      
      // Optional: Display confidence scores
      console.log('Officer confidence:', result.confidence);
    }
  };

  // WORKFLOW 3: Full pipeline (news → website scrape → verification)
  const handleCompleteWorkflow = async (newsInput, websiteUrl) => {
    const pipelineResult = await executeFullPipeline(newsInput, websiteUrl);
    if (pipelineResult) {
      setSummaryBullets(pipelineResult.stage1.summaryBullets);
      setVerificationData(pipelineResult.stage2.verificationData);
    }
  };

  return (
    <div>
      {loading && <Spinner />}
      {error && <Alert severity="error">{error}</Alert>}
      
      {/* RTI Progress List - gets data from stage1Result.summaryBullets */}
      <RTIProgressList bullets={summaryBullets} />
      
      {/* Government Organizations List - gets data from stage1Result.entityMappings.governments */}
      <GovernmentOrganizationsList organizations={stage1Result?.entityMappings.governments || []} />
      
      {/* VerificationGrid - gets formatted data from stage2Result.verificationData */}
      {verificationData && <VerificationGrid databaseContact={verificationData} />}
    </div>
  );
}
*/

// ═══════════════════════════════════════════════════════════════════════════════════════
// INTEGRATION EXAMPLE 2: Search Modal - Using Stage 3 Fallback
// ═══════════════════════════════════════════════════════════════════════════════════════

/*
import useIntelligentPipeline from '../hooks/useIntelligentPipeline';
import { Dialog, DialogTitle, DialogContent, Alert, Button } from '@mui/material';

function OfficerSearchModal() {
  const { stage3FallbackLookup, loading, error, stage3Result } = useIntelligentPipeline();
  const [searchQuery, setSearchQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [fallbackSuggestion, setFallbackSuggestion] = useState(null);

  // When local search returns 0 results, trigger Stage 3
  const handleSearchWithFallback = async (officerName, ministry) => {
    // First: Try local database search
    const localMatch = await searchLocalDatabase(officerName);
    
    if (!localMatch || localMatch.length === 0) {
      // No local match found → Use Stage 3 fallback
      console.log('No local match, triggering Cerebras fallback...');
      const fallbackResult = await stage3FallbackLookup(officerName, ministry, '');
      
      if (fallbackResult) {
        setFallbackSuggestion(fallbackResult.fallbackData);
        setOpen(true); // Show suggestion modal
      }
    }
  };

  return (
    <>
      <SearchInput onSearch={(query) => handleSearchWithFallback(query, '')} />
      
      {/* Suggestion Modal for Stage 3 fallback results */}
      <Dialog open={open} onClose={() => setOpen(false)}>
        <DialogTitle>Officer Not Found in Database - Cerebras Suggestion</DialogTitle>
        <DialogContent>
          {error && <Alert severity="error">{error}</Alert>}
          {fallbackSuggestion && (
            <>
              <Alert severity="warning">
                {stage3Result?.warning} This is synthesized data. Verify through official channels.
              </Alert>
              
              {/* Display fallback result using same VerificationGrid component */}
              <VerificationGrid databaseContact={fallbackSuggestion} isLoading={loading} />
              
              <Button onClick={() => {
                // User can save/verify this data
                saveFallbackData(fallbackSuggestion);
              }}>
                Use This Data
              </Button>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
*/

// ═══════════════════════════════════════════════════════════════════════════════════════
// INTEGRATION EXAMPLE 3: React State Management
// Component integration showing proper state updates
// ═══════════════════════════════════════════════════════════════════════════════════════

/*
// In your main component (Home.js or App.js):
const [uiState, setUiState] = useState({
  // RTI Progress List data
  summaryBullets: ['', '', ''],
  
  // Government Organizations List
  governmentOrganizations: [],
  
  // RTI Officers List
  officers: [
    // { name, designation, organization }
  ],
  
  // Officer Profile Cards Grid / VerificationGrid
  selectedOfficer: null,
  verificationData: null,
  verificationLoading: false,
  
  // Stage 3 fallback modal
  fallbackSuggestion: null,
  showFallbackModal: false
});

// Update state from Stage 1 results
const applyStage1Results = (stage1Result) => {
  setUiState(prev => ({
    ...prev,
    summaryBullets: stage1Result.summaryBullets,
    governmentOrganizations: stage1Result.entityMappings.governments,
    officers: stage1Result.entityMappings.officers.map((name, idx) => ({
      name,
      designation: stage1Result.entityMappings.designations[idx] || 'Unknown',
      organization: stage1Result.entityMappings.governments[0] || ''
    }))
  }));
};

// Update state from Stage 2 results
const applyStage2Results = (stage2Result) => {
  setUiState(prev => ({
    ...prev,
    verificationData: stage2Result.verificationData,
    selectedOfficer: stage2Result.verificationData.Primary_Officer,
    verificationLoading: false
  }));
};

// Update state from Stage 3 fallback
const applyStage3Results = (stage3Result) => {
  setUiState(prev => ({
    ...prev,
    fallbackSuggestion: stage3Result.fallbackData,
    showFallbackModal: true,
    verificationLoading: false
  }));
};
*/

// ═══════════════════════════════════════════════════════════════════════════════════════
// COMPONENT INTEGRATION: Minimal Changes to Existing Components
// ═══════════════════════════════════════════════════════════════════════════════════════

/**
 * RTI Progress List Component
 * DATA SOURCE: stage1Result.summaryBullets (Array of 3 strings)
 * 
 * Example:
 * <RTIProgressList bullets={["Health ministry announces new guidelines", "RTI request filed", "Investigation ongoing"]} />
 */
const RTIProgressListIntegration = `
// In the component where RTI Progress List is rendered:
const RTIProgressList = ({ bullets = ['', '', ''] }) => {
  return (
    <List>
      {bullets.filter(b => b?.trim()).map((bullet, idx) => (
        <ListItem key={idx}>
          <ListItemIcon><CheckCircleIcon /></ListItemIcon>
          <ListItemText primary={bullet} />
        </ListItem>
      ))}
    </List>
  );
};

// Usage:
<RTIProgressList bullets={uiState.summaryBullets} />
`;

/**
 * Government Organizations List
 * DATA SOURCE: stage1Result.entityMappings.governments (Array of strings)
 */
const GovernmentOrganizationsIntegration = `
const GovernmentOrganizationsList = ({ organizations = [] }) => {
  return (
    <Box>
      {organizations.length > 0 ? (
        <List>
          {organizations.map((org, idx) => (
            <ListItem key={idx}>
              <BusinessIcon />
              <ListItemText primary={org} />
            </ListItem>
          ))}
        </List>
      ) : (
        <Typography>No organizations found</Typography>
      )}
    </Box>
  );
};

// Usage:
<GovernmentOrganizationsList organizations={uiState.governmentOrganizations} />
`;

/**
 * Officer Profile Cards Grid / VerificationGrid
 * DATA SOURCE: stage2Result.verificationData (Pre-formatted 26-column schema)
 * 
 * NO TRANSFORMATION NEEDED - Just pass the object directly!
 */
const VerificationGridIntegration = `
// The Stage 2 result is already formatted for VerificationGrid:
const stage2Result = {
  verificationData: {
    office_name: "...",
    Ministry: "...",
    Primary_Officer: "...",
    Primary_Designation: "...",
    Primary_Mobile: "...",
    Primary_Email: "...",
    Primary_Image_URL: "...",
    Alternate_Officer: "...",
    Alternate_Designation: "...",
    // ... (all 26 fields)
  }
};

// Just pass it directly - no transformation needed!
<VerificationGrid 
  databaseContact={stage2Result.verificationData}
  officerSlots={stage2Result.officerSlots}
  isLoading={loading}
/>
`;

/**
 * Search Interface with Stage 3 Fallback Modal
 * DATA SOURCE: stage3Result.fallbackData (When local search returns 0 results)
 */
const SearchWithFallbackIntegration = `
const SearchWithFallback = ({ onLocalSearchEmpty }) => {
  const [searchQuery, setSearchQuery] = useState('');
  const { stage3FallbackLookup, loading, stage3Result } = useIntelligentPipeline();
  const [showFallbackModal, setShowFallbackModal] = useState(false);

  const handleSearch = async (query) => {
    // Try local database first
    const localResults = await searchLocalDB(query);
    
    if (localResults.length === 0) {
      // No results - use Stage 3 fallback
      const fallback = await stage3FallbackLookup(query);
      if (fallback) {
        setShowFallbackModal(true);
      }
    }
  };

  return (
    <>
      <SearchInput onChange={(e) => setSearchQuery(e.target.value)} />
      <Button onClick={() => handleSearch(searchQuery)}>Search</Button>
      
      {/* Fallback suggestion modal */}
      <Dialog open={showFallbackModal} onClose={() => setShowFallbackModal(false)}>
        <DialogTitle>Officer Not in Database - Suggested from Cerebras</DialogTitle>
        <DialogContent>
          <Alert severity="warning">
            Synthesized data. Verify through official channels.
          </Alert>
          {stage3Result && (
            <VerificationGrid databaseContact={stage3Result.fallbackData} />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
};
`;

// ═══════════════════════════════════════════════════════════════════════════════════════
// API WRAPPER FUNCTIONS (Add to frontend/src/api/axiosConfig.js)
// ═══════════════════════════════════════════════════════════════════════════════════════

const apiWrappers = `
// Add these to frontend/src/api/axiosConfig.js

export const stage1SummarizeNews = async (newsText, newsTitle = '', llmProvider = 'openai') => {
  const response = await apiClient.post('/api/stage1-summarize', {
    text: newsText,
    title: newsTitle,
    llm_provider: llmProvider
  });
  return response.data;
};

export const stage2ScrapeSchema = async (websiteUrl, llmProvider = 'gemini') => {
  const response = await apiClient.post('/api/stage2-scrape', {
    url: websiteUrl,
    llm_provider: llmProvider
  });
  return response.data;
};

export const stage3FallbackLookup = async (officerName, ministry = '', context = '') => {
  const response = await apiClient.post('/api/stage3-fallback', {
    officer_name: officerName,
    ministry,
    context
  });
  return response.data;
};
`;

// Export all documentation
export default {
  integrationExamples: {
    home: 'See Example 1: Home.js integration',
    searchModal: 'See Example 2: Search Modal with Stage 3',
    stateManagement: 'See Example 3: React state management'
  },
  components: {
    rtiProgressList: RTIProgressListIntegration,
    governmentOrganizations: GovernmentOrganizationsIntegration,
    verificationGrid: VerificationGridIntegration,
    searchWithFallback: SearchWithFallbackIntegration
  },
  apiWrappers
};
