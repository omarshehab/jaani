import React, { useEffect, useMemo, useState } from 'react';
import {
  Box,
  Chip,
  IconButton,
  InputAdornment,
  OutlinedInput,
  Paper,
  Stack,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import SendRoundedIcon from '@mui/icons-material/SendRounded';
import ReplayRoundedIcon from '@mui/icons-material/ReplayRounded';
import { useTranslation } from 'react-i18next';
import SloganCarousel from './SloganCarousel';

const HeroSection = ({
  value,
  onChange,
  onSubmit,
  onReset,
  loading,
  error,
  placeholder,
  enableSticky = true,
  selectedProvider = 'auto',
  onProviderChange,
  providerStatus = null,
  lastAnalysisInfo = null,
}) => {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));
  const { t } = useTranslation();
  const [isStuck, setIsStuck] = useState(false);
  const [keyboardOffset, setKeyboardOffset] = useState(0);
  const [lastAnalyzedUrl, setLastAnalyzedUrl] = useState(null);

  // Predefined news links that are always shown
  const PREDEFINED_LINKS = [
    { label: 'প্রথম আলো ১', url: 'https://www.prothomalo.com/bangladesh/pkvsnl7zw9' },
    { label: 'প্রথম আলো ২', url: 'https://www.prothomalo.com/business/economics/dsqg6uqgyj' },
    { label: 'প্রথম আলো ৩', url: 'https://www.prothomalo.com/bangladesh/5zbxcermyg' },
    { label: 'ঢাকা পোস্ট', url: 'https://www.dhakapost.com/national/425825' },
  ];

  const LLM_PROVIDER_OPTIONS = [
    { value: 'auto', label: 'Auto' },
    { value: 'openai', label: 'OpenAI' },
    { value: 'grok', label: 'Grok' },
    { value: 'kimi', label: 'Kimi' },
  ];

  // Load last analyzed URL from localStorage
  useEffect(() => {
    const loadLastUrl = () => {
      try {
        const lastUrl = localStorage.getItem('rti_last_analyzed_url');
        if (lastUrl) {
          setLastAnalyzedUrl(lastUrl);
        }
      } catch {
        // ignore
      }
    };

    loadLastUrl();

    // Poll for changes (in case same-tab updates don't trigger storage event)
    const interval = setInterval(loadLastUrl, 2000);
    
    // Listen for storage changes from other tabs
    window.addEventListener('storage', loadLastUrl);
    
    return () => {
      clearInterval(interval);
      window.removeEventListener('storage', loadLastUrl);
    };
  }, []);

  const handleSubmit = (submittedUrl) => {
    // Guard: onClick passes an event object — ignore non-string arguments.
    const urlArg = typeof submittedUrl === 'string' ? submittedUrl : '';
    const nextUrl = (urlArg || value || '').trim();
    if (loading || !nextUrl) return;

    if (urlArg && urlArg !== value) {
      onChange(urlArg);
    }

    onSubmit(nextUrl);
  };

  // ── Sticky scroll behaviour ──────────────────────────────────
  useEffect(() => {
    if (!enableSticky || !isMobile) {
      setIsStuck(false);
      return undefined;
    }
    const handleScroll = () => setIsStuck(window.scrollY > 120);
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, [enableSticky, isMobile]);

  // ── Virtual‑keyboard offset (keeps input above keypad) ──────
  useEffect(() => {
    if (!enableSticky) return undefined;
    const vv = window.visualViewport;
    if (!vv) return undefined;

    const onResize = () => {
      // When the keyboard is open the visual viewport height shrinks.
      // The difference tells us exactly how much to lift the bar.
      const diff = window.innerHeight - vv.height;
      setKeyboardOffset(diff > 50 ? diff : 0);   // ignore tiny rounding
      if (diff > 50) setIsStuck(true);            // auto-stick when typing
    };

    vv.addEventListener('resize', onResize);
    vv.addEventListener('scroll', onResize);
    return () => {
      vv.removeEventListener('resize', onResize);
      vv.removeEventListener('scroll', onResize);
    };
  }, [enableSticky]);

  const heroPlaceholder = useMemo(() => placeholder || t('home.urlPlaceholder'), [placeholder, t]);

  return (
    <Stack spacing={3} textAlign="center" alignItems="center" sx={{ mb: { xs: 4, md: 6 }, width: '100%' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: { xs: 1, md: 2 }, flexWrap: 'wrap' }}>
        <Typography
          component="span"
          sx={{
            fontFamily: '"Noto Serif Bengali", "Kalpurush", serif',
            fontSize: { xs: '1.8rem', md: '3.1rem' },
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            fontWeight: 600,
            color: '#8B1212',
          }}
        >
          {t('JAANI.heroWelcome')}
        </Typography>
        <Typography
          component="span"
          sx={{
            fontFamily: '"Noto Serif Bengali", "Kalpurush", serif',
            fontSize: { xs: '3.6rem', md: '6rem' },
            lineHeight: 0.95,
            color: '#8B1212',
            letterSpacing: '0.03em',
            fontWeight: 700,
          }}
        >
          JAANI
        </Typography>
      </Box>
      <SloganCarousel />

      {/* Pill-Shaped Input */}
      <Paper
        elevation={isStuck ? 6 : 0}
        sx={{
          borderRadius: '9999px',
          boxShadow: isStuck
            ? '0 -4px 20px rgba(46, 36, 25, 0.24)'
            : '0 8px 24px rgba(46, 36, 25, 0.16)',
          px: { xs: 1.5, md: 3 },
          py: { xs: 0.5, md: 1 },
          backgroundColor: '#FBF5E8',
          border: '1px solid #D8C5A5',
          position: isStuck ? 'fixed' : 'relative',
          left: isStuck ? 8 : 'auto',
          right: isStuck ? 8 : 'auto',
          /* ── Sits right above the virtual keyboard ── */
          bottom: isStuck ? Math.max(keyboardOffset, 8) : 'auto',
          zIndex: isStuck ? theme.zIndex.modal + 10 : 1,
          width: isStuck ? 'calc(100% - 16px)' : '100%',
          maxWidth: isStuck ? 560 : 'none',
          mx: 'auto',
          transition: keyboardOffset > 0 ? 'bottom 0.1s ease' : 'all 0.3s ease',
        }}
      >
        <OutlinedInput
          fullWidth={true}
          value={value}
          placeholder={heroPlaceholder}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              handleSubmit();
            }
          }}
          disabled={loading}
          sx={{
            borderRadius: '9999px',
            backgroundColor: '#FBF5E8',
            '& fieldset': {
              borderColor: 'transparent',
              borderWidth: '0px',
            },
            '&:hover fieldset': {
              borderColor: 'transparent',
            },
            '&.Mui-focused fieldset': {
              borderColor: 'transparent',
              borderWidth: '0px',
            },
            '& input': {
              fontFamily: '"Noto Serif Bengali", "Kalpurush", serif',
              fontSize: { xs: '0.95rem', md: '1.1rem' },
              padding: { xs: '14px 16px', md: '16px 24px' },
              color: '#4D4030',
              overflowX: 'auto',
              whiteSpace: 'nowrap',
              '&::placeholder': {
                color: '#8D7C65',
                opacity: 1,
              },
            },
          }}
          endAdornment={
            <InputAdornment position="end" sx={{ gap: 1, mr: 0.5 }}>
              {value && (
                <IconButton
                  onClick={onReset}
                  size="small"
                  disabled={loading}
                  sx={{
                    color: '#8B1212',
                    '&:hover': {
                      backgroundColor: 'rgba(139, 18, 18, 0.08)',
                    }
                  }}
                >
                  <ReplayRoundedIcon fontSize="small" />
                </IconButton>
              )}
              <IconButton
                onClick={handleSubmit}
                disabled={loading || !value.trim()}
                sx={{
                  width: 40,
                  height: 40,
                  backgroundColor: '#8B1212',
                  color: '#FDF6EC',
                  boxShadow: '0 2px 8px rgba(46, 36, 25, 0.2)',
                  '&:hover': {
                    backgroundColor: '#701010',
                    boxShadow: '0 4px 12px rgba(46, 36, 25, 0.24)',
                  },
                  '&:disabled': {
                    backgroundColor: '#D8CBB6',
                    color: '#A39276',
                  },
                  borderRadius: '50%',
                }}
              >
                <SendRoundedIcon fontSize="small" />
              </IconButton>
            </InputAdornment>
          }
        />

        {!isStuck && (
          <Box sx={{ mt: 1.25, px: { xs: 1, md: 2 }, width: '100%' }}>
            <Stack direction="row" spacing={1} flexWrap="wrap">
              <Typography variant="caption" sx={{ color: '#8D7C65', alignSelf: 'center', mr: 0.5, fontFamily: '"Noto Serif Bengali", "Kalpurush", serif' }}>
                Previous news:
              </Typography>

              {/* Always show predefined links */}
              {PREDEFINED_LINKS.map((link) => (
                <Chip
                  key={link.url}
                  size="small"
                  label={link.label}
                  onClick={() => {
                    handleSubmit(link.url);
                  }}
                  sx={{
                    cursor: 'pointer',
                    backgroundColor: '#F8EDDA',
                    border: '1px solid #D8C5A5',
                    '&:hover': {
                      backgroundColor: '#F2DFC2',
                      borderColor: '#C8AE82'
                    },
                    fontWeight: 500,
                    color: '#4D4030',
                    '& .MuiChip-label': {
                      maxWidth: '120px',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    },
                  }}
                />
              ))}

              {/* Show last analyzed URL if different from predefined */}
              {lastAnalyzedUrl && !PREDEFINED_LINKS.some(link => link.url === lastAnalyzedUrl) && (
                <Chip
                  key="last-analyzed"
                  size="small"
                  label="Last Analyzed"
                  onClick={() => {
                    handleSubmit(lastAnalyzedUrl);
                  }}
                  sx={{
                    cursor: 'pointer',
                    backgroundColor: '#F2DFC2',
                    border: '1px solid #B98C4D',
                    color: '#7C5C2B',
                    '&:hover': {
                      backgroundColor: '#EED6B0',
                      borderColor: '#9C763C'
                    },
                    fontWeight: 600,
                  }}
                />
              )}
            </Stack>

            <Stack direction="row" spacing={1} flexWrap="wrap" sx={{ mt: 1.25, alignItems: 'center' }}>
              <Typography variant="caption" sx={{ color: '#8D7C65', mr: 0.5, fontFamily: '"Noto Serif Bengali", "Kalpurush", serif' }}>
                AI provider:
              </Typography>
              {LLM_PROVIDER_OPTIONS.map((providerOption) => {
                const selected = selectedProvider === providerOption.value;
                return (
                  <Chip
                    key={providerOption.value}
                    size="small"
                    label={providerOption.label}
                    disabled={loading}
                    onClick={() => {
                      if (typeof onProviderChange === 'function') {
                        onProviderChange(providerOption.value);
                      }
                    }}
                    variant={selected ? 'filled' : 'outlined'}
                    sx={{
                      cursor: loading ? 'default' : 'pointer',
                      borderColor: selected ? '#8B1212' : '#D8C5A5',
                      backgroundColor: selected ? '#8B1212' : '#FBF5E8',
                      color: selected ? '#FDF6EC' : '#4D4030',
                      fontWeight: selected ? 700 : 500,
                      '&:hover': {
                        backgroundColor: selected ? '#701010' : '#F2DFC2',
                        borderColor: selected ? '#701010' : '#C8AE82',
                      },
                    }}
                  />
                );
              })}
            </Stack>

            <Box
              sx={{
                mt: 1.25,
                p: 1.25,
                borderRadius: 2,
                backgroundColor: '#F8EDDA',
                border: '1px solid #D8C5A5',
              }}
            >
              <Stack spacing={0.8}>
                <Typography variant="caption" sx={{ color: '#6B5A43', fontWeight: 700, fontFamily: '"Noto Serif Bengali", "Kalpurush", serif' }}>
                  AI সাড়া ও মডেল অবস্থা
                </Typography>

                <Stack direction="row" spacing={1} flexWrap="wrap">
                  {(providerStatus?.live || []).map((item) => (
                    <Chip
                      key={item.provider}
                      size="small"
                      label={`${item.provider}: ${item.ok ? 'OK' : 'Fail'}${item.model ? ` • ${item.model}` : ''}`}
                      sx={{
                        backgroundColor: item.ok ? '#E8F5E9' : '#FDECEA',
                        color: item.ok ? '#2E7D32' : '#B3261E',
                        border: `1px solid ${item.ok ? '#A5D6A7' : '#F5B5AF'}`,
                        fontWeight: 600,
                      }}
                    />
                  ))}
                </Stack>

                {lastAnalysisInfo && (
                  <Typography variant="caption" sx={{ color: '#4D4030', fontFamily: '"Noto Serif Bengali", "Kalpurush", serif' }}>
                    সর্বশেষ বিশ্লেষণ: {lastAnalysisInfo.provider || 'unknown'}
                    {lastAnalysisInfo.model ? ` • ${lastAnalysisInfo.model}` : ''}
                    {Number.isFinite(lastAnalysisInfo.entityCount) ? ` • entities ${lastAnalysisInfo.entityCount}` : ''}
                  </Typography>
                )}
              </Stack>
            </Box>
          </Box>
        )}

        {error && (
          <Typography
            variant="body2"
            sx={{
              display: 'block',
              mt: 1.5,
              ml: 2,
              textAlign: 'left',
              color: '#7f1d1d',
              bgcolor: '#f7ddd8',
              p: 1,
              borderRadius: 1,
              border: '1px solid #d59f97',
              fontFamily: '"Noto Serif Bengali", "Kalpurush", serif',
              fontSize: '0.85rem',
              fontWeight: 500,
            }}
          >
            ⚠️ {error}
          </Typography>
        )}
      </Paper>
    </Stack>
  );
};

export default HeroSection;

