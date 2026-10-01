import React, { useMemo, useState, useEffect, useCallback } from 'react';
import {
  Box,
  Card,
  CardContent,
  Typography,
  Stack,
  Avatar,
  Button,
  TextField,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  IconButton,
  Grid,
  Alert,
  Snackbar,
  Tooltip,
  Chip,
  Paper,
  Table,
  TableBody,
  TableRow,
  TableCell,
  LinearProgress,
  Skeleton,
  CircularProgress,
} from '@mui/material';
import PersonIcon from '@mui/icons-material/Person';
import VerifiedUserIcon from '@mui/icons-material/VerifiedUser';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import SaveIcon from '@mui/icons-material/Save';
import CloseIcon from '@mui/icons-material/Close';
import LanguageIcon from '@mui/icons-material/Language';
import CompareArrowsIcon from '@mui/icons-material/CompareArrows';
import RefreshIcon from '@mui/icons-material/Refresh';
import CloudDownloadIcon from '@mui/icons-material/CloudDownload';
import PhoneIcon from '@mui/icons-material/Phone';
import EmailIcon from '@mui/icons-material/Email';
import BadgeIcon from '@mui/icons-material/Badge';
import BusinessIcon from '@mui/icons-material/Business';
// ContactPageIcon removed — Summary Fields section removed
import LocationOnIcon from '@mui/icons-material/LocationOn';
import DownloadIcon from '@mui/icons-material/Download';
import AccountBalanceIcon from '@mui/icons-material/AccountBalance';
import useTimedProgress from '../hooks/useTimedProgress';
import useIntelligentPipeline from '../hooks/useIntelligentPipeline';
import ProgressWithETA from './ProgressWithETA';
import { buildApiUrl, buildAssetUrl } from '../api/axiosConfig';

/**
 * VerificationGrid Component — Government Office Personnel Directory Style
 *
 * JAANI RTI Verification Database
 * - Displays RTI officer data in formal government-style personnel cards
 * - Side-by-side comparison dialog with live website preview
 * - Persistent popup window for X-Frame-Options bypass
 * - Save changes back to CSV via backend API
 */

// ═══════════════════════════════════════════════════════════════════
const FIELD_LABELS = {
  'Ministry': 'মন্ত্রণালয়',
  'ministry': 'মন্ত্রণালয়',
  'Department': 'বিভাগ',
  'department': 'বিভাগ',
  'Primary_Officer': 'দায়িত্বপ্রাপ্ত কর্মকর্তা',
  'Primary_Mobile': 'প্রাথমিক মোবাইল',
  'Primary_Email': 'প্রাথমিক ইমেইল',
  'Alternate_Officer': 'বিকল্প কর্মকর্তা',
  'Alternate_Designation': 'বিকল্প পদবি',
  'Alternate_Mobile': 'বিকল্প মোবাইল',
  'Alternate_Email': 'বিকল্প ইমেইল',
  'Appellate_Officer': 'আপীল কর্তৃপক্ষ',
  'Appellate_Name': 'আপীল কর্তৃপক্ষ',
  'Appellate_Designation': 'আপীল পদবি',
  'Appellate_Phone': 'আপীল ফোন',
  'Appellate_Mobile': 'আপীল মোবাইল',
  'Appellate_Email': 'আপীল ইমেইল',
  'Appellate_Address': 'আপীল ঠিকানা',
  'Website_Link': 'ওয়েবসাইট',
  'name': 'নাম',
  'duty_officer': 'দায়িত্বপ্রাপ্ত কর্মকর্তা',
  'duty_officer_mobile': 'মোবাইল',
  'duty_officer_email': 'ইমেইল',
  'alternate_duty_officer': 'বিকল্প কর্মকর্তা',
  'alternate_designation': 'বিকল্প পদবি',
  'alternate_mobile': 'বিকল্প মোবাইল',
  'alternate_email': 'বিকল্প ইমেইল',
  'website_link': 'ওয়েবসাইট',
  'Duty Officer': 'দায়িত্বপ্রাপ্ত কর্মকর্তা',
  'Mobile': 'মোবাইল',
  'phone': 'মোবাইল',
  'E-mail': 'ইমেইল',
  'email': 'ইমেইল',
  'Designation': 'পদবি',
  'designation': 'পদবি',
  'Alternate Duty Officer': 'বিকল্প কর্মকর্তা',
  'Alternate Mobile': 'বিকল্প মোবাইল',
  'Alternate E-mail': 'বিকল্প ইমেইল',
  'Website Link': 'ওয়েবসাইট',
  'Last time checked': 'সর্বশেষ যাচাই',
  'last_time_checked': 'সর্বশেষ যাচাই',
  'office_name': 'অফিস',
  'source': 'উৎস',
};

const EXCLUDED_FIELDS = new Set([
  '_id', '__v', 'createdAt', 'updatedAt', 'id', 'source',
]);

/* ── Government Color Theme ─────────────────────────────────────── */
const GOV = {
  green:       '#006a4e',   // Bangladesh flag green
  greenLight:  '#e8f5e9',
  greenDark:   '#004d38',
  maroon:      '#6a1b25',
  maroonLight: '#fbe9eb',
  gold:        '#c5a55a',
  goldLight:   '#fdf6e3',
  border:      '#b9d3b0',
  bg:          '#f7faf5',
  text:        '#1b2e1b',
  textMuted:   '#4b6043',
  white:       '#ffffff',
  sealBorder:  '#8b7d3c',
};

// ── Pure helpers (no closure over component state) — safe at module scope ──
const formatValue = (value) => {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  return String(value).trim();
};

const getFieldValue = (contact, fieldKeys) => {
  if (!contact) return 'N/A';
  for (const key of fieldKeys) {
    const val = contact[key];
    const formatted = formatValue(val);
    if (formatted !== '') return formatted;
  }
  return '';
};

const normalizeAssetUrl = (value) => {
  const formatted = formatValue(value);
  if (!formatted || formatted === 'N/A') return '';
  return buildAssetUrl(formatted);
};

