import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Box,
  Typography,
  Collapse,
  IconButton,
  Divider,
  Stack,
  Button,
  Chip,
  Skeleton,
  LinearProgress,
} from '@mui/material';
import AddRoundedIcon from '@mui/icons-material/AddRounded';
import RemoveRoundedIcon from '@mui/icons-material/RemoveRounded';
import LinkRoundedIcon from '@mui/icons-material/LinkRounded';
import DownloadRoundedIcon from '@mui/icons-material/DownloadRounded';
import HighlightRoundedIcon from '@mui/icons-material/HighlightRounded';
import CategoryRoundedIcon from '@mui/icons-material/CategoryRounded';
import AccountBalanceRoundedIcon from '@mui/icons-material/AccountBalanceRounded';
import PersonRoundedIcon from '@mui/icons-material/PersonRounded';
import BusinessRoundedIcon from '@mui/icons-material/BusinessRounded';
import PlaceRoundedIcon from '@mui/icons-material/PlaceRounded';
import TranslateRoundedIcon from '@mui/icons-material/TranslateRounded';
import SmartToyRoundedIcon from '@mui/icons-material/SmartToyRounded';
import apiClient, { buildReaderUrl, buildReaderPrepareUrl } from '../api/axiosConfig';
import { highlightHTMLEntities } from '../utils/highlightHTMLEntities';

// Highlight colours for the Extracted Text view — same values as the inline span styles in
// utils/highlightHTMLEntities.js and the Live Page reader's READER_STYLE.
const HIGHLIGHT_SX = {
  '& .important-sentence-highlight': { backgroundColor: '#fff176 !important', color: '#212121 !important', borderRadius: '2px', padding: '0 1px' },
  '& .keyword-highlight': { backgroundColor: '#bbdefb !important', color: '#0d47a1 !important', borderRadius: '2px', padding: '0 2px' },
  '& .gov-org-highlight': { backgroundColor: '#e3f2fd !important', color: '#1565c0 !important', fontWeight: 600, borderRadius: '3px', padding: '0 2px' },
  '& .officer-highlight': { textDecorationLine: 'underline', textDecorationColor: '#1565c0', textDecorationThickness: '3px', textUnderlineOffset: '4px', fontWeight: 600 },
};

const PERSON_TYPE_SET = new Set(['PERSON', 'PER']);
const ORG_TYPE_SET = new Set(['ORG', 'ORGANIZATION', 'INSTITUTION']);
const LOCATION_TYPE_SET = new Set(['GPE', 'LOC', 'LOCATION']);

const RANK_KEYWORDS = [
  'minister', 'secretary', 'chairman', 'director', 'officer', 'commissioner', 'advisor', 'chief', 'principal',
  'মন্ত্রী', 'সচিব', 'চেয়ারম্যান', 'পরিচালক', 'কর্মকর্তা', 'কমিশনার', 'উপদেষ্টা', 'প্রধান', 'সভাপতি'
];

const splitNameAndRank = (rawValue = '') => {
  const raw = (rawValue || '').toString().replace(/\s+/g, ' ').trim();
  if (!raw) return { name: '', rank: '' };

  const parts = raw
    .split(/\s*[—–-]\s*|\s*,\s*|\s*\|\s*|\s*\(\s*|\s*\)\s*/)
    .map((p) => p.trim())
    .filter(Boolean);

  if (parts.length <= 1) return { name: raw, rank: '' };

  const first = parts[0];
  const rest = parts.slice(1).join(' — ');
  const restLower = rest.toLowerCase();
  const firstLower = first.toLowerCase();

  const restLooksLikeRank = RANK_KEYWORDS.some((k) => restLower.includes(k));
  const firstLooksLikeRank = RANK_KEYWORDS.some((k) => firstLower.includes(k));

  if (restLooksLikeRank) return { name: first, rank: rest };
  if (firstLooksLikeRank && parts.length > 1) return { name: parts.slice(1).join(' '), rank: first };
  return { name: raw, rank: '' };
};

const normalizeEntityRecord = (entity) => {
  if (typeof entity === 'string') {
    const parsed = splitNameAndRank(entity);
    return {
      text: parsed.name || entity,
      rank: parsed.rank || '',
      type: '',
    };
  }

  const rawText = (entity?.text || entity?.name || entity?.value || '').toString().trim();
  const parsed = splitNameAndRank(rawText);
  return {
    text: parsed.name || rawText,
    rank: (entity?.rank || entity?.designation || entity?.title || entity?.role || parsed.rank || '').toString().trim(),
    type: (entity?.label || entity?.type || entity?.entityType || '').toString().toUpperCase(),
  };
};

// Hoisted to module scope (not defined inside AnalysisAccordion) — a component
// defined inside another component's render body gets a fresh function identity
// on every re-render, which makes React treat it as a different component type
// and unmount/remount it. Since clicking "+" triggers a state update that
// re-renders the parent, that remount could happen between mousedown and
// mouseup, causing the click to silently not register.
const AccordionSection = ({
  title,
  icon: Icon,
  expanded,
  onToggle,
  children
}) => (
  <Box
    sx={{
      bg: '#FFFFFF',
      borderRadius: '8px',
      border: '1px solid #E0E0E0',
      mb: 2,
      overflow: 'hidden',
      transition: 'all 0.3s ease',
      '&:hover': {
        boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
      }
    }}
  >
    <Box
      onClick={onToggle}
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        px: { xs: 2, md: 3 },
        py: 2.5,
        cursor: 'pointer',
        userSelect: 'none',
        '&:hover': {
          backgroundColor: '#f9f9f9',
        }
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
        {Icon && (
          <Icon
            sx={{
              color: '#8B1212',
              fontSize: '1.5rem',
            }}
          />
        )}
        <Typography
          sx={{
            fontFamily: '"Inter", "Work Sans", sans-serif',
            fontWeight: 600,
            fontSize: { xs: '1rem', md: '1.125rem' },
            color: '#212121',
            letterSpacing: '0.02em',
          }}
        >
          {title}
        </Typography>
      </Box>
      <IconButton
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        sx={{
          color: '#8B1212',
          backgroundColor: '#F2DFC2',
          '&:hover': {
            backgroundColor: '#EBCFA3',
          },
          width: 36,
          height: 36,
        }}
      >
        {expanded ? (
          <RemoveRoundedIcon fontSize="small" />
        ) : (
          <AddRoundedIcon fontSize="small" />
        )}
      </IconButton>
    </Box>
    <Collapse in={expanded} unmountOnExit timeout={0}>
      <Divider />
      <Box sx={{ px: { xs: 2, md: 3 }, py: { xs: 2, md: 3 } }}>
        {children}
      </Box>
    </Collapse>
  </Box>
);

