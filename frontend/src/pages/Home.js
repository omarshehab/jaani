/**
 * ✅ Home.js - Main Page with Full API Integration
 * 
 * Data Flow:
 * 1. User enters URL → HeroSection
 * 2. User clicks send → POST /api/analyze (extract text + media)
 * 3. Backend analysis → POST /api/analyze-text
 * 4. Automatically trigger → POST /api/verify-contact
 * 5. Display results in AnalysisAccordion + VerificationGrid
 * 6. User composes email in MailCard
 * 7. Click send → POST /api/send-mail
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Stack, Typography, Container, Alert, Snackbar, Dialog, DialogTitle, DialogContent, DialogActions, Button, CircularProgress, TextField, InputAdornment, IconButton, Autocomplete, Checkbox } from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import CheckBoxOutlineBlankIcon from '@mui/icons-material/CheckBoxOutlineBlank';
import CheckBoxIcon from '@mui/icons-material/CheckBox';
import { useTranslation } from 'react-i18next';
import { useGoogleLogin } from '@react-oauth/google';
import { useAppContext } from '../context/AppContext';
import HeroSection from '../components/HeroSection';
import AnalysisAccordion from '../components/AnalysisAccordion';
import VerificationGrid from '../components/VerificationGrid';
import MailCard from '../components/MailCard';
import RtiPostmarkComposer from '../components/RtiPostmarkComposer';
import Footer from '../components/Footer';
import ProgressWithETA from '../components/ProgressWithETA';
import useTimedProgress from '../hooks/useTimedProgress';
import useIntelligentPipeline from '../hooks/useIntelligentPipeline';
import LightbulbIcon from '@mui/icons-material/Lightbulb';
import WarningIcon from '@mui/icons-material/Warning';
import { computeUrlHash, getCachedArticle, cacheArticle, recordView, updateSentenceHighlights } from '../db/jaaniDB';
import apiClient, {
  analyzeUrl,
  analyzeText,
  buildApiUrl,
  buildAssetUrl,
  extractEntitiesFromNews as fetchExtractedEntities,
  verifyContact,
  getOfficesList,
  getLlmStatus,
  getGmailAuthUrl,
  getGmailStatus,
  exchangeGmailAuthCode,
  createGmailDraft,
  sendViaGmail,
  getEmailTemplates,
  getEmailTemplateContent,
} from '../api/axiosConfig';

const normalizePersonKey = (value = '') => (value || '').toString().normalize('NFC')
  .replace(/[​-‍]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

// Merge officials from /api/extract-entities ({name, designation, office, ministry}) into the
// analyze-text entity list as PER entities with their designation, de-duplicated by name.
// Returns null when there is nothing to merge (the caller keeps the original list).
const mergeNewsPersons = (entities, newsPersons) => {
  const persons = Array.isArray(newsPersons) ? newsPersons.filter((p) => p?.name) : [];
  if (!persons.length) return null;
  const merged = (Array.isArray(entities) ? entities : []).map((e) => ({ ...e }));
  persons.forEach((p) => {
    const key = normalizePersonKey(p.name);
    const existing = merged.find((e) => normalizePersonKey(e?.text || e?.name) === key);
    if (existing) {
      existing.label = 'PER';
      if (!existing.rank && p.designation) existing.rank = p.designation;
      return;
    }
    merged.push({
      text: p.name,
      label: 'PER',
      rank: p.designation || '',
      office: p.office || '',
      ministry: p.ministry || '',
      source: 'extract-entities',
    });
  });
  // Drop person entities that are just a longer phrase wrapping a known official's name
  // (e.g. "…বিভাগের অতিরিক্ত উপকমিশনার নিয়াজ মেহেদী" when "নিয়াজ মেহেদী" is listed).
  const personKeys = persons.map((p) => normalizePersonKey(p.name));
  return merged.filter((e) => {
    if ((e?.label || '').toUpperCase() !== 'PER') return true;
    const key = normalizePersonKey(e?.text || e?.name);
    return !personKeys.some((pk) => pk !== key && key.includes(pk));
  });
};

const Home = () => {
  const { t } = useTranslation();
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [snackbarOpen, setSnackbarOpen] = useState(false);
  const {
    loading,
    setLoading,
  } = useAppContext();

  // API Response State
  const [analysisData, setAnalysisData] = useState(null);
  const [verificationData, setVerificationData] = useState(null);
  // Manually-added Section 3 cards (from the Ministry/Division/Office search bar), kept in their
  // OWN state instead of merged into verificationData.matches: the automatic article-driven
  // verification call finishes asynchronously and does a full setVerificationData(verifyResult)
  // replace, which would silently wipe out a manual addition that landed first. Keeping them
  // separate and combining both at render time makes the manual search immune to that race.
  const [manualMatches, setManualMatches] = useState([]);
  const [prefetchedImages, setPrefetchedImages] = useState({});
  const [emailToList, setEmailToList] = useState(['']);
  const [senderEmail, setSenderEmail] = useState('');
  const [gmailConnectedEmail, setGmailConnectedEmail] = useState(null);
  const [emailSubject, setEmailSubject] = useState(t('composer.defaultSubject') || 'তথ্য অধিকার আইনে তথ্য চাহিদাপত্র — তথ্য');
  const [emailBody/*, setEmailBody*/] = useState(t('composer.defaultBody') || '<p>মাননীয় কর্মকর্তা,</p><p>আমরা নাগরিকরা প্রাসঙ্গিক তথ্য সরবরাহের জন্য আপনার সদয় পদক্ষেপ কামনা করছি।</p><p>শ্রদ্ধাসহ,<br/>সচেতন নাগরিক</p>');
  const [bodyTemplates, setBodyTemplates] = useState([]);
  const [verifying, setVerifying] = useState(false);
  const [manualOfficeQuery, setManualOfficeQuery] = useState('');
  const [manualSearching, setManualSearching] = useState(false);
  const [manualSearchError, setManualSearchError] = useState('');
  // Browse-and-pick alternative to free-text search: every (Ministry, Division, Office) row,
  // fetched once and filtered client-side by Autocomplete's own search box.
  const [officesList, setOfficesList] = useState([]);
  const [officesListLoaded, setOfficesListLoaded] = useState(false);
  const [selectedOffices, setSelectedOffices] = useState([]);
  const [officesAdding, setOfficesAdding] = useState(false);
  const [sendingEmail, setSendingEmail] = useState(false);
  const [selectedLlmProvider, setSelectedLlmProvider] = useState('auto');
  const [providerStatus, setProviderStatus] = useState(null);
  
  // ══ PIPELINE INTEGRATION: Stage 3 Fallback Modal State ══
  const [fallbackModalOpen, setFallbackModalOpen] = useState(false);
  const [fallbackData, setFallbackData] = useState(null);
  const [fallbackLoading, setFallbackLoading] = useState(false);
  const [fallbackError, setFallbackError] = useState('');
  const [lastSearchQuery, setLastSearchQuery] = useState('');
  
  const { stage3FallbackLookup } = useIntelligentPipeline();

  const analysisProgress = useTimedProgress(loading, 24);
  const verifyProgress = useTimedProgress(verifying, 20);
  const mailProgress = useTimedProgress(sendingEmail, 14);

  // When user clicks "Save Draft" / "Send" and isn't connected yet, we queue the action.
  // This avoids popup blockers by opening the OAuth popup from the user's click.
  const pendingGmailActionRef = useRef(null);
  const inFlightPrefetchRef = useRef(new Set());
  const analyzeAbortRef = useRef(null);
  const verifyAbortRef = useRef(null);
  const requestVersionRef = useRef(0);

  const isCanceledRequestError = useCallback((err) => {
    const msg = err?.message || '';
    return err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED' || /aborted|canceled|cancelled/i.test(msg);
  }, []);

  const deriveOfficeQueryFromAnalysis = useCallback((analysis) => {
    const relatedOffices = Array.isArray(analysis?.related_offices)
      ? analysis.related_offices.filter(Boolean)
      : [];

    if (relatedOffices.length > 0) {
      return relatedOffices.join(' | ');
    }

    return (
      analysis?.rti_target_office
      || analysis?.related_office
      || analysis?.related_ministry
      || ''
    );
  }, []);

  // Builds the Section 3 grounding payload from a specific analysis object (never from React
  // state directly) — passing the freshly-fetched `data` avoids a stale-closure bug where the
  // automatic post-analysis verification call would read the PREVIOUS article's analysisData
  // because setAnalysisData() had not yet re-rendered when this ran.
  const buildMlAnalysisPayload = useCallback((analysis) => {
    if (!analysis) return {};
    return {
      rti_target_office: analysis.rti_target_office || analysis.related_office || '',
      related_ministry: analysis.related_ministry || '',
      related_ministries: Array.isArray(analysis.related_ministries) ? analysis.related_ministries : [],
      entities: Array.isArray(analysis.entities) ? analysis.entities : [],
      verified_entities: Array.isArray(analysis.verified_entities) ? analysis.verified_entities : [],
      // Section 3 grounding: pass all detected government bodies from Section 2
      gov_body_matches: Array.isArray(analysis.gov_body_matches) ? analysis.gov_body_matches : [],
      mentioned_gov_orgs: Array.isArray(analysis.mentionedGovOrgs) ? analysis.mentionedGovOrgs
        : Array.isArray(analysis.mentioned_gov_orgs) ? analysis.mentioned_gov_orgs : [],
      enriched_entities: Array.isArray(analysis.enriched_entities) ? analysis.enriched_entities : [],
    };
  }, []);

  const extractEntitiesFromNews = useCallback(async (newsText, signal, llmProvider = 'auto') => {
    try {
      const response = await fetchExtractedEntities(newsText, { signal, llm_provider: llmProvider });
      if (!response?.success || !response?.enriched) {
        console.warn('Extraction failed:', response?.error || response);
        return null;
      }
      // response.extracted.entities is the LLM's full structured read of the article (every
      // ministry/office/division it named or clearly implied via an official's role, e.g. an
      // "Education Adviser" naming both Ministry of Education AND Ministry of Primary and Mass
      // Education) -- richer than `enriched`, which collapses everything down to one best-guess
      // office. Carried alongside `enriched` (unchanged, still used for the preview card) so
      // Section 3 can be grounded on all of it, not just the single best guess.
      const rawGovNames = Array.isArray(response.extracted?.entities)
        ? response.extracted.entities
          .filter((e) => ['ministry', 'division', 'office'].includes(e?.type))
          .map((e) => (e.ministry || e.division || e.office || e.name || '').toString().trim())
          .filter(Boolean)
        : [];
      return { ...response.enriched, _rawGovNames: rawGovNames };
    } catch (err) {
      console.error('Entity extraction error:', err);
      return null;
    }
  }, []);

  useEffect(() => () => {
    analyzeAbortRef.current?.abort?.();
    verifyAbortRef.current?.abort?.();
  }, []);

  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        const status = await getLlmStatus();
        if (mounted) setProviderStatus(status);
      } catch (err) {
        if (mounted) {
          setProviderStatus({ success: false, live: [] });
        }
      }
    })();
    return () => { mounted = false; };
  }, []);

  // Merges the article-driven auto matches with any manually-searched additions (kept as
  // separate state, manualMatches, precisely so a later automatic verification response can
  // never silently overwrite a manual addition). Shared by Section 3's rendering and Section 4's
  // composer (one draft per resolved office).
  const combinedMatches = useMemo(() => [
    ...(Array.isArray(verificationData?.matches) ? verificationData.matches : []),
    ...manualMatches,
  ], [verificationData, manualMatches]);

  const getGovUrlFromContact = useCallback((contact) => {
    if (!contact) return '';
    const urlFields = ['Website_Link', 'website_link', 'Website Link', 'website', 'verifyUrl', 'source_url'];
    for (const field of urlFields) {
      const val = contact?.[field];
      if (typeof val === 'string' && /^https?:\/\//i.test(val)) return val;
    }
    return '';
  }, []);

  const openUserGestureWindow = (features = 'noopener,noreferrer') => {
    try {
      return window.open('about:blank', '_blank', features);
    } catch (e) {
      return null;
    }
  };

  const navigateWindowOrNewTab = (maybeWindow, url) => {
    if (!url) return;
    try {
      if (maybeWindow && !maybeWindow.closed) {
        maybeWindow.location.href = url;
        return;
      }
    } catch (e) {
      // fall back to open
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  // Listen for OAuth popup completion (backend callback posts a message to this window)
  useEffect(() => {
    const onMessage = (event) => {
      if (!event?.data || typeof event.data !== 'object') return;
      if (event.data.type !== 'gmail_auth_success') return;

      const authedEmail = event.data.email;
      if (authedEmail) {
        setGmailConnectedEmail(authedEmail);
        setSuccessMessage(`✅ Gmail connected: ${authedEmail}`);
        setSnackbarOpen(true);
      }

      if (event.data.requestedEmail && authedEmail && event.data.matchesRequested === false) {
        setError(`You authenticated as ${authedEmail}, but you typed ${event.data.requestedEmail}. Please switch Google account or update the From address.`);
      }
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const googleConnect = useGoogleLogin({
    flow: 'auth-code',
    scope: 'https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.modify',
    onSuccess: async (tokenResponse) => {
      try {
        const code = tokenResponse?.code;
        if (!code) throw new Error('Google login did not return an auth code');

        const result = await exchangeGmailAuthCode(code);
        if (!result?.success) {
          throw new Error(result?.error || result?.message || 'Failed to connect Gmail');
        }

        setGmailConnectedEmail(result.email);
        setSenderEmail(result.email); // Sync From field with actual connected account
        setSuccessMessage(`✅ Gmail connected: ${result.email}`);
        setSnackbarOpen(true);

        // Resume any queued action (draft/send) after OAuth succeeds.
        const pending = pendingGmailActionRef.current;
        pendingGmailActionRef.current = null;

        // Update sender_email in the pending FormData to match the actually connected account.
        // This prevents mismatches where the user connected a different account than originally typed.
        if (pending?.formData && result.email) {
          pending.formData.set('sender_email', result.email);
        }

        if (pending?.type === 'draft') {
          await (async () => {
            try {
              const fd = pending.formData;
              const resultDraft = await createGmailDraft(fd);
              if (!resultDraft?.success) throw new Error(resultDraft?.error || 'Failed to create Gmail draft');

              const openUrl = resultDraft?.composeUrl || resultDraft?.draftsUrl || resultDraft?.gmailUrl;
              navigateWindowOrNewTab(pending.resultWindow, openUrl);

              setSuccessMessage('✅ Draft saved to your Gmail Drafts');
              setSnackbarOpen(true);
            } catch (err) {
              try { pending.resultWindow?.close?.(); } catch (e) {}
              setError(err?.message || 'Failed to save Gmail draft');
            } finally {
              setSendingEmail(false);
            }
          })();
        } else if (pending?.type === 'send') {
          await (async () => {
            try {
              const fd = pending.formData;
              const resultSend = await sendViaGmail(fd);
              if (!resultSend?.success) throw new Error(resultSend?.error || 'Failed to send via Gmail');

              const openUrl = resultSend?.gmailUrl || resultSend?.sentUrl;
              navigateWindowOrNewTab(pending.resultWindow, openUrl);

              setSuccessMessage('✅ Email sent via Gmail');
              setSnackbarOpen(true);
            } catch (err) {
              try { pending.resultWindow?.close?.(); } catch (e) {}
              setError(err?.message || 'Failed to send via Gmail');
            } finally {
              setSendingEmail(false);
            }
          })();
        } else {
          // No pending action; nothing to resume.
        }
      } catch (e) {
        const pending = pendingGmailActionRef.current;
        pendingGmailActionRef.current = null;
        try { pending?.resultWindow?.close?.(); } catch (closeErr) {}
        setError(e?.message || 'Failed to connect Gmail');
        setSendingEmail(false);
      }
    },
    onError: () => {
      const pending = pendingGmailActionRef.current;
      pendingGmailActionRef.current = null;
      try { pending?.resultWindow?.close?.(); } catch (closeErr) {}
      setError('Google login failed or was cancelled');
      setSendingEmail(false);
    },
  });

  useEffect(() => {
    const email = (senderEmail || '').trim();
    if (!email) {
      setGmailConnectedEmail(null);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const status = await getGmailStatus(email);
        if (cancelled) return;
        if (status?.success && status?.connected) {
          setGmailConnectedEmail(status.email || email);
        } else {
          setGmailConnectedEmail(null);
        }
      } catch (e) {
        if (!cancelled) setGmailConnectedEmail(null);
      }
    }, 500);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [senderEmail]);

  const openGmailAuthPopupAndWait = async ({ force = false } = {}) => {
    const email = (senderEmail || '').trim();
    if (!email) throw new Error('Please enter your Gmail address in the From field first.');

    // Open first (user gesture), then navigate after we fetch URL.
    const popup = window.open('about:blank', 'gmail_oauth', 'width=520,height=720,noopener,noreferrer');

    if (!popup) {
      throw new Error('Popup blocked. Please allow popups for this site and try again.');
    }

    const auth = await getGmailAuthUrl(email, force);
    if (!auth?.success || !auth?.url) {
      try { popup.close(); } catch (e) {}
      throw new Error(auth?.error || 'Failed to generate Gmail auth URL');
    }

    try {
      popup.location.href = auth.url;
    } catch (e) {
      try { popup.close(); } catch (e2) {}
      throw new Error('Failed to open authentication window. Please try again.');
    }

    // Wait for the postMessage from callback
    await new Promise((resolve, reject) => {
      const timeoutMs = 120000;
      const startedAt = Date.now();

      let cleanedUp = false;
      let handler;

      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        if (handler) window.removeEventListener('message', handler);
        clearInterval(interval);
      };

      const interval = setInterval(() => {
        if (popup.closed) {
          cleanup();
          reject(new Error('Authentication window closed before completion.'));
        } else if (Date.now() - startedAt > timeoutMs) {
          try { popup.close(); } catch (e) {}
          cleanup();
          reject(new Error('Authentication timed out. Please try again.'));
        }
      }, 400);

      handler = (event) => {
        if (!event?.data || typeof event.data !== 'object') return;
        if (event.data.type !== 'gmail_auth_success') return;
        cleanup();
        resolve();
      };

      window.addEventListener('message', handler);
    });
  };

  /*
  const ensureGmailConnected = async () => {
    const email = (senderEmail || '').trim();
    if (!email) throw new Error('Please enter your Gmail address in the From field first.');

    try {
      const status = await getGmailStatus(email);
      if (status?.success && status?.connected) {
        setGmailConnectedEmail(status.email || email);
        if (status.matchesRequested === false) {
          throw new Error(`Connected Gmail is ${status.email}, but From is ${email}.`);
        }
        return;
      }
    } catch (e) {
      // fall through to auth popup
    }

    await openGmailAuthPopupAndWait({ force: false });
  };
  */

  /**
   * Build FormData from compose instance data (used by MailCard callbacks).
   * composeData: { to, cc, bcc, subject, bodyHtml, bodyText, attachments: File[] }
   */
  const buildFormDataFromCompose = (composeData) => {
    const fd = new FormData();
    fd.append('sender_email', (senderEmail || '').trim());
    fd.append('to', (composeData.to || '').trim().replace(/[\r\n]+/g, ''));
    if (composeData.cc) fd.append('cc', composeData.cc.trim().replace(/[\r\n]+/g, ''));
    if (composeData.bcc) fd.append('bcc', composeData.bcc.trim().replace(/[\r\n]+/g, ''));
    fd.append('subject', composeData.subject || '');
    fd.append('body_text', composeData.bodyText || '');
    fd.append('body_html', composeData.bodyHtml || '');
    if (Array.isArray(composeData.attachments)) {
      composeData.attachments.forEach((file) => {
        if (file) fd.append('files', file, file.name);
      });
    }
    return fd;
  };

  useEffect(() => {
    let disposed = false;

    const loadBodyTemplates = async () => {
      try {
        const list = await getEmailTemplates();
        const fileNames = Array.isArray(list?.templates) ? list.templates : [];
        if (!fileNames.length || disposed) {
          if (!disposed) setBodyTemplates([]);
          return;
        }

        const loaded = await Promise.all(
          fileNames.map(async (name) => {
            try {
              const detail = await getEmailTemplateContent(name);
              if (!detail?.success) return null;
              return {
                filename: name,
                content: detail.content || '',
                format: detail.format || 'text',
              };
            } catch {
              return null;
            }
          })
        );

        if (!disposed) {
          setBodyTemplates(loaded.filter(Boolean));
        }
      } catch {
        if (!disposed) setBodyTemplates([]);
      }
    };

    loadBodyTemplates();
    return () => {
      disposed = true;
    };
  }, []);

  /**
   * Step 1: Handle URL Analysis
   * Phase 1 — POST /api/analyze: the article (title, images, body HTML) is shown the
   *           moment extraction returns, with no AI data yet.
   * Phase 2 — POST /api/analyze-text + POST /api/extract-entities run in parallel; their
   *           results are merged into the already-visible article (highlights appear then).
   * Phase 3 — sentence highlights (salience ensemble) arrive later into `sentenceHighlights`.
   * Every state write after an await is guarded by requestVersionRef, and the merge is also
   * keyed on the request id stored in the state, so a stale request can never overwrite a newer one.
   */
  const handleAnalyzeUrl = async (overrideUrl = '') => {
    const targetUrl = (overrideUrl || url || '').trim();
    const isValidTargetUrl = /https?:\/\/[\w-]+(\.[\w-]+)+[/#?]?.*$/.test(targetUrl);
    let analysisReady = false;

    if (!targetUrl || !isValidTargetUrl) {
      setError(t('home.invalidUrl') || 'Invalid URL format');
      return;
    }

    const requestId = requestVersionRef.current + 1;
    requestVersionRef.current = requestId;
    const isCurrentRequest = () => requestId === requestVersionRef.current;

    analyzeAbortRef.current?.abort?.();
    verifyAbortRef.current?.abort?.();
    const analyzeController = new AbortController();
    analyzeAbortRef.current = analyzeController;

    setError('');
    setSuccessMessage('');
    setLoading(true);
    setVerifying(false);
    setAnalysisData(null);
    setVerificationData(null);
    setManualMatches([]);

    try {
      console.log(`\n📰 [HOME] Starting analysis for: ${targetUrl}`);

      try {
        localStorage.setItem('rti_last_analyzed_url', targetUrl);
      } catch (e) {
        console.warn('Could not save to localStorage:', e);
      }

      // Cache key from THIS submission's URL (never from later input state), same hash as the
      // backend's reader token / salience urlHash. '' when Web Crypto is unavailable → no cache.
      const urlHash = await computeUrlHash(targetUrl);
      if (!isCurrentRequest()) return;

      // Phase 3 helper: sentence highlights from the salience ensemble (runs server-side after
      // /api/analyze-text answered). Poll every 2s for up to 90s; stop on ready, timeout, or a
      // newer submission. Failure just means no sentence highlights — never an error.
      const startSaliencePolling = (salienceHash) => {
        if (!salienceHash) return;
        void (async () => {
          const deadline = Date.now() + 90000;
          const salienceStartedAt = Date.now();
          while (Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 2000));
            if (!isCurrentRequest()) return;
            try {
              const resp = await apiClient.get('/api/salience-status', {
                params: { urlHash: salienceHash },
                timeout: 10000,
                validateStatus: (status) => status < 500,
              });
              if (!isCurrentRequest()) return;
              if (resp.status === 404) return;
              if (resp.status === 200 && resp.data?.ready) {
                const sentenceHighlights = Array.isArray(resp.data.sentenceHighlights) ? resp.data.sentenceHighlights : [];
                console.log(`✨ [HOME] Sentence highlights: ${sentenceHighlights.length} (ratio ${resp.data.ratio}, ${resp.data.providerCount}/3 providers) after ${Date.now() - salienceStartedAt}ms`);
                setAnalysisData((prev) => {
                  if (!prev || prev.requestId !== requestId) return prev;
                  return { ...prev, sentenceHighlights, salience_ratio: resp.data.ratio || 0 };
                });
                if (sentenceHighlights.length) {
                  void updateSentenceHighlights(urlHash, sentenceHighlights).catch(() => {});
                }
                return;
              }
            } catch (e) {
              // transient network error — keep polling until the deadline
            }
          }
        })();
      };

      // RTI Act guidance for the RTI officer card (routing, deadlines, exemption flags, questions).
      // Runs after the analysis is on screen; always fetched fresh because deadlines count from today.
      const startRtiGuidance = (data) => {
        const text = data?.text || data?.extractedText || '';
        if (!text) return;
        void apiClient.post('/api/rti-guidance', {
          text,
          title: data?.meta_data?.title || '',
          llm_provider: selectedLlmProvider,
        }, { timeout: 60000, signal: analyzeController.signal }).then((resp) => {
          if (!isCurrentRequest() || !resp?.data?.success) return;
          setAnalysisData((prev) => {
            if (!prev || prev.requestId !== requestId) return prev;
            return { ...prev, rti_guidance: resp.data.guidance };
          });
        }).catch(() => { /* guidance is optional; the card works without it */ });
      };

      // Section 3 hand-off: officer verification from the analysis result. Section 3 must only
      // ever show cards for organizations Section 2 actually detected and lists under "Detected
      // Organizations" -- no pre-populated shortcut card from a raw single-officer extraction
      // guess (extractedEntityData/verification_prefetch used to set one immediately here,
      // before the real detected-organizations resolution below even ran).
      const startVerification = (data) => {
        const officeQuery = deriveOfficeQueryFromAnalysis(data);
        if (officeQuery) {
          console.log(`\n🔍 [HOME] Automatically triggering verification for: ${officeQuery}`);

          // Step 2 (fast): Load database-backed officer data first.
          // Step 3 (enhanced): Continue enriching with live website details in background.
          void (async () => {
            await handleVerifyContact(officeQuery, selectedLlmProvider, {
              requestId,
              enrichWeb: false,
              allowDbFallback: false,
              mlAnalysisData: data,
            });

            if (!isCurrentRequest()) {
              return;
            }

            await handleVerifyContact(officeQuery, selectedLlmProvider, {
              requestId,
              enrichWeb: true,
              allowDbFallback: true,
              mlAnalysisData: data,
            });
          })();
        } else {
          console.log('⚠️ No related office found in analysis');
        }
      };

      // ── Phase 0: browser cache (Dexie, 24h) — a hit skips /api/analyze and both AI calls ──
      const cached = urlHash ? await getCachedArticle(urlHash).catch(() => null) : null;
      if (!isCurrentRequest()) return;
      if (cached?.analysis) {
        const cachedData = {
          ...cached.analysis,
          articleHtml: cached.articleHtml,
          requestId,
          ai_status: 'done',
          fromCache: true,
          sentenceHighlights: Array.isArray(cached.sentenceHighlights) ? cached.sentenceHighlights : [],
        };
        setAnalysisData(cachedData);
        analysisReady = true;
        setLoading(false);
        console.log(`⚡ [HOME] Article served from browser cache (${urlHash.slice(0, 12)}…) — no /api/analyze or AI calls`);
        void recordView(urlHash, cachedData.meta_data?.title || targetUrl).catch(() => {});

        // The Live Page reader keeps highlight inputs in memory for 10 minutes only — hand them back.
        if (cachedData.proxyModeAvailable) {
          void apiClient.post('/api/reader-payload', {
            url: targetUrl,
            entities: cachedData.entities || [],
            keywords: cachedData.keywords || [],
            sentenceHighlights: cachedData.sentenceHighlights,
          }, { timeout: 10000 }).catch(() => {});
        }

        if (!cachedData.sentenceHighlights.length) startSaliencePolling(cachedData.url_hash || urlHash);
        startRtiGuidance(cachedData);
        startVerification(cachedData);
        return;
      }

      // ── Phase 1: extract the article and render it immediately ──
      const extractionResponse = await analyzeUrl({ url: targetUrl }, {
        signal: analyzeController.signal,
      });

      if (!isCurrentRequest()) return;

      const extractedText = extractionResponse?.text || '';
      const media = extractionResponse?.media || {
        images: [],
        external_videos: [],
        self_hosted_videos: [],
      };

      if (!extractedText) {
        throw new Error('No content extracted from the URL. The site may be blocking access.');
      }

      const buildMetaData = (aiData = {}) => ({
        ...(aiData?.meta_data || {}),
        source: targetUrl,
        domain: new URL(targetUrl).hostname,
        url: targetUrl,
        title: extractionResponse?.title || aiData?.meta_data?.title || '',
        subtitle: extractionResponse?.subtitle || aiData?.meta_data?.subtitle || '',
        author: extractionResponse?.author || aiData?.meta_data?.author || '',
        date: extractionResponse?.publicationDate || aiData?.meta_data?.date || '',
        site_name: extractionResponse?.siteName || '',
        modified: extractionResponse?.modifiedDate || '',
        canonical_url: extractionResponse?.canonicalUrl || '',
      });

      // Extraction-owned fields: these always win over anything the AI response carries.
      const articleFields = {
        requestId,
        text: extractedText,
        extractedText,
        media,
        images: (media.images || []).map((src) => ({ src, alt: 'Article image' })),
        video_present: (media.external_videos || []).length > 0 || (media.self_hosted_videos || []).length > 0,
        articleHtml: extractionResponse?.articleHtml || '',
        proxyModeAvailable: Boolean(extractionResponse?.proxyModeAvailable),
      };

      setAnalysisData({
        ...articleFields,
        meta_data: buildMetaData(),
        ai_status: 'pending',
        // Filled later by the sentence-salience ensemble (Phase 3).
        sentenceHighlights: [],
      });
      analysisReady = true;
      setLoading(false);
      console.log(`⏱️ [HOME] Article rendered; starting AI analysis (request ${requestId})`);

      // ── Phase 2: both AI calls in parallel; a failure in one keeps the other's result ──
      const [analysisOutcome, entityOutcome] = await Promise.allSettled([
        analyzeText(extractedText, {
          llm_provider: selectedLlmProvider,
          url: targetUrl,
          signal: analyzeController.signal,
        }),
        extractEntitiesFromNews(extractedText, analyzeController.signal, selectedLlmProvider),
      ]);

      if (!isCurrentRequest()) return;

      const analysisResponse = analysisOutcome.status === 'fulfilled' ? analysisOutcome.value : null;
      const aiData = analysisResponse?.success ? (analysisResponse.data || {}) : {};
      const extractedEntityData = entityOutcome.status === 'fulfilled' ? entityOutcome.value : null;
      const analysisFailed = !analysisResponse?.success;

      if (analysisFailed) {
        const reason = analysisOutcome.status === 'rejected'
          ? (analysisOutcome.reason?.response?.data?.error || analysisOutcome.reason?.message)
          : analysisResponse?.error;
        console.warn('⚠️ [HOME] /api/analyze-text failed:', reason);
        if (!(analysisOutcome.status === 'rejected' && isCanceledRequestError(analysisOutcome.reason))) {
          setError(`AI analysis failed (${reason || 'unknown error'}). The article is shown without highlights.`);
        }
      }

      // Officials named in the article, with designation, from /api/extract-entities (the richer
      // extractor) join the analyze-text entities so Section 2 shows them directly.
      const mergedEntities = mergeNewsPersons(aiData.entities, extractedEntityData?.news_persons);
      const aiUnavailable = Boolean(aiData.analysis_unavailable);

      // Section 3 grounding: analyze-text's gazetteer-based mentioned_gov_orgs only catches literal
      // Bengali name mentions; extract-entities' LLM read also infers a ministry from an official's
      // stated role (e.g. "Education Adviser" -> both Ministry of Education and Ministry of Primary
      // and Mass Education, neither ever named verbatim in the article). Union both, deduped, so
      // Section 3 is grounded on everything actually detected, not just the gazetteer's substring hits.
      const baseGovOrgs = Array.isArray(aiData.mentionedGovOrgs) ? aiData.mentionedGovOrgs
        : Array.isArray(aiData.mentioned_gov_orgs) ? aiData.mentioned_gov_orgs : [];
      const rawGovNames = Array.isArray(extractedEntityData?._rawGovNames) ? extractedEntityData._rawGovNames : [];
      const mentionedGovOrgs = Array.from(new Set([...baseGovOrgs, ...rawGovNames]));

      const mergedData = {
        ...aiData,
        ...(mergedEntities ? { entities: mergedEntities } : {}),
        ...articleFields,
        meta_data: buildMetaData(aiData),
        extractedEntityData,
        mentioned_gov_orgs: mentionedGovOrgs,
        mentionedGovOrgs,
        ai_status: aiUnavailable ? 'unavailable' : (analysisFailed && !extractedEntityData ? 'failed' : 'done'),
      };

      setAnalysisData((prev) => {
        // Only merge into the article this request rendered (not a newer one, not a reset).
        if (!prev || prev.requestId !== requestId) return prev;
        return { ...mergedData, sentenceHighlights: prev.sentenceHighlights || [] };
      });
      console.log('📊 Analysis Data:', mergedData);

      // Cache only a successful analysis (a failed one would pin a highlight-less article for 24h).
      // Fire-and-forget, after the render: IndexedDB never delays what the user sees.
      if (!analysisFailed && !aiUnavailable && urlHash) {
        void cacheArticle(urlHash, targetUrl, mergedData).catch((e) => console.warn('[jaaniDB] cache write failed:', e?.message || e));
      }

      startSaliencePolling(aiData?.salience_pending ? (aiData?.url_hash || '') : '');
      startRtiGuidance(mergedData);
      startVerification(mergedData);

    } catch (err) {
      if (isCanceledRequestError(err)) {
        console.log('ℹ️ [HOME] Analysis request canceled due to a newer request.');
        return;
      }
      console.error('❌ Analysis Error:', err);
      if (!isCurrentRequest()) return;
      const errorMsg = err.response?.data?.error || err.message || 'Analysis failed';
      setError(errorMsg);
    } finally {
      if (analyzeAbortRef.current === analyzeController) {
        analyzeAbortRef.current = null;
      }
      if (isCurrentRequest() && !analysisReady) {
        setLoading(false);
      }
    }
  };

  /**
   * Step 2: Handle Contact Verification
   * POST /api/verify-contact with office_name
   * Displays both database and live scraped records
   */
  const handleVerifyContact = useCallback(async (officeName, providerOverride = '', options = {}) => {
    const activeProvider = (providerOverride || selectedLlmProvider || 'auto').toString().trim().toLowerCase() || 'auto';
    const {
      requestId = requestVersionRef.current,
      enrichWeb = true,
      allowDbFallback = true,
      mlAnalysisData = null,
    } = options;

    if (!officeName || requestId !== requestVersionRef.current) {
      return;
    }

    verifyAbortRef.current?.abort?.();
    const verifyController = new AbortController();
    verifyAbortRef.current = verifyController;

    setVerifying(true);
    let quickFallbackTimer = null;
    try {
      console.log(`\n🔍 [HOME] Verifying contact for: ${officeName} (provider=${activeProvider})`);

      // Extract detected government organizations from Section 2 analysis for Section 3 matching.
      // Prefer the explicitly-passed source (fresh, just-fetched data) over React state, which may
      // not have re-rendered yet when this is called right after setAnalysisData().
      const mlAnalysis = buildMlAnalysisPayload(mlAnalysisData || analysisData);

      // First try enriched verification (includes live web lookup).
      // If that fails (often due site blocking / timeout), fallback to DB-only mode.
      let verifyResult;
      try {
        verifyResult = await verifyContact(officeName, enrichWeb, {
          llm_provider: activeProvider,
          signal: verifyController.signal,
          mlAnalysis, // Pass semantic analysis for intelligent office matching
        });
      } catch (enrichErr) {
        if (isCanceledRequestError(enrichErr)) {
          throw enrichErr;
        }
        if (!enrichWeb || !allowDbFallback) {
          throw enrichErr;
        }

        console.warn('⚠️ Enriched verification failed, retrying database-only verification:', enrichErr?.message || enrichErr);
        verifyResult = await verifyContact(officeName, false, {
          llm_provider: activeProvider,
          signal: verifyController.signal,
          mlAnalysis, // Pass semantic analysis even in fallback
        });
        setSuccessMessage('⚠️ Live website verification failed. Showing database results only.');
        setSnackbarOpen(true);
      }

      if (requestId !== requestVersionRef.current) {
        return;
      }

      console.log('✅ Verification response:', verifyResult);
      
      // Show message if fuzzy/fallback results
      if (verifyResult?.fuzzyMatch) {
        setSuccessMessage(`⚠️ Exact match not found. Showing similar offices for "${officeName}"`);
        setSnackbarOpen(true);
      } else if (verifyResult?.fallback) {
        setSuccessMessage(`⚠️ No match found for "${officeName}". Showing common government offices.`);
        setSnackbarOpen(true);
      } else if (verifyResult?.fromWebSearch) {
        setSuccessMessage(`✅ Found contact information from web search`);
        setSnackbarOpen(true);
      }
      
      if (Array.isArray(verifyResult?.matches)) {
        const seenMatches = new Set();
        verifyResult = {
          ...verifyResult,
          matches: verifyResult.matches.filter((m) => {
            const key = [m?.Office || m?.office_name, m?.Website_Link, m?.Primary_Officer, m?.Alternate_Officer, m?.Appellate_Officer].join('|');
            if (seenMatches.has(key)) return false;
            seenMatches.add(key);
            return true;
          }),
        };
      }

      setVerificationData(verifyResult);
      setPrefetchedImages({});
      inFlightPrefetchRef.current = new Set();

      // Pre-populate email with resolved officers' emails (only from grounded, deduplicated cards)
      const allEmails = [];
      if (Array.isArray(verifyResult?.matches) && verifyResult.matches.length > 0) {
        verifyResult.matches.forEach((match) => {
          // Skip cards that resolved to "none" (no officers found)
          if (match?.resolution?.rung === 'none') return;
          const email = match?.Primary_Email || match?.duty_officer_email || match?.email;
          if (email && !allEmails.includes(email)) allEmails.push(email);
        });
      }

      if (allEmails.length > 0) {
        const officeLabel = officeName || 'তথ্য';
        setEmailSubject(`তথ্য অধিকার আইনে তথ্য চাহিদাপত্র — ${officeLabel}`);
        setEmailToList(allEmails);
      }

    } catch (err) {
      if (isCanceledRequestError(err)) {
        console.log('ℹ️ [HOME] Verification request canceled due to a newer request.');
        return;
      }
      console.error('❌ Verification Error:', err);
      const errorMsg = err.response?.data?.error || err.message || 'Verification failed';
      setError(errorMsg);
    } finally {
      if (quickFallbackTimer) {
        clearTimeout(quickFallbackTimer);
      }
      if (verifyAbortRef.current === verifyController) {
        verifyAbortRef.current = null;
      }
      if (requestId === requestVersionRef.current) {
        setVerifying(false);
      }
    }
  }, [analysisData, buildMlAnalysisPayload, isCanceledRequestError, selectedLlmProvider]);

  const handleRetryVerification = useCallback(async () => {
    if (verifying) return;
    const officeQuery = deriveOfficeQueryFromAnalysis(analysisData || {});
    if (!officeQuery) {
      setError('No office context available to retry verification.');
      return;
    }
    await handleVerifyContact(officeQuery, selectedLlmProvider, {
      requestId: requestVersionRef.current,
      enrichWeb: true,
      allowDbFallback: true,
    });
  }, [analysisData, deriveOfficeQueryFromAnalysis, handleVerifyContact, selectedLlmProvider, verifying]);

  const handleUseCacheVerification = useCallback(async () => {
    if (verifying) return;
    const officeQuery = deriveOfficeQueryFromAnalysis(analysisData || {});
    if (!officeQuery) {
      setError('No office context available for local cache verification.');
      return;
    }
    await handleVerifyContact(officeQuery, selectedLlmProvider, {
      requestId: requestVersionRef.current,
      enrichWeb: false,
      allowDbFallback: false,
    });
  }, [analysisData, deriveOfficeQueryFromAnalysis, handleVerifyContact, selectedLlmProvider, verifying]);

  // ══ Section 3: manual Ministry/Division/Office search ══
  // Lets the user type an office the article-driven resolution missed and pull it in directly
  // from the CSV, without re-running (or discarding) the article-based verification above it.
  // Reuses the same /api/verify-contact endpoint and ladder/AI-fallback resolution as the
  // automatic path — a manual search finds exactly what an article mention would have found.
  const handleManualOfficeSearch = useCallback(async () => {
    const query = manualOfficeQuery.trim();
    if (!query || manualSearching) return;

    setManualSearching(true);
    setManualSearchError('');
    try {
      const result = await verifyContact(query, false, { llm_provider: selectedLlmProvider || 'auto' });
      const newMatches = Array.isArray(result?.matches) ? result.matches : [];

      if (newMatches.length === 0) {
        setManualSearchError(result?.message || `"${query}"-এর জন্য কোনো তথ্য পাওয়া যায়নি।`);
        return;
      }

      setManualMatches((prevManual) => {
        const autoMatches = Array.isArray(verificationData?.matches) ? verificationData.matches : [];
        const existingKeys = new Set(
          [...autoMatches, ...prevManual].map((m) => m?.resolution?.resolvedRowKey).filter(Boolean)
        );
        const toAdd = newMatches.filter((m) => !existingKeys.has(m?.resolution?.resolvedRowKey));
        if (toAdd.length === 0) return prevManual; // already shown — nothing new to add
        return [...prevManual, ...toAdd];
      });
      setManualOfficeQuery('');
    } catch (err) {
      console.error('❌ Manual office search error:', err);
      setManualSearchError(err?.response?.data?.error || err?.message || 'অনুসন্ধান ব্যর্থ হয়েছে');
    } finally {
      setManualSearching(false);
    }
  }, [manualOfficeQuery, manualSearching, selectedLlmProvider, verificationData]);

  const ensureOfficesListLoaded = useCallback(async () => {
    if (officesListLoaded) return;
    try {
      const result = await getOfficesList();
      if (Array.isArray(result?.offices)) setOfficesList(result.offices);
    } catch (err) {
      console.error('❌ Failed to load offices list:', err);
    } finally {
      setOfficesListLoaded(true);
    }
  }, [officesListLoaded]);

  // Adds every checked office from the browse dropdown, the same way a free-text search does
  // (exact Office-name match against the CSV, so this always resolves directly -- no AI fallback
  // needed since the option text IS the canonical CSV spelling).
  const handleAddSelectedOffices = useCallback(async () => {
    if (selectedOffices.length === 0 || officesAdding) return;
    setOfficesAdding(true);
    setManualSearchError('');
    try {
      const results = await Promise.all(
        selectedOffices.map((opt) => verifyContact(opt.office, false, { llm_provider: selectedLlmProvider || 'auto' }).catch(() => null))
      );
      const newMatches = results.flatMap((r) => (Array.isArray(r?.matches) ? r.matches : []));
      setManualMatches((prevManual) => {
        const autoMatches = Array.isArray(verificationData?.matches) ? verificationData.matches : [];
        const existingKeys = new Set(
          [...autoMatches, ...prevManual].map((m) => m?.resolution?.resolvedRowKey).filter(Boolean)
        );
        const toAdd = newMatches.filter((m) => !existingKeys.has(m?.resolution?.resolvedRowKey));
        // De-dupe within this same batch too (two selected offices resolving to the same row).
        const seen = new Set();
        const deduped = toAdd.filter((m) => {
          const k = m?.resolution?.resolvedRowKey;
          if (k && seen.has(k)) return false;
          if (k) seen.add(k);
          return true;
        });
        if (deduped.length === 0) return prevManual;
        return [...prevManual, ...deduped];
      });
      setSelectedOffices([]);
    } catch (err) {
      console.error('❌ Add selected offices error:', err);
      setManualSearchError(err?.message || 'নির্বাচিত দপ্তর যোগ করতে ব্যর্থ হয়েছে');
    } finally {
      setOfficesAdding(false);
    }
  }, [selectedOffices, officesAdding, selectedLlmProvider, verificationData]);

  // ══ PIPELINE INTEGRATION: Stage 3 Fallback Handler ══
  const handleFallbackSearch = useCallback(async (searchQuery = '') => {
    const queryToUse = searchQuery || lastSearchQuery || verificationData?.searchQuery || 'Government Officer';
    
    if (!queryToUse) {
      setFallbackError('Unable to determine search query for fallback.');
      return;
    }

    setFallbackLoading(true);
    setFallbackError('');
    setFallbackData(null);
    
    try {
      const result = await stage3FallbackLookup(
        queryToUse,
        analysisData?.rti_target_office || analysisData?.related_ministry || 'Government',
        `RTI search for: ${queryToUse}`
      );

      if (result && result.fallbackData) {
        setFallbackData(result.fallbackData);
        setFallbackModalOpen(true);
      } else {
        setFallbackError('Unable to generate fallback suggestions. Please try a different search.');
      }
    } catch (err) {
      console.error('Stage 3 fallback error:', err);
      setFallbackError(err.message || 'Error generating fallback suggestions. Please try again.');
    } finally {
      setFallbackLoading(false);
    }
  }, [lastSearchQuery, verificationData, analysisData, stage3FallbackLookup]);

  // ═══════════════════════════════════════════════════════════════════
  // Dynamic edit/update: instantly reflect saved changes in the UI
  // ═══════════════════════════════════════════════════════════════════
  const handleContactUpdated = useCallback((updatedContact, matchIndex) => {
    setVerificationData((prev) => {
      if (!prev) return prev;
      const next = { ...prev };

      if (Array.isArray(next.matches) && next.matches.length > 0) {
        // Multi-match mode: update the specific match by index
        next.matches = next.matches.map((m, idx) =>
          idx === matchIndex ? { ...m, ...updatedContact } : m
        );
      } else if (next.databaseRecord) {
        // Single record mode
        next.databaseRecord = { ...next.databaseRecord, ...updatedContact };
      }

      return next;
    });

    // Show success feedback
    setSuccessMessage('✅ Contact updated successfully!');
    setSnackbarOpen(true);
  }, []);

  // Batch prefetch officer images for verification results
  useEffect(() => {
    const run = async () => {
      const matches = Array.isArray(verificationData?.matches) ? verificationData.matches : [];
      const contacts = matches.length > 0
        ? matches
        : (verificationData?.databaseRecord ? [verificationData.databaseRecord] : []);

      if (!contacts || contacts.length === 0) return;

      const urls = contacts.map(getGovUrlFromContact).filter(Boolean);
      if (urls.length === 0) return;

      const unique = Array.from(new Set(urls));
      const toFetch = unique.filter((u) => !prefetchedImages[u] && !inFlightPrefetchRef.current.has(u));
      if (toFetch.length === 0) return;

      // Stay in the in-flight set after completion so URLs with no image aren't re-requested forever.
      toFetch.forEach((u) => inFlightPrefetchRef.current.add(u));
      try {
        const resp = await fetch(buildApiUrl('/api/extract-images'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ urls: toFetch }),
        });
        const data = await resp.json();
        if (data?.success && Array.isArray(data.results)) {
          setPrefetchedImages((prev) => {
            const next = { ...prev };
            for (const r of data.results) {
              if (r?.url && r?.imageUrl) next[r.url] = buildAssetUrl(r.imageUrl);
            }
            return next;
          });
        }
      } catch (e) {
        // Non-critical; individual cards will still fetch.
      }
    };

    run();
  }, [verificationData, getGovUrlFromContact, prefetchedImages]);

  /**
   * Step 3: Save Draft or Send via Gmail API
   * Called by MailCard with per-compose-instance data.
   * composeData: { to, cc, bcc, subject, bodyHtml, bodyText, attachments: File[] }
   * options:     { openWindow: boolean } — false for bulk operations
   */
  const handleSaveDraftForCompose = async (composeData, options = {}) => {
    if (!composeData?.to || !composeData?.subject) {
      setError('Please fill in recipient and subject');
      return { success: false, error: 'Missing required fields' };
    }

    try {
      setError('');
      const openWindow = options.openWindow !== false;
      const resultWindow = openWindow ? openUserGestureWindow() : null;
      setSendingEmail(true);

      const fromEmail = (senderEmail || '').trim();
      const connectedMatches =
        Boolean(gmailConnectedEmail) &&
        (!fromEmail || gmailConnectedEmail.toLowerCase() === fromEmail.toLowerCase());

      const fd = buildFormDataFromCompose(composeData);

      if (!connectedMatches) {
        if (!openWindow) {
          // Bulk mode — can't queue, ask user to connect first
          return { success: false, needsAuth: true, error: 'Please connect Gmail first' };
        }
        pendingGmailActionRef.current = { type: 'draft', formData: fd, resultWindow };
        await handleConnectGmail();
        return { success: false, connecting: true };
      }

      const result = await createGmailDraft(fd);
      if (!result?.success) {
        throw new Error(result?.message || result?.error || 'Failed to create Gmail draft');
      }

      const openUrl = result?.composeUrl || result?.draftsUrl || result?.gmailUrl;
      if (resultWindow) navigateWindowOrNewTab(resultWindow, openUrl);

      setSuccessMessage('✅ Draft saved to your Gmail Drafts');
      setSnackbarOpen(true);
      return { success: true };
    } catch (e) {
      setError(e?.message || 'Failed to save Gmail draft');
      return { success: false, error: e?.message };
    } finally {
      setSendingEmail(false);
    }
  };

  const handleSendForCompose = async (composeData, options = {}) => {
    if (!composeData?.to || !composeData?.subject) {
      setError('Please fill in recipient and subject');
      return { success: false, error: 'Missing required fields' };
    }

    try {
      setError('');
      const openWindow = options.openWindow !== false;
      const resultWindow = openWindow ? openUserGestureWindow() : null;
      setSendingEmail(true);

      const fromEmail = (senderEmail || '').trim();
      const connectedMatches =
        Boolean(gmailConnectedEmail) &&
        (!fromEmail || gmailConnectedEmail.toLowerCase() === fromEmail.toLowerCase());

      const fd = buildFormDataFromCompose(composeData);

      if (!connectedMatches) {
        if (!openWindow) {
          return { success: false, needsAuth: true, error: 'Please connect Gmail first' };
        }
        pendingGmailActionRef.current = { type: 'send', formData: fd, resultWindow };
        await handleConnectGmail();
        return { success: false, connecting: true };
      }

      const result = await sendViaGmail(fd);
      if (!result?.success) {
        throw new Error(result?.message || result?.error || 'Failed to send via Gmail');
      }

      const openUrl = result?.gmailUrl || result?.sentUrl;
      if (resultWindow) navigateWindowOrNewTab(resultWindow, openUrl);

      setSuccessMessage('✅ Email sent via Gmail');
      setSnackbarOpen(true);
      return { success: true };
    } catch (e) {
      setError(e?.message || 'Failed to send via Gmail');
      return { success: false, error: e?.message };
    } finally {
      setSendingEmail(false);
    }
  };

  const handleConnectGmail = async () => {
    try {
      setError('');
      if (process.env.REACT_APP_GOOGLE_CLIENT_ID) {
        googleConnect();
        return;
      }
      await openGmailAuthPopupAndWait({ force: false });
    } catch (e) {
      setError(e?.message || 'Failed to connect Gmail');
    }
  };

  return (
    <Box sx={{ backgroundColor: 'transparent', minHeight: '100vh' }}>
      {/* Hero Section */}
      <Box
        sx={{
          minHeight: { xs: '52vh', md: '74vh' },
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
          py: { xs: 2.5, md: 5.5 },
          px: { xs: 1, md: 0 },
          backgroundColor: 'transparent',
        }}
      >
        <Container maxWidth="lg">
          <Stack spacing={3} alignItems="center">
            {/* URL Input Hero */}
            <Box sx={{ mt: { xs: -6, md: -14 } }}>
              <HeroSection
                value={url}
                onChange={setUrl}
                onSubmit={handleAnalyzeUrl}
                loading={loading}
                error={error}
                onReset={() => {
                  requestVersionRef.current += 1;
                  analyzeAbortRef.current?.abort?.();
                  verifyAbortRef.current?.abort?.();
                  setUrl('');
                  setAnalysisData(null);
                  setVerificationData(null);
                  setError('');
                }}
                selectedProvider={selectedLlmProvider}
                onProviderChange={setSelectedLlmProvider}
                providerStatus={providerStatus}
                lastAnalysisInfo={analysisData ? {
                  provider: analysisData.llm_provider_used || analysisData.source || analysisData.ml_source || '',
                  model: analysisData.llm_model_used || '',
                  entityCount: Array.isArray(analysisData.entities) ? analysisData.entities.length : 0,
                } : null}
                placeholder={t('home.urlPlaceholder') || 'Paste a news URL here...'}
                enableSticky={false}
              />
            </Box>

            {/* Loading State */}
            {loading && (
              <Box sx={{ width: '100%', mt: 1.5 }}>
                <ProgressWithETA
                  active={loading}
                  label={t('home.analyzing') || 'Analyzing... 📰'}
                  helper="Running article extraction and relevance scoring"
                  progress={analysisProgress.progress}
                  etaText={analysisProgress.etaText}
                />
              </Box>
            )}

            {/* Verification Loading State */}
            {verifying && (
              <Box sx={{ width: '100%', mt: 1.5 }}>
                <ProgressWithETA
                  active={verifying}
                  label="Verifying contact data... 🔍"
                  helper="Matching database records with live website details"
                  progress={verifyProgress.progress}
                  etaText={verifyProgress.etaText}
                />
              </Box>
            )}

            {sendingEmail && (
              <Box sx={{ width: '100%', mt: 1 }}>
                <ProgressWithETA
                  active={sendingEmail}
                  compact
                  label="Processing Gmail action"
                  progress={mailProgress.progress}
                  etaText={mailProgress.etaText}
                />
              </Box>
            )}
          </Stack>
        </Container>
      </Box>

      {/* Results Sections */}
      {(analysisData || verificationData) && (
        <Box
          sx={{
            py: { xs: 2, md: 5 },
            px: { xs: 0.5, md: 0 },
            backgroundColor: 'rgba(251, 245, 232, 0.72)',
            border: '1px solid #D8C5A5',
            borderRadius: 4,
            backdropFilter: 'blur(1.5px)',
          }}
        >
          <Container maxWidth="lg">
            {/* Fallback Warning Banner */}
            {analysisData?.source === 'smart-fallback' && (
              <Alert 
                severity="warning" 
                sx={{ 
                  mb: 2, 
                  backgroundColor: '#FFF3E0', 
                  border: '1px solid #FFB74D',
                  borderRadius: '6px',
                  fontFamily: '"Noto Sans Bengali", "Roboto", sans-serif',
                }}
                icon={<WarningIcon sx={{ color: '#F57F17' }} />}
              >
                <Typography sx={{ fontWeight: 600, color: '#E65100', fontSize: '0.95rem' }}>
                  সকল AI সেবা অনুপলব্ধ — স্বয়ংক্রিয় বিশ্লেষণ ব্যবহার করা হচ্ছে
                </Typography>
                <Typography sx={{ fontSize: '0.85rem', color: '#BF360C', mt: 0.5 }}>
                  বিশ্লেষণ কম নির্ভুল হতে পারে। কৃপয়া আবার চেষ্টা করুন বা ম্যানুয়াল যাচাইকরণ বিবেচনা করুন।
                </Typography>
              </Alert>
            )}
            {/* Analysis Results */}
            {analysisData && (
              <AnalysisAccordion
                newsText={analysisData.text || analysisData.extractedText || analysisData.summary || 'No content available'}
                newsLink={analysisData.meta_data?.source || 'https://example.com'}
                summary={analysisData.summary || ''}
                metadata={analysisData.meta_data || {}}
                isLoading={loading}
                aiPending={analysisData.ai_status === 'pending'}
                rtiGuidance={analysisData.rti_guidance || null}
                aiUnavailableReason={analysisData.ai_status === 'unavailable'
                  ? (analysisData.unavailable_reason || 'AI analysis is unavailable right now.')
                  : ''}
                sentenceHighlights={analysisData.sentenceHighlights || []}
                proxyModeAvailable={Boolean(analysisData.proxyModeAvailable)}
                readerToken={analysisData.reader_token || ''}
                images={analysisData.images || []}
                videoPresent={Boolean(analysisData.video_present)}
                articleHtml={analysisData.articleHtml || ''}
                mentionedGovOrgs={analysisData.mentionedGovOrgs || analysisData.mentioned_gov_orgs || []}
                // Gemini AI Analysis fields
                category={analysisData.category || ''}
                categoryConfidence={analysisData.category_confidence || 0}
                entities={analysisData.entities || []}
                enrichedEntitiesData={analysisData.enriched_entities || []}
                geminiKeywords={analysisData.keywords || []}
                highlights={analysisData.highlights || []}
                relatedOffices={analysisData.related_offices || []}
                language={analysisData.language || ''}
                analysisSource={analysisData.source || analysisData.ml_source || ''}
                llmProviderUsed={analysisData.llm_provider_used || analysisData.source || analysisData.ml_source || ''}
                llmModelUsed={analysisData.llm_model_used || ''}
                // Semantic Ministry Mapping fields (Upgrade 3)
                ministryReasoning={analysisData.ministry_reasoning || ''}
                relatedMinistriesVerified={analysisData.related_ministries_verified || []}
                civicGrievance={analysisData.civic_grievance || ''}
                rtiTargetOffice={analysisData.rti_target_office || ''}
              />
            )}

            {/* Manual Ministry/Division/Office search — for offices the article-driven
                resolution above missed. Adds a card instantly from the CSV, alongside
                whatever the article already resolved, without discarding those results. */}
            {analysisData && (
              <Box sx={{ mt: 2, mb: 1 }}>
                <TextField
                  fullWidth
                  size="small"
                  placeholder="অফিস মিস হয়েছে? মন্ত্রণালয় / বিভাগ / দপ্তরের নাম লিখুন..."
                  value={manualOfficeQuery}
                  onChange={(e) => { setManualOfficeQuery(e.target.value); if (manualSearchError) setManualSearchError(''); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleManualOfficeSearch(); }}
                  disabled={manualSearching}
                  sx={{
                    '& .MuiOutlinedInput-root': { bgcolor: '#fff', borderRadius: '8px' },
                    '& input': { fontFamily: '"Noto Serif Bengali", "Kalpurush", serif' },
                  }}
                  InputProps={{
                    startAdornment: (
                      <InputAdornment position="start">
                        <SearchIcon sx={{ color: '#8d6e63' }} />
                      </InputAdornment>
                    ),
                    endAdornment: (
                      <InputAdornment position="end">
                        {manualSearching ? (
                          <CircularProgress size={18} />
                        ) : (
                          <IconButton size="small" onClick={handleManualOfficeSearch} disabled={!manualOfficeQuery.trim()}>
                            <SearchIcon fontSize="small" />
                          </IconButton>
                        )}
                      </InputAdornment>
                    ),
                  }}
                />
                {manualSearchError && (
                  <Typography sx={{ mt: 0.5, fontSize: '0.8rem', color: '#bf360c', fontFamily: '"Noto Serif Bengali", "Kalpurush", serif' }}>
                    {manualSearchError}
                  </Typography>
                )}

                {/* Browse-and-pick alternative: a checklist dropdown of every office in the
                    dataset, for when the user doesn't know the exact name to type. */}
                <Stack direction="row" spacing={1} alignItems="flex-start" sx={{ mt: 1 }}>
                  <Autocomplete
                    multiple
                    disableCloseOnSelect
                    fullWidth
                    size="small"
                    options={officesList}
                    value={selectedOffices}
                    onOpen={ensureOfficesListLoaded}
                    onChange={(_e, newValue) => setSelectedOffices(newValue)}
                    groupBy={(option) => option.ministry}
                    getOptionLabel={(option) => option.office}
                    isOptionEqualToValue={(a, b) => a.ministry === b.ministry && a.division === b.division && a.office === b.office}
                    renderOption={(props, option, { selected }) => (
                      <li {...props} key={`${option.ministry}|${option.division}|${option.office}`}>
                        <Checkbox
                          icon={<CheckBoxOutlineBlankIcon fontSize="small" />}
                          checkedIcon={<CheckBoxIcon fontSize="small" />}
                          checked={selected}
                          size="small"
                          sx={{ mr: 1 }}
                        />
                        <span style={{ fontFamily: '"Noto Serif Bengali", "Kalpurush", serif' }}>{option.office}</span>
                      </li>
                    )}
                    renderInput={(params) => (
                      <TextField
                        {...params}
                        placeholder={officesList.length ? 'তালিকা থেকে একাধিক দপ্তর বেছে নিন...' : 'তালিকা লোড হচ্ছে...'}
                        sx={{
                          '& .MuiOutlinedInput-root': { bgcolor: '#fff', borderRadius: '8px' },
                          '& input': { fontFamily: '"Noto Serif Bengali", "Kalpurush", serif' },
                        }}
                      />
                    )}
                    sx={{ flex: 1 }}
                  />
                  <Button
                    variant="contained"
                    size="small"
                    onClick={handleAddSelectedOffices}
                    disabled={selectedOffices.length === 0 || officesAdding}
                    sx={{ mt: 0.25, whiteSpace: 'nowrap', bgcolor: '#4D4030', '&:hover': { bgcolor: '#3a3024' } }}
                  >
                    {officesAdding ? <CircularProgress size={16} sx={{ color: '#fff' }} /> : `যোগ করুন${selectedOffices.length ? ` (${selectedOffices.length})` : ''}`}
                  </Button>
                </Stack>
              </Box>
            )}

            {/* Verification Results - Real API Data */}
            {(() => { return (verificationData || combinedMatches.length > 0) ? (
              <Box>
                {combinedMatches.length > 0 ? (
                  <Stack spacing={2}>
                    {combinedMatches.map((match, idx) => (
                      <Box key={`${match.office_name || match.resolution?.resolvedRowKey || idx}-${idx}`}>
                        <Typography sx={{ mb: 0.5, fontWeight: 700, color: '#4D4030', fontFamily: '"Noto Serif Bengali", "Kalpurush", serif' }}>
                          {combinedMatches.length > 1 ? `${idx + 1}: ` : ''}{match.office_name || match.Office || match.Ministry || 'অজানা'}
                        </Typography>
                        {/* Per-card notice from resolution ladder */}
                        {match.resolution?.noticeBn && (
                          <Typography sx={{ mb: 1, fontSize: '0.85rem', color: '#bf360c', fontFamily: '"Noto Serif Bengali", "Kalpurush", serif', fontStyle: 'italic' }}>
                            {match.resolution.noticeBn}
                          </Typography>
                        )}
                        {/* Per-card: show which entities from the article this card covers */}
                        {Array.isArray(match.resolution?.requestedEntities) && match.resolution.requestedEntities.length > 0 && (
                          <Typography sx={{ mb: 1, fontSize: '0.8rem', color: '#5d4037', fontFamily: '"Noto Serif Bengali", "Kalpurush", serif' }}>
                            সংবাদে উল্লিখিত: {match.resolution.requestedEntities.join(', ')}
                          </Typography>
                        )}
                        <VerificationGrid
                          databaseContact={match}
                          scrapedContact={verificationData?.liveScrapedRecords?.[idx] || null}
                          discrepancies={verificationData?.discrepancies_by_match?.[idx] || null}
                          isLoading={verifying}
                          loadingProgress={verifyProgress.progress}
                          loadingEta={verifyProgress.etaText}
                          prefetchedImageUrl={prefetchedImages[getGovUrlFromContact(match)] || null}
                          networkStatus={match.network_status || 'ok'}
                          partialSuccess={Boolean(match.partial_success)}
                          statusMessage={''}
                          officerSlots={match.officer_slots || null}
                          onRetry={handleRetryVerification}
                          onUseCache={handleUseCacheVerification}
                          retryDisabled={verifying}
                          integrityWarnings={verificationData?.integrity_warnings || []}
                          onContactUpdated={(updatedData) => handleContactUpdated(updatedData, idx)}
                        />
                      </Box>
                    ))}
                  </Stack>
                ) : verificationData?.databaseRecord || verificationData?.liveScrapedRecord ? (
                  <VerificationGrid
                    databaseContact={verificationData.databaseRecord}
                    scrapedContact={verificationData.liveScrapedRecord}
                    discrepancies={verificationData?.discrepancies || null}
                    isLoading={verifying}
                    loadingProgress={verifyProgress.progress}
                    loadingEta={verifyProgress.etaText}
                    prefetchedImageUrl={prefetchedImages[getGovUrlFromContact(verificationData.databaseRecord)] || null}
                    networkStatus={verificationData?.network_status || 'ok'}
                    partialSuccess={Boolean(verificationData?.partial_success)}
                    statusMessage={verificationData?.message || verificationData?.error || ''}
                    officerSlots={verificationData?.officer_slots || null}
                    onRetry={handleRetryVerification}
                    onUseCache={handleUseCacheVerification}
                    retryDisabled={verifying}
                          integrityWarnings={verificationData?.integrity_warnings || []}
                    onContactUpdated={(updatedData) => handleContactUpdated(updatedData, 0)}
                  />
                ) : verificationData && !verificationData?.databaseRecord && !combinedMatches.length ? (
                  // ══ PIPELINE: No Results Found → Show Fallback Option ══
                  <Box sx={{ textAlign: 'center', py: 3 }}>
                    <LightbulbIcon sx={{ fontSize: '3rem', color: '#ffd54f', mb: 1, opacity: 0.8 }} />
                    <Typography sx={{ fontSize: '1rem', fontWeight: 600, color: '#5d4037', mb: 2 }}>
                      স্থানীয় ডেটাবেসে সঠিক মিল পাওয়া যায়নি
                    </Typography>
                    <Typography sx={{ fontSize: '0.9rem', color: '#795548', mb: 3, maxWidth: 400, mx: 'auto' }}>
                      অনুসন্ধানকৃত মন্ত্রণালয়ে সংশ্লিষ্ট কর্মকর্তা খুঁজতে AI সংশ্লেষণ ব্যবহার করুন
                    </Typography>
                    <Button
                      variant="contained"
                      onClick={() => {
                        setLastSearchQuery(verificationData?.searchQuery || '');
                        handleFallbackSearch();
                      }}
                      disabled={fallbackLoading}
                      sx={{
                        textTransform: 'none',
                        fontWeight: 600,
                        bgcolor: '#d32f2f',
                        color: '#ffffff',
                        px: 3,
                        py: 1.25,
                        borderRadius: '6px',
                        '&:hover': { bgcolor: '#b71c1c' },
                      }}
                    >
                      {fallbackLoading ? 'Searching with AI...' : '🤖 Try AI Fallback Search'}
                    </Button>
                  </Box>
                ) : null}
              </Box>
            ) : analysisData ? (
              <Box sx={{ textAlign: 'center', py: 4 }}>
                <Typography sx={{ color: '#8D7C65', fontSize: '0.95rem', fontFamily: '"Noto Serif Bengali", "Kalpurush", serif' }}>
                  {verifying ? 'Searching verification database...' : 'Searching for contact information...'}
                </Typography>
              </Box>
            ) : null; })()}

            {/* Section 4 — Postmark-based composer (government-document styling, matching
                Sections 1-3), one card per resolved office, AI-drafted Form "ক" per article.
                The original Gmail OAuth system (MailCard.js) is untouched — never deleted, kept
                reachable via the "Gmail (OAuth)" toggle inside RtiPostmarkComposer. */}
            {(verificationData || analysisData) && (
              <RtiPostmarkComposer
                offices={combinedMatches}
                articleText={analysisData?.text || analysisData?.extractedText || analysisData?.summary || ''}
                defaultFrom={senderEmail}
                legacyMailCard={(
                  <MailCard
                    senderEmail={senderEmail}
                    onSenderEmailChange={setSenderEmail}
                    gmailConnectedEmail={gmailConnectedEmail}
                    onConnectGmail={handleConnectGmail}
                    initialRecipients={emailToList}
                    defaultSubject={emailSubject}
                    defaultBody={emailBody}
                    onSaveDraft={handleSaveDraftForCompose}
                    onSendEmail={handleSendForCompose}
                    isLoading={sendingEmail}
                    loadingProgress={mailProgress.progress}
                    loadingEta={mailProgress.etaText}
                    bodyTemplates={bodyTemplates}
                  />
                )}
              />
            )}
          </Container>
        </Box>
      )}

      {/* Error Alert */}
      {error && (
        <Box sx={{ py: 2 }}>
          <Container maxWidth="lg">
            <Alert severity="error" onClose={() => setError('')}>
              {error}
            </Alert>
          </Container>
        </Box>
      )}

      {/* Success Snackbar */}
      <Snackbar
        open={snackbarOpen}
        autoHideDuration={5000}
        onClose={() => setSnackbarOpen(false)}
      >
        <Alert severity="success">{successMessage}</Alert>
      </Snackbar>

      {/* ══ PIPELINE: Stage 3 Fallback Suggestion Modal ══ */}
      <Dialog
        open={fallbackModalOpen}
        onClose={() => {
          setFallbackModalOpen(false);
          setFallbackData(null);
        }}
        maxWidth="sm"
        fullWidth
        PaperProps={{
          sx: {
            borderRadius: '12px',
            border: '2px solid #d32f2f',
          }
        }}
      >
        <DialogTitle sx={{
          bgcolor: '#ffebee',
          borderBottom: '2px solid #d32f2f',
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          fontWeight: 700,
          color: '#b71c1c'
        }}>
          <LightbulbIcon sx={{ fontSize: '1.3rem' }} />
          AI-Synthesized Officer Information
        </DialogTitle>

        <DialogContent sx={{ py: 2 }}>
          {fallbackError && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {fallbackError}
            </Alert>
          )}

          {fallbackLoading && (
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', py: 3 }}>
              <Stack alignItems="center" spacing={1}>
                <CircularProgress size={40} />
                <Typography sx={{ fontSize: '0.9rem', color: '#666' }}>
                  Synthesizing officer data with AI...
                </Typography>
              </Stack>
            </Box>
          )}

          {fallbackData && !fallbackLoading && (
            <>
              {/* Warning Alert */}
              <Alert severity="warning" icon={<WarningIcon />} sx={{ mb: 2, bgcolor: '#fff3e0', borderColor: '#ff9800' }}>
                <Typography sx={{ fontSize: '0.85rem', fontWeight: 500, mb: 1 }}>
                  ⚠️ This is AI-synthesized data for reference only
                </Typography>
                <Typography sx={{ fontSize: '0.8rem', color: '#666' }}>
                  Please verify through official government channels before using this information for official communication.
                </Typography>
              </Alert>

              {/* Display with VerificationGrid */}
              <VerificationGrid
                databaseContact={fallbackData}
                isLoading={false}
                prefetchedImageUrl={null}
                networkStatus="fallback"
                statusMessage="Data synthesized by AI"
                onContactUpdated={(updatedData) => setFallbackData(updatedData)}
              />

              {/* Metadata */}
              {fallbackData._source === 'stage3_cerebras_fallback' && (
                <Box sx={{ mt: 2, p: 1.5, bgcolor: '#e3f2fd', borderRadius: '6px', borderLeft: '4px solid #1976d2' }}>
                  <Typography sx={{ fontSize: '0.75rem', color: '#1565c0', fontWeight: 600 }}>
                    🔬 Synthesis Method: AI
                  </Typography>
                  <Typography sx={{ fontSize: '0.75rem', color: '#1565c0', mt: 0.5 }}>
                    Response time: &lt; 1 second | Confidence: {fallbackData._confidence || '65%'}
                  </Typography>
                </Box>
              )}
            </>
          )}
        </DialogContent>

        <DialogActions sx={{ bgcolor: '#fafafa', p: 2, gap: 1 }}>
          <Button
            onClick={() => {
              setFallbackModalOpen(false);
              setFallbackData(null);
            }}
            sx={{
              textTransform: 'none',
              fontWeight: 600,
              color: '#666',
              '&:hover': { bgcolor: '#f5f5f5' }
            }}
          >
            Dismiss
          </Button>
          {fallbackData && (
            <Button
              variant="contained"
              onClick={() => {
                // Pre-populate email fields with fallback data
                if (fallbackData?.Primary_Email) {
                  setEmailToList([fallbackData.Primary_Email]);
                }
                const officerName = fallbackData?.Primary_Officer || 'Officer';
                setEmailSubject(`Inquiry to ${officerName}`);
                
                // Close modal and show success
                setFallbackModalOpen(false);
                setSuccessMessage('✅ Officer data loaded. Scroll down to compose email.');
                setSnackbarOpen(true);
              }}
              sx={{
                textTransform: 'none',
                fontWeight: 600,
                bgcolor: '#1976d2'
              }}
            >
              Use This Data
            </Button>
          )}
        </DialogActions>
      </Dialog>

      {/* Footer */}
      <Footer />
    </Box>
  );
};

export default Home;