// Hoisted to module scope (not defined inside VerificationGrid's render body) —
// a component defined inside another component's render gets a fresh function
// identity on every re-render, which makes React unmount/remount it instead of
// reconciling it. For an <Avatar> loading a photo, that means the <img> element
// itself gets torn down and recreated before the browser finishes loading it —
// on a component that re-renders as often as this one does (image-loading
// state, progress ticks), the photo can end up never actually finishing a load.
const OfficerCard = ({
  label, nameKeys, designationKeys, phoneKeys, mobileKeys, emailKeys, addressKeys, photoKeys, type,
  databaseContact, roleImages, fetchedImage, isImageLoading, onDownloadVCard,
}) => {
  const officerName = getFieldValue(databaseContact, nameKeys);
  const designation = getFieldValue(databaseContact, designationKeys);
  const phoneVal = getFieldValue(databaseContact, phoneKeys);
  const mobileVal = getFieldValue(databaseContact, mobileKeys);
  const emailVal = getFieldValue(databaseContact, emailKeys);
  const addressVal = addressKeys ? getFieldValue(databaseContact, addressKeys) : '';

  const officerPhoto = getFieldValue(databaseContact, photoKeys || []);
  const isEmpty = !officerName || officerName.trim() === '';
  const isPrimary = type === 'primary';
  const isAlternate = type === 'alternate';
  const accentColor = isPrimary ? GOV.green : isAlternate ? GOV.maroon : '#1565C0';
  const accentLight = isPrimary ? GOV.greenLight : isAlternate ? GOV.maroonLight : '#e3f2fd';

  return (
    <Paper
      elevation={0}
      sx={{
        border: `2px solid ${accentColor}`,
        borderRadius: '6px',
        overflow: 'hidden',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        opacity: isEmpty ? 0.55 : 1,
        position: 'relative',
        /* ── Holographic shimmer border effect ── */
        '&::before': {
          content: '""',
          position: 'absolute',
          inset: -1,
          borderRadius: '7px',
          background: `linear-gradient(135deg, ${GOV.gold}44, transparent 40%, ${accentColor}33, transparent 60%, ${GOV.gold}44)`,
          zIndex: 0,
          pointerEvents: 'none',
        },
      }}
    >
      {/* Card Header Strip — ID card top band */}
      <Box
        sx={{
          bgcolor: accentColor,
          py: 0.6,
          px: 1.5,
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          position: 'relative',
          zIndex: 1,
          /* Gold bottom accent line */
          '&::after': {
            content: '""',
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            height: '2px',
            background: `linear-gradient(90deg, transparent, ${GOV.gold}, transparent)`,
          },
        }}
      >
        <BadgeIcon sx={{ fontSize: '0.9rem', color: GOV.gold }} />
        <Typography
          sx={{
            fontSize: '0.72rem',
            fontWeight: 700,
            color: GOV.white,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
          }}
        >
          {label}
        </Typography>
      </Box>

      {/* Card Body — with watermark seal */}
      <Box sx={{
        p: 1.5,
        flex: 1,
        bgcolor: GOV.white,
        position: 'relative',
        zIndex: 1,
        /* ── Faint government seal watermark ── */
        '&::after': {
          content: '"⚖"',
          position: 'absolute',
          right: 8,
          bottom: 8,
          fontSize: '4rem',
          opacity: 0.035,
          color: accentColor,
          pointerEvents: 'none',
          fontWeight: 900,
          lineHeight: 1,
        },
      }}>
        {/* Photo + Name block — ID card layout */}
        <Stack direction="row" spacing={1.5} alignItems="flex-start" sx={{ mb: 1.25 }}>
          {/* Official photo frame with double border */}
          <Box sx={{
            p: '2px',
            border: `2px solid ${GOV.gold}`,
            borderRadius: '4px',
            bgcolor: GOV.white,
            flexShrink: 0,
            position: 'relative',
            boxShadow: `0 0 0 1px ${accentColor}22`,
          }}>
            <Avatar
              src={
                (normalizeAssetUrl(officerPhoto) || undefined)
                || (isPrimary
                  ? (normalizeAssetUrl(roleImages?.primary || fetchedImage) || undefined)
                  : isAlternate
                    ? (normalizeAssetUrl(roleImages?.alternate) || undefined)
                    : (normalizeAssetUrl(roleImages?.appellate) || undefined))
              }
              variant="rounded"
              sx={{
                width: 58,
                height: 72,
                bgcolor: accentLight,
                borderRadius: '2px',
                fontSize: '1.2rem',
                ...(isImageLoading
                  ? {
                      '&::after': {
                        content: '""',
                        position: 'absolute',
                        inset: 0,
                        bgcolor: 'rgba(255,255,255,0.6)',
                        backgroundImage: 'linear-gradient(90deg, transparent, rgba(0,100,78,.08), transparent)',
                        animation: 'shimmer 1.5s infinite',
                      },
                    }
                  : {}),
              }}
            >
              <PersonIcon sx={{ color: GOV.textMuted }} />
            </Avatar>
          </Box>

          <Box sx={{ minWidth: 0, flex: 1 }}>
            {isEmpty ? (
              <Box sx={{ py: 0.5 }}>
                <Typography
                  sx={{
                    fontSize: '0.85rem',
                    fontWeight: 600,
                    color: GOV.textMuted,
                    opacity: 0.7,
                    fontStyle: 'italic',
                  }}
                >
                  — Officer data not available —
                </Typography>
                <Typography
                  sx={{
                    fontSize: '0.7rem',
                    color: GOV.textMuted,
                    opacity: 0.6,
                    mt: 0.25,
                  }}
                >
                  Enable website scraping to fetch additional details
                </Typography>
              </Box>
            ) : (
              <>
                <Typography
                  sx={{
                    fontSize: '0.92rem',
                    fontWeight: 800,
                    color: GOV.text,
                    lineHeight: 1.2,
                    mb: 0.25,
                    fontFamily: '"Noto Sans Bengali", "SolaimanLipi", sans-serif',
                  }}
                >
                  {officerName || '(খালি)'}
                </Typography>
                <Typography
                  sx={{
                    fontSize: '0.76rem',
                    color: GOV.textMuted,
                    fontStyle: 'italic',
                    lineHeight: 1.3,
                  }}
                >
                  {designation || '(খালি)'}
                </Typography>
              </>
            )}
          </Box>
        </Stack>

        {/* Contact Details Table — ALWAYS SHOWS ALL MANDATORY FIELDS */}
        <Table size="small" sx={{ '& td': { py: 0.35, px: 0, border: 'none', verticalAlign: 'top' } }}>
          <TableBody>
            {/* MANDATORY FIELD 1: ফোন (Phone) */}
            <TableRow>
              <TableCell sx={{ width: 28 }}>
                <PhoneIcon sx={{ fontSize: '0.82rem', color: GOV.green }} />
              </TableCell>
              <TableCell>
                <Typography sx={{ fontSize: '0.72rem', color: '#666', fontWeight: 700 }}>ফোন:</Typography>
              </TableCell>
              <TableCell>
                <Typography sx={{ fontSize: '0.76rem', color: GOV.text, fontWeight: phoneVal ? 600 : 400 }}>
                  {phoneVal || '(খালি)'}
                </Typography>
              </TableCell>
            </TableRow>
            {/* MANDATORY FIELD 2: মোবাইল (Mobile) */}
            <TableRow>
              <TableCell sx={{ width: 28 }}>
                <PhoneIcon sx={{ fontSize: '0.82rem', color: GOV.green }} />
              </TableCell>
              <TableCell>
                <Typography sx={{ fontSize: '0.72rem', color: '#666', fontWeight: 700 }}>মোবাইল:</Typography>
              </TableCell>
              <TableCell>
                <Typography sx={{ fontSize: '0.76rem', color: GOV.text, fontWeight: mobileVal ? 600 : 400 }}>
                  {mobileVal || '(খালি)'}
                </Typography>
              </TableCell>
            </TableRow>
            {/* MANDATORY FIELD 3: ইমেইল (Email) */}
            <TableRow>
              <TableCell sx={{ width: 28 }}>
                <EmailIcon sx={{ fontSize: '0.82rem', color: GOV.green }} />
              </TableCell>
              <TableCell>
                <Typography sx={{ fontSize: '0.72rem', color: '#666', fontWeight: 700 }}>ইমেইল:</Typography>
              </TableCell>
              <TableCell>
                <Typography
                  component="a"
                  href={emailVal && emailVal !== '' ? `mailto:${emailVal}` : '#'}
                  sx={{
                    fontSize: '0.74rem',
                    color: emailVal && emailVal !== '' ? GOV.green : '#999',
                    textDecoration: 'none',
                    fontFamily: 'monospace',
                    wordBreak: 'break-all',
                    fontWeight: emailVal && emailVal !== '' ? 600 : 400,
                    '&:hover': { textDecoration: emailVal && emailVal !== '' ? 'underline' : 'none' },
                  }}
                >
                  {emailVal || '(খালি)'}
                </Typography>
              </TableCell>
            </TableRow>
            {/* MANDATORY FIELD 4: ঠিকানা (Address) */}
            <TableRow>
              <TableCell sx={{ width: 28 }}>
                <LocationOnIcon sx={{ fontSize: '0.82rem', color: GOV.green }} />
              </TableCell>
              <TableCell>
                <Typography sx={{ fontSize: '0.72rem', color: '#666', fontWeight: 700 }}>ঠিকানা:</Typography>
              </TableCell>
              <TableCell>
                <Typography sx={{ fontSize: '0.74rem', color: GOV.text, fontWeight: addressVal ? 600 : 400 }}>
                  {addressVal || '(খালি)'}
                </Typography>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>

        {/* vCard download */}
        {!isEmpty && (
          <Button
            size="small"
            startIcon={<DownloadIcon sx={{ fontSize: '0.85rem' }} />}
            onClick={() => onDownloadVCard(type)}
            sx={{
              mt: 1,
              textTransform: 'none',
              fontSize: '0.7rem',
              fontWeight: 600,
              color: accentColor,
              border: `1px solid ${isPrimary ? GOV.border : '#d4a0a8'}`,
              borderRadius: '3px',
              px: 1.5,
              '&:hover': {
                bgcolor: accentLight,
              },
            }}
          >
            vCard ডাউনলোড
          </Button>
        )}
      </Box>
    </Paper>
  );
};