// Dates from /api/rti-guidance are Asia/Dhaka calendar days held as UTC midnight.
const bnDate = (iso) => {
  if (!iso) return '';
  try {
    return new Date(`${iso}T00:00:00Z`).toLocaleDateString('bn-BD', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' });
  } catch {
    return iso;
  }
};

const bnNum = (n) => Number(n).toLocaleString('bn-BD');

const GuidanceLine = ({ children, tone = '#33691E' }) => (
  <Typography sx={{ fontFamily: '"Noto Sans Bengali", "Roboto", sans-serif', fontSize: '0.82rem', color: tone, lineHeight: 1.6 }}>
    {children}
  </Typography>
);

const GuidanceHeading = ({ children }) => (
  <Typography sx={{ fontFamily: '"Noto Sans Bengali", "Inter", sans-serif', fontWeight: 700, fontSize: '0.85rem', color: '#1B5E20', mt: 1.5, mb: 0.5 }}>
    {children}
  </Typography>
);

// RTI Actionability — lives inside the RTI officer card block (not a separate section).
// Every statement shows the RTI Act 2009 section it rests on.
const RtiActionability = ({ guidance }) => {
  const { routing, deadlines, urgency, section32, section7, notes = [], suggestedQuestions = [], money = [] } = guidance || {};
  return (
    <Box sx={{ mt: 1.5, border: '1px dashed #81C784', borderRadius: '10px', backgroundColor: '#FAFFF7', p: 2 }}>
      <Typography sx={{ fontFamily: '"Noto Sans Bengali", "Inter", sans-serif', fontWeight: 800, fontSize: '0.92rem', color: '#1B5E20' }}>
        📝 RTI আবেদনের নির্দেশনা
      </Typography>

      <GuidanceHeading>কোথায় আবেদন করবেন</GuidanceHeading>
      <GuidanceLine>{routing.note}</GuidanceLine>
      {routing.designatedOfficer && (
        <GuidanceLine>তথ্য প্রদানকারী কর্মকর্তা: {routing.designatedOfficer.name}{routing.designatedOfficer.designation ? `, ${routing.designatedOfficer.designation}` : ''} (ধারা ১০)</GuidanceLine>
      )}
      {routing.appellateAuthority && (
        <GuidanceLine>আপিল কর্তৃপক্ষ: {routing.appellateAuthority.name}{routing.appellateAuthority.designation ? `, ${routing.appellateAuthority.designation}` : ''} (ধারা ২(ক), ২৪)</GuidanceLine>
      )}

      {deadlines && (
        <>
          <GuidanceHeading>সময়সীমা (আজ পাঠালে)</GuidanceHeading>
          {urgency?.applies && <GuidanceLine tone="#B71C1C">⏱ {urgency.note}</GuidanceLine>}
          <GuidanceLine>
            পাঠানো: {bnDate(deadlines.sendDate)} → উত্তরের শেষ দিন: {bnDate(deadlines.replyBy)} ({bnNum(deadlines.workingDays)} কার্যদিবস, ধারা {deadlines.workingDaysSection === '9(2)' ? '৯(২)' : '৯(১)'})
          </GuidanceLine>
          <GuidanceLine>তথ্য দিতে অপারগ হলে কারণসহ লিখিত জানানোর শেষ দিন: {bnDate(deadlines.refusalReasonsBy)} (১০ কার্যদিবস, ধারা ৯(৩))</GuidanceLine>
          <GuidanceLine>
            সময়ের মধ্যে উত্তর না এলে আবেদন প্রত্যাখ্যাত গণ্য হয়; তখন আপিল কর্তৃপক্ষের কাছে আপিলের শেষ দিন {bnDate(deadlines.appealBy)} (৩০ দিন, ধারা ২৪) — আপিল কর্তৃপক্ষ ১৫ দিনের মধ্যে নিষ্পত্তি করবেন; তারপর ৩০ দিনের মধ্যে তথ্য কমিশনে অভিযোগ (ধারা ২৫)।
          </GuidanceLine>
          <GuidanceLine tone="#757575">{deadlines.holidayCaveat}</GuidanceLine>
        </>
      )}

      {(section32 || section7?.flags?.length > 0) && (
        <>
          <GuidanceHeading>সম্ভাব্য বাধা</GuidanceHeading>
          {section32 && <GuidanceLine tone="#B71C1C">{section32.note}</GuidanceLine>}
          {section7?.flags?.length > 0 && (
            <>
              {section7.flags.map((f) => (
                <GuidanceLine key={f.category}>• {f.category}: {f.why} (ধারা ৭)</GuidanceLine>
              ))}
              <GuidanceLine tone="#757575">{section7.note} এটি AI-এর প্রাথমিক মূল্যায়ন, আইনি পরামর্শ নয়।</GuidanceLine>
              {section7.degraded && (
                <GuidanceLine tone="#B26A00">প্রধান মডেলটি সাড়া না দেওয়ায় এই মূল্যায়ন একটি বিকল্প (কম সক্ষম) মডেল দিয়ে করা হয়েছে — সতর্কতার সঙ্গে দেখুন।</GuidanceLine>
              )}
            </>
          )}
        </>
      )}

      {notes.length > 0 && (
        <>
          <GuidanceHeading>জেনে রাখুন</GuidanceHeading>
          {notes.map((n) => <GuidanceLine key={n.section}>• {n.text}</GuidanceLine>)}
        </>
      )}

      {suggestedQuestions.length > 0 && (
        <>
          <GuidanceHeading>আবেদনে যা চাইতে পারেন (ফরম "ক", ক্রমিক ২)</GuidanceHeading>
          {suggestedQuestions.map((q, i) => <GuidanceLine key={q} tone="#212121">{bnNum(i + 1)}. {q}</GuidanceLine>)}
          <GuidanceLine tone="#757575">AI-প্রস্তাবিত খসড়া; পাঠানোর আগে সংবাদের তথ্যের সঙ্গে মিলিয়ে নিন।</GuidanceLine>
        </>
      )}

      {money.length > 0 && (
        <>
          <GuidanceHeading>সংবাদে উল্লিখিত অর্থের পরিমাণ</GuidanceHeading>
          {money.map((m) => <GuidanceLine key={m.amount} tone="#212121">• {m.amount} — “…{m.context}…”</GuidanceLine>)}
        </>
      )}
    </Box>
  );
};

/**
 * AnalysisAccordion Component
 *
 * Expandable sections for "Read The News" and "News Summary" with proof links
 * Matches RTI2.jpg design specifications
 */
const AnalysisAccordion = ({ 
  newsText = '', 
  newsLink = '',
  summary = '',
  metadata = {},
  isLoading = false,
  // True while /api/analyze-text + /api/extract-entities are still running (article already shown).
  aiPending = false,
  // Non-empty when every AI provider failed: the AI-written blocks are replaced by this message.
  aiUnavailableReason = '',
  // RTI Act 2009 guidance from /api/rti-guidance (routing, deadlines, flags, questions, money).
  rtiGuidance = null,
  // Verbatim sentences picked by the salience ensemble; arrives after the AI merge (polled).
  sentenceHighlights = [],
  // Outlet is on the reader allowlist (from /api/analyze) → the Live Page view is offered.
  proxyModeAvailable = false,
  // Token from /api/analyze-text that makes the reader inject the same highlights.
  readerToken = '',
  images = [],
  articleHtml = '',
  videoPresent = false,
  // ── Gemini AI Analysis Props ──
  category = '',
  categoryConfidence = 0,
  entities = [],
  geminiKeywords = [],
  highlights = [],
  relatedOffices = [],
  // Government bodies found in the article by the backend's deterministic gazetteer match
  // (JAANI_RTI_OFFICERS_COMPLETE.csv + agency→parent table), most-mentioned first.
  mentionedGovOrgs = [],
  language = '',
  analysisSource = '',
  llmProviderUsed = '',
  llmModelUsed = '',
  // ── NEW: Semantic Ministry Mapping Props (Upgrade 3) ──
  ministryReasoning = '',
  rtiTargetOffice = '',
  // P9: AI-suggested related ministries that matched the RTI dataset (official names).
  relatedMinistriesVerified = [],
  civicGrievance = '',
  // NEW: Enriched entities from CSV lookup (with databaseMatch) — separate from raw `entities`
  enrichedEntitiesData = [],
}) => {
  const { t, i18n } = useTranslation();
  // Counts in the active language's digits (১, ২ … in Bengali).
  const fmtCount = (n) => Number(n).toLocaleString(String(i18n.language || '').startsWith('bn') ? 'bn-BD' : 'en-US');
  const [expandedNews, setExpandedNews] = useState(false);
  const [expandedSummary, setExpandedSummary] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [relatedNews, setRelatedNews] = useState({ loading: false, sameStory: [], related: [], factChecks: [], error: '' });
  // Read The News view: 'live' (reader, highlighted) → 'extracted'.
  const [viewMode, setViewMode] = useState(proxyModeAvailable ? 'live' : 'extracted');
  // 'preparing' | 'ready' | 'failed' | 'unavailable'
  const [liveStatus, setLiveStatus] = useState(proxyModeAvailable ? 'preparing' : 'unavailable');
  const userPickedModeRef = useRef(false);
  const newsRef = useRef(null);

  const escapeHtml = (value = '') => (value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

  const highlightBlockHtml = (html = '', fallbackText = '') => {
    const safeHtml = html || (fallbackText ? escapeHtml(fallbackText).replace(/\r?\n/g, '<br/>') : '');
    if (!safeHtml) return '';
    return highlightHTMLEntities(safeHtml, entities, geminiKeywords, sentenceHighlights);
  };

  const selectViewMode = (mode) => {
    userPickedModeRef.current = true;
    setViewMode(mode);
  };

  // Warm the reader snapshot as soon as the article is shown (in parallel with the AI calls).
  // Any failure — not allowlisted, site blocked, timeout — silently falls back to Extracted Text.
  useEffect(() => {
    const fallBack = () => {
      if (!userPickedModeRef.current) setViewMode('extracted');
    };
    if (!proxyModeAvailable || !newsLink) {
      setLiveStatus('unavailable');
      fallBack();
      return undefined;
    }
    let cancelled = false;
    setLiveStatus('preparing');
    fetch(buildReaderPrepareUrl(newsLink))
      .then((r) => r.json().catch(() => ({ ok: false })))
      .then((d) => {
        if (cancelled) return;
        if (d?.ok) {
          setLiveStatus('ready');
        } else {
          setLiveStatus('failed');
          fallBack();
        }
      })
      .catch(() => {
        if (cancelled) return;
        setLiveStatus('failed');
        fallBack();
      });
    return () => { cancelled = true; };
  }, [proxyModeAvailable, newsLink]);

  const readerSrc = buildReaderUrl(newsLink || '', readerToken, sentenceHighlights.length ? `s${sentenceHighlights.length}` : '');
  const showLivePage = viewMode === 'live' && liveStatus === 'ready';
  const showExtracted = viewMode === 'extracted' || (viewMode === 'live' && !showLivePage);
  const banglaFontFamily = '"Noto Serif Bengali", "Kalpurush", "SolaimanLipi", serif';

  const plainText = useMemo(() => {
    if (articleHtml) {
      const temp = document.createElement('div');
      temp.innerHTML = articleHtml;
      return (temp.innerText || temp.textContent || '').trim();
    }
    return (newsText || '').trim();
  }, [articleHtml, newsText]);

  const normalizedReadImages = useMemo(() => {
    return (Array.isArray(images) ? images : [])
      .map((img, idx) => ({
        src: img?.src || img?.image_url || '',
        alt: img?.alt || img?.alt_text || `News image ${idx + 1}`,
        caption: img?.caption || '',
        position: img?.position || idx + 1,
      }))
      .filter((img) => Boolean(img.src));
  }, [images]);

  const relatedGovernmentOrgs = useMemo(() => {
    const fromGazetteer = (Array.isArray(mentionedGovOrgs) ? mentionedGovOrgs : []).filter(Boolean);
    if (fromGazetteer.length) return fromGazetteer;
    return Array.isArray(relatedOffices) ? relatedOffices.filter(Boolean) : [];
  }, [mentionedGovOrgs, relatedOffices]);

  const shouldShowGovOrgBox = relatedGovernmentOrgs.length > 0 || Boolean(rtiTargetOffice) || Boolean(ministryReasoning)
    || relatedMinistriesVerified.length > 0;

  const normalizedEntities = useMemo(() => {
    return (entities || [])
      .map(normalizeEntityRecord)
      .filter((ent) => ent.text)
      .reduce((acc, ent) => {
        const key = `${ent.text.toLowerCase()}__${(ent.rank || '').toLowerCase()}__${ent.type}`;
        if (!acc.some((x) => x._key === key)) {
          acc.push({ ...ent, _key: key });
        }
        return acc;
      }, []);
  }, [entities]);

  // ── Split entities into Persons vs Organizations vs Others ──
  const personEntities = useMemo(() => {
    return normalizedEntities.filter((ent) => {
      if (PERSON_TYPE_SET.has(ent.type)) return true;
      // Heuristic fallback: if entity includes a rank/designation keyword,
      // treat it as person for cleaner person extraction.
      const combined = `${ent.text} ${ent.rank}`.toLowerCase();
      return RANK_KEYWORDS.some((k) => combined.includes(k));
    });
  }, [normalizedEntities]);

  const orgEntities = useMemo(() => {
    return normalizedEntities.filter((ent) => {
      if (ORG_TYPE_SET.has(ent.type)) return true;
      const combined = `${ent.text} ${ent.rank}`.toLowerCase();
      // Exclude entries already captured as persons by rank keywords.
      if (RANK_KEYWORDS.some((k) => combined.includes(k))) return false;
      return /ministry|department|authority|commission|agency|directorate|board|university|corporation|মন্ত্রণালয়|অধিদপ্তর|বিভাগ|কমিশন|কর্তৃপক্ষ/.test(combined);
    });
  }, [normalizedEntities]);

  const locationEntities = useMemo(() => {
    return normalizedEntities.filter((ent) => LOCATION_TYPE_SET.has(ent.type));
  }, [normalizedEntities]);

  // Enriched entities with databaseMatch from CSV lookup (includes fallback entries).
  // Prefer the dedicated enrichedEntitiesData prop; fall back to filtering raw entities.
  // A backend "FALLBACK" match is a placeholder record (a fixed default office),
  // not a real match for the entity — showing it as a card would present
  // fabricated office info as if it were the entity's real match, so these
  // are dropped rather than rendered.
  const isRealDatabaseMatch = (e) => {
    if (!e?.databaseMatch) return false;
    const dm = e.databaseMatch;
    if (dm.isFallback || dm.matchType === 'FALLBACK') return false;
    // A row with no officer on file yet is not shown as an empty card (brief 15.7b).
    const o = dm.officers;
    return !o || ['primary', 'alternate', 'appellate'].some((r) => o[r] && o[r].name);
  };

  const enrichedEntities = useMemo(() => {
    if (Array.isArray(enrichedEntitiesData) && enrichedEntitiesData.length > 0) {
      return enrichedEntitiesData.filter(isRealDatabaseMatch);
    }
    return (entities || []).filter(isRealDatabaseMatch);
  }, [enrichedEntitiesData, entities]);

  // DOM-aware entity highlighting: runs on articleHtml + entities from AI analysis.
  // Uses DOMParser TreeWalker so HTML attributes (src, href…) are never touched.
  // Only computed when the "Read The News" accordion is expanded to avoid blocking the main thread on mount.
  const highlightedArticleHtml = useMemo(() => {
    if (!articleHtml || !expandedNews) return articleHtml || '';
    return highlightHTMLEntities(articleHtml, entities, geminiKeywords, sentenceHighlights);
  }, [articleHtml, entities, geminiKeywords, sentenceHighlights, expandedNews]);

  // Same story in other newspapers + topically related news (Google News RSS via backend).
  // Runs once on the title alone (the article renders before the AI finishes), then again when
  // keywords/summary/entities land, since the combined search needs them to find coverage.
  const relatedKeywordsKey = (geminiKeywords || []).slice(0, 3).join(',');
  const relatedSummaryKey = (summary || '').slice(0, 400);
  const relatedEntitiesKey = (entities || []).map((e) => e?.text || e?.name || '').filter(Boolean).slice(0, 4).join(',');
  useEffect(() => {
    const title = (metadata?.title || '').trim();
    if (!title && !relatedKeywordsKey) return undefined;
    let cancelled = false;
    // Keep the previous (title-only) results visible while the fuller search runs.
    setRelatedNews((prev) => ({ ...prev, loading: true, error: '' }));
    apiClient.get('/api/related-news', {
      params: {
        title,
        keywords: relatedKeywordsKey,
        summary: relatedSummaryKey,
        date: metadata?.date || metadata?.published_date || '',
        entities: relatedEntitiesKey,
        exclude: newsLink || '',
        language: language || '',
      },
      timeout: 25000,
    }).then((res) => {
      if (cancelled) return;
      setRelatedNews({
        loading: false,
        sameStory: res.data?.sameStory || [],
        related: res.data?.related || [],
        factChecks: res.data?.factChecks || [],
        error: '',
      });
    }).catch(() => {
      if (!cancelled) setRelatedNews((prev) => ({ ...prev, loading: false, error: prev.sameStory.length || prev.related.length ? '' : 'Could not load related news.' }));
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metadata?.title, newsLink, relatedKeywordsKey, relatedSummaryKey, relatedEntitiesKey]);

  // The one metadata card (P13): each fact once. Category confidence lives only in the badge row.
  const articleMetaRows = useMemo(() => {
    const words = (plainText || '').trim().split(/\s+/).filter(Boolean).length;
    let domain = metadata?.domain || '';
    if (!domain && newsLink) { try { domain = new URL(newsLink).hostname; } catch { domain = ''; } }
    domain = domain.replace(/^www\./, '');
    const siteName = metadata?.site_name || metadata?.siteName || '';
    const canonical = metadata?.canonical_url || '';
    return [
      [t('newsAnalysis.meta.source'), siteName && siteName.replace(/^www\./, '') !== domain ? siteName : ''],
      [t('newsAnalysis.meta.domain'), domain],
      [t('newsAnalysis.meta.author'), metadata?.author],
      [t('newsAnalysis.meta.published'), metadata?.date || metadata?.published_date],
      [t('newsAnalysis.meta.modified'), metadata?.modified && metadata.modified !== (metadata?.date || '') ? metadata.modified : ''],
      [t('newsAnalysis.meta.canonical'), canonical && canonical !== newsLink ? canonical : ''],
      [t('newsAnalysis.meta.subtitle'), metadata?.subtitle],
      [t('newsAnalysis.meta.language'), language],
      [t('newsAnalysis.meta.category'), category],
      [t('newsAnalysis.meta.length'), words ? `${words} words · ~${Math.max(1, Math.round(words / 200))} min read` : ''],
      [t('newsAnalysis.meta.images'), normalizedReadImages.length ? String(normalizedReadImages.length) : ''],
      [t('newsAnalysis.meta.analyzedBy'), [llmProviderUsed || analysisSource, llmModelUsed].filter(Boolean).join(' · ')],
    ].filter(([, v]) => v && String(v).trim());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metadata, newsLink, plainText, language, category, normalizedReadImages, llmProviderUsed, analysisSource, llmModelUsed, t]);

  // Download as PDF (server-generated, reliable)
  const handleDownloadPDF = async () => {
    if (!newsLink || pdfBusy) return;
    setPdfBusy(true);
    try {
      const response = await apiClient.post(
        '/api/download-pdf',
        {
          url: newsLink,
          type: 'summary',
          title: metadata?.title || '',
          articleHtml: articleHtml || '',
          articleText: plainText || newsText || '',
          // Pass all analysis data for enriched PDF
          enrichedData: {
            summary: summary || '',
            category: category || '',
            categoryConfidence: categoryConfidence || 0,
            highlights: highlights || [],
            persons: personEntities.map((e) => ({
              name: e?.text || '',
              rank: e?.rank || '',
              text: e?.rank ? `${e.text} — ${e.rank}` : e?.text || '',
            })),
            organizations: orgEntities.map((e) => ({
              name: e?.text || '',
              text: e?.text || '',
            })),
            locations: locationEntities.map((e) => e?.text || ''),
            keywords: geminiKeywords || [],
            relatedGovOrgs: relatedGovernmentOrgs || [],
            mentionedGovOrgs: mentionedGovOrgs || [],
            rtiTargetOffice: rtiTargetOffice || '',
            ministryReasoning: ministryReasoning || '',
            entityStats: {
              totalEntities: normalizedEntities.length,
              personCount: personEntities.length,
              organizationCount: orgEntities.length,
              locationCount: locationEntities.length,
            },
            metadata: {
              title: metadata?.title || '',
              domain: metadata?.domain || '',
              siteName: metadata?.site_name || metadata?.siteName || '',
              canonicalUrl: metadata?.canonical_url || '',
              modifiedDate: metadata?.modified || '',
              author: metadata?.author || '',
              publishedDate: metadata?.published_date || metadata?.date || '',
            },
            // What the reader saw in the "Same news" / "Related news" cards.
            sameStory: relatedNews.sameStory.slice(0, 10).map((s) => ({
              title: s?.title || 'Source', url: s?.url || '', source: s?.source || '', publishedAt: s?.publishedAt || '',
            })),
            relatedNews: relatedNews.related.slice(0, 10).map((s) => ({
              title: s?.title || 'Source', url: s?.url || '', source: s?.source || '', publishedAt: s?.publishedAt || '',
            })),
            factChecks: relatedNews.factChecks.slice(0, 6).map((s) => ({
              title: s?.title || 'Fact-check', url: s?.url || '', source: s?.source || '', publishedAt: s?.publishedAt || '',
            })),
            language: language || '',
            analysisSource: analysisSource || '',
          },
        },
        { responseType: 'blob', timeout: 240000 }
      );

      // One combined PDF (summary + evidence certificate + screenshots). A ZIP only if one was asked for.
      const contentType = String(response.headers?.['content-type'] || '');
      const isZip = contentType.includes('zip');
      const disposition = String(response.headers?.['content-disposition'] || '');
      const serverName = (disposition.match(/filename="([^"]+)"/) || [])[1];
      const blob = new Blob([response.data], { type: isZip ? 'application/zip' : 'application/pdf' });
      const blobUrl = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = isZip ? (serverName || `news_summary_${Date.now()}.zip`) : `news_summary_${Date.now()}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(blobUrl);
    } catch (error) {
      console.error('PDF download error:', error);
      alert('Failed to download PDF');
    } finally {
      setPdfBusy(false);
    }
  };

  return (
    <Box sx={{ width: '100%', maxWidth: '900px', mx: 'auto', my: { xs: 2, md: 4 }, px: { xs: 0.5, md: 0 } }}>
      {/* Read The News Accordion */}
      <AccordionSection
        title="Read The News"
        icon={LinkRoundedIcon}
        expanded={expandedNews}
        onToggle={() => setExpandedNews(!expandedNews)}
      >
        <Stack spacing={2}>
          {/* ── Skeleton Loading State (Upgrade 4) ────────────────── */}
          {isLoading ? (
            <Box sx={{ width: '100%' }}>
              {/* Title skeleton */}
              <Skeleton variant="text" width="85%" height={40} sx={{ mb: 2 }} />
              <Skeleton variant="text" width="60%" height={40} sx={{ mb: 3 }} />
              {/* Image skeleton */}
              <Skeleton variant="rectangular" width="100%" height={280} sx={{ borderRadius: '8px', mb: 3 }} />
              {/* Paragraph skeletons */}
              <Skeleton variant="text" width="100%" height={18} sx={{ mb: 0.5 }} />
              <Skeleton variant="text" width="100%" height={18} sx={{ mb: 0.5 }} />
              <Skeleton variant="text" width="95%" height={18} sx={{ mb: 0.5 }} />
              <Skeleton variant="text" width="100%" height={18} sx={{ mb: 0.5 }} />
              <Skeleton variant="text" width="88%" height={18} sx={{ mb: 2 }} />
              <Skeleton variant="text" width="100%" height={18} sx={{ mb: 0.5 }} />
              <Skeleton variant="text" width="92%" height={18} sx={{ mb: 0.5 }} />
              <Skeleton variant="text" width="100%" height={18} sx={{ mb: 0.5 }} />
              <Skeleton variant="text" width="70%" height={18} sx={{ mb: 2 }} />
              {/* Second image placeholder */}
              <Skeleton variant="rectangular" width="100%" height={200} sx={{ borderRadius: '8px', mb: 2 }} />
              <Skeleton variant="text" width="100%" height={18} sx={{ mb: 0.5 }} />
              <Skeleton variant="text" width="85%" height={18} />
            </Box>
          ) : (
          <>
          {newsLink && (
            <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" alignItems="center" data-testid="rtn-mode-bar">
              {proxyModeAvailable && liveStatus !== 'failed' && liveStatus !== 'unavailable' && (
                <Button
                  size="small"
                  variant={viewMode === 'live' ? 'contained' : 'outlined'}
                  onClick={() => selectViewMode('live')}
                  sx={{ bgcolor: viewMode === 'live' ? '#1565C0' : undefined, borderColor: '#1565C0', color: viewMode === 'live' ? '#fff' : '#1565C0', fontSize: '0.78rem' }}
                >
                  {liveStatus === 'preparing' ? '⏳ Live Page (Highlighted)' : '🌐 Live Page (Highlighted)'}
                </Button>
              )}
              <Button
                size="small"
                variant={showExtracted ? 'contained' : 'outlined'}
                onClick={() => selectViewMode('extracted')}
                sx={{ bgcolor: showExtracted ? '#8B1212' : undefined, borderColor: '#8B1212', color: showExtracted ? '#fff' : '#8B1212', fontSize: '0.78rem' }}
              >
                📄 Extracted Text
              </Button>
              <Box
                component="a"
                href={newsLink}
                target="_blank"
                rel="noopener noreferrer"
                sx={{ fontSize: '0.8rem', color: '#555', ml: 'auto', textDecoration: 'none', '&:hover': { textDecoration: 'underline' } }}
              >
                ↗ Open in new tab
              </Box>
            </Stack>
          )}
          {viewMode === 'live' && liveStatus === 'preparing' && (
            <Typography data-testid="live-preparing" sx={{ fontSize: '0.8rem', color: '#6B5A43', fontStyle: 'italic' }}>
              ⏳ Loading the live page — showing the extracted text meanwhile…
            </Typography>
          )}

          {showLivePage && (
            <Box>
              <Box
                component="iframe"
                key={readerSrc} // reloads with highlights once the AI token arrives
                title="Live Page (Highlighted)"
                src={readerSrc}
                referrerPolicy="no-referrer"
                // The reader strips every script server-side, so the frame needs no script or
                // same-origin rights at all.
                sandbox="allow-popups allow-popups-to-escape-sandbox"
                sx={{ width: '100%', height: { xs: '75vh', md: '82vh' }, border: '1px solid #e0e0e0', borderRadius: '10px', backgroundColor: '#fff' }}
              />
              <Typography sx={{ mt: 1, fontSize: '0.78rem', color: '#777', fontFamily: banglaFontFamily }}>
                {readerToken
                  ? '🌐 মূল পাতা — বিজ্ঞাপন বাদে, হাইলাইটসহ।'
                  : '🌐 মূল পাতা — AI হাইলাইট তৈরি হচ্ছে, তৈরি হলে পাতাটি নিজে থেকে আবার লোড হবে।'}
              </Typography>
            </Box>
          )}

          {showExtracted && (
          <>
          {/* Article Header — always shown regardless of articleHtml */}
          {metadata?.title && (
            <Typography
              sx={{
                fontFamily: banglaFontFamily,
                fontWeight: 700,
                fontSize: { xs: '1.5rem', md: '2rem' },
                color: '#212121',
                mb: 2,
                lineHeight: 1.3,
              }}
            >
              {metadata.title}
            </Typography>
          )}

          {metadata?.subtitle && (
            <Typography
              sx={{
                fontFamily: '"Noto Serif Bengali", "Kalpurush", serif',
                fontWeight: 500,
                fontSize: { xs: '1rem', md: '1.15rem' },
                color: '#424242',
                mb: 1.5,
                lineHeight: 1.5,
              }}
            >
              {metadata.subtitle}
            </Typography>
          )}

          {(metadata?.author || metadata?.date) && (
            <Box
              sx={{
                display: 'flex', alignItems: 'center', gap: 1.5, mb: 1.5,
                pb: 1.5, borderBottom: '1px solid #eee', flexWrap: 'wrap',
              }}
            >
              {metadata.author && (
                <Typography sx={{ fontFamily: banglaFontFamily, fontSize: '0.85rem', color: '#555', fontWeight: 600 }}>
                  ✍️ {metadata.author}
                </Typography>
              )}
              {metadata.date && (
                <Typography sx={{ fontFamily: banglaFontFamily, fontSize: '0.8rem', color: '#888' }}>
                  🕐 {metadata.date}
                </Typography>
              )}
            </Box>
          )}

          {videoPresent && (
            <Box sx={{ backgroundColor: '#E3F2FD', border: '1px solid #90CAF9', color: '#0D47A1', borderRadius: '8px', px: 1.5, py: 1, mb: 1.5 }}>
              <Typography sx={{ fontWeight: 600, fontSize: '0.9rem' }}>Video file present</Typography>
            </Box>
          )}

          {aiPending && (
            <Typography data-testid="ai-pending" sx={{ fontSize: '0.8rem', color: '#6B5A43', fontStyle: 'italic' }}>
              ⏳ AI analysis running — highlights will appear shortly…
            </Typography>
          )}

          {/* Article HTML (sanitized, DOM-order replica) */}
          {articleHtml ? (
            <Box 
              ref={newsRef}
              sx={{
                '& *': { '&[style]': {} },
                '&': { fontFamily: banglaFontFamily },
                '& mark, & .highlight-yellow': { backgroundColor: '#fff59d !important', color: '#212121 !important', padding: '2px 5px', borderRadius: '3px', display: 'inline', lineHeight: 'inherit' },
                '& .important-line-highlight': { backgroundColor: '#fff59d !important', color: '#212121 !important', padding: '2px 5px', borderRadius: '3px', fontWeight: 500 },
                ...HIGHLIGHT_SX,
                '& img': { maxWidth: '100%', height: 'auto', display: 'block', borderRadius: '8px', my: 3, mx: 'auto' },
                '& figcaption': { fontFamily: banglaFontFamily, fontSize: '0.875rem', color: '#666', fontStyle: 'italic', mt: 1, textAlign: 'center' },
                '& p, & li, & blockquote': { fontFamily: banglaFontFamily, fontSize: { xs: '1rem', md: '1.03rem' }, lineHeight: 1.9, color: '#212121' },
                '& h1': { fontFamily: banglaFontFamily, fontWeight: 700, fontSize: { xs: '1.5rem', md: '2rem' }, color: '#212121', mb: 2, lineHeight: 1.3 },
                '& h2, & h3, & h4': { fontFamily: banglaFontFamily, fontWeight: 600, fontSize: { xs: '1rem', md: '1.15rem' }, color: '#424242', mb: 1.5, lineHeight: 1.5 }
              }}
              dangerouslySetInnerHTML={{ __html: highlightedArticleHtml || articleHtml }}
            />
          ) : newsText ? (
            // Plain-text fallback for the rare extraction that yields text but no article HTML.
            <Typography
              ref={newsRef}
              component="div"
              sx={{
                fontFamily: banglaFontFamily,
                fontSize: { xs: '0.95rem', md: '1rem' },
                lineHeight: 1.7,
                color: '#424242',
                whiteSpace: 'pre-line',
                mb: 2,
                ...HIGHLIGHT_SX,
              }}
              dangerouslySetInnerHTML={{ __html: highlightBlockHtml('', newsText) }}
            />
          ) : (
            <Typography
              sx={{
                fontFamily: banglaFontFamily,
                fontSize: '1rem',
                color: '#9E9E9E',
                fontStyle: 'italic',
              }}
            >
              No news content available yet.
            </Typography>
          )}
          </>
          )}
          </>
          )}
        </Stack>
      </AccordionSection>

      {/* News Summary & AI Analysis Accordion */}
      <AccordionSection
        title={t('newsAnalysis.title')}
        icon={SmartToyRoundedIcon}
        expanded={expandedSummary}
        onToggle={() => setExpandedSummary(!expandedSummary)}
      >
        <Stack spacing={2.5}>
          {/* ── Skeleton Loading for AI Summary (Upgrade 4) ────── */}
          {(isLoading || aiPending) ? (
            <Box>
              <Stack direction="row" spacing={1} sx={{ mb: 2 }}>
                <Skeleton variant="rounded" width={140} height={28} />
                <Skeleton variant="rounded" width={80} height={28} />
              </Stack>
              <Skeleton variant="rounded" width="100%" height={80} sx={{ mb: 2 }} />
              <Skeleton variant="text" width="30%" height={22} sx={{ mb: 1 }} />
              <Skeleton variant="text" width="100%" height={18} sx={{ mb: 0.5 }} />
              <Skeleton variant="text" width="95%" height={18} sx={{ mb: 0.5 }} />
              <Skeleton variant="text" width="80%" height={18} sx={{ mb: 2 }} />
              <Skeleton variant="rounded" width="100%" height={100} sx={{ mb: 2 }} />
              <Stack direction="row" spacing={0.75} sx={{ mb: 2 }}>
                {[1,2,3,4,5].map(i => (
                  <Skeleton key={i} variant="rounded" width={80} height={26} />
                ))}
              </Stack>
              <Skeleton variant="rounded" width="100%" height={90} />
            </Box>
          ) : (
          <>
          {/* Gemini AI Badge + Category Row */}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
            {analysisSource && (
              <Chip
                icon={<SmartToyRoundedIcon />}
                label={analysisSource}
                size="small"
                sx={{ backgroundColor: '#E8F5E9', color: '#2E7D32', fontWeight: 600, fontFamily: '"Inter", sans-serif' }}
              />
            )}
            {language && (
              <Chip
                icon={<TranslateRoundedIcon />}
                label={language}
                size="small"
                sx={{ backgroundColor: '#F3E5F5', color: '#7B1FA2', fontWeight: 600, fontFamily: '"Inter", sans-serif' }}
              />
            )}
            {category && (
              <Chip
                icon={<CategoryRoundedIcon />}
                label={category}
                size="small"
                sx={{ backgroundColor: '#1565C0', color: '#fff', fontWeight: 700, fontSize: '0.85rem', fontFamily: '"Inter", sans-serif' }}
              />
            )}
            {categoryConfidence > 0 && (
              <Typography sx={{ fontSize: '0.78rem', color: '#5C6BC0', fontWeight: 500 }}>
                ({Math.round(categoryConfidence * 100)}% confidence)
              </Typography>
            )}
          </Box>

          <Typography sx={{ fontFamily: '"Noto Sans Bengali", "Roboto", sans-serif', fontSize: '0.78rem', color: '#6D4C41', backgroundColor: '#FFF8E1', borderRadius: '6px', px: 1.5, py: 0.75 }}>
            ⚠️ {t('newsAnalysis.disclaimer')}
          </Typography>

          {aiUnavailableReason && (
            <Box sx={{ backgroundColor: '#FFF8E1', border: '1px solid #FFE082', borderRadius: '10px', p: 2 }}>
              <Typography sx={{ fontWeight: 700, fontSize: '0.95rem', color: '#8D6E00', mb: 0.5 }}>
                {t('newsAnalysis.aiUnavailableTitle')}
              </Typography>
              <Typography sx={{ fontSize: '0.85rem', color: '#5D4037' }}>
                {aiUnavailableReason} {t('newsAnalysis.aiUnavailableBody')}
              </Typography>
            </Box>
          )}

          {/* ── Section 1: Summary + Key Highlights ── */}
          {(summary || highlights?.length > 0) && (
          <Box sx={{ 
            background: 'linear-gradient(145deg, #ffffff 0%, #f9f9f9 100%)', 
            borderRadius: '16px', 
            p: 3, 
            border: '1px solid #E0E0E0',
            boxShadow: '0px 4px 20px rgba(0, 0, 0, 0.05)',
            position: 'relative',
            overflow: 'hidden'
          }}>
            {/* Background Decorative Element */}
            <Box sx={{
              position: 'absolute',
              top: -20,
              right: -20,
              opacity: 0.04,
              transform: 'scale(2.5) rotate(15deg)',
              pointerEvents: 'none'
            }}>
              <SmartToyRoundedIcon sx={{ fontSize: 100 }} />
            </Box>

            {/* Summary */}
            {summary && (
              <Box sx={{ mb: highlights?.length > 0 ? 3 : 0, position: 'relative', zIndex: 1 }}>
                <Typography sx={{ 
                  fontFamily: '"Inter", sans-serif', 
                  fontWeight: 800, 
                  fontSize: '1.15rem', 
                  color: '#1a237e', 
                  mb: 1.5, 
                  display: 'flex', 
                  alignItems: 'center', 
                  gap: 1,
                  letterSpacing: '-0.3px'
                }}>
                  <span style={{ fontSize: '1.4rem' }}>📋</span> {t('newsAnalysis.execSummary')}
                </Typography>
                <Typography sx={{ 
                  fontFamily: '"Noto Serif Bengali", "Kalpurush", serif', 
                  fontSize: { xs: '0.95rem', md: '1.05rem' }, 
                  lineHeight: 1.8, 
                  color: '#37474f', 
                  pl: 2.5, 
                  borderLeft: '4px solid #3f51b5',
                  backgroundColor: 'rgba(63, 81, 181, 0.03)',
                  padding: '12px 16px 12px 20px',
                  borderRadius: '0 8px 8px 0',
                  boxShadow: 'inset 2px 0 0 0 rgba(255,255,255,0.5)'
                }}>
                  {summary}
                </Typography>
                {civicGrievance && (
                  <Typography sx={{ mt: 1, fontFamily: '"Noto Sans Bengali", "Roboto", sans-serif', fontSize: '0.88rem', color: '#455A64' }}>
                    <b>{t('newsAnalysis.civicGrievance')}:</b> {civicGrievance}
                  </Typography>
                )}
              </Box>
            )}

            {/* Key Highlights */}
            {highlights && highlights.length > 0 && (
              <Box sx={{ 
                backgroundColor: '#ffffff', 
                borderRadius: '12px', 
                p: 2.5,
                border: '1px solid rgba(255, 179, 0, 0.3)',
                boxShadow: '0 2px 10px rgba(255, 179, 0, 0.08)',
                position: 'relative',
                zIndex: 1
              }}>
                <Typography sx={{ 
                  fontFamily: '"Inter", sans-serif', 
                  fontWeight: 800, 
                  fontSize: '1rem', 
                  color: '#f57c00', 
                  mb: 2, 
                  display: 'flex', 
                  alignItems: 'center', 
                  gap: 0.75,
                  letterSpacing: '-0.2px'
                }}>
                  <HighlightRoundedIcon sx={{ fontSize: '1.3rem' }} />
                  {t('newsAnalysis.highlights')}
                </Typography>
                <Stack spacing={1.5}>
                  {highlights.map((h, idx) => (
                    <Box key={idx} sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.5 }}>
                      <Box sx={{ 
                        mt: 0.5,
                        width: 6, 
                        height: 6, 
                        borderRadius: '50%', 
                        backgroundColor: '#ffb300',
                        boxShadow: '0 0 0 3px rgba(255, 179, 0, 0.2)',
                        flexShrink: 0
                      }} />
                      <Typography sx={{ 
                        fontFamily: '"Roboto", sans-serif', 
                        fontSize: '0.95rem', 
                        lineHeight: 1.6, 
                        color: '#424242', 
                        fontWeight: 500
                      }}>
                        {h}
                      </Typography>
                    </Box>
                  ))}
                </Stack>
              </Box>
            )}
          </Box>
          )}

          {/* ── Section 2: Government Context (RTI + Related Offices) ── */}
          {shouldShowGovOrgBox && (
            <Box sx={{ backgroundColor: '#E8F5E9', border: '1px solid #A5D6A7', borderRadius: '10px', p: 2 }}>
              <Typography sx={{ fontFamily: '"Inter", sans-serif', fontWeight: 700, fontSize: '1rem', color: '#2E7D32', mb: 1.5, display: 'flex', alignItems: 'center', gap: 0.5 }}>
                <AccountBalanceRoundedIcon sx={{ fontSize: '1.2rem' }} />
                {t('newsAnalysis.govContext')}
              </Typography>

              {/* RTI Target Office */}
              {rtiTargetOffice && (
                <Box sx={{ 
                  backgroundColor: '#C8E6C9', border: '1px solid #81C784', borderRadius: '8px', 
                  p: 1.5, mb: 1.5, display: 'flex', alignItems: 'flex-start', gap: 1,
                }}>
                  <Box sx={{ width: 28, height: 28, borderRadius: '50%', backgroundColor: '#2E7D32', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, mt: 0.25 }}>
                    <Typography sx={{ fontSize: '0.65rem', color: '#fff', fontWeight: 800 }}>RTI</Typography>
                  </Box>
                  <Box>
                    <Typography sx={{ fontFamily: '"Inter", sans-serif', fontSize: '0.75rem', color: '#1B5E20', fontWeight: 700, mb: 0.25 }}>
                      {t('newsAnalysis.rtiTargetOffice')}
                    </Typography>
                    <Typography sx={{ fontFamily: '"Noto Sans Bengali", "Roboto", sans-serif', fontSize: '0.95rem', color: '#1B5E20', fontWeight: 800 }}>
                      {rtiTargetOffice}
                    </Typography>
                  </Box>
                </Box>
              )}

              {/* Government bodies found in the article (gazetteer match) */}
              <Stack spacing={0.5}>
                {relatedGovernmentOrgs.map((office, idx) => (
                  <Box key={office} sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 0.25 }}>
                    <Box sx={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: idx === 0 ? '#2E7D32' : '#66BB6A', flexShrink: 0 }} />
                    <Typography sx={{ fontFamily: '"Noto Sans Bengali", "Roboto", sans-serif', fontSize: '0.9rem', color: '#1B5E20', fontWeight: idx === 0 ? 700 : 400 }}>
                      {office}
                    </Typography>
                  </Box>
                ))}
              </Stack>

              {relatedMinistriesVerified.length > 0 && (
                <Typography sx={{ mt: 1, fontFamily: '"Noto Sans Bengali", "Roboto", sans-serif', fontSize: '0.84rem', color: '#2E7D32' }}>
                  {t('newsAnalysis.relatedVerified')}: {relatedMinistriesVerified.join(', ')}
                </Typography>
              )}

              {ministryReasoning && (
                <Typography sx={{ mt: 1, pt: 1, borderTop: '1px solid #A5D6A7', fontFamily: '"Roboto", sans-serif', fontSize: '0.82rem', color: '#2E7D32', fontStyle: 'italic', lineHeight: 1.5 }}>
                  💡 {ministryReasoning}
                </Typography>
              )}
            </Box>
          )}

          {/* ── Section 3a: Detected Persons + Detected Organizations ── */}
          {(personEntities.length > 0 || orgEntities.length > 0) && (
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2 }}>
              {/* Detected Persons */}
              {personEntities.length > 0 && (
                <Box sx={{ backgroundColor: '#EDE7F6', borderRadius: '10px', p: 1.5, border: '1px solid #D1C4E9' }}>
                  <Typography sx={{ fontFamily: '"Inter", sans-serif', fontWeight: 700, fontSize: '0.9rem', color: '#4527A0', mb: 1, display: 'flex', alignItems: 'center', gap: 0.5 }}>
                    <PersonRoundedIcon sx={{ fontSize: '1.1rem' }} />
                    {t('newsAnalysis.persons', { count: fmtCount(personEntities.length) })}
                  </Typography>
                  <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                    {personEntities.slice(0, 20).map((ent, idx) => {
                      const label = ent?.text || '';
                      const designation = ent?.rank ? ` — ${ent.rank}` : '';
                      return (
                        <Chip
                          key={`per-${idx}`}
                          icon={<PersonRoundedIcon sx={{ fontSize: '0.85rem' }} />}
                          label={`${label}${designation}`}
                          size="small"
                          sx={{ backgroundColor: '#E8EAF6', color: '#283593', fontWeight: 600, fontFamily: '"Inter", sans-serif', fontSize: '0.75rem' }}
                        />
                      );
                    })}
                  </Box>
                </Box>
              )}

              {/* Detected Organizations */}
              {orgEntities.length > 0 && (
                <Box sx={{ backgroundColor: '#E0F2F1', borderRadius: '10px', p: 1.5, border: '1px solid #B2DFDB' }}>
                  <Typography sx={{ fontFamily: '"Inter", sans-serif', fontWeight: 700, fontSize: '0.9rem', color: '#00695C', mb: 1, display: 'flex', alignItems: 'center', gap: 0.5 }}>
                    <BusinessRoundedIcon sx={{ fontSize: '1.1rem' }} />
                    {t('newsAnalysis.orgs', { count: fmtCount(orgEntities.length) })}
                  </Typography>
                  <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                    {orgEntities.slice(0, 20).map((ent, idx) => {
                      const label = ent?.text || '';
                      return (
                        <Chip
                          key={`org-${idx}`}
                          icon={<BusinessRoundedIcon sx={{ fontSize: '0.85rem' }} />}
                          label={label}
                          size="small"
                          sx={{ backgroundColor: '#E0F2F1', color: '#004D40', fontWeight: 600, fontFamily: '"Inter", sans-serif', fontSize: '0.75rem' }}
                        />
                      );
                    })}
                  </Box>
                </Box>
              )}
            </Box>
          )}

          {/* ── Section 3b: Locations (if any) ── */}
          {locationEntities.length > 0 && (
            <Box sx={{ backgroundColor: '#FFF3E0', borderRadius: '10px', p: 1.5, border: '1px solid #FFE0B2' }}>
              <Typography sx={{ fontFamily: '"Inter", sans-serif', fontWeight: 700, fontSize: '0.9rem', color: '#E65100', mb: 1, display: 'flex', alignItems: 'center', gap: 0.5 }}>
                <PlaceRoundedIcon sx={{ fontSize: '1.1rem' }} />
                {t('newsAnalysis.locations', { count: fmtCount(locationEntities.length) })}
              </Typography>
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                {locationEntities.slice(0, 20).map((ent, idx) => {
                  const label = ent?.text || '';
                  return (
                    <Chip
                      key={`loc-${idx}`}
                      icon={<PlaceRoundedIcon sx={{ fontSize: '0.85rem' }} />}
                      label={label}
                      size="small"
                      sx={{ backgroundColor: '#FFF3E0', color: '#E65100', fontWeight: 600, fontFamily: '"Inter", sans-serif', fontSize: '0.75rem' }}
                    />
                  );
                })}
              </Box>
            </Box>
          )}

          {/* ── Section 3c-pre: RTI Officer Cards (CSV-matched + Fallback) ── */}
          {enrichedEntities.length > 0 && (
            <Box>
              <Typography sx={{ fontFamily: '"Inter", sans-serif', fontWeight: 700, fontSize: '0.95rem', color: '#1a237e', mb: 1.5, display: 'flex', alignItems: 'center', gap: 0.75 }}>
                🏛️ {t('newsAnalysis.rtiOfficers', { count: fmtCount(enrichedEntities.length) })}
              </Typography>
              <Stack spacing={1.5}>
                {enrichedEntities.map((ent, idx) => {
                  const dm = ent.databaseMatch;

                  // Normal matched card
                  const primary = dm.officers?.primary;
                  const alternate = dm.officers?.alternate;
                  return (
                    <Box key={`em-${idx}`} sx={{
                      border: '1px solid #A5D6A7',
                      borderRadius: '10px',
                      backgroundColor: '#F1F8E9',
                      p: 2,
                    }}>
                      <Typography sx={{ fontFamily: '"Noto Sans Bengali", "Roboto", sans-serif', fontWeight: 800, fontSize: '0.95rem', color: '#1B5E20', mb: dm.escalatedFrom?.length || dm.viaMinistry ? 0.5 : 1.25 }}>
                        🏛️ {dm.office || dm.division || dm.ministry || ent.originalEntity}
                      </Typography>
                      {dm.escalatedFrom?.length > 0 && (
                        <Typography sx={{ fontFamily: '"Noto Sans Bengali", "Roboto", sans-serif', fontSize: '0.78rem', color: '#33691E', mb: 1.25 }}>
                          সংবাদে উল্লেখিত {dm.escalatedFrom.join(', ')}-এর নিজস্ব তথ্য কর্মকর্তা ডেটাসেটে নেই, তাই এর ঊর্ধ্বতন কর্তৃপক্ষ {dm.matchedBody}-এর তথ্য দেখানো হচ্ছে।
                        </Typography>
                      )}
                      {dm.viaMinistry && (
                        <Typography sx={{ fontFamily: '"Noto Sans Bengali", "Roboto", sans-serif', fontSize: '0.78rem', color: '#33691E', mb: 1.25 }}>
                          {dm.viaMinistry}-এর নিজস্ব সারি ডেটাসেটে নেই; এটি এর অধীন একটি বিভাগ।
                        </Typography>
                      )}
                      <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
                        {primary?.name && (
                          <Box sx={{ display: 'flex', gap: 1.25, alignItems: 'flex-start', flex: 1, minWidth: 200 }}>
                            {primary.image && (
                              <Box component="img" src={primary.image} alt={primary.name}
                                sx={{ width: 48, height: 48, borderRadius: '50%', objectFit: 'cover', border: '2px solid #A5D6A7', flexShrink: 0 }}
                                onError={(e) => { e.target.style.display = 'none'; }}
                              />
                            )}
                            <Box>
                              <Typography sx={{ fontFamily: '"Noto Sans Bengali", "Roboto", sans-serif', fontWeight: 700, fontSize: '0.9rem', color: '#2E7D32' }}>{primary.name}</Typography>
                              {primary.designation && <Typography sx={{ fontSize: '0.78rem', color: '#555', fontWeight: 500 }}>{primary.designation}</Typography>}
                              {primary.mobile && <Typography sx={{ fontSize: '0.75rem', color: '#555' }}>📞 {primary.mobile}</Typography>}
                              {primary.email && <Typography sx={{ fontSize: '0.75rem', color: '#1565C0' }}>✉️ {primary.email}</Typography>}
                            </Box>
                          </Box>
                        )}
                        {alternate?.name && (
                          <Box sx={{ display: 'flex', gap: 1.25, alignItems: 'flex-start', flex: 1, minWidth: 200 }}>
                            {alternate.image && (
                              <Box component="img" src={alternate.image} alt={alternate.name}
                                sx={{ width: 40, height: 40, borderRadius: '50%', objectFit: 'cover', border: '2px solid #C8E6C9', flexShrink: 0, opacity: 0.85 }}
                                onError={(e) => { e.target.style.display = 'none'; }}
                              />
                            )}
                            <Box>
                              <Typography sx={{ fontFamily: '"Noto Sans Bengali", "Roboto", sans-serif', fontWeight: 600, fontSize: '0.85rem', color: '#388E3C' }}>{alternate.name}</Typography>
                              {alternate.designation && <Typography sx={{ fontSize: '0.75rem', color: '#666' }}>{alternate.designation}</Typography>}
                              {alternate.mobile && <Typography sx={{ fontSize: '0.73rem', color: '#555' }}>📞 {alternate.mobile}</Typography>}
                              {alternate.email && <Typography sx={{ fontSize: '0.73rem', color: '#1565C0' }}>✉️ {alternate.email}</Typography>}
                            </Box>
                          </Box>
                        )}
                      </Box>
                      {dm.websiteLink && (
                        <Box component="a" href={dm.websiteLink} target="_blank" rel="noopener noreferrer"
                          sx={{ display: 'inline-block', mt: 1, fontSize: '0.75rem', color: '#1565C0', textDecoration: 'none', '&:hover': { textDecoration: 'underline' } }}
                        >
                          🔗 RTI তথ্য কর্মকর্তার পাতা
                        </Box>
                      )}
                    </Box>
                  );
                })}
              </Stack>
              {rtiGuidance?.routing && <RtiActionability guidance={rtiGuidance} />}
            </Box>
          )}

          {/* ── Metadata + same story elsewhere + related news ── */}
          {articleMetaRows.length > 0 && (
            <Box sx={{ backgroundColor: '#FAFAFA', borderRadius: '10px', p: 1.5, border: '1px solid #E0E0E0' }}>
              <Typography sx={{ fontFamily: '"Inter", sans-serif', fontWeight: 700, fontSize: '0.9rem', color: '#212121', mb: 1 }}>
                🗂️ {t('newsAnalysis.metadata')}
              </Typography>
              <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '140px 1fr' }, columnGap: 1.5, rowGap: 0.5 }}>
                {articleMetaRows.map(([k, v]) => (
                  <React.Fragment key={k}>
                    <Typography sx={{ fontSize: '0.8rem', color: '#757575', fontWeight: 600 }}>{k}</Typography>
                    <Typography sx={{ fontSize: '0.85rem', color: '#212121', wordBreak: 'break-word' }}>{v}</Typography>
                  </React.Fragment>
                ))}
              </Box>
            </Box>
          )}

          {[
            [`📰 ${t('newsAnalysis.sameNews')}`, relatedNews.sameStory, t('newsAnalysis.sameNewsEmpty'), false],
            [`🔗 ${t('newsAnalysis.relatedNews')}`, relatedNews.related, t('newsAnalysis.relatedNewsEmpty'), true],
          ].map(([heading, list, emptyText, isRelatedCard]) => (
            <Box key={heading} sx={{ backgroundColor: '#FAFAFA', borderRadius: '10px', p: 1.5, border: '1px solid #E0E0E0' }}>
              <Typography sx={{ fontFamily: '"Inter", sans-serif', fontWeight: 700, fontSize: '0.9rem', color: '#212121', mb: 1 }}>
                {heading}
              </Typography>
              {relatedNews.loading && <Typography sx={{ fontSize: '0.82rem', color: '#757575' }}>{t('newsAnalysis.searching')}</Typography>}
              {!relatedNews.loading && list.length === 0 && (
                <Typography sx={{ fontSize: '0.82rem', color: '#9E9E9E' }}>{relatedNews.error ? t('newsAnalysis.relatedError') : emptyText}</Typography>
              )}
              <Stack spacing={0.75}>
                {list.map((item, idx) => (
                  <Box key={`${item.url}-${idx}`} component="a" href={item.url} target="_blank" rel="noopener noreferrer"
                    sx={{ display: 'block', textDecoration: 'none', color: '#8B1212', '&:hover .rn-title': { textDecoration: 'underline' } }}>
                    <Typography className="rn-title" sx={{ fontSize: '0.88rem', lineHeight: 1.5 }}>{item.title}</Typography>
                    <Typography sx={{ fontSize: '0.74rem', color: '#757575' }}>
                      {item.source}{item.publishedAt ? ` · ${new Date(item.publishedAt).toLocaleString()}` : ''}{item.similarity ? ` · ${Math.round(item.similarity * 100)}% match` : ''}{item.viaGoogleNews ? ` · ${t('newsAnalysis.viaGoogleNews')}` : ''}
                    </Typography>
                  </Box>
                ))}
              </Stack>
              {isRelatedCard && relatedNews.factChecks.length > 0 && (
                <Box sx={{ mt: 1.5, pt: 1.25, borderTop: '1px dashed #E0E0E0' }}>
                  <Typography sx={{ fontFamily: '"Noto Sans Bengali", "Inter", sans-serif', fontWeight: 700, fontSize: '0.85rem', color: '#212121', mb: 0.5 }}>
                    🔎 {t('newsAnalysis.factChecks')}
                  </Typography>
                  <Typography sx={{ fontSize: '0.74rem', color: '#757575', mb: 0.75 }}>
                    {t('newsAnalysis.factChecksNote')}
                  </Typography>
                  <Stack spacing={0.75}>
                    {relatedNews.factChecks.map((fc) => (
                      <Box key={fc.url} component="a" href={fc.url} target="_blank" rel="noopener noreferrer"
                        sx={{ display: 'block', textDecoration: 'none', color: '#8B1212', '&:hover .rn-title': { textDecoration: 'underline' } }}>
                        <Typography className="rn-title" sx={{ fontSize: '0.88rem', lineHeight: 1.5 }}>{fc.title}</Typography>
                        <Typography sx={{ fontSize: '0.74rem', color: '#757575' }}>
                          {fc.source}{fc.publishedAt ? ` · ${new Date(fc.publishedAt).toLocaleDateString()}` : ''} · {fc.relation === 'same_claim' ? t('newsAnalysis.sameClaim') : t('newsAnalysis.sameEvent')}
                        </Typography>
                      </Box>
                    ))}
                  </Stack>
                </Box>
              )}
            </Box>
          ))}

          {/* ── Section 4: Sources + Download ── */}
          <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            {/* News Link + Related Sources */}
            <Box sx={{ flex: 1, minWidth: 200 }}>
              <Typography sx={{ fontFamily: '"Inter", sans-serif', fontWeight: 700, fontSize: '0.9rem', color: '#212121', mb: 0.5 }}>
                📰 {t('newsAnalysis.source')}
              </Typography>
              <Box
                component="a"
                href={newsLink || '#'}
                target="_blank"
                rel="noopener noreferrer"
                sx={{ display: 'inline-block', color: '#8B1212', textDecoration: 'none', fontSize: '0.88rem', wordBreak: 'break-word', '&:hover': { textDecoration: 'underline' } }}
              >
                {newsLink || t('newsAnalysis.noLink')}
              </Box>

            </Box>

            {/* Download */}
            {summary && (
              <Button
                startIcon={<DownloadRoundedIcon />}
                onClick={handleDownloadPDF}
                disabled={pdfBusy}
                size="small"
                sx={{
                  textTransform: 'none', backgroundColor: '#FF6B6B', color: '#fff',
                  fontWeight: 600, fontSize: '0.85rem', py: 0.75, px: 2, borderRadius: '6px',
                  '&:hover': { backgroundColor: '#ee5a52' },
                  flexShrink: 0,
                }}
              >
                {pdfBusy ? t('newsAnalysis.preserving') : t('newsAnalysis.downloadPdf')}
              </Button>
            )}
            {summary && pdfBusy && (
              <Box sx={{ flexBasis: '100%' }}>
                <LinearProgress sx={{ borderRadius: 1, height: 6 }} />
                <Typography sx={{ fontSize: '0.75rem', color: '#757575', mt: 0.5 }}>{t('newsAnalysis.preservingDetail')}</Typography>
              </Box>
            )}
          </Box>

          </>
          )}
        </Stack>
      </AccordionSection>
    </Box>
  );
};

export default AnalysisAccordion;