// ═══════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════
const VerificationGrid = ({
  databaseContact = null,
  scrapedContact = null,
  isLoading = false,
  onContactUpdated = null,
  prefetchedImageUrl = null,
  loadingProgress = 0,
  loadingEta = 'Calculating...',
  networkStatus = 'ok',
  partialSuccess = false,
  statusMessage = '',
  officerSlots = null,
  onRetry = null,
  onUseCache = null,
  retryDisabled = false,
}) => {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editedData, setEditedData] = useState({});
  const [saveStatus, setSaveStatus] = useState(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [iframeKey, setIframeKey] = useState(0);
  const [fetchedImage, setFetchedImage] = useState(() => prefetchedImageUrl || null);
  // Per-role fetched images: { primary, alternate, appellate }
  const [roleImages, setRoleImages] = useState({ primary: null, alternate: null, appellate: null });
  const [isImageLoading, setIsImageLoading] = useState(false);
  const [isIframeLoading, setIsIframeLoading] = useState(false);
  // ══ PIPELINE INTEGRATION: Stage 2 Scraping State ══
  const [scrapingInProgress, setScrapingInProgress] = useState(false);
  const [scrapingError, setScrapingError] = useState('');
  const [scrapingSuccess, setScrapingSuccess] = useState('');
  const { stage2ScrapeSchema } = useIntelligentPipeline();
  const imageProgress = useTimedProgress(isImageLoading, 8);
  const iframeProgress = useTimedProgress(isIframeLoading, 12);
  // Used for webview iframe (needs full URL for cross-origin iframe src)
  const backendBaseUrl = (() => {
    const envUrl = (process.env.REACT_APP_BACKEND_URL || '').trim().replace(/\/+$/, '');
    if (envUrl) return envUrl;
    // No env var — fall back to the current page's own
    // origin rather than a hardcoded port, since the backend port can change.
    return (typeof window !== 'undefined' && window.location) ? window.location.origin : '';
  })();

  // If parent provides a prefetched image later, hydrate local state.
  useEffect(() => {
    if (prefetchedImageUrl && prefetchedImageUrl !== fetchedImage) {
      setFetchedImage(prefetchedImageUrl);
    }
  }, [prefetchedImageUrl, fetchedImage]);

  // ── Utilities ──────────────────────────────────────────────────
  const getLabel = (key) =>
    FIELD_LABELS[key] || key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

  const govUrl = useMemo(() => {
    const urlFields = ['Website_Link', 'website_link', 'Website Link', 'website', 'verifyUrl', 'source_url'];
    for (const field of urlFields) {
      const val = databaseContact?.[field];
      if (typeof val === 'string' && /^https?:\/\//i.test(val)) return val;
    }
    return '';
  }, [databaseContact]);

  const normalizedNetworkStatus = (networkStatus || '').toString().toLowerCase();
  const isNetworkDegraded = partialSuccess || ['partial', 'degraded', 'error'].includes(normalizedNetworkStatus);
  const isConnectionRetrying = isLoading && ['pending', 'retrying', 'processing', 'partial', 'degraded'].includes(normalizedNetworkStatus);

  const roleStatus = useMemo(() => {
    if (officerSlots && typeof officerSlots === 'object') {
      return {
        primary_found: Boolean(officerSlots.primary_found),
        alternate_found: Boolean(officerSlots.alternate_found),
        appellate_found: Boolean(officerSlots.appellate_found),
      };
    }

    const hasText = (value) => typeof value === 'string' && value.trim().length > 0;

    return {
      primary_found: hasText(databaseContact?.Primary_Officer) || hasText(databaseContact?.duty_officer) || hasText(databaseContact?.name),
      alternate_found: hasText(databaseContact?.Alternate_Officer) || hasText(databaseContact?.alternate_duty_officer),
      appellate_found: hasText(databaseContact?.Appellate_Officer) || hasText(databaseContact?.Appellate_Name),
    };
  }, [officerSlots, databaseContact]);

  const missingRoleLabels = useMemo(() => {
    const missing = [];
    if (!roleStatus.primary_found) missing.push('Primary');
    if (!roleStatus.alternate_found) missing.push('Alternate');
    if (!roleStatus.appellate_found) missing.push('Appellate');
    return missing;
  }, [roleStatus]);

  const statusSeverity = normalizedNetworkStatus === 'error' ? 'error' : 'warning';

  // Sync editedData
  useEffect(() => {
    if (databaseContact) setEditedData({ ...databaseContact });
  }, [databaseContact]);

  // Fetch profile images — UPGRADED: fetches up to 3 images for all officer roles
  useEffect(() => {
    const fetchImage = async () => {
      if (!govUrl) return;

      // Keep prefetched image for immediate display, but still try to fetch
      // role-specific officer images (primary/alternate/appellate) for accuracy.
      const hasRoleImages = Boolean(roleImages.primary || roleImages.alternate || roleImages.appellate);
      if (hasRoleImages) return;

      setIsImageLoading(true);
      try {
        // Request 3 images (one per officer role) from the same page
        const response = await fetch(buildApiUrl(`/api/extract-image?url=${encodeURIComponent(govUrl)}&count=3`));
        const result = await response.json();
        if (result.success) {
          // Set primary image for backward compatibility
          if (result.imageUrl && !prefetchedImageUrl) {
            setFetchedImage(normalizeAssetUrl(result.imageUrl));
          }
          // Set per-role images
          setRoleImages({
            primary: normalizeAssetUrl(result.primaryImage || result.imageUrl),
            alternate: normalizeAssetUrl(result.alternateImage),
            appellate: normalizeAssetUrl(result.appellateImage),
          });
        }
      } catch (err) {
        console.warn('Could not extract profile images:', err.message);
      } finally {
        setIsImageLoading(false);
      }
    };
    fetchImage();
  }, [govUrl, prefetchedImageUrl, roleImages.primary, roleImages.alternate, roleImages.appellate]);

  // Display values
  const displayValues = useMemo(() => {
    if (!databaseContact) return {};
    return {
      name: getFieldValue(databaseContact, ['Primary_Officer', 'duty_officer', 'name', 'Duty Officer']),
      designation: getFieldValue(databaseContact, ['Primary_Designation', 'designation', 'Designation']),
      office: getFieldValue(databaseContact, ['office_name', 'Office_Name', 'ministry', 'Ministry', 'department', 'Department']),
      ministry: getFieldValue(databaseContact, ['ministry', 'Ministry']),
      department: getFieldValue(databaseContact, ['department', 'Department']),
      phone: getFieldValue(databaseContact, ['Primary_Mobile', 'duty_officer_mobile', 'Mobile', 'phone']),
      email: getFieldValue(databaseContact, ['Primary_Email', 'duty_officer_email', 'E-mail', 'email']),
      website: getFieldValue(databaseContact, ['Website_Link', 'website_link', 'Website Link']),
    };
  }, [databaseContact]);

  const modifiedCount = useMemo(() => {
    if (!databaseContact) return 0;
    return Object.keys(editedData).filter(
      (key) => editedData[key] !== databaseContact[key] && !EXCLUDED_FIELDS.has(key)
    ).length;
  }, [editedData, databaseContact]);

  // ── Handlers ───────────────────────────────────────────────────
  const handleFieldChange = (key, value) => {
    setEditedData((prev) => ({ ...prev, [key]: value }));
  };

  // ══ PIPELINE INTEGRATION: Stage 2 Scraping Handler ══
  const handleScrapeOfficerDetails = async () => {
    if (!govUrl) {
      setScrapingError('No website URL found. Please ensure the Website_Link field is populated.');
      return;
    }

    setScrapingInProgress(true);
    setScrapingError('');
    setScrapingSuccess('');

    try {
      const result = await stage2ScrapeSchema(govUrl, 'gemini');

      if (result.success && result.data) {
        // Merge scraped data with existing data
        const mergedData = {
          ...databaseContact,
          ...result.data,
          _source: 'stage2_scrape',
          _confidence: result.confidence || {}
        };

        // Update editedData to trigger component state update
        setEditedData(mergedData);

        // Update role-specific images if extracted
        if (result.data.Primary_Image_URL) {
          setRoleImages(prev => ({
            ...prev,
            primary: result.data.Primary_Image_URL
          }));
        }
        if (result.data.Alternate_Image_URL) {
          setRoleImages(prev => ({
            ...prev,
            alternate: result.data.Alternate_Image_URL
          }));
        }
        if (result.data.Appellate_Image_URL) {
          setRoleImages(prev => ({
            ...prev,
            appellate: result.data.Appellate_Image_URL
          }));
        }

        setScrapingSuccess('✅ Officer details scraped successfully! Grid updated with latest data.');
      } else {
        setScrapingError(result.error || 'Failed to scrape officer details. Please check the website URL.');
      }
    } catch (err) {
      console.error('Stage 2 scraping error:', err);
      setScrapingError(err.message || 'An error occurred during scraping. Please try again.');
    } finally {
      setScrapingInProgress(false);
    }
  };

  const openLivePopup = useCallback(() => {
    if (!govUrl) return;
    const popupWidth = window.screen.width * 0.5;
    const popupHeight = window.screen.height * 0.95;
    const left = window.screen.width - popupWidth;
    window.open(
      govUrl,
      'JANIVerifyPopup',
      `width=${popupWidth},height=${popupHeight},left=${left},top=0,scrollbars=yes,resizable=yes,toolbar=yes,menubar=no,location=yes,status=yes`
    );
  }, [govUrl]);

  const handleSave = async () => {
    setSaveStatus('loading');
    setErrorMessage('');
    try {
      const identifier =
        databaseContact.Primary_Mobile ||
        databaseContact.Primary_Email ||
        databaseContact.Alternate_Mobile ||
        databaseContact.Alternate_Email ||
        databaseContact.Appellate_Mobile ||
        databaseContact.Appellate_Email ||
        databaseContact.phone ||
        databaseContact.Mobile ||
        databaseContact.duty_officer_mobile ||
        databaseContact.email ||
        databaseContact['E-mail'];

      const matchHints = {
        office_name: editedData.office_name || editedData.Office || editedData.Office_Name || editedData.Department || editedData.department || '',
        website_link: editedData.Website_Link || editedData.website_link || editedData['Website Link'] || govUrl || '',
        primary_email: editedData.Primary_Email || editedData.email || '',
        primary_mobile: editedData.Primary_Mobile || editedData.phone || '',
      };

      const response = await fetch(buildApiUrl('/api/contacts/update'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: databaseContact._id,
          original_identifier: identifier,
          match_hints: matchHints,
          updates: editedData,
        }),
      });
      const result = await response.json();
      if (response.ok && result.success) {
        setSaveStatus('success');
        // Immediately notify parent so the card updates dynamically
        if (onContactUpdated) onContactUpdated(editedData);
        // Close dialog after brief success feedback
        setTimeout(() => {
          setDialogOpen(false);
          setSaveStatus(null);
        }, 800);
      } else {
        setSaveStatus('error');
        setErrorMessage(result.error || 'Failed to save changes');
      }
    } catch (err) {
      setSaveStatus('error');
      setErrorMessage(err.message || 'Network error');
    }
  };

  const refreshIframe = () => setIframeKey((prev) => prev + 1);

  useEffect(() => {
    if (dialogOpen && govUrl) {
      setIsIframeLoading(true);
      return;
    }
    setIsIframeLoading(false);
  }, [dialogOpen, govUrl, iframeKey]);

  const safeText = (value) =>
    (value == null ? '' : String(value)).replace(/[\r\n]+/g, ' ').trim();

  const buildVCard = ({ fullName, org, title, phone, email }) => {
    const fn = safeText(fullName);
    const organization = safeText(org);
    const jobTitle = safeText(title);
    const tel = safeText(phone);
    const mail = safeText(email).replace(/\s+/g, '');
    const rev = new Date().toISOString();
    return [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'N:',
      `FN:${fn}`,
      organization ? `ORG:${organization}` : null,
      jobTitle ? `TITLE:${jobTitle}` : null,
      tel ? `TEL;TYPE=WORK,VOICE:${tel}` : null,
      mail ? `EMAIL:${mail}` : null,
      `REV:${rev}`,
      'END:VCARD',
      '',
    ]
      .filter(Boolean)
      .join('\r\n');
  };

  const downloadTextFile = (content, filename, mime = 'text/vcard') => {
    const blob = new Blob([content], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const handleDownloadVCard = (type) => {
    const isPrimary = type === 'primary';
    const isAlternate = type === 'alternate';
    const fn = getFieldValue(databaseContact, isPrimary
      ? ['Primary_Officer', 'duty_officer', 'name']
      : isAlternate
        ? ['Alternate_Officer', 'alternate_duty_officer']
        : ['Appellate_Officer', 'Appellate_Name']);
    const phone = getFieldValue(databaseContact, isPrimary
      ? ['Primary_Mobile', 'duty_officer_mobile', 'phone']
      : isAlternate
        ? ['Alternate_Mobile', 'alternate_mobile']
        : ['Appellate_Mobile', 'Appellate_Phone']);
    const email = getFieldValue(databaseContact, isPrimary
      ? ['Primary_Email', 'duty_officer_email', 'email']
      : isAlternate
        ? ['Alternate_Email', 'alternate_email']
        : ['Appellate_Email']);
    const org = getFieldValue(databaseContact, ['Department', 'department', 'Ministry', 'ministry']);
    const title = getFieldValue(databaseContact, isPrimary
      ? ['Primary_Designation', 'designation', 'Designation']
      : isAlternate
        ? ['Alternate_Designation', 'alternate_designation']
        : ['Appellate_Designation']);
    const vcard = buildVCard({ fullName: fn, org, title, phone, email });
    const fileBase = safeText(fn || `${type}_officer`).replace(/[\\/:*?"<>|]+/g, '_');
    downloadTextFile(vcard, `${fileBase}.vcf`);
  };

  // OfficerCard now lives at module scope above (see near GOV/formatValue) —
  // kept out of this render body so its component identity stays stable across
  // re-renders and React never remounts it mid-click or mid-image-load.

  // ═══════════════════════════════════════════════════════════════════
  // RENDER: EMPTY STATE
  // ═══════════════════════════════════════════════════════════════════
  if (!databaseContact) {
    return (
      <Card
        variant="outlined"
        sx={{
          p: 4,
          textAlign: 'center',
          bgcolor: GOV.bg,
          borderStyle: 'dashed',
          borderColor: GOV.border,
        }}
      >
        <AccountBalanceIcon sx={{ fontSize: 52, color: GOV.border, mb: 1 }} />
        <Typography color="text.secondary" sx={{ fontSize: '0.85rem' }}>
          যাচাইয়ের জন্য কোনো তথ্য পাওয়া যায়নি
        </Typography>

        {isNetworkDegraded && (
          <Box sx={{ mt: 2, width: '100%', maxWidth: 620, mx: 'auto' }}>
            <Alert severity={statusSeverity} sx={{ textAlign: 'left' }}>
              <Typography sx={{ fontSize: '0.8rem', fontWeight: 600 }}>
                {statusMessage || 'Network or website restrictions prevented full verification. Please retry or use local cache.'}
              </Typography>
              <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
                {typeof onUseCache === 'function' && (
                  <Button size="small" variant="outlined" onClick={onUseCache} disabled={retryDisabled}>
                    Fetch from Local Cache
                  </Button>
                )}
                {typeof onRetry === 'function' && (
                  <Button size="small" variant="contained" onClick={onRetry} disabled={retryDisabled}>
                    Try Manual Search
                  </Button>
                )}
              </Stack>
            </Alert>
          </Box>
        )}
      </Card>
    );
  }

  // ═══════════════════════════════════════════════════════════════════
  // RENDER: SKELETON LOADING STATE (Upgrade 4)
  // ═══════════════════════════════════════════════════════════════════
  if (isLoading) {
    return (
      <Box sx={{ width: '100%', maxWidth: 960, mx: 'auto' }}>
        <Box sx={{ mb: 1.1, px: 0.5 }}>
          <LinearProgress
            variant="determinate"
            value={Math.max(1, Math.min(99, Math.round(loadingProgress || 0)))}
            sx={{
              height: 8,
              borderRadius: 6,
              backgroundColor: '#E7E1D2',
              '& .MuiLinearProgress-bar': { backgroundColor: GOV.green, borderRadius: 6 },
            }}
          />
          <Box sx={{ display: 'flex', justifyContent: 'space-between', mt: 0.35 }}>
            <Typography sx={{ fontSize: '0.78rem', color: GOV.textMuted, fontWeight: 600 }}>
              {Math.max(1, Math.min(99, Math.round(loadingProgress || 0)))}% complete
            </Typography>
            <Typography sx={{ fontSize: '0.78rem', color: GOV.textMuted }}>
              ETA: {loadingEta}
            </Typography>
          </Box>
          {isConnectionRetrying && (
            <Typography sx={{ mt: 0.45, fontSize: '0.78rem', color: GOV.textMuted }}>
              Retrying connection to government server...
            </Typography>
          )}
        </Box>
        <Card
          elevation={0}
          sx={{
            borderRadius: '4px',
            border: `2px solid ${GOV.border}`,
            overflow: 'hidden',
            bgcolor: GOV.white,
          }}
        >
          {/* Skeleton Banner */}
          <Box sx={{ background: `linear-gradient(135deg, ${GOV.greenDark} 0%, ${GOV.green} 60%, ${GOV.greenDark} 100%)`, px: 2, py: 1.25, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Stack direction="row" spacing={1} alignItems="center">
              <Skeleton variant="circular" width={34} height={34} sx={{ bgcolor: 'rgba(255,255,255,0.15)' }} />
              <Box>
                <Skeleton variant="text" width={140} height={18} sx={{ bgcolor: 'rgba(255,255,255,0.2)' }} />
                <Skeleton variant="text" width={100} height={12} sx={{ bgcolor: 'rgba(255,255,255,0.12)' }} />
              </Box>
            </Stack>
            <Skeleton variant="rounded" width={130} height={30} sx={{ bgcolor: 'rgba(255,255,255,0.15)' }} />
          </Box>

          {/* Skeleton Office Identity */}
          <Box sx={{ bgcolor: GOV.bg, px: 2, py: 1.25, borderBottom: `1px solid ${GOV.border}` }}>
            <Skeleton variant="text" width="20%" height={16} sx={{ mb: 0.5 }} />
            <Skeleton variant="text" width="60%" height={24} sx={{ mb: 0.25 }} />
            <Skeleton variant="text" width="40%" height={16} />
          </Box>

          {/* Skeleton Officer Cards */}
          <CardContent sx={{ p: 2, '&:last-child': { pb: 2 } }}>
            <Grid container spacing={2}>
              {[0, 1, 2].map((i) => (
                <Grid item xs={12} md={i < 2 ? 6 : 12} key={i}>
                  <Paper elevation={0} sx={{ border: `2px solid ${i === 0 ? GOV.border : '#d4a0a8'}`, borderRadius: '4px', overflow: 'hidden' }}>
                    <Box sx={{ bgcolor: i === 0 ? GOV.green : i === 1 ? GOV.maroon : '#1565C0', py: 0.6, px: 1.5 }}>
                      <Skeleton variant="text" width={180} height={16} sx={{ bgcolor: 'rgba(255,255,255,0.2)' }} />
                    </Box>
                    <Box sx={{ p: 1.5 }}>
                      <Stack direction="row" spacing={1.5} alignItems="flex-start" sx={{ mb: 1.25 }}>
                        <Skeleton variant="rounded" width={58} height={72} />
                        <Box sx={{ flex: 1 }}>
                          <Skeleton variant="text" width="80%" height={20} sx={{ mb: 0.5 }} />
                          <Skeleton variant="text" width="50%" height={16} />
                        </Box>
                      </Stack>
                      <Skeleton variant="text" width="70%" height={16} sx={{ mb: 0.5 }} />
                      <Skeleton variant="text" width="60%" height={16} sx={{ mb: 0.5 }} />
                      <Skeleton variant="text" width="85%" height={16} sx={{ mb: 1 }} />
                      <Skeleton variant="rounded" width={110} height={26} />
                    </Box>
                  </Paper>
                </Grid>
              ))}
            </Grid>
          </CardContent>

          {/* Skeleton Bottom Strip */}
          <Box sx={{ bgcolor: GOV.green, py: 0.5, px: 2, display: 'flex', justifyContent: 'space-between' }}>
            <Skeleton variant="text" width={180} height={14} sx={{ bgcolor: 'rgba(255,255,255,0.15)' }} />
            <Skeleton variant="text" width={120} height={14} sx={{ bgcolor: 'rgba(255,255,255,0.1)' }} />
          </Box>
        </Card>
      </Box>
    );
  }

  // ═══════════════════════════════════════════════════════════════════
  // RENDER: MAIN — Government Personnel Directory Card
  // ═══════════════════════════════════════════════════════════════════
  return (
    <Box sx={{ width: '100%', maxWidth: 960, mx: 'auto' }}>
      {isNetworkDegraded && (
        <Alert
          severity={statusSeverity}
          sx={{ mb: 1.5 }}
          action={(
            <Stack direction="row" spacing={1}>
              {typeof onUseCache === 'function' && (
                <Button size="small" variant="outlined" onClick={onUseCache} disabled={retryDisabled}>
                  Fetch from Local Cache
                </Button>
              )}
              {typeof onRetry === 'function' && (
                <Button size="small" variant="contained" onClick={onRetry} disabled={retryDisabled}>
                  Try Manual Search
                </Button>
              )}
            </Stack>
          )}
        >
          <Typography sx={{ fontSize: '0.8rem', fontWeight: 600 }}>
            {statusMessage || 'Verification completed in degraded mode due to network/site limits.'}
          </Typography>
          {missingRoleLabels.length > 0 && (
            <Stack direction="row" spacing={0.75} sx={{ mt: 1 }}>
              {missingRoleLabels.map((label) => (
                <Chip
                  key={label}
                  size="small"
                  color="warning"
                  variant="outlined"
                  label={`${label} role missing`}
                />
              ))}
            </Stack>
          )}
        </Alert>
      )}

      {/* ══ PIPELINE: Scraping Error Alert ══ */}
      {scrapingError && (
        <Alert 
          severity="error" 
          onClose={() => setScrapingError('')}
          sx={{ mb: 1.5 }}
        >
          <Typography sx={{ fontSize: '0.85rem', fontWeight: 500 }}>
            {scrapingError}
          </Typography>
        </Alert>
      )}

      {/* ══ PIPELINE: Scraping Success Alert ══ */}
      {scrapingSuccess && (
        <Alert 
          severity="success" 
          onClose={() => setScrapingSuccess('')}
          sx={{ mb: 1.5 }}
        >
          <Typography sx={{ fontSize: '0.85rem', fontWeight: 500 }}>
            {scrapingSuccess}
          </Typography>
        </Alert>
      )}

      <Card
        elevation={0}
        sx={{
          borderRadius: '4px',
          border: `2px solid ${GOV.green}`,
          overflow: 'hidden',
          bgcolor: GOV.white,
        }}
      >
        {/* ─── Top Banner: Official Green Header ─────────────────── */}
        <Box
          sx={{
            background: `linear-gradient(135deg, ${GOV.greenDark} 0%, ${GOV.green} 60%, ${GOV.greenDark} 100%)`,
            px: 2,
            py: 1.25,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            position: 'relative',
          }}
        >
          {/* Left: Seal + Title */}
          <Stack direction="row" spacing={1} alignItems="center">
            {/* Mini emblem circle */}
            <Box
              sx={{
                width: 34,
                height: 34,
                borderRadius: '50%',
                border: `2px solid ${GOV.gold}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                bgcolor: 'rgba(255,255,255,0.12)',
                flexShrink: 0,
              }}
            >
              <AccountBalanceIcon sx={{ fontSize: '1.1rem', color: GOV.gold }} />
            </Box>

            <Box>
              <Typography
                sx={{
                  fontWeight: 800,
                  fontSize: '0.82rem',
                  color: GOV.white,
                  letterSpacing: '0.05em',
                  lineHeight: 1.2,
                  fontFamily: '"Noto Sans Bengali", "SolaimanLipi", sans-serif',
                }}
              >
                যাচাইকৃত তথ্যভাণ্ডার
              </Typography>
              <Typography
                sx={{
                  fontSize: '0.62rem',
                  color: GOV.gold,
                  fontWeight: 600,
                  letterSpacing: '0.1em',
                  textTransform: 'uppercase',
                }}
              >
                RTI OFFICER DIRECTORY
              </Typography>
            </Box>

            <Chip
              icon={<VerifiedUserIcon sx={{ fontSize: '0.8rem !important', color: `${GOV.green} !important` }} />}
              label="যাচাইকৃত"
              size="small"
              sx={{
                height: 22,
                fontSize: '0.65rem',
                bgcolor: GOV.goldLight,
                color: GOV.green,
                fontWeight: 700,
                border: `1px solid ${GOV.gold}`,
                ml: 1,
                display: { xs: 'none', sm: 'flex' },
              }}
            />
          </Stack>

          {/* Right: Scrape & Compare Buttons */}
          <Stack direction="row" spacing={0.75}>
            {/* ══ PIPELINE: Scrape Officer Details Button ══ */}
            <Tooltip title="Scrape latest data from official website">
              <Button
                size="small"
                variant="outlined"
                startIcon={
                  scrapingInProgress ? (
                    <CircularProgress size={16} sx={{ mr: 0.5 }} />
                  ) : (
                    <CloudDownloadIcon sx={{ fontSize: '1rem' }} />
                  )
                }
                onClick={handleScrapeOfficerDetails}
                disabled={scrapingInProgress || !govUrl}
                sx={{
                  textTransform: 'none',
                  fontWeight: 700,
                  fontSize: { xs: '0.65rem', md: '0.72rem' },
                  py: 0.5,
                  px: { xs: 0.75, md: 1.25 },
                  color: GOV.white,
                  borderColor: 'rgba(255,255,255,0.5)',
                  border: '1px solid rgba(255,255,255,0.5)',
                  borderRadius: '3px',
                  transition: 'all 0.3s ease',
                  '&:hover': { 
                    borderColor: GOV.white,
                    backgroundColor: 'rgba(255,255,255,0.1)'
                  },
                  '&:disabled': { 
                    borderColor: 'rgba(255,255,255,0.2)', 
                    color: 'rgba(255,255,255,0.3)' 
                  },
                }}
              >
                {scrapingInProgress ? 'স্ক্র্যাপিং...' : 'স্ক্র্যাপ করুন'}
              </Button>
            </Tooltip>

            {/* EXISTING: Compare & Edit Button */}
            <Button
              size="small"
              variant="contained"
              startIcon={<CompareArrowsIcon sx={{ fontSize: '1rem' }} />}
              onClick={() => setDialogOpen(true)}
              disabled={!govUrl}
              sx={{
                textTransform: 'none',
                fontWeight: 700,
                fontSize: { xs: '0.65rem', md: '0.72rem' },
                py: 0.5,
                px: { xs: 1, md: 1.5 },
                bgcolor: GOV.gold,
                color: GOV.greenDark,
                border: `1px solid ${GOV.sealBorder}`,
                borderRadius: '3px',
                '&:hover': { bgcolor: '#b8953f', color: GOV.white },
                '&:disabled': { bgcolor: 'rgba(255,255,255,0.2)', color: 'rgba(255,255,255,0.5)' },
              }}
            >
              তুলনা ও সম্পাদনা
            </Button>
          </Stack>
        </Box>

        {/* ─── Office Identity Section ────────────────────────────── */}
        <Box
          sx={{
            bgcolor: GOV.bg,
            px: 2,
            py: 1.25,
            borderBottom: `1px solid ${GOV.border}`,
          }}
        >
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
            <BusinessIcon sx={{ fontSize: '1rem', color: GOV.green }} />
            <Typography
              sx={{
                fontSize: '0.68rem',
                fontWeight: 700,
                color: GOV.textMuted,
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
              }}
            >
              অফিস / দপ্তর
            </Typography>
          </Stack>

          <Typography
            sx={{
              fontSize: '1rem',
              fontWeight: 800,
              color: GOV.green,
              lineHeight: 1.3,
              fontFamily: '"Noto Sans Bengali", "SolaimanLipi", sans-serif',
            }}
          >
            {getFieldValue(databaseContact, ['office_name', 'Office_Name'])}
          </Typography>

          {isImageLoading && (
            <Box sx={{ mt: 0.8, mb: 0.3 }}>
              <LinearProgress
                variant="determinate"
                value={Math.max(1, Math.min(99, Math.round(imageProgress.progress || 0)))}
                sx={{
                  height: 6,
                  borderRadius: 5,
                  backgroundColor: '#E7E1D2',
                  '& .MuiLinearProgress-bar': { backgroundColor: GOV.green, borderRadius: 5 },
                }}
              />
              <Typography sx={{ mt: 0.25, fontSize: '0.7rem', color: GOV.textMuted }}>
                Loading officer image • {Math.round(imageProgress.progress || 0)}% • {imageProgress.etaText}
              </Typography>
            </Box>
          )}

          {(displayValues.ministry !== 'N/A' || displayValues.department !== 'N/A') && (
            <Typography
              sx={{
                fontSize: '0.78rem',
                color: GOV.textMuted,
                mt: 0.25,
              }}
            >
              {displayValues.ministry !== 'N/A' && displayValues.ministry}
              {displayValues.ministry !== 'N/A' && displayValues.department !== 'N/A' && ' — '}
              {displayValues.department !== 'N/A' && displayValues.department}
            </Typography>
          )}
        </Box>

        {/* ─── Officer Personnel Cards ────────────────────────────── */}
        <CardContent sx={{ p: 2, '&:last-child': { pb: 2 } }}>
          {/* Show warnings for missing officer data */}
          {missingRoleLabels.length > 0 && (
            <Alert
              severity="warning"
              sx={{ mb: 1.5, fontSize: '0.85rem' }}
              onClose={() => {}}
            >
              <strong>Incomplete Officer Data:</strong> {missingRoleLabels.join(', ')} officer information not found in database.
              {' '}
              <span style={{ opacity: 0.8 }}>Enable "Scrape Website" to fetch missing details from official sources.</span>
            </Alert>
          )}
          
          {isNetworkDegraded && normalizedNetworkStatus !== 'ok' && (
            <Alert
              severity={statusSeverity}
              sx={{ mb: 1.5, fontSize: '0.85rem' }}
              onClose={() => {}}
            >
              <strong>Network Status: {normalizedNetworkStatus.toUpperCase()}</strong> — Some data may be incomplete or cached.
              {' '}
              <span style={{ opacity: 0.8 }}>Images are being fetched in the background.</span>
            </Alert>
          )}
          
          <Grid container spacing={2}>
            {/* Primary Officer */}
            <Grid item xs={12} md={6}>
              <OfficerCard
                label="দায়িত্বপ্রাপ্ত কর্মকর্তা (ক)"
                labelColor="primary"
                nameKeys={['Primary_Officer', 'duty_officer', 'name', 'Duty Officer']}
                designationKeys={['Primary_Designation', 'designation', 'Designation']}
                phoneKeys={['Primary_Phone']}
                mobileKeys={['Primary_Mobile', 'duty_officer_mobile', 'Mobile', 'phone']}
                emailKeys={['Primary_Email', 'duty_officer_email', 'E-mail', 'email']}
                addressKeys={['Primary_Address']}
                photoKeys={['Primary_Photo']}
                type="primary"
                databaseContact={databaseContact}
                roleImages={roleImages}
                fetchedImage={fetchedImage}
                isImageLoading={isImageLoading}
                onDownloadVCard={handleDownloadVCard}
              />
            </Grid>

            {/* Alternate Officer */}
            <Grid item xs={12} md={6}>
              <OfficerCard
                label="বিকল্প দায়িত্বপ্রাপ্ত কর্মকর্তা (খ)"
                labelColor="alternate"
                nameKeys={['Alternate_Officer', 'alternate_duty_officer', 'Alternate Duty Officer']}
                designationKeys={['Alternate_Designation', 'alternate_designation']}
                phoneKeys={['Alternate_Phone']}
                mobileKeys={['Alternate_Mobile', 'alternate_mobile', 'Alternate Mobile']}
                emailKeys={['Alternate_Email', 'alternate_email', 'Alternate E-mail']}
                addressKeys={['Alternate_Address']}
                photoKeys={['Alternate_Photo']}
                type="alternate"
                databaseContact={databaseContact}
                roleImages={roleImages}
                fetchedImage={fetchedImage}
                isImageLoading={isImageLoading}
                onDownloadVCard={handleDownloadVCard}
              />
            </Grid>

            {/* Appellate Officer */}
            <Grid item xs={12} md={12}>
              <OfficerCard
                label="আপীল কর্তৃপক্ষ"
                labelColor="appellate"
                nameKeys={['Appellate_Officer', 'Appellate_Name']}
                designationKeys={['Appellate_Designation']}
                phoneKeys={['Appellate_Phone']}
                mobileKeys={['Appellate_Mobile']}
                emailKeys={['Appellate_Email']}
                addressKeys={['Appellate_Address']}
                photoKeys={['Appellate_Photo']}
                type="appellate"
                databaseContact={databaseContact}
                roleImages={roleImages}
                fetchedImage={fetchedImage}
                isImageLoading={isImageLoading}
                onDownloadVCard={handleDownloadVCard}
              />
            </Grid>
          </Grid>

          {/* ─── Website & Office Links ──────────────────────────── */}
          {govUrl && (
            <Box
              sx={{
                mt: 2,
                pt: 1.5,
                borderTop: `1px solid ${GOV.border}`,
              }}
            >
              <Stack direction="row" alignItems="center" spacing={0.75}>
                <LanguageIcon sx={{ fontSize: '0.95rem', color: GOV.green }} />
                <Typography
                  component="a"
                  href={govUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  sx={{
                    fontSize: '0.76rem',
                    color: GOV.green,
                    fontWeight: 600,
                    textDecoration: 'none',
                    '&:hover': { textDecoration: 'underline', color: GOV.greenDark },
                    maxWidth: '100%',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    display: 'block',
                  }}
                >
                  {govUrl}
                </Typography>
              </Stack>

              {Array.isArray(databaseContact?.Discovered_Office_Links) &&
                databaseContact.Discovered_Office_Links.length > 0 && (
                  <Box sx={{ mt: 1.25 }}>
                    <Typography
                      sx={{
                        fontSize: '0.65rem',
                        color: GOV.textMuted,
                        textTransform: 'uppercase',
                        mb: 0.5,
                        fontWeight: 600,
                        letterSpacing: '0.06em',
                      }}
                    >
                      সংশ্লিষ্ট অফিস লিংক
                    </Typography>
                    <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap">
                      {databaseContact.Discovered_Office_Links.slice(0, 8).map((u) => (
                        <Chip
                          key={u}
                          label="Open"
                          size="small"
                          icon={<OpenInNewIcon />}
                          component="a"
                          href={u}
                          target="_blank"
                          rel="noopener noreferrer"
                          clickable
                          sx={{
                            fontSize: '0.68rem',
                            borderColor: GOV.border,
                            color: GOV.green,
                            '& .MuiChip-icon': { color: GOV.green },
                          }}
                          variant="outlined"
                        />
                      ))}
                    </Stack>
                  </Box>
                )}
            </Box>
          )}

          {/* Summary Fields section removed — data already shown in officer cards above */}
        </CardContent>

        {/* ─── Bottom Strip ───────────────────────────────────────── */}
        <Box
          sx={{
            bgcolor: GOV.green,
            py: 0.5,
            px: 2,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <Typography sx={{ fontSize: '0.6rem', color: GOV.gold, fontWeight: 600, letterSpacing: '0.08em' }}>
            JAANI — তথ্য অধিকার আইন ২০০৯
          </Typography>
          <Typography sx={{ fontSize: '0.58rem', color: 'rgba(255,255,255,0.5)' }}>
            গণপ্রজাতন্ত্রী বাংলাদেশ সরকার
          </Typography>
        </Box>
      </Card>

      {/* ═════════════════════════════════════════════════════════════
          SIDE-BY-SIDE COMPARISON DIALOG (preserved)
      ═════════════════════════════════════════════════════════════ */}
      <Dialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        maxWidth={false}
        fullWidth
        PaperProps={{
          sx: {
            width: '96vw',
            height: '92vh',
            maxWidth: '96vw',
            m: 1,
            borderRadius: '4px',
            border: `2px solid ${GOV.green}`,
            overflow: 'hidden',
          },
        }}
      >
        {/* Dialog Header — Government style */}
        <DialogTitle
          sx={{
            p: 0,
            borderBottom: `1px solid ${GOV.border}`,
          }}
        >
          <Box
            sx={{
              background: `linear-gradient(135deg, ${GOV.greenDark}, ${GOV.green})`,
              px: 2,
              py: 1,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <Stack direction="row" spacing={1} alignItems="center">
              <CompareArrowsIcon sx={{ color: GOV.gold, fontSize: '1.2rem' }} />
              <Typography sx={{ fontWeight: 700, fontSize: '0.95rem', color: GOV.white }}>
                তথ্য যাচাই ও হালনাগাদ
              </Typography>
              <Chip
                size="small"
                label={`${modifiedCount} পরিবর্তন`}
                sx={{
                  bgcolor: modifiedCount > 0 ? '#fff3e0' : 'rgba(255,255,255,0.15)',
                  color: modifiedCount > 0 ? '#e65100' : 'rgba(255,255,255,0.7)',
                  fontSize: '0.7rem',
                  height: 22,
                  fontWeight: 600,
                }}
              />
            </Stack>
            <IconButton onClick={() => setDialogOpen(false)} size="small" sx={{ color: GOV.white }}>
              <CloseIcon />
            </IconButton>
          </Box>
        </DialogTitle>

        {/* Dialog Content: Split Pane */}
        <DialogContent sx={{ p: 0, display: 'flex', overflow: 'hidden' }}>
          <Grid container sx={{ height: '100%' }}>
            {/* ═══ LEFT PANEL: EDITABLE FORM ═══ */}
            <Grid
              item
              xs={12}
              md={5}
              lg={4.5}
              sx={{
                height: '100%',
                overflow: 'auto',
                borderRight: `1px solid ${GOV.border}`,
                bgcolor: GOV.white,
              }}
            >
              <Box sx={{ p: 2 }}>
                <Alert
                  severity="info"
                  sx={{
                    mb: 2,
                    py: 0.5,
                    bgcolor: GOV.greenLight,
                    border: `1px solid ${GOV.border}`,
                    '& .MuiAlert-icon': { color: GOV.green },
                    '& .MuiAlert-message': { fontSize: '0.75rem', color: GOV.text },
                  }}
                >
                  সরকারি ওয়েবসাইট দেখে তথ্য যাচাই করুন। পরিবর্তিত ফিল্ড হলুদ রঙে দেখা যাবে।
                </Alert>

                {/* Grouped editable fields (compact curated layout) */}
                {(() => {
                  if (!databaseContact) return null;
                  const pickKey = (...candidates) => candidates.find((k) => Object.prototype.hasOwnProperty.call(databaseContact, k)) || candidates[0];
                  const sections = [
                    {
                      title: '🏢 অফিস / দপ্তর',
                      color: GOV.green,
                      fields: [
                        { key: pickKey('office_name', 'Office_Name'), wide: true },
                        { key: pickKey('Ministry', 'ministry') },
                        { key: pickKey('Department', 'department') },
                        { key: pickKey('Website_Link', 'website_link'), wide: true },
                      ],
                    },
                    {
                      title: '👤 দায়িত্বপ্রাপ্ত কর্মকর্তা (ক)',
                      color: GOV.green,
                      fields: [
                        { key: 'Primary_Officer' },
                        { key: 'Primary_Designation' },
                        { key: 'Primary_Phone' },
                        { key: 'Primary_Mobile' },
                        { key: 'Primary_Email', wide: true },
                        { key: 'Primary_Address', wide: true, multiline: true },
                      ],
                    },
                    {
                      title: '👥 বিকল্প কর্মকর্তা (খ)',
                      color: GOV.maroon,
                      fields: [
                        { key: 'Alternate_Officer' },
                        { key: 'Alternate_Designation' },
                        { key: 'Alternate_Phone' },
                        { key: 'Alternate_Mobile' },
                        { key: 'Alternate_Email', wide: true },
                        { key: 'Alternate_Address', wide: true, multiline: true },
                      ],
                    },
                    {
                      title: '⚖️ আপীল কর্তৃপক্ষ',
                      color: '#1565C0',
                      fields: [
                        { key: pickKey('Appellate_Officer', 'Appellate_Name') },
                        { key: 'Appellate_Designation' },
                        { key: 'Appellate_Phone' },
                        { key: 'Appellate_Mobile' },
                        { key: 'Appellate_Email', wide: true },
                        { key: 'Appellate_Address', wide: true, multiline: true },
                      ],
                    },
                  ];

                  return (
                    <Stack spacing={2}>
                      {sections.map((section) => (
                        <Box key={section.title}>
                          <Typography
                            sx={{
                              fontSize: '0.78rem',
                              fontWeight: 700,
                              color: section.color,
                              mb: 1,
                              pb: 0.5,
                              borderBottom: `2px solid ${section.color}22`,
                            }}
                          >
                            {section.title}
                          </Typography>
                          <Grid container spacing={1}>
                            {section.fields.map((field) => {
                              const key = field.key;
                              const hasValue = Object.prototype.hasOwnProperty.call(databaseContact, key) || (editedData[key] != null && editedData[key] !== '');
                              if (!hasValue) return null;
                              const isModified = (editedData[key] || '') !== (databaseContact[key] || '');
                              return (
                                <Grid item xs={12} md={field.wide ? 12 : 6} key={key}>
                                  <TextField
                                    label={getLabel(key)}
                                    value={editedData[key] || ''}
                                    onChange={(e) => handleFieldChange(key, e.target.value)}
                                    fullWidth
                                    size="small"
                                    multiline={Boolean(field.multiline)}
                                    minRows={field.multiline ? 2 : 1}
                                    maxRows={field.multiline ? 4 : 1}
                                    InputProps={{
                                      sx: { fontSize: '0.78rem' },
                                    }}
                                    InputLabelProps={{
                                      sx: { fontSize: '0.72rem' },
                                    }}
                                    sx={{
                                      '& .MuiOutlinedInput-root': {
                                        bgcolor: isModified ? '#fff8e1' : GOV.white,
                                        '& fieldset': {
                                          borderColor: isModified ? '#ffb300' : GOV.border,
                                        },
                                      },
                                    }}
                                  />
                                </Grid>
                              );
                            })}
                          </Grid>
                        </Box>
                      ))}
                    </Stack>
                  );
                })()}
              </Box>
            </Grid>

            {/* ═══ RIGHT PANEL: LIVE BROWSER VIEW ═══ */}
            <Grid
              item
              xs={12}
              md={7}
              lg={7.5}
              sx={{
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                bgcolor: '#f1f3f4',
              }}
            >
              {/* Browser Toolbar */}
              <Paper
                elevation={0}
                sx={{
                  p: 1,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1,
                  borderBottom: '1px solid #dadce0',
                  borderRadius: 0,
                  bgcolor: GOV.bg,
                }}
              >
                {/* Traffic lights */}
                <Stack direction="row" spacing={0.5} sx={{ mr: 1 }}>
                  <Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: '#ff5f57' }} />
                  <Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: '#febc2e' }} />
                  <Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: '#28c840' }} />
                </Stack>

                {/* Address bar */}
                <Box
                  sx={{
                    flexGrow: 1,
                    bgcolor: GOV.white,
                    borderRadius: 1,
                    px: 1.5,
                    py: 0.5,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 0.5,
                    border: `1px solid ${GOV.border}`,
                  }}
                >
                  <Box sx={{ fontSize: '0.75rem' }}>🔒</Box>
                  <Typography noWrap sx={{ fontSize: '0.75rem', color: GOV.text, fontFamily: 'monospace' }}>
                    {govUrl || 'No URL'}
                  </Typography>
                </Box>

                <Tooltip title="Reload iframe">
                  <IconButton size="small" onClick={refreshIframe}>
                    <RefreshIcon sx={{ fontSize: '1rem' }} />
                  </IconButton>
                </Tooltip>

                <Button
                  variant="contained"
                  size="small"
                  startIcon={<OpenInNewIcon sx={{ fontSize: '0.9rem' }} />}
                  onClick={openLivePopup}
                  disabled={!govUrl}
                  sx={{
                    textTransform: 'none',
                    fontSize: '0.7rem',
                    fontWeight: 600,
                    py: 0.5,
                    px: 1.5,
                    bgcolor: GOV.green,
                    '&:hover': { bgcolor: GOV.greenDark },
                  }}
                >
                  লাইভ ট্যাব
                </Button>
              </Paper>

              {/* iframe */}
              <Box sx={{ flexGrow: 1, position: 'relative', bgcolor: GOV.white }}>
                {govUrl ? (
                  <iframe
                    key={iframeKey}
                    title="Government website"
                    src={`${backendBaseUrl}/api/webview?url=${encodeURIComponent(govUrl)}`}
                    style={{ width: '100%', height: '100%', border: 0 }}
                    loading="lazy"
                    onLoad={() => setIsIframeLoading(false)}
                  />
                ) : (
                  <Box
                    sx={{
                      height: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: '#9e9e9e',
                    }}
                  >
                    <Stack alignItems="center" spacing={1}>
                      <LanguageIcon sx={{ fontSize: 48 }} />
                      <Typography>No website URL available</Typography>
                    </Stack>
                  </Box>
                )}

                {govUrl && isIframeLoading && (
                  <Box
                    sx={{
                      position: 'absolute',
                      inset: 0,
                      bgcolor: 'rgba(255,255,255,0.92)',
                      zIndex: 2,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      px: 2,
                    }}
                  >
                    <ProgressWithETA
                      active={isIframeLoading}
                      compact
                      label="Loading website iframe"
                      progress={iframeProgress.progress}
                      etaText={iframeProgress.etaText}
                    />
                  </Box>
                )}

                {govUrl && (
                  <Box
                    sx={{
                      position: 'absolute',
                      bottom: 0,
                      left: 0,
                      right: 0,
                      py: 0.75,
                      px: 2,
                      bgcolor: `${GOV.greenDark}dd`,
                      color: GOV.white,
                      fontSize: '0.7rem',
                      textAlign: 'center',
                      pointerEvents: 'none',
                    }}
                  >
                    ✅ Backend proxy সক্রিয় | সমস্যা হলে "লাইভ ট্যাব" ক্লিক করুন
                  </Box>
                )}
              </Box>
            </Grid>
          </Grid>
        </DialogContent>

        {/* Dialog Footer */}
        <DialogActions
          sx={{
            p: 1.5,
            borderTop: `1px solid ${GOV.border}`,
            justifyContent: 'space-between',
            bgcolor: GOV.bg,
          }}
        >
          <Typography sx={{ fontSize: '0.75rem', color: GOV.textMuted }}>
            {modifiedCount > 0
              ? `${modifiedCount}টি ফিল্ড পরিবর্তিত হয়েছে`
              : 'কোনো পরিবর্তন নেই'}
          </Typography>
          <Stack direction="row" spacing={1}>
            <Button
              onClick={() => setDialogOpen(false)}
              sx={{ textTransform: 'none', fontSize: '0.8rem', color: GOV.textMuted }}
            >
              বাতিল
            </Button>
            <Button
              variant="contained"
              startIcon={saveStatus === 'loading' ? null : <SaveIcon />}
              onClick={handleSave}
              disabled={modifiedCount === 0 || saveStatus === 'loading'}
              sx={{
                textTransform: 'none',
                fontSize: '0.8rem',
                fontWeight: 600,
                bgcolor: GOV.green,
                '&:hover': { bgcolor: GOV.greenDark },
              }}
            >
              {saveStatus === 'loading' ? 'সংরক্ষণ হচ্ছে...' : 'পরিবর্তন সংরক্ষণ'}
            </Button>
          </Stack>
        </DialogActions>
      </Dialog>

      {/* ═══════════════════════════════════════════════════════════
          NOTIFICATIONS
      ═══════════════════════════════════════════════════════════ */}
      <Snackbar
        open={saveStatus === 'success'}
        autoHideDuration={3000}
        onClose={() => setSaveStatus(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert severity="success" onClose={() => setSaveStatus(null)}>
          ✅ তথ্য সফলভাবে সংরক্ষিত হয়েছে!
        </Alert>
      </Snackbar>

      <Snackbar
        open={saveStatus === 'error'}
        autoHideDuration={6000}
        onClose={() => setSaveStatus(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert severity="error" onClose={() => setSaveStatus(null)}>
          ❌ সংরক্ষণে সমস্যা: {errorMessage}
        </Alert>
      </Snackbar>

      {/* ─── Instruction Footer ──────────────────────────────────── */}
      <Box sx={{ mt: 1.5, px: 1, display: 'flex', alignItems: 'center', gap: 0.75 }}>
        <Typography sx={{ fontSize: '0.68rem', color: GOV.textMuted, lineHeight: 1.5 }}>
          💡 <strong>"তুলনা ও সম্পাদনা"</strong> দিয়ে সরকারি সাইটের সাথে তুলনা করুন। iframe-এ সমস্যা হলে "লাইভ ট্যাব" ব্যবহার করুন।
        </Typography>
      </Box>
    </Box>
  );
};

export default VerificationGrid;
